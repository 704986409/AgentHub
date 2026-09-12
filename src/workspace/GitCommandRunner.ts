import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process';

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly acceptedExitCodes?: readonly number[];
}

export interface GitCommandRunnerLike {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export type GitCommandErrorCode =
  | 'GIT_COMMAND_UNAVAILABLE'
  | 'GIT_COMMAND_TIMEOUT'
  | 'GIT_COMMAND_OUTPUT_LIMIT'
  | 'GIT_COMMAND_FAILED';

export class GitCommandError extends Error {
  public constructor(
    public readonly code: GitCommandErrorCode,
    public readonly operation: string,
    public readonly exitCode?: number,
  ) {
    super(gitCommandErrorMessage(code, operation, exitCode));
    this.name = 'GitCommandError';
  }
}

export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export interface GitCommandRunnerOptions {
  readonly gitExecutable?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly execFile?: GitExecFile;
}

export class GitCommandRunner implements GitCommandRunnerLike {
  readonly #gitExecutable: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #execFile: GitExecFile;

  public constructor(options: GitCommandRunnerOptions = {}) {
    this.#gitExecutable = nonBlank(options.gitExecutable ?? 'git', 'gitExecutable');
    this.#defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 30_000, 'defaultTimeoutMs');
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1024 * 1024, 'maxOutputBytes');
    this.#execFile = options.execFile ?? execFile;
  }

  public run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      return Promise.reject(new TypeError('Git arguments must be strings'));
    }
    let cwd: string;
    let timeout: number;
    let accepted: readonly number[];
    try {
      cwd = nonBlank(options.cwd, 'cwd');
      timeout = positiveInteger(options.timeoutMs ?? this.#defaultTimeoutMs, 'timeoutMs');
      accepted = options.acceptedExitCodes ?? [0];
      if (!Array.isArray(accepted) || accepted.length === 0 ||
        !accepted.every((code) => Number.isSafeInteger(code) && code >= 0)) {
        throw new TypeError('acceptedExitCodes must contain non-negative integers');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Git invocation options are invalid'));
    }
    const operation = args[0] ?? 'git';
    return new Promise((resolve, reject) => {
      this.#execFile(this.#gitExecutable, [...args], {
        cwd,
        timeout,
        maxBuffer: this.#maxOutputBytes,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      }, (error, stdoutValue, stderrValue) => {
        const stdout = String(stdoutValue);
        const stderr = String(stderrValue);
        if (error === null) {
          resolve(Object.freeze({ exitCode: 0, stdout, stderr }));
          return;
        }
        const numericCode = typeof error.code === 'number' ? error.code : undefined;
        if (numericCode !== undefined && accepted.includes(numericCode)) {
          resolve(Object.freeze({ exitCode: numericCode, stdout, stderr }));
          return;
        }
        reject(classifyCommandError(error, operation, numericCode));
      });
    });
  }
}

function classifyCommandError(
  error: ExecFileException,
  operation: string,
  exitCode: number | undefined,
): GitCommandError {
  if (error.code === 'ENOENT') return new GitCommandError('GIT_COMMAND_UNAVAILABLE', operation);
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GitCommandError('GIT_COMMAND_OUTPUT_LIMIT', operation, exitCode);
  }
  if (error.killed) {
    return new GitCommandError('GIT_COMMAND_TIMEOUT', operation, exitCode);
  }
  return new GitCommandError('GIT_COMMAND_FAILED', operation, exitCode);
}

function gitCommandErrorMessage(code: GitCommandErrorCode, operation: string, exitCode?: number): string {
  const suffix = exitCode === undefined ? '' : ` (exit ${String(exitCode)})`;
  switch (code) {
    case 'GIT_COMMAND_UNAVAILABLE': return 'Git executable is unavailable';
    case 'GIT_COMMAND_TIMEOUT': return `Git operation ${operation} timed out${suffix}`;
    case 'GIT_COMMAND_OUTPUT_LIMIT': return `Git operation ${operation} exceeded its output limit${suffix}`;
    case 'GIT_COMMAND_FAILED': return `Git operation ${operation} failed${suffix}`;
  }
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must be a non-blank string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}
