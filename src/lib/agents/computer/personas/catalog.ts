import { ComputerPersonaSummary, ComputerPersonaId } from './types';

export const COMPUTER_PERSONA_STORAGE_KEY = 'computerPersonaId';

export const COMPUTER_PERSONA_CATALOG: readonly ComputerPersonaSummary[] = [
  {
    id: 'reality-checker',
    name: 'Reality Checker',
    color: '#ef4444',
    description:
      'Evidence-obsessed reviewer that defaults to NEEDS WORK until the trace proves success.',
    strengths: ['validation', 'qa', 'evidence'],
  },
  {
    id: 'agents-orchestrator',
    name: 'Agents Orchestrator',
    color: '#06b6d4',
    description:
      'Process-first coordinator that enforces clean handoffs, checkpoints, and retries.',
    strengths: ['planning', 'handoffs', 'coordination'],
  },
  {
    id: 'frontend-developer',
    name: 'Frontend Developer',
    color: '#22c55e',
    description:
      'UI-focused specialist for responsive interfaces, accessibility, and polished implementation.',
    strengths: ['ui', 'accessibility', 'performance'],
  },
  {
    id: 'backend-architect',
    name: 'Backend Architect',
    color: '#3b82f6',
    description:
      'Architecture-minded specialist for APIs, schemas, reliability, and secure systems.',
    strengths: ['apis', 'schemas', 'reliability'],
  },
  {
    id: 'rapid-prototyper',
    name: 'Rapid Prototyper',
    color: '#16a34a',
    description:
      'Speed-biased builder that prefers the smallest working path to validate the idea fast.',
    strengths: ['mvp', 'speed', 'iteration'],
  },
  {
    id: 'ai-engineer',
    name: 'AI Engineer',
    color: '#2563eb',
    description:
      'AI systems specialist focused on prompts, evaluations, safety, and model integration.',
    strengths: ['llms', 'evaluation', 'safety'],
  },
  {
    id: 'senior-developer',
    name: 'Senior Developer',
    color: '#10b981',
    description:
      'Implementation-heavy specialist for difficult debugging, polish, and end-to-end delivery.',
    strengths: ['implementation', 'debugging', 'craft'],
  },
  {
    id: 'test-results-analyzer',
    name: 'Test Results Analyzer',
    color: '#6366f1',
    description:
      'Quality analyst that turns raw results into release risk, trends, and next actions.',
    strengths: ['analysis', 'risk', 'reporting'],
  },
] as const;

const personaIds = new Set<string>(
  COMPUTER_PERSONA_CATALOG.map((persona) => persona.id),
);

const personaSummaryMap = new Map<ComputerPersonaId, ComputerPersonaSummary>(
  COMPUTER_PERSONA_CATALOG.map((persona) => [persona.id, persona]),
);

export const isComputerPersonaId = (
  value: string,
): value is ComputerPersonaId => {
  return personaIds.has(value);
};

export const getComputerPersonaSummaryById = (
  personaId?: string | null,
): ComputerPersonaSummary | undefined => {
  if (!personaId || !isComputerPersonaId(personaId)) {
    return undefined;
  }

  return personaSummaryMap.get(personaId);
};
