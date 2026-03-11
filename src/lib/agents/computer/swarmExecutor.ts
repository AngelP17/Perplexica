import crypto from 'crypto';
import path from 'node:path';
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
  ComputerToolExecutionContext,
  SwarmAgentExecutionOutcome,
  SwarmExecutionOutcome,
  SwarmPlan,
  SwarmPlanAgent,
} from './types';
import { getSkillTools, skillRegistry } from './skills/registry';
import { getWorkspaceBase } from './tools';
import {
  getComputerPersonaById,
  toComputerPersonaSummary,
  type ComputerPersona,
} from './personas';

const executionRoleSchema = z.enum([
  'coder',
  'researcher',
  'browser',
  'vision',
]);

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
    return 3;
  }

  if (mode === 'balanced') {
    return 5;
  }

  return 7;
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

type PersonaScope = 'planner' | 'executor' | 'summary';

const getPersonaOverlay = (
  persona: ComputerPersona | undefined,
  scope: PersonaScope,
) => {
  if (!persona) {
    return '';
  }

  const baseLines = [
    `Active specialist persona: ${persona.name}`,
    `Persona strengths: ${persona.strengths.join(', ')}`,
    persona.systemPrompt,
  ];

  if (scope === 'planner') {
    return [
      ...baseLines,
      'You are still the swarm planner.',
      'Return ONLY valid JSON matching the required schema.',
      'Shape the plan around this persona, keep handoffs explicit, and add a verification-oriented final step when the task changes code, files, or visible behavior.',
    ].join('\n');
  }

  if (scope === 'executor') {
    return [
      ...baseLines,
      'You are still the assigned execution skill.',
      'Stay within the available tools and the exact assigned task, but apply this persona as your quality bar.',
      'Before you declare completion, verify the result at the highest level this persona would expect.',
    ].join('\n');
  }

  return [
    ...baseLines,
    'Write the final user-facing update in this persona style while staying fully grounded in the execution outcome and tool trace.',
  ].join('\n');
};

