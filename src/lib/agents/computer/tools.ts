import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import z from 'zod';
import { ComputerTool, FileToolResult, PythonToolResult } from './types';
import { getImageMimeType } from '@/lib/models/vision';

const execFileAsync = promisify(execFile);

const MAX_TEXT_OUTPUT_CHARS = 12_000;
const GEOCODING_TIMEOUT_MS = 5_000;
const LOCATION_TIMEZONE_ALIASES: Record<string, string> = {
  maui: 'Pacific/Honolulu',
  honolulu: 'Pacific/Honolulu',
  hawaii: 'Pacific/Honolulu',
  oahu: 'Pacific/Honolulu',
  kauai: 'Pacific/Honolulu',
  molokai: 'Pacific/Honolulu',
  lanai: 'Pacific/Honolulu',
};

export const truncateText = (
  value: string,
  maxLength: number = MAX_TEXT_OUTPUT_CHARS,
) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} characters]`;
};

export const getWorkspaceBase = () => {
  return process.env.COMPUTER_WORKSPACE_DIR?.trim() || process.cwd();
};

export const resolveWorkspacePath = (targetPath: string = '.') => {
  const workspaceBase = path.resolve(getWorkspaceBase());
  const resolvedPath = path.resolve(workspaceBase, targetPath);

  if (
    resolvedPath !== workspaceBase &&
    !resolvedPath.startsWith(`${workspaceBase}${path.sep}`)
  ) {
    throw new Error(
      `Path traversal detected. Use a relative path or an absolute path inside the workspace only: ${workspaceBase}`,
    );
  }

  return resolvedPath;
};

const formatExecError = (error: unknown): PythonToolResult => {
  const err = error as NodeJS.ErrnoException & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };

  return {
    success: false,
    error:
      err.killed || err.signal === 'SIGTERM'
        ? 'Python execution timed out after 30 seconds'
        : err.message,
    stdout: truncateText(String(err.stdout ?? '')),
    stderr: truncateText(String(err.stderr ?? '')),
    exitCode:
      typeof err.code === 'number' ? err.code : err.signal ? 1 : undefined,
    timedOut: Boolean(err.killed || err.signal === 'SIGTERM'),
  };
};

const readFileSchema = z.object({
  filepath: z.string().min(1, 'File path is required'),
});

const writeFileSchema = z.object({
  filepath: z.string().min(1, 'File path is required'),
  content: z.string(),
});

const listFilesSchema = z.object({
  directory: z.string().optional(),
});

const executePythonSchema = z.object({
  code: z.string().min(1, 'Python code is required'),
});

const currentTimeSchema = z
  .object({
    location: z.string().trim().optional(),
    timezone: z.string().trim().optional(),
  })
  .refine((value) => value.location || value.timezone, {
    message: 'Provide either a location or a timezone',
    path: ['location'],
  });

const isValidTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone,
    }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const resolveTimeZoneFromLocation = async (location: string) => {
  const normalizedLocation = location.trim().toLowerCase();
  const aliasTimeZone = LOCATION_TIMEZONE_ALIASES[normalizedLocation];

  if (aliasTimeZone) {
    return {
      label: location.trim(),
      timeZone: aliasTimeZone,
    };
  }

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', location.trim());
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, {
    signal: AbortSignal.timeout(GEOCODING_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to resolve location "${location}" (${response.status})`,
    );
  }

  const data = (await response.json()) as {
    results?: Array<{
      name?: string;
      admin1?: string;
      country?: string;
      timezone?: string;
    }>;
  };

  const match = data.results?.[0];

  if (!match?.timezone) {
    throw new Error(`Could not resolve a timezone for "${location}"`);
  }

  const label = [match.name, match.admin1, match.country]
    .filter(Boolean)
    .join(', ');

  return {
    label: label || location.trim(),
    timeZone: match.timezone,
  };
};

