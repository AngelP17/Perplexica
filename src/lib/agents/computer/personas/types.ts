export type ComputerPersonaId =
  | 'reality-checker'
  | 'agents-orchestrator'
  | 'frontend-developer'
  | 'backend-architect'
  | 'rapid-prototyper'
  | 'ai-engineer'
  | 'senior-developer'
  | 'test-results-analyzer';

export type ComputerPersonaSummary = {
  id: ComputerPersonaId;
  name: string;
  color: string;
  description: string;
  strengths: readonly string[];
};

export type ComputerPersona = ComputerPersonaSummary & {
  sourceUrl: string;
  systemPrompt: string;
};