const withPersonaOverlay = (
  basePrompt: string,
  persona: ComputerPersona | undefined,
  scope: PersonaScope,
) => {
  const overlay = getPersonaOverlay(persona, scope);

  if (!overlay) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${overlay}`;
};

const getWorkspaceRoot = (input?: ComputerAgentInput) =>
  path.resolve(
    getWorkspaceBase(input ? { sandbox: input.config.sandbox } : undefined),
  );

const getDisplayPath = (workspaceRoot: string, targetPath: string) => {
  const relativePath = path.relative(workspaceRoot, targetPath);

  if (!relativePath) {
    return '.';
  }

  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return targetPath;
};

const uniqueStrings = (values: string[]) => {
  return Array.from(new Set(values.filter(Boolean)));
};

const getLikelyImageArtifacts = (paths: string[]) => {
  return uniqueStrings(
    paths.filter((filePath) => /\.(png|jpe?g|webp|gif)$/i.test(filePath)),
  );
};

const requiresSuccessfulVisionAnalysis = (role: ComputerSkillName) => {
  return role === 'vision';
};

const getCreatedPathsFromToolResult = (
  toolName: string,
  result: ComputerToolResult,
) => {
  if (toolName !== 'write_file' && toolName !== 'browser_screenshot') {
    return [];
  }

  const directPath =
    typeof result.path === 'string' && result.path.trim() ? result.path : null;
  const nestedPath =
    toolName === 'browser_screenshot' &&
    typeof result.data === 'object' &&
    result.data !== null &&
    'path' in result.data &&
    typeof result.data.path === 'string' &&
    result.data.path.trim()
      ? result.data.path
      : null;

  return uniqueStrings([directPath, nestedPath].filter(Boolean) as string[]);
};

const getExecutionWarnings = (outcome: SwarmExecutionOutcome) => {
  return uniqueStrings(
    outcome.agentOutcomes
      .filter(
        (agentOutcome) => agentOutcome.completed && agentOutcome.hadToolErrors,
      )
      .flatMap((agentOutcome) => agentOutcome.errors)
      .map((error) => truncateText(error, 180)),
  );
};

const getBlockingErrors = (outcome: SwarmExecutionOutcome) => {
  return uniqueStrings(
    outcome.agentOutcomes
      .filter((agentOutcome) => !agentOutcome.completed)
      .flatMap((agentOutcome) => agentOutcome.errors)
      .map((error) => truncateText(error, 180)),
  );
};

const buildExecutionErrorMessage = (outcome: SwarmExecutionOutcome) => {
  const blockingErrors = getBlockingErrors(outcome);
  const hasPathTraversal = blockingErrors.some((error) =>
    error.includes('Path traversal detected'),
  );

  if (hasPathTraversal) {
    return 'Computer task stalled after trying to access files outside the workspace. Use relative workspace paths and retry.';
  }

  if (
    outcome.agentOutcomes.some(
      (agentOutcome) => agentOutcome.iterationLimitReached,
    )
  ) {
    return 'Computer task reached the iteration limit before finishing.';
  }

  return blockingErrors[0] || 'Computer task did not complete.';
};

const buildExecutionSummary = (
  outcome: SwarmExecutionOutcome,
  workspaceRoot: string,
) => {
  const createdPaths = uniqueStrings(outcome.createdPaths).map((filePath) =>
    getDisplayPath(workspaceRoot, filePath),
  );

  if (outcome.success) {
    const parts = ['Task completed in computer mode.'];

    if (createdPaths.length > 0) {
      parts.push(
        `Created: ${createdPaths.map((filePath) => `\`${filePath}\``).join(', ')}.`,
      );
    }

    const warnings = getExecutionWarnings(outcome);

    if (warnings.length > 0) {
      parts.push(
        'The run recovered from earlier tool errors. Review Computer Steps above for the full trace.',
      );
    }

    if (createdPaths.length === 0 && warnings.length === 0) {
      parts.push('Review Computer Steps above for the full trace.');
    }

    return parts.join(' ');
  }

  const blockingErrors = getBlockingErrors(outcome);
  const hasPathTraversal = blockingErrors.some((error) =>
    error.includes('Path traversal detected'),
  );
  const parts = ['Task incomplete.'];

  if (createdPaths.length > 0) {
    parts.push(
      `Created before stopping: ${createdPaths.map((filePath) => `\`${filePath}\``).join(', ')}.`,
    );
  }

  if (
    outcome.agentOutcomes.some(
      (agentOutcome) => agentOutcome.iterationLimitReached,
    )
  ) {
    parts.push(
      'At least one agent reached the iteration limit before finishing.',
    );
  }

  if (hasPathTraversal) {
    parts.push(
      `File tools only work inside the workspace \`${workspaceRoot}\` using relative paths like \`.\` or \`notes/file.txt\`, or absolute paths that stay under that root.`,
    );
  }

  if (blockingErrors.length > 0) {
    parts.push(`Blocking issues: ${blockingErrors.join(' | ')}.`);
  }

  parts.push('Review the Computer Steps above and retry.');

  return parts.join(' ');
};

