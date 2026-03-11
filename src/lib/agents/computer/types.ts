import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { Tool } from '@/lib/models/types';
import { ChatTurnMessage } from '@/lib/types';
import type { ComputerPersonaId } from './personas';
import type { ComputerSandbox } from './sandbox';

export type ComputerAgentConfig = {
  llm: BaseLLM<any>;
  mode: 'speed' | 'balanced' | 'quality';
  swarmEnabled: boolean;
  systemInstructions: string;
  sandbox: ComputerSandbox;
  specialistPersonaId?: ComputerPersonaId;
  providerId?: string;
  chatModelKey?: string;
  preferredCoderModelKey?: string;
  resolveChatModel?: (modelKey: string) => Promise<BaseLLM<any>>;
  resolveVisionModel?: () => Promise<{
    llm: BaseLLM<any>;
    modelKey: string;
  } | null>;
};

export type ComputerAgentInput = {
  chatHistory: ChatTurnMessage[];
  task: string;
  chatId: string;
  messageId: string;
  config: ComputerAgentConfig;
};

export type ComputerToolResult = {
  success: boolean;
  error?: string;
  [key: string]: unknown;
};

export type ComputerToolExecutionContext = {
  sandbox: ComputerSandbox;
};

export interface ComputerTool<
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
> extends Tool {
  schema: TSchema;
  execute: (
    params: z.infer<TSchema>,
    context: ComputerToolExecutionContext,
  ) => Promise<ComputerToolResult>;
}

export type ComputerSkillName =
  | 'planner'
  | 'operator'
  | 'coder'
  | 'researcher'
  | 'browser'
  | 'vision';

export type SwarmPlanAgent = {
  role: ComputerSkillName;
  task: string;
  tools?: string[];
};

export type SwarmPlan = {
  plan: string;
  agents: SwarmPlanAgent[];
};

export type SwarmAgentExecutionOutcome = {
  role: ComputerSkillName;
  completed: boolean;
  iterationLimitReached: boolean;
  hadToolErrors: boolean;
  createdPaths: string[];
  errors: string[];
  successfulTools: string[];
};

export type SwarmExecutionOutcome = {
  success: boolean;
  hadWarnings: boolean;
  createdPaths: string[];
  agentOutcomes: SwarmAgentExecutionOutcome[];
  summary: string;
  errorMessage?: string;
};

export type FileToolResult = ComputerToolResult & {
  content?: string;
  path?: string;
};

export type PythonToolResult = ComputerToolResult & {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  path?: string;
  timedOut?: boolean;
};

export type BrowserToolResult = ComputerToolResult & {
  data?: Record<string, unknown>;
};
