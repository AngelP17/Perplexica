export type FailureClass =
  | 'planner_json'
  | 'tool_validation'
  | 'tool_permission'
  | 'tool_quota'
  | 'browser_selector'
  | 'browser_navigation'
  | 'python_sandbox'
  | 'retrieval_empty'
  | 'retrieval_low_confidence'
  | 'writer_grounding'
  | 'unknown';

const RULES: Array<{ match: RegExp; type: FailureClass; recovery: string }> = [
  {
    match: /json|schema|structured output/i,
    type: 'planner_json',
    recovery: 'Retry with JSON repair, lower temperature, or fallback operator mode.',
  },
  {
    match: /not available to the .* skill|required|validation/i,
    type: 'tool_validation',
    recovery: 'Repair tool args and retry the step with the same plan.',
  },
  {
    match: /allowlist|private or loopback|outside the task workspace|permission/i,
    type: 'tool_permission',
    recovery: 'Keep actions inside the sandbox, workspace, and domain policy.',
  },
  {
    match: /quota exceeded|iteration limit/i,
    type: 'tool_quota',
    recovery: 'Tighten the plan, reduce artifact size, or raise quotas explicitly.',
  },
  {
    match: /No elements found|Unable to find an element/i,
    type: 'browser_selector',
    recovery: 'Retry with a screenshot, updated selector, or visual-analysis step.',
  },
  {
    match: /navigation|SearXNG|fetch content|http|https/i,
    type: 'browser_navigation',
    recovery: 'Retry the request, change the domain, or fall back to another source.',
  },
  {
    match: /Python execution|sandbox policy|subprocess|network access is disabled/i,
    type: 'python_sandbox',
    recovery: 'Keep Python self-contained and use tool-native I/O instead of network/subprocess.',
  },
  {
    match: /could not find any relevant information|search request failed/i,
    type: 'retrieval_empty',
    recovery: 'Broaden the query, add sources, or skip answering.',
  },
  {
    match: /conflicting|low-confidence|\[\d+\?\]/i,
    type: 'retrieval_low_confidence',
    recovery: 'Prefer higher-confidence sources and hedge unsupported claims.',
  },
  {
    match: /unsupported assumption|limitation/i,
    type: 'writer_grounding',
    recovery: 'Regenerate with a smaller context and stricter citation instructions.',
  },
];

export const classifyFailure = (message: string) => {
  const normalized = message || '';
  const rule = RULES.find((candidate) => candidate.match.test(normalized));

  return {
    type: rule?.type || 'unknown',
    recovery:
      rule?.recovery || 'Inspect the trace, tighten constraints, and retry with a smaller scope.',
  };
};
