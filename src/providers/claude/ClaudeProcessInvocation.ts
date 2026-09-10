import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface ClaudeSpawnInvocation {
  executable: string;
  args: string[];
}

export interface ClaudeProcessInvocationDependencies {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  realpath?: (path: string) => string;
}

export class ClaudeProcessInvocationError extends Error {
  public constructor(
    public readonly code: 'CLAUDE_CMD_TARGET_UNRESOLVED',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeProcessInvocationError';
  }
}

export function createClaudeSpawnInvocation(
  executable: string,
  args: readonly string[],
  dependencies: ClaudeProcessInvocationDependencies = {},
): ClaudeSpawnInvocation {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return { executable, args: [...args] };
  }

  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const exists = dependencies.exists ?? existsSync;
  const realpath = dependencies.realpath ?? realpathSync;
  const tokens = parseForwardingShim(readText(executable), executable);
  const target = expandShimToken(tokens[0], executable);
  if (target === undefined || !exists(target)) {
    throw new ClaudeProcessInvocationError(
      'CLAUDE_CMD_TARGET_UNRESOLVED',
      `Claude command shim target was not found: ${executable}`,
    );
  }
  const prefixArgs = tokens.slice(1).map((token) => expandShimToken(token, executable) ?? token);
  return { executable: realpath(target), args: [...prefixArgs, ...args] };
}

function parseForwardingShim(content: string, shimPath: string): string[] {
  const line = content.split(/\r?\n/u).map((candidate) => candidate.trim()).find((candidate) => /\s%\*\s*$/iu.test(candidate));
  if (line === undefined) return unresolved(shimPath);
  const prefix = line.replace(/\s+%\*\s*$/iu, '');
  const tokens: string[] = [];
  let offset = 0;
  while (offset < prefix.length) {
    while (/\s/u.test(prefix[offset] ?? '')) offset += 1;
    if (offset >= prefix.length) break;
    if (prefix[offset] !== '"') return unresolved(shimPath);
    const end = prefix.indexOf('"', offset + 1);
    if (end < 0) return unresolved(shimPath);
    tokens.push(prefix.slice(offset + 1, end));
    offset = end + 1;
  }
  if (tokens.length === 0) return unresolved(shimPath);
  return tokens;
}

function expandShimToken(token: string | undefined, shimPath: string): string | undefined {
  if (token === undefined) return undefined;
  const expanded = token.replace(/^%dp0%[\\/]?/iu, '');
  if (expanded !== token) return resolve(dirname(shimPath), expanded);
  if (isAbsolute(token)) return token;
  return token.includes('%') ? undefined : token;
}

function unresolved(shimPath: string): never {
  throw new ClaudeProcessInvocationError(
    'CLAUDE_CMD_TARGET_UNRESOLVED',
    `Claude command shim cannot be invoked without unsafe shell parsing: ${shimPath}`,
  );
}
