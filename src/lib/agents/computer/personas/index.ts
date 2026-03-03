import { getComputerPersonaSummaryById } from './catalog';
import { agentsOrchestrator } from './agents-orchestrator';
import { aiEngineerPersona } from './ai-engineer';
import { backendArchitect } from './backend-architect';
import { frontendDeveloper } from './frontend-developer';
import { rapidPrototyper } from './rapid-prototyper';
import { realityChecker } from './reality-checker';
import { seniorDeveloper } from './senior-developer';
import { testResultsAnalyzer } from './test-results-analyzer';
import { ComputerPersona, ComputerPersonaId, ComputerPersonaSummary } from './types';

export * from './types';
export * from './catalog';
export * from './agents-orchestrator';
export * from './ai-engineer';
export * from './backend-architect';
export * from './frontend-developer';
export * from './rapid-prototyper';
export * from './reality-checker';
export * from './senior-developer';
export * from './test-results-analyzer';

export const ALL_COMPUTER_PERSONAS: readonly ComputerPersona[] = [
  realityChecker,
  agentsOrchestrator,
  frontendDeveloper,
  backendArchitect,
  rapidPrototyper,
  aiEngineerPersona,
  seniorDeveloper,
  testResultsAnalyzer,
] as const;

const personaMap = new Map<ComputerPersonaId, ComputerPersona>(
  ALL_COMPUTER_PERSONAS.map((persona) => [persona.id, persona]),
);

export const getComputerPersonaById = (
  personaId?: string | null,
): ComputerPersona | undefined => {
  const summary = getComputerPersonaSummaryById(personaId);

  if (!summary) {
    return undefined;
  }

  return personaMap.get(summary.id);
};

export const toComputerPersonaSummary = (
  persona: ComputerPersona,
): ComputerPersonaSummary => {
  return {
    id: persona.id,
    name: persona.name,
    color: persona.color,
    description: persona.description,
    strengths: persona.strengths,
  };
};
