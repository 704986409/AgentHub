import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface CodexProcessManagerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class CodexProcessManager extends EventEmitter {
  #process: ChildProcessWithoutNullStreams | null = null;
  readonly #options: Required<Pick<CodexProcessManagerOptions, 'command' | 'args'>> & CodexProcessManagerOptions;

  public constructor(options: CodexProcessManagerOptions = {}) {
    super();
    this.#options = { command: 'codex', args: ['app-server'], ...options };
  }

  public get process(): ChildProcessWithoutNullStreams | null {
    return this.#process;
  }

  public get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null && !this.#process.killed;
  }

  public start(): void {
    if (this.running) throw new Error('Codex app-server is already running');
    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env ? { ...process.env, ...this.#options.env } : process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.stdout.on('data', (chunk: Buffer) => this.emit('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk));
    child.on('error', (error: Error) => this.emit('error', error));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit('exit', { code, signal } satisfies CodexProcessExit);
      this.#process = null;
    });
    this.emit('started', child.pid);
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
        done();
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
