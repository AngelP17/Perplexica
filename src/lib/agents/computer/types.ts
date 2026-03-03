import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { Tool } from '@/lib/models/types';
import { ChatTurnMessage } from '@/lib/types';

export type ComputerAgentConfig = {
  llm: BaseLLM<any>;
  mode: 'speed' | 'balanced' | 'quality';
  swarmEnabled: boolean;
  systemInstructions: string;
  resolveChatModel?: (modelKey: string) => Promise<BaseLLM<any>>;
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

export interface ComputerTool<
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
> extends Tool {
  schema: TSchema;
  execute: (params: z.infer<TSchema>) => Promise<ComputerToolResult>;
}

export type ComputerSkillName =
  | 'planner'
  | 'operator'
  | 'coder'
  | 'researcher'
  | 'browser';

export type SwarmPlanAgent = {
  role: ComputerSkillName;
  task: string;
  tools?: string[];
};

export type SwarmPlan = {
  plan: string;
  agents: SwarmPlanAgent[];
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
