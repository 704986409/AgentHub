import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export class AntigravityExecutableResolutionError extends Error {
  public constructor(
    public readonly code: 'EXECUTABLE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'AntigravityExecutableResolutionError';
  }
}

export interface AntigravityExecutableResolverDependencies {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  findOnPath?: (command: string, env: NodeJS.ProcessEnv) => readonly string[];
}

export function resolveAntigravityExecutable(
  command = 'agy',
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AntigravityExecutableResolverDependencies = {},
): string {
  const exists = dependencies.exists ?? existsSync;
  const realpath = dependencies.realpath ?? realpathSync;
  const explicitPath = isPath(command) ? command : undefined;
  if (explicitPath !== undefined) {
    return resolveExistingPath(explicitPath, exists, realpath, 'Explicit Antigravity executable');
  }

  const configured = (env.ANTIGRAVITY_EXECUTABLE ?? env.AGY_EXECUTABLE)?.trim();
  if (configured !== undefined && configured.length > 0) {
    return resolveExistingPath(configured, exists, realpath, 'ANTIGRAVITY_EXECUTABLE');
  }

  const candidatesToTry = [command];
  const platform = dependencies.platform ?? process.platform;

  for (const cmd of candidatesToTry) {
    if (platform === 'win32') {
      const findOnPath = dependencies.findOnPath ?? findOnWindowsPath;
      const found = findOnPath(cmd, env).filter((p) => p.length > 0 && exists(p));
      const selected = [...found].sort(compareWindowsCandidates)[0];
      if (selected !== undefined) return realpath(selected);
    } else {
      const findOnPath = dependencies.findOnPath ?? findOnPosixPath;
      const found = findOnPath(cmd, env).filter((p) => p.length > 0 && exists(p));
      if (found[0] !== undefined) return realpath(found[0]);
    }
  }

  throw new AntigravityExecutableResolutionError(
    'EXECUTABLE_NOT_FOUND',
    `Antigravity executable was not found on PATH (tried ${candidatesToTry.join(', ')})`,
  );
}

function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv): readonly string[] {
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

function findOnPosixPath(command: string, env: NodeJS.ProcessEnv): readonly string[] {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    env,
    shell: false,
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
    throw new AntigravityExecutableResolutionError('EXECUTABLE_NOT_FOUND', `${source} was not found: ${path}`);
  }
  return realpath(path);
}

function isPath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\');
}