const currentTimeTool: ComputerTool<typeof currentTimeSchema> = {
  name: 'get_current_time',
  description:
    'Get the current local time for a location or IANA timezone. Required args: location or timezone. Examples: {"location":"Maui"} or {"timezone":"Pacific/Honolulu"}.',
  schema: currentTimeSchema,
  execute: async (params) => {
    try {
      const resolved = params.timezone?.trim()
        ? {
            label: params.location?.trim() || params.timezone.trim(),
            timeZone: params.timezone.trim(),
          }
        : await resolveTimeZoneFromLocation(params.location!.trim());

      if (!isValidTimeZone(resolved.timeZone)) {
        throw new Error(`Invalid timezone "${resolved.timeZone}"`);
      }

      const now = new Date();
      const localTime = new Intl.DateTimeFormat('en-US', {
        timeZone: resolved.timeZone,
        weekday: 'short',
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(now);

      return {
        success: true,
        data: {
          location: resolved.label,
          timezone: resolved.timeZone,
          localTime,
          unixMs: now.getTime(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const analyzeImageSchema = z.object({
  imagePath: z.string().min(1, 'Image path is required'),
  question: z.string().min(1, 'Question is required').optional(),
});

const readFileTool: ComputerTool<typeof readFileSchema> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file inside the workspace. Required args: filepath (prefer relative paths such as "notes/todo.txt"; absolute paths are allowed only when they stay under the workspace root).',
  schema: readFileSchema,
  execute: async (params): Promise<FileToolResult> => {
    try {
      const safePath = resolveWorkspacePath(params.filepath);
      const content = await fs.readFile(safePath, 'utf-8');

      return {
        success: true,
        path: safePath,
        content: truncateText(content),
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const writeFileTool: ComputerTool<typeof writeFileSchema> = {
  name: 'write_file',
  description:
    'Write UTF-8 content to a file inside the workspace, creating parent folders if needed. Required args: filepath (prefer relative paths such as "notes/todo.txt"; absolute paths are allowed only when they stay under the workspace root), content.',
  schema: writeFileSchema,
  execute: async (params): Promise<FileToolResult> => {
    try {
      const safePath = resolveWorkspacePath(params.filepath);
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, params.content, 'utf-8');

      return {
        success: true,
        path: safePath,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const listFilesTool: ComputerTool<typeof listFilesSchema> = {
  name: 'list_files',
  description:
    'List files and directories in a workspace folder. Optional arg: directory (defaults to "."). Prefer relative paths such as "." or "notes"; absolute paths are allowed only when they stay under the workspace root. Directory names end with a trailing slash.',
  schema: listFilesSchema,
  execute: async (params): Promise<FileToolResult> => {
    try {
      const safePath = resolveWorkspacePath(params.directory || '.');
      await fs.mkdir(safePath, { recursive: true });

      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const content = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .join('\n');

      return {
        success: true,
        path: safePath,
        content: content || '[empty directory]',
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

export const fileTools = {
  read_file: readFileTool,
  write_file: writeFileTool,
  list_files: listFilesTool,
};

export const utilityTools = {
  get_current_time: currentTimeTool,
};

export const createAnalyzeImageTool = (
  resolveVisionModel?: () => Promise<
    | {
        llm: {
          generateVisionText: (input: {
            messages: Array<{
              role: 'system' | 'user' | 'assistant';
              content: Array<
                | { type: 'text'; text: string }
                | { type: 'image'; imagePath: string; mimeType?: string }
              >;
            }>;
            options?: {
              temperature?: number;
              maxTokens?: number;
            };
          }) => Promise<{ content: string }>;
        };
        modelKey: string;
      }
    | null
  >,
): ComputerTool<typeof analyzeImageSchema> => ({
  name: 'analyze_image',
  description:
    'Inspect an image or screenshot with a multimodal model. Required args: imagePath, question.',
  schema: analyzeImageSchema,
  execute: async (params) => {
    try {
      if (!resolveVisionModel) {
        throw new Error(
          'No vision-model resolver is configured for computer mode.',
        );
      }

      const resolvedPath = resolveWorkspacePath(params.imagePath);
      await fs.access(resolvedPath);

      const visionModel = await resolveVisionModel();

      if (!visionModel) {
        throw new Error(
          'No vision-capable model is configured. Select a multimodal chat model or add one such as llava, qwen2.5-vl, or gpt-4o.',
        );
      }

      const response = await visionModel.llm.generateVisionText({
        messages: [
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'You are a precise visual analyst. Answer only from what is visible in the provided image and call out uncertainty when something is unclear.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  params.question?.trim() ||
                  'Describe the important visible details in this image, including page title, primary content, and any relevant links or UI state.',
              },
              {
                type: 'image',
                imagePath: resolvedPath,
                mimeType: getImageMimeType(resolvedPath),
              },
            ],
          },
        ],
        options: {
          temperature: 0.1,
          maxTokens: 700,
        },
      });

      return {
        success: true,
        path: resolvedPath,
        model: visionModel.modelKey,
        content: truncateText(response.content.trim(), 4_000),
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
});

export const pythonTool: ComputerTool<typeof executePythonSchema> = {
  name: 'execute_python',
  description:
    'Execute Python 3 code inside the workspace and capture stdout and stderr. Required args: code.',
  schema: executePythonSchema,
  execute: async (params): Promise<PythonToolResult> => {
    const workspaceBase = path.resolve(getWorkspaceBase());
    const tempFilePath = path.join(
      workspaceBase,
      `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
    );

    try {
      await fs.mkdir(workspaceBase, { recursive: true });
      await fs.writeFile(tempFilePath, params.code, 'utf-8');

      const result = await execFileAsync('python3', [tempFilePath], {
        cwd: workspaceBase,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });

      return {
        success: true,
        path: tempFilePath,
        stdout: truncateText(String(result.stdout ?? '')),
        stderr: truncateText(String(result.stderr ?? '')),
        exitCode: 0,
      };
    } catch (error) {
      return {
        path: tempFilePath,
        ...formatExecError(error),
      };
    } finally {
      await fs.unlink(tempFilePath).catch(() => undefined);
    }
  },
};
