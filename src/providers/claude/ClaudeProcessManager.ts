import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { resolveClaudeExecutable } from './ClaudeExecutableResolver.js';
import { createClaudeSpawnInvocation } from './ClaudeProcessInvocation.js';

export interface ClaudeProcessManagerOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stopTimeoutMs?: number;
}

export interface ClaudeProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type ClaudeProcessErrorCode =
  | 'CLAUDE_PROCESS_ALREADY_RUNNING'
  | 'CLAUDE_PROCESS_NOT_RUNNING'
  | 'CLAUDE_STDIN_NOT_WRITABLE'
  | 'CLAUDE_PROCESS_SPAWN_FAILED'
  | 'CLAUDE_PROCESS_STOP_TIMEOUT';

export class ClaudeProcessError extends Error {
  public constructor(
    public readonly code: ClaudeProcessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeProcessError';
  }
}

type ClaudeProcessState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING';

interface Completion {
  promise: Promise<ClaudeProcessExit>;
  resolve: (exit: ClaudeProcessExit) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class ClaudeProcessManager extends EventEmitter {
  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #stopTimeoutMs: number;
  #process: ChildProcessWithoutNullStreams | null = null;
  #state: ClaudeProcessState = 'STOPPED';
  #executablePath: string | undefined;
  #completion: Completion | undefined;
  #lastExit: ClaudeProcessExit | undefined;
  #stopPromise: Promise<void> | undefined;

  public constructor(options: ClaudeProcessManagerOptions = {}) {
    super();
    this.#command = options.command ?? 'claude';
    this.#args = [...(options.args ?? [])];
    this.#cwd = options.cwd;
    this.#env = options.env ?? process.env;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.on('error', () => undefined);
  }

  public get process(): ChildProcessWithoutNullStreams | null {
    return this.#process;
  }

  public get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null &&
      (this.#state === 'STARTING' || this.#state === 'RUNNING' || this.#state === 'STOPPING');
  }

  public get pid(): number | undefined {
    return this.#process?.pid;
  }

  public get executablePath(): string | undefined {
    return this.#executablePath;
  }

  public get args(): readonly string[] {
    return [...this.#args];
  }

  public async start(): Promise<void> {
    if (this.#state !== 'STOPPED' || this.#process !== null) {
      throw new ClaudeProcessError(
        'CLAUDE_PROCESS_ALREADY_RUNNING',
        'Claude process is already running or changing lifecycle state',
      );
    }
    this.#state = 'STARTING';
    this.#lastExit = undefined;
    this.#stopPromise = undefined;
    const completion = createCompletion();
    completion.promise.catch(() => undefined);
    this.#completion = completion;

    let child: ChildProcessWithoutNullStreams;
    let executablePath: string;
    try {
      executablePath = resolveClaudeExecutable(this.#command, this.#env);
      const invocation = createClaudeSpawnInvocation(executablePath, this.#args);
      child = spawn(invocation.executable, invocation.args, {
        cwd: this.#cwd,
        env: this.#env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const error = processError('CLAUDE_PROCESS_SPAWN_FAILED', 'Unable to spawn Claude process', cause);
      this.#state = 'STOPPED';
      settleCompletionError(completion, error);
      this.emit('error', error);
      throw error;
    }

    this.#process = child;
    this.#executablePath = executablePath;
    await new Promise<void>((resolveStart, rejectStart) => {
      let startSettled = false;
      const settleStart = (error?: ClaudeProcessError): void => {
        if (startSettled) return;
        startSettled = true;
        if (error === undefined) resolveStart();
        else rejectStart(error);
      };
      child.once('spawn', () => {
        if (this.#process !== child) return;
        this.#state = 'RUNNING';
        this.emit('started', child.pid);
        settleStart();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.#process === child) this.emit('stdout', chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.#process === child) this.emit('stderr', chunk);
      });
      child.stdin.on('error', (cause: Error) => {
        if (this.#process === child) this.emit('error', processError('CLAUDE_STDIN_NOT_WRITABLE', cause.message, cause));
      });
      child.on('error', (cause: Error) => {
        if (this.#process !== child) return;
        const error = processError('CLAUDE_PROCESS_SPAWN_FAILED', cause.message, cause);
        this.emit('error', error);
        if (this.#state === 'STARTING') {
          this.#process = null;
          this.#state = 'STOPPED';
          settleCompletionError(completion, error);
          settleStart(error);
        }
      });
      child.once('close', (code, signal) => {
        if (this.#process !== child) return;
        const exit = { code, signal } satisfies ClaudeProcessExit;
        this.#process = null;
        this.#state = 'STOPPED';
        this.#lastExit = exit;
        settleCompletion(completion, exit);
        this.emit('exit', exit);
      });
    });
  }

  public async write(data: string | Buffer): Promise<void> {
    const child = this.requireWritableProcess();
    await new Promise<void>((resolve, reject) => {
      let callbackComplete = false;
      let drainComplete = true;
      let settled = false;
      const cleanup = (): void => {
        child.stdin.off('error', onError);
        child.stdin.off('drain', onDrain);
        child.off('exit', onExit);
      };
      const finish = (): void => {
        if (settled || !callbackComplete || !drainComplete) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(processError('CLAUDE_STDIN_NOT_WRITABLE', 'Claude stdin write failed', cause));
      };
      const onError = (cause: Error): void => fail(cause);
      const onDrain = (): void => {
        drainComplete = true;
        finish();
      };
      const onExit = (): void => fail(new Error('Claude process exited during stdin write'));
      child.stdin.once('error', onError);
      child.once('exit', onExit);
      try {
        const accepted = child.stdin.write(data, (error) => {
          if (error !== null && error !== undefined) {
            fail(error);
            return;
          }
          callbackComplete = true;
          finish();
        });
        if (!accepted) {
          drainComplete = false;
          child.stdin.once('drain', onDrain);
        }
      } catch (cause) {
        fail(cause);
      }
    });
  }

  public async endInput(): Promise<void> {
    const child = this.requireWritableProcess();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.stdin.off('error', onError);
        child.off('exit', onExit);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(processError('CLAUDE_STDIN_NOT_WRITABLE', 'Unable to end Claude stdin', cause));
      };
      const onError = (cause: Error): void => fail(cause);
      const onExit = (): void => fail(new Error('Claude process exited before stdin ended'));
      child.stdin.once('error', onError);
      child.once('exit', onExit);
      try {
        child.stdin.end(succeed);
      } catch (cause) {
        fail(cause);
      }
    });
  }

  public waitForExit(): Promise<ClaudeProcessExit> {
    if (this.#lastExit !== undefined) return Promise.resolve({ ...this.#lastExit });
    if (this.#completion !== undefined) return this.#completion.promise;
    return Promise.reject(new ClaudeProcessError('CLAUDE_PROCESS_NOT_RUNNING', 'Claude process has not been started'));
  }

  public stop(): Promise<void> {
    if (this.#process === null) return Promise.resolve();
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const child = this.#process;
    this.#state = 'STOPPING';
    this.#stopPromise = this.stopChild(child).finally(() => {
      this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  public forceStop(): void {
    const child = this.#process;
    if (child === null || child.exitCode !== null) return;
    this.forceStopChild(child);
  }

  private requireWritableProcess(): ChildProcessWithoutNullStreams {
    const child = this.#process;
    if (child === null || child.exitCode !== null || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new ClaudeProcessError('CLAUDE_STDIN_NOT_WRITABLE', 'Claude stdin is not writable');
    }
    return child;
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.requestTermination(child);
    if (await waitUntilSettled(this.waitForExit(), this.#stopTimeoutMs)) return;
    this.forceStopChild(child);
    if (await waitUntilSettled(this.waitForExit(), 1_000)) return;
    throw new ClaudeProcessError('CLAUDE_PROCESS_STOP_TIMEOUT', 'Claude process did not exit after forced stop');
  }

  private requestTermination(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid !== undefined) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T'], { shell: false, windowsHide: true });
      killer.on('error', () => child.kill());
      return;
    }
    child.kill('SIGTERM');
  }

  private forceStopChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid !== undefined) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
      killer.on('error', () => child.kill());
      return;
    }
    child.kill('SIGKILL');
  }
}

function createCompletion(): Completion {
  let resolvePromise: ((exit: ClaudeProcessExit) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<ClaudeProcessExit>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) throw new Error('Unable to create process completion');
  return { promise, resolve: resolvePromise, reject: rejectPromise, settled: false };
}

function settleCompletion(completion: Completion, exit: ClaudeProcessExit): void {
  if (completion.settled) return;
  completion.settled = true;
  completion.resolve(exit);
}

function settleCompletionError(completion: Completion, error: Error): void {
  if (completion.settled) return;
  completion.settled = true;
  completion.reject(error);
}

function processError(code: ClaudeProcessErrorCode, message: string, cause: unknown): ClaudeProcessError {
  return new ClaudeProcessError(code, message, { cause });
}

async function waitUntilSettled(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
