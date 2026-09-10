import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { CodexDiagnosticSink } from './CodexDiagnostics.js';

export interface CodexProcessManagerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?: CodexDiagnosticSink;
}

export interface CodexProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class CodexProcessManager extends EventEmitter {
  #process: ChildProcessWithoutNullStreams | null = null;
  readonly #options: Required<Pick<CodexProcessManagerOptions, 'command' | 'args'>> & CodexProcessManagerOptions;
  #executablePath: string | undefined;

  public constructor(options: CodexProcessManagerOptions = {}) {
    super();
    this.#options = { command: 'codex', args: ['app-server', '--listen', 'stdio://'], ...options };
  }

  public get process(): ChildProcessWithoutNullStreams | null {
    return this.#process;
  }

  public get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null && !this.#process.killed;
  }

  public get executablePath(): string | undefined {
    return this.#executablePath;
  }

  public get args(): readonly string[] {
    return this.#options.args;
  }

  public get pid(): number | undefined {
    return this.#process?.pid;
  }

  public async start(): Promise<void> {
    if (this.running) throw new Error('Codex app-server is already running');
    const executablePath = resolveCodexExecutable(this.#options.command, this.#options.env);
    const child = spawn(executablePath, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env ? { ...process.env, ...this.#options.env } : process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#executablePath = executablePath;
    this.#process = child;
    child.stdout.on('data', (chunk: Buffer) => this.emit('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk));
    child.on('error', (error: Error) => this.emit('error', error));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#options.onDiagnostic?.({
        timestamp: new Date().toISOString(),
        type: 'process-exit',
        details: { code, signal },
      });
      this.emit('exit', { code, signal } satisfies CodexProcessExit);
      this.#process = null;
    });
    this.#options.onDiagnostic?.({
      timestamp: new Date().toISOString(),
      type: 'process-started',
      details: { executablePath, args: this.#options.args, pid: child.pid },
    });
    this.emit('started', child.pid);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.assertRunning();
  }

  public assertRunning(): void {
    if (!this.running || this.#process?.pid === undefined) {
      throw new Error('Codex app-server did not remain alive after spawn');
    }
  }

  public write(data: string): void {
    if (!this.#process?.stdin.writable) throw new Error('Codex app-server stdin is not writable');
    this.#process.stdin.write(data);
  }

  public async stop(timeoutMs = 2_000): Promise<void> {
    const child = this.#process;
    if (child === null) return;
    if (child.stdin.writable) child.stdin.end();
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.forceStop();
        const forceStopTimer = setTimeout(done, 500);
        child.once('exit', () => {
          clearTimeout(forceStopTimer);
          done();
        });
      }, timeoutMs);
      child.once('exit', done);
      if (child.exitCode !== null) done();
    });
  }

  public forceStop(): void {
    const child = this.#process;
    if (child === null || child.killed) return;
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
    } else {
      child.kill();
    }
  }
}

export function resolveCodexExecutable(command = 'codex', env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return resolveExistingPath(command);

  const configuredExecutable = env.CODEX_EXECUTABLE;
  if (command === 'codex' && configuredExecutable !== undefined && configuredExecutable.trim().length > 0) {
    return resolveExistingPath(configuredExecutable);
  }

  if (process.platform === 'win32' && command === 'codex') {
    const result = spawnSync('where.exe', ['codex'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      env,
    });
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const candidate = candidates.find((line) => /\.exe$/i.test(line)) ?? candidates[0];
    if (candidate !== undefined) return resolveExistingPath(candidate);
  }

  return command;
}

function resolveExistingPath(candidate: string): string {
  return existsSync(candidate) ? realpathSync(candidate) : candidate;
}
