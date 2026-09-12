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
  readonly env?: NodeJS.ProcessEnv;
}

export class GitCommandRunner implements GitCommandRunnerLike {
  readonly #gitExecutable: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #execFile: GitExecFile;
  readonly #env: NodeJS.ProcessEnv;

  public constructor(options: GitCommandRunnerOptions = {}) {
    const gitExecutable = options.gitExecutable;
    const defaultTimeoutMs = options.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes;
    const execFileValue = options.execFile;
    const env = options.env;
    this.#gitExecutable = nonBlank(gitExecutable ?? 'git', 'gitExecutable');
    this.#defaultTimeoutMs = positiveInteger(defaultTimeoutMs ?? 30_000, 'defaultTimeoutMs');
    this.#maxOutputBytes = positiveInteger(maxOutputBytes ?? 1024 * 1024, 'maxOutputBytes');
    this.#execFile = execFileValue ?? execFile;
    this.#env = sanitizeGitEnvironment(env ?? process.env);
  }

  public run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    if (!Array.isArray(args)) {
      return Promise.reject(new TypeError('Git arguments must be strings'));
    }
    const argsValues: unknown[] = Array.from(args as readonly unknown[]);
    if (!argsValues.every((arg) => typeof arg === 'string')) {
      return Promise.reject(new TypeError('Git arguments must be strings'));
    }
    const argsSnapshot = argsValues;
    let cwd: string;
    let timeout: number;
    let accepted: readonly number[];
    try {
      const cwdValue = options.cwd;
      const timeoutValue = options.timeoutMs;
      const acceptedValue = options.acceptedExitCodes;
      cwd = nonBlank(cwdValue, 'cwd');
      timeout = positiveInteger(timeoutValue ?? this.#defaultTimeoutMs, 'timeoutMs');
      accepted = [...(acceptedValue ?? [0])];
      if (!Array.isArray(accepted) || accepted.length === 0 ||
        !accepted.every((code) => Number.isSafeInteger(code) && code >= 0)) {
        throw new TypeError('acceptedExitCodes must contain non-negative integers');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Git invocation options are invalid'));
    }
    const operation = argsSnapshot[0] ?? 'git';
    return new Promise((resolve, reject) => {
      this.#execFile(this.#gitExecutable, argsSnapshot, {
        cwd,
        timeout,
        maxBuffer: this.#maxOutputBytes,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: { ...this.#env },
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

const gitRoutingEnvironment = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_DIFF_OPTS',
]);

function sanitizeGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!gitRoutingEnvironment.has(key.toUpperCase()) && value !== undefined) result[key] = value;
  }
  return Object.freeze(result);
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
