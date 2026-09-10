import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export class ClaudeExecutableResolutionError extends Error {
  public constructor(
    public readonly code: 'EXECUTABLE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeExecutableResolutionError';
  }
}

export interface ClaudeExecutableResolverDependencies {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  findOnPath?: (command: string, env: NodeJS.ProcessEnv) => readonly string[];
}

export function resolveClaudeExecutable(
  command = 'claude',
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ClaudeExecutableResolverDependencies = {},
): string {
  const exists = dependencies.exists ?? existsSync;
  const realpath = dependencies.realpath ?? realpathSync;
  const explicitPath = isPath(command) ? command : undefined;
  if (explicitPath !== undefined) return resolveExistingPath(explicitPath, exists, realpath, 'Explicit Claude executable');

  const configured = command === 'claude' ? env.CLAUDE_EXECUTABLE?.trim() : undefined;
  if (configured !== undefined && configured.length > 0) {
    return resolveExistingPath(configured, exists, realpath, 'CLAUDE_EXECUTABLE');
  }

  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    const findOnPath = dependencies.findOnPath ?? findClaudeOnWindowsPath;
    const candidates = findOnPath(command, env).filter((candidate) => candidate.length > 0 && exists(candidate));
    const selected = [...candidates].sort(compareWindowsCandidates)[0];
    if (selected !== undefined) return realpath(selected);
  }

  return command;
}

function findClaudeOnWindowsPath(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  const result = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}

function compareWindowsCandidates(left: string, right: string): number {
  return windowsCandidateRank(left) - windowsCandidateRank(right);
}

function windowsCandidateRank(path: string): number {
  if (/\.exe$/iu.test(path)) return 0;
  if (/\.cmd$/iu.test(path)) return 1;
  if (/\.com$/iu.test(path)) return 2;
  if (/\.bat$/iu.test(path)) return 3;
  return 4;
}

function resolveExistingPath(
  path: string,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
  source: string,
): string {
  if (!exists(path)) {
    throw new ClaudeExecutableResolutionError('EXECUTABLE_NOT_FOUND', `${source} was not found: ${path}`);
  }
  return realpath(path);
}

function isPath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\');
}
