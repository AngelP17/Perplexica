import fs from 'node:fs/promises';
import path from 'node:path';

export const BENCHMARK_ROOT = path.join(process.cwd(), 'benchmarks');
export const BENCHMARK_RESULTS_DIR = path.join(
  BENCHMARK_ROOT,
  'results',
  'latest',
);

export const ensureResultsDir = async () => {
  await fs.mkdir(BENCHMARK_RESULTS_DIR, { recursive: true });
};

export const readJson = async <T>(relativePath: string): Promise<T> => {
  const fullPath = path.join(BENCHMARK_ROOT, relativePath);
  const content = await fs.readFile(fullPath, 'utf-8');
  return JSON.parse(content) as T;
};

export const writeJsonResult = async (name: string, value: unknown) => {
  await ensureResultsDir();
  const fullPath = path.join(BENCHMARK_RESULTS_DIR, `${name}.json`);
  await fs.writeFile(fullPath, JSON.stringify(value, null, 2));
  return fullPath;
};

export const writeMarkdownResult = async (name: string, value: string) => {
  await ensureResultsDir();
  const fullPath = path.join(BENCHMARK_RESULTS_DIR, `${name}.md`);
  await fs.writeFile(fullPath, value);
  return fullPath;
};

export const toMarkdownTable = (
  headers: string[],
  rows: Array<Array<string | number>>,
) => {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const lines = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerLine, separator, ...lines].join('\n');
};
