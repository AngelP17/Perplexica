import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export type ComputerSandboxPolicy = {
  rootDir: string;
  sandboxId: string;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
  maxFileCount: number;
  maxPythonRuntimeMs: number;
  maxPythonOutputChars: number;
  maxBrowserActions: number;
  allowBrowserDomains: string[];
  denyPrivateNetworks: boolean;
  pythonNetworkEnabled: boolean;
};

export type ComputerSandboxRuntime = {
  toolCalls: number;
  browserActions: number;
};

export type ComputerSandbox = {
  chatId: string;
  messageId: string;
  workspaceRoot: string;
  artifactsDir: string;
  policy: ComputerSandboxPolicy;
  runtime: ComputerSandboxRuntime;
  resolvePath: (targetPath?: string) => string;
  recordWrite: (targetPath: string, bytes: number) => Promise<void>;
  recordBrowserAction: () => void;
  assertBrowserUrlAllowed: (targetUrl: string) => void;
};

const DEFAULT_SANDBOX_BASE = path.join(
  process.cwd(),
  'data',
  'computer-workspaces',
);

const isPrivateHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase();

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.local') ||
    normalized === 'host.docker.internal'
  ) {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (!ipVersion) {
    return false;
  }

  if (ipVersion === 4) {
    return (
      normalized.startsWith('10.') ||
      normalized.startsWith('127.') ||
      normalized.startsWith('192.168.') ||
      normalized.startsWith('169.254.')
    );
  }

  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  );
};

const getAllowlist = () => {
  return (process.env.COMPUTER_BROWSER_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
};

const getSandboxBaseDir = () =>
  path.resolve(
    process.env.COMPUTER_WORKSPACE_DIR?.trim() || DEFAULT_SANDBOX_BASE,
  );

const getDefaultPolicy = (
  sandboxId: string,
  rootDir: string,
): ComputerSandboxPolicy => ({
  rootDir,
  sandboxId,
  maxFileBytes: Number(process.env.COMPUTER_MAX_FILE_BYTES || 256_000),
  maxWorkspaceBytes: Number(
    process.env.COMPUTER_MAX_WORKSPACE_BYTES || 2_000_000,
  ),
  maxFileCount: Number(process.env.COMPUTER_MAX_FILE_COUNT || 64),
  maxPythonRuntimeMs: Number(process.env.COMPUTER_MAX_PYTHON_MS || 15_000),
  maxPythonOutputChars: Number(
    process.env.COMPUTER_MAX_PYTHON_OUTPUT_CHARS || 12_000,
  ),
  maxBrowserActions: Number(process.env.COMPUTER_MAX_BROWSER_ACTIONS || 20),
  allowBrowserDomains: getAllowlist(),
  denyPrivateNetworks:
    process.env.COMPUTER_DENY_PRIVATE_NETWORKS?.trim() !== 'false',
  pythonNetworkEnabled: process.env.COMPUTER_PYTHON_NETWORK?.trim() === 'true',
});

const calculateWorkspaceUsage = async (workspaceRoot: string) => {
  let totalBytes = 0;
  let fileCount = 0;

  const visit = async (currentPath: string) => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      const stats = await fs.stat(fullPath);
      totalBytes += stats.size;
      fileCount += 1;
    }
  };

  await fs.mkdir(workspaceRoot, { recursive: true });
  await visit(workspaceRoot);

  return {
    totalBytes,
    fileCount,
  };
};

export const createComputerSandbox = async (input: {
  chatId: string;
  messageId: string;
}) => {
  const sandboxId = `${input.chatId}/${input.messageId}`;
  const workspaceRoot = path.join(
    getSandboxBaseDir(),
    input.chatId,
    input.messageId,
  );
  const artifactsDir = path.join(workspaceRoot, 'browser-artifacts');
  const policy = getDefaultPolicy(sandboxId, workspaceRoot);

  await fs.mkdir(artifactsDir, { recursive: true });

  const runtime: ComputerSandboxRuntime = {
    toolCalls: 0,
    browserActions: 0,
  };

  const resolvePath = (targetPath: string = '.') => {
    const resolved = path.resolve(workspaceRoot, targetPath);

    if (
      resolved !== workspaceRoot &&
      !resolved.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      throw new Error(
        `Path traversal detected. Use only paths inside the task workspace: ${workspaceRoot}`,
      );
    }

    return resolved;
  };

  const recordWrite = async (targetPath: string, bytes: number) => {
    if (bytes > policy.maxFileBytes) {
      throw new Error(
        `File quota exceeded for ${targetPath}. Max file size is ${policy.maxFileBytes} bytes.`,
      );
    }

    const usage = await calculateWorkspaceUsage(workspaceRoot);
    if (usage.fileCount > policy.maxFileCount) {
      throw new Error(
        `Workspace file quota exceeded. Max files is ${policy.maxFileCount}.`,
      );
    }

    if (usage.totalBytes > policy.maxWorkspaceBytes) {
      throw new Error(
        `Workspace size quota exceeded. Max workspace size is ${policy.maxWorkspaceBytes} bytes.`,
      );
    }
  };

  const recordBrowserAction = () => {
    runtime.browserActions += 1;

    if (runtime.browserActions > policy.maxBrowserActions) {
      throw new Error(
        `Browser action quota exceeded. Max browser actions is ${policy.maxBrowserActions}.`,
      );
    }
  };

  const assertBrowserUrlAllowed = (targetUrl: string) => {
    const parsed = new URL(targetUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Browser navigation is limited to http and https URLs.');
    }

    const hostname = parsed.hostname.toLowerCase();

    if (policy.denyPrivateNetworks && isPrivateHostname(hostname)) {
      throw new Error(
        `Navigation to private or loopback hosts is blocked by the sandbox policy: ${hostname}`,
      );
    }

    if (
      policy.allowBrowserDomains.length > 0 &&
      !policy.allowBrowserDomains.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
    ) {
      throw new Error(
        `Navigation to ${hostname} is not allowed by COMPUTER_BROWSER_ALLOWLIST.`,
      );
    }
  };

  return {
    chatId: input.chatId,
    messageId: input.messageId,
    workspaceRoot,
    artifactsDir,
    policy,
    runtime,
    resolvePath,
    recordWrite,
    recordBrowserAction,
    assertBrowserUrlAllowed,
  } as ComputerSandbox;
};
