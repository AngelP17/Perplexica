import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  readJson,
  toMarkdownTable,
  writeJsonResult,
  writeMarkdownResult,
} from './utils.ts';

type FailureClass =
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

const FAILURE_RULES: Array<{
  match: RegExp;
  type: FailureClass;
  recovery: string;
}> = [
  {
    match: /json|schema|structured output/i,
    type: 'planner_json',
    recovery:
      'Retry with JSON repair, lower temperature, or fallback operator mode.',
  },
  {
    match: /not available to the .* skill|required|validation/i,
    type: 'tool_validation',
    recovery: 'Repair tool args and retry the step with the same plan.',
  },
  {
    match:
      /allowlist|private or loopback|outside the task workspace|permission/i,
    type: 'tool_permission',
    recovery: 'Keep actions inside the sandbox, workspace, and domain policy.',
  },
  {
    match: /quota exceeded|iteration limit/i,
    type: 'tool_quota',
    recovery:
      'Tighten the plan, reduce artifact size, or raise quotas explicitly.',
  },
  {
    match: /No elements found|Unable to find an element/i,
    type: 'browser_selector',
    recovery:
      'Retry with a screenshot, updated selector, or visual-analysis step.',
  },
  {
    match: /navigation|SearXNG|fetch content|http|https/i,
    type: 'browser_navigation',
    recovery:
      'Retry the request, change the domain, or fall back to another source.',
  },
  {
    match:
      /Python execution|sandbox policy|subprocess|network access is disabled/i,
    type: 'python_sandbox',
    recovery:
      'Keep Python self-contained and use tool-native I/O instead of network/subprocess.',
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
    recovery:
      'Regenerate with a smaller context and stricter citation instructions.',
  },
];

const getTokenCount = (text: string) => Math.ceil(text.length / 4);

const classifyFailure = (message: string) => {
  const normalized = message || '';
  const rule = FAILURE_RULES.find((candidate) =>
    candidate.match.test(normalized),
  );

  return {
    type: rule?.type || 'unknown',
    recovery:
      rule?.recovery ||
      'Inspect the trace, tighten constraints, and retry with a smaller scope.',
  };
};

type AgentFixture = {
  tasks: Array<{
    id: string;
    task: string;
    expectedSignals: string[];
    interactionMode: 'computer';
  }>;
};

const parseNdjson = async (response: Response) => {
  if (!response.body) {
    throw new Error('Missing response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const messages: any[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      messages.push(JSON.parse(trimmed));
    }
  }

  if (buffered.trim()) {
    messages.push(JSON.parse(buffered.trim()));
  }

  return messages;
};

const run = async () => {
  const baseUrl = process.env.BENCHMARK_BASE_URL?.trim();
  const providerId = process.env.BENCHMARK_CHAT_PROVIDER_ID?.trim();
  const modelKey = process.env.BENCHMARK_CHAT_MODEL_KEY?.trim();

  if (!baseUrl || !providerId || !modelKey) {
    const skipped = {
      ok: true,
      skipped: true,
      reason:
        'Set BENCHMARK_BASE_URL, BENCHMARK_CHAT_PROVIDER_ID, and BENCHMARK_CHAT_MODEL_KEY to run live agent benchmarks.',
    };
    await writeJsonResult('agent-benchmark', skipped);
    await writeMarkdownResult(
      'agent-benchmark',
      `# Agent Benchmark Report\n\nLive benchmark skipped.\n\nReason: ${skipped.reason}\n`,
    );
    console.log(JSON.stringify(skipped, null, 2));
    return;
  }

  const fixture = await readJson<AgentFixture>('fixtures/agent_tasks.json');
  const rows: Array<{
    id: string;
    success: boolean;
    latencyMs: number;
    tokenUsage: number;
    failureClass: string;
  }> = [];

  for (const taskCase of fixture.tasks) {
    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const startedAt = performance.now();

    const response = await fetch(`${baseUrl}/api/computer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          chatId,
          messageId,
          content: taskCase.task,
        },
        optimizationMode: 'balanced',
        swarmEnabled: true,
        history: [],
        chatModel: {
          providerId,
          key: modelKey,
        },
        systemInstructions: '',
      }),
    });

    if (!response.ok) {
      const payload = await response
        .json()
        .catch(() => ({ message: 'Benchmark request failed' }));
      const failure = classifyFailure(
        String(payload.message || 'Request failed'),
      );
      rows.push({
        id: taskCase.id,
        success: false,
        latencyMs: performance.now() - startedAt,
        tokenUsage: getTokenCount(taskCase.task),
        failureClass: failure.type,
      });
      continue;
    }

    const events = await parseNdjson(response);
    const latencyMs = performance.now() - startedAt;
    const serialized = JSON.stringify(events);
    const success =
      events.some((event) => event.type === 'messageEnd') &&
      !events.some((event) => event.type === 'error') &&
      taskCase.expectedSignals.every((signal) =>
        serialized.toLowerCase().includes(signal.toLowerCase()),
      );

    const errorEvent = events.find((event) => event.type === 'error');
    const failure = errorEvent
      ? classifyFailure(String(errorEvent.data || 'unknown'))
      : { type: 'none', recovery: '' };

    rows.push({
      id: taskCase.id,
      success,
      latencyMs,
      tokenUsage: getTokenCount(taskCase.task) + getTokenCount(serialized),
      failureClass: success ? 'none' : failure.type,
    });
  }

  const successRate =
    rows.filter((row) => row.success).length / Math.max(rows.length, 1);
  const avgLatency =
    rows.reduce((sum, row) => sum + row.latencyMs, 0) /
    Math.max(rows.length, 1);
  const avgTokens =
    rows.reduce((sum, row) => sum + row.tokenUsage, 0) /
    Math.max(rows.length, 1);

  const markdown = `# Agent Benchmark Report

## Summary

- Success rate: ${(successRate * 100).toFixed(1)}%
- Average latency: ${avgLatency.toFixed(1)} ms
- Average token usage: ${avgTokens.toFixed(1)}

${toMarkdownTable(
  ['Task', 'Success', 'Latency ms', 'Token Usage', 'Failure Class'],
  rows.map((row) => [
    row.id,
    row.success ? 'yes' : 'no',
    row.latencyMs.toFixed(1),
    row.tokenUsage.toFixed(1),
    row.failureClass,
  ]),
)}
`;

  const jsonPath = await writeJsonResult('agent-benchmark', {
    generatedAt: new Date().toISOString(),
    successRate,
    avgLatency,
    avgTokens,
    rows,
  });
  const markdownPath = await writeMarkdownResult('agent-benchmark', markdown);

  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: false,
        successRate,
        avgLatency,
        avgTokens,
        jsonPath,
        markdownPath,
      },
      null,
      2,
    ),
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