export class SwarmExecutor {
  static async createSwarmPlan(
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
  ): Promise<SwarmPlan> {
    const maxRetries = 2;
    const selectedPersona = getComputerPersonaById(
      input.config.specialistPersonaId,
    );

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const systemPrompt = withPersonaOverlay(
          withSystemInstructions(
            skillRegistry.planner.systemPrompt,
            input.config.systemInstructions,
          ),
          selectedPersona,
          'planner',
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
          persona: selectedPersona
            ? toComputerPersonaSummary(selectedPersona)
            : undefined,
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
          persona: selectedPersona
            ? toComputerPersonaSummary(selectedPersona)
            : undefined,
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
    const preferredModelKey =
      skillName === 'coder'
        ? input.config.preferredCoderModelKey || skill?.model
        : skill?.model;

    if (!preferredModelKey || !input.config.resolveChatModel) {
      return input.config.llm;
    }

    try {
      return await input.config.resolveChatModel(preferredModelKey);
    } catch (error) {
      console.warn(
        `[ComputerAgent] Falling back to the selected chat model for "${skillName}" because "${preferredModelKey}" could not be loaded.`,
        error,
      );
      return input.config.llm;
    }
  }

  private static async executeToolCall(
    toolCall: ToolCall,
    agent: SwarmPlanAgent,
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
    sharedHistory: Message[],
    agentMessages: Message[],
  ): Promise<ComputerToolResult> {
    const tools = getSkillTools(agent.role, input.config);
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
        result = await tool.execute(parsedArgs.data, {
          sandbox: input.config.sandbox,
        } satisfies ComputerToolExecutionContext);
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

    return result;
  }

  static async executeSubAgent(
    agent: SwarmPlanAgent,
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
    sharedHistory: Message[],
    priorCreatedPaths: string[] = [],
  ): Promise<SwarmAgentExecutionOutcome> {
    const outcome: SwarmAgentExecutionOutcome = {
      role: agent.role,
      completed: false,
      iterationLimitReached: false,
      hadToolErrors: false,
      createdPaths: [],
      errors: [],
      successfulTools: [],
    };
    const skill = skillRegistry[agent.role];
    const selectedPersona = getComputerPersonaById(
      input.config.specialistPersonaId,
    );

    if (!skill) {
      const error = `Unknown skill "${agent.role}" was skipped.`;

      appendObservationStep(session, blockId, {
        type: 'observation',
        observation: error,
        success: false,
      });
      outcome.errors.push(error);

      return outcome;
    }

    const llm = await this.resolveLLMForSkill(agent.role, input);
    const tools = getSkillTools(agent.role, input.config);
    const likelyImageArtifacts = getLikelyImageArtifacts(priorCreatedPaths);
    const agentMessages: Message[] = [
      {
        role: 'system',
        content: withPersonaOverlay(
          withSystemInstructions(
            skill.systemPrompt,
            input.config.systemInstructions,
          ),
          selectedPersona,
          'executor',
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
          selectedPersona
            ? `Supervising persona: ${selectedPersona.name} - ${selectedPersona.description}`
            : null,
          `Available tools: ${tools.map((tool) => tool.name).join(', ') || 'none'}`,
          `Workspace root: ${getWorkspaceRoot(input)}`,
          agent.role === 'vision' && likelyImageArtifacts.length > 0
            ? `Relevant image artifacts from earlier steps: ${likelyImageArtifacts
                .map((filePath) =>
                  getDisplayPath(getWorkspaceRoot(input), filePath),
                )
                .join(', ')}`
            : null,
          'All file paths must stay inside this workspace. Prefer relative paths such as "." or "notes/file.txt". Absolute paths are allowed only when they stay under this workspace root.',
          agent.role === 'vision' && likelyImageArtifacts.length > 0
            ? 'For this task, call analyze_image on one of the listed image artifacts before writing your conclusion.'
            : null,
          'Use tools when they are needed, and reply directly when the sub-task is complete.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

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
        if (
          requiresSuccessfulVisionAnalysis(agent.role) &&
          !outcome.successfulTools.includes('analyze_image')
        ) {
          const error =
            '[vision] A vision agent must successfully call analyze_image before it can finish.';
          outcome.errors.push(error);
          appendObservationStep(session, blockId, {
            type: 'observation',
            observation: error,
            success: false,
          });
          continue;
        }

        if (response.content.trim()) {
          appendObservationStep(session, blockId, {
            type: 'observation',
            observation: truncateText(response.content.trim(), 2_000),
            success: true,
          });
        }

        outcome.completed = true;
        break;
      }

      for (const toolCall of response.toolCalls) {
        const result = await this.executeToolCall(
          toolCall,
          agent,
          input,
          session,
          blockId,
          sharedHistory,
          agentMessages,
        );

        if (!result.success) {
          outcome.hadToolErrors = true;
          outcome.errors.push(
            `[${agent.role}] ${toolCall.name}: ${result.error || 'Tool execution failed.'}`,
          );
        } else {
          outcome.successfulTools?.push(toolCall.name);
        }

        outcome.createdPaths.push(
          ...getCreatedPathsFromToolResult(toolCall.name, result),
        );
      }
    }

    if (!outcome.completed) {
      outcome.iterationLimitReached = true;
      outcome.errors.push(
        `[${agent.role}] Reached the iteration limit before explicitly finishing the task.`,
      );
      appendObservationStep(session, blockId, {
        type: 'observation',
        observation: `[${agent.role}] Reached the iteration limit before explicitly finishing the task.`,
        success: false,
      });
    }

    outcome.createdPaths = uniqueStrings(outcome.createdPaths);
    outcome.successfulTools = uniqueStrings(outcome.successfulTools ?? []);

    return outcome;
  }

  static async streamFinalSummary(
    input: ComputerAgentInput,
    session: SessionManager,
    sharedHistory: Message[],
    outcome: SwarmExecutionOutcome,
  ) {
    const selectedPersona = getComputerPersonaById(
      input.config.specialistPersonaId,
    );

    if (!outcome.success) {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'text',
        data: outcome.summary,
      });

      return;
    }

    const summaryContext = {
      success: outcome.success,
      hadWarnings: outcome.hadWarnings,
      createdPaths: uniqueStrings(outcome.createdPaths).map((filePath) =>
        getDisplayPath(getWorkspaceRoot(input), filePath),
      ),
      warnings: getExecutionWarnings(outcome),
      persona: selectedPersona
        ? {
            name: selectedPersona.name,
            strengths: selectedPersona.strengths,
          }
        : undefined,
    };

    const summaryStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: withPersonaOverlay(
            withSystemInstructions(
              getComputerSummaryPrompt(),
              input.config.systemInstructions,
            ),
            selectedPersona,
            'summary',
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
            `Execution outcome: ${JSON.stringify(summaryContext)}`,
            'Write the final user-facing update now.',
            'Mention created files or notable outputs when they exist.',
            'Do not claim a file was created unless it appears in createdPaths.',
          ].join('\n'),
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
        data: outcome.summary,
      });
    }
  }

  static async executeSwarm(
    plan: SwarmPlan,
    input: ComputerAgentInput,
    session: SessionManager,
    blockId: string,
  ): Promise<SwarmExecutionOutcome> {
    const sharedHistory: Message[] = [];
    const agentOutcomes: SwarmAgentExecutionOutcome[] = [];
    const cumulativeCreatedPaths: string[] = [];

    for (const agent of plan.agents) {
      const agentOutcome = await this.executeSubAgent(
        agent,
        input,
        session,
        blockId,
        sharedHistory,
        cumulativeCreatedPaths,
      );

      agentOutcomes.push(agentOutcome);
      cumulativeCreatedPaths.push(...agentOutcome.createdPaths);
    }

    const outcome: SwarmExecutionOutcome = {
      success: agentOutcomes.every((agentOutcome) => agentOutcome.completed),
      hadWarnings: agentOutcomes.some(
        (agentOutcome) => agentOutcome.completed && agentOutcome.hadToolErrors,
      ),
      createdPaths: uniqueStrings(
        agentOutcomes.flatMap((agentOutcome) => agentOutcome.createdPaths),
      ),
      agentOutcomes,
      summary: '',
    };

    outcome.summary = buildExecutionSummary(outcome, getWorkspaceRoot(input));
    outcome.errorMessage = outcome.success
      ? undefined
      : buildExecutionErrorMessage(outcome);

    await this.streamFinalSummary(input, session, sharedHistory, outcome);

    return outcome;
  }
}
