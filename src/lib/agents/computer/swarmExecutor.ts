import crypto from 'crypto';
import z from 'zod';
import { repairJson } from '@toolsycc/json-repair';
import BaseLLM from '@/lib/models/base/llm';
import { ToolCall } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import {
  ActionComputerSubStep,
  Message,
  ObservationComputerSubStep,
  PlanningComputerSubStep,
  TextBlock,
} from '@/lib/types';
import {
  getComputerSummaryPrompt,
  getComputerTaskContext,
  getSwarmPlanningPrompt,
  withSystemInstructions,
} from './prompts';
import { truncateText } from './tools';
import {
  ComputerAgentInput,
  ComputerSkillName,
  ComputerToolResult,
  SwarmPlan,
  SwarmPlanAgent,
} from './types';
import { getSkillTools, skillRegistry } from './skills/registry';

const executionRoleSchema = z.enum(['coder', 'researcher', 'browser']);

const swarmPlanSchema = z.object({
  plan: z.string().min(1).max(800),
  agents: z
    .array(
      z.object({
        role: executionRoleSchema,
        task: z.string().min(1).max(600),
        tools: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(4),
});

const getBlockOrThrow = (session: SessionManager, blockId: string) => {
  const block = session.getBlock(blockId);

  if (!block || block.type !== 'computer') {
    throw new Error('Computer block not found');
  }

  return block;
};

const syncSubSteps = (session: SessionManager, blockId: string) => {
  const block = getBlockOrThrow(session, blockId);

  session.updateBlock(blockId, [
    {
      op: 'replace',
      path: '/data/subSteps',
      value: block.data.subSteps,
    },
  ]);
};

const appendPlanningStep = (
  session: SessionManager,
  blockId: string,
  step: Omit<PlanningComputerSubStep, 'id'>,
) => {
  const block = getBlockOrThrow(session, blockId);

  block.data.subSteps.push({
    id: crypto.randomUUID(),
    ...step,
  });
  syncSubSteps(session, blockId);
};

const appendActionStep = (
  session: SessionManager,
  blockId: string,
  step: Omit<ActionComputerSubStep, 'id'>,
) => {
  const block = getBlockOrThrow(session, blockId);
  const actionId = crypto.randomUUID();

  block.data.subSteps.push({
    id: actionId,
    ...step,
  });
  syncSubSteps(session, blockId);

  return actionId;
};

const updateActionStatus = (
  session: SessionManager,
  blockId: string,
  actionId: string,
  status: ActionComputerSubStep['status'],
) => {
  const block = getBlockOrThrow(session, blockId);
  const action = block.data.subSteps.find(
    (subStep) => subStep.id === actionId && subStep.type === 'action',
  );

  if (!action || action.type !== 'action') {
    return;
  }

  action.status = status;
  syncSubSteps(session, blockId);
};

const appendObservationStep = (
  session: SessionManager,
  blockId: string,
  step: Omit<ObservationComputerSubStep, 'id'>,
) => {
  const block = getBlockOrThrow(session, blockId);

  block.data.subSteps.push({
    id: crypto.randomUUID(),
    ...step,
  });
  syncSubSteps(session, blockId);
};

const renderToolCall = (agentRole: ComputerSkillName, toolCall: ToolCall) => {
  const argPreview = truncateText(
    JSON.stringify(toolCall.arguments ?? {}),
    180,
  );

  return `[${agentRole}] ${toolCall.name}(${argPreview})`;
};

const renderToolResult = (result: ComputerToolResult) => {
  return truncateText(JSON.stringify(result, null, 2), 4_000);
};

const getIterationLimit = (mode: ComputerAgentInput['config']['mode']) => {
  if (mode === 'speed') {
    return 2;
  }

  if (mode === 'balanced') {
    return 4;
  }

  return 6;
};

const getExecutionTemperature = (
  mode: ComputerAgentInput['config']['mode'],
) => {
  if (mode === 'speed') {
    return 0.1;
  }

  if (mode === 'balanced') {
    return 0.2;
  }

  return 0.3;
};

export class SwarmExecutor {
  static async createSwarmPlan(
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
  ): Promise<SwarmPlan> {
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const systemPrompt = withSystemInstructions(
          skillRegistry.planner.systemPrompt,
          input.config.systemInstructions,
        );

        const userPrompt = [
          getComputerTaskContext(input.task, input.chatHistory),
          '',
          getSwarmPlanningPrompt(input.task),
        ].join('\n');

        let plan: z.infer<typeof swarmPlanSchema>;

        try {
          // First attempt: use generateObject (structured output)
          plan = (await input.config.llm.generateObject({
            schema: swarmPlanSchema,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            options: {
              temperature: 0.1, // Lower temp for more deterministic JSON
            },
          })) as z.infer<typeof swarmPlanSchema>;
        } catch (structuredError) {
          if (attempt === maxRetries) {
            throw structuredError;
          }

          console.warn(
            `[ComputerAgent] Structured output failed (attempt ${attempt + 1}/${maxRetries + 1}), trying text generation with JSON repair...`,
          );

          // Fallback: use generateText and repair JSON
          const response = await input.config.llm.generateText({
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content:
                  userPrompt +
                  '\n\nReminder: Return ONLY the JSON object, no markdown, no explanation.',
              },
            ],
            options: {
              temperature: 0.1,
            },
          });

          let jsonText = response.content.trim();

          // Remove markdown code blocks if present
          jsonText = jsonText.replace(/^```(?:json)?\s*/gm, '');
          jsonText = jsonText.replace(/\s*```$/gm, '');

          // Try to repair malformed JSON
          try {
            const repairedJson = repairJson(jsonText) as string;
            plan = swarmPlanSchema.parse(JSON.parse(repairedJson));
            console.log(
              '[ComputerAgent] Successfully repaired and validated plan JSON',
            );
          } catch (repairError) {
            if (attempt < maxRetries) {
              console.warn(
                `[ComputerAgent] JSON repair failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
                repairError,
              );
              continue;
            }
            throw repairError;
          }
        }

        const normalizedPlan: SwarmPlan = {
          plan: plan.plan,
          agents: plan.agents.map((agent) => ({
            role: agent.role,
            task: agent.task,
            tools: agent.tools,
          })),
        };

        appendPlanningStep(session, blockId, {
          type: 'planning',
          plan: normalizedPlan.plan,
          agents: normalizedPlan.agents.map((agent) => ({
            role: agent.role,
            task: agent.task,
          })),
        });

        console.log(
          `[ComputerAgent] Swarm plan created successfully with ${normalizedPlan.agents.length} agent(s)`,
        );

        return normalizedPlan;
      } catch (error) {
        if (attempt < maxRetries) {
          console.warn(
            `[ComputerAgent] Plan creation attempt ${attempt + 1}/${maxRetries + 1} failed, retrying...`,
          );
          continue;
        }

        console.error(
          '[ComputerAgent] All plan creation attempts failed, falling back to operator:',
          error,
        );

        const fallbackPlan: SwarmPlan = {
          plan: 'Plan generation failed after multiple attempts. Using single general-purpose operator.',
          agents: [{ role: 'operator', task: input.task }],
        };

        appendPlanningStep(session, blockId, {
          type: 'planning',
          plan: fallbackPlan.plan,
          agents: fallbackPlan.agents.map((agent) => ({
            role: agent.role,
            task: agent.task,
          })),
        });

        return fallbackPlan;
      }
    }

    // Fallback (should never reach here due to loop logic, but TypeScript needs it)
    const fallbackPlan: SwarmPlan = {
      plan: 'Using single operator.',
      agents: [{ role: 'operator', task: input.task }],
    };

    return fallbackPlan;
  }

  private static async resolveLLMForSkill(
    skillName: ComputerSkillName,
    input: ComputerAgentInput,
  ): Promise<BaseLLM<any>> {
    const skill = skillRegistry[skillName];

    if (!skill?.model || !input.config.resolveChatModel) {
      return input.config.llm;
    }

    try {
      return await input.config.resolveChatModel(skill.model);
    } catch (error) {
      console.warn(
        `[ComputerAgent] Falling back to the selected chat model for "${skillName}" because "${skill.model}" could not be loaded.`,
        error,
      );
      return input.config.llm;
    }
  }

  private static async executeToolCall(
    toolCall: ToolCall,
    agent: SwarmPlanAgent,
    session: SessionManager,
    blockId: string,
    sharedHistory: Message[],
    agentMessages: Message[],
  ) {
    const tools = getSkillTools(agent.role);
    const tool = tools.find((candidate) => candidate.name === toolCall.name);

    const actionId = appendActionStep(session, blockId, {
      type: 'action',
      action: renderToolCall(agent.role, toolCall),
      tool: toolCall.name,
      status: 'running',
    });

    let result: ComputerToolResult;

    if (!tool) {
      result = {
        success: false,
        error: `Tool "${toolCall.name}" is not available to the ${agent.role} skill.`,
      };
    } else {
      const parsedArgs = tool.schema.safeParse(toolCall.arguments ?? {});

      if (!parsedArgs.success) {
        result = {
          success: false,
          error: parsedArgs.error.issues
            .map((issue) => issue.message)
            .join(', '),
        };
      } else {
        result = await tool.execute(parsedArgs.data);
      }
    }

    updateActionStatus(
      session,
      blockId,
      actionId,
      result.success ? 'completed' : 'error',
    );

    appendObservationStep(session, blockId, {
      type: 'observation',
      observation: renderToolResult(result),
      success: result.success,
    });

    const toolMessage: Message = {
      role: 'tool',
      id: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify(result),
    };

    agentMessages.push(toolMessage);
    sharedHistory.push(toolMessage);
  }

  static async executeSubAgent(
    agent: SwarmPlanAgent,
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
    sharedHistory: Message[],
  ) {
    const skill = skillRegistry[agent.role];

    if (!skill) {
      appendObservationStep(session, blockId, {
        type: 'observation',
        observation: `Unknown skill "${agent.role}" was skipped.`,
        success: false,
      });
      return;
    }

    const llm = await this.resolveLLMForSkill(agent.role, input);
    const tools = getSkillTools(agent.role);
    const agentMessages: Message[] = [
      {
        role: 'system',
        content: withSystemInstructions(
          skill.systemPrompt,
          input.config.systemInstructions,
        ),
      },
      {
        role: 'user',
        content: getComputerTaskContext(input.task, input.chatHistory),
      },
      ...sharedHistory,
      {
        role: 'user',
        content: [
          `Role: ${skill.role}`,
          `Assigned task: ${agent.task}`,
          `Available tools: ${tools.map((tool) => tool.name).join(', ') || 'none'}`,
          'Use tools when they are needed, and reply directly when the sub-task is complete.',
        ].join('\n'),
      },
    ];

    let completed = false;
    const maxIterations = getIterationLimit(input.config.mode);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await llm.generateText({
        messages: agentMessages,
        tools,
        options: {
          temperature: getExecutionTemperature(input.config.mode),
        },
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content,
        ...(response.toolCalls.length > 0
          ? { tool_calls: response.toolCalls }
          : {}),
      };

      agentMessages.push(assistantMessage);
      sharedHistory.push(assistantMessage);

      if (response.toolCalls.length === 0) {
        if (response.content.trim()) {
          appendObservationStep(session, blockId, {
            type: 'observation',
            observation: truncateText(response.content.trim(), 2_000),
            success: true,
          });
        }

        completed = true;
        break;
      }

      for (const toolCall of response.toolCalls) {
        await this.executeToolCall(
          toolCall,
          agent,
          session,
          blockId,
          sharedHistory,
          agentMessages,
        );
      }
    }

    if (!completed) {
      appendObservationStep(session, blockId, {
        type: 'observation',
        observation: `[${agent.role}] Reached the iteration limit before explicitly finishing the task.`,
        success: false,
      });
    }
  }

  static async streamFinalSummary(
    input: ComputerAgentInput,
    session: SessionManager,
    sharedHistory: Message[],
  ) {
    const summaryStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: withSystemInstructions(
            getComputerSummaryPrompt(),
            input.config.systemInstructions,
          ),
        },
        {
          role: 'user',
          content: getComputerTaskContext(input.task, input.chatHistory),
        },
        ...sharedHistory,
        {
          role: 'user',
          content:
            'Write the final user-facing update now. Mention created files or notable outputs when they exist.',
        },
      ],
      options: {
        temperature: 0.2,
      },
    });

    let responseBlockId = '';

    for await (const chunk of summaryStream) {
      if (!chunk.contentChunk) {
        continue;
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);
        responseBlockId = block.id;
        continue;
      }

      const existingBlock = session.getBlock(responseBlockId);

      if (!existingBlock || existingBlock.type !== 'text') {
        continue;
      }

      existingBlock.data += chunk.contentChunk;
      session.updateBlock(existingBlock.id, [
        {
          op: 'replace',
          path: '/data',
          value: existingBlock.data,
        },
      ]);
    }

    if (!responseBlockId) {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'text',
        data: 'Execution finished. Review the steps above for the full trace.',
      });
    }
  }

  static async executeSwarm(
    plan: SwarmPlan,
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
  ) {
    const sharedHistory: Message[] = [];

    for (const agent of plan.agents) {
      await this.executeSubAgent(agent, input, session, blockId, sharedHistory);
    }

    await this.streamFinalSummary(input, session, sharedHistory);
  }
}
