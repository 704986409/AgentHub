import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import { buildAgentHubWorkerResultInstruction } from '../../protocol/AgentHubWorkerResultInstruction.js';
import {
  AgentHubWorkerResultParser,
  type AgentHubWorkerResultFailure,
} from '../../protocol/AgentHubWorkerResultParser.js';
import { resolveCursorExecutable } from './CursorExecutableResolver.js';
import { CursorStreamParseError, CursorStreamParser } from './CursorStreamParser.js';

export interface CursorWorkerSessionOptions {
  context: AgentRuntimeContext;
  eventBus?: EventBus | undefined;
  workspacePath?: string | undefined;
  config?: Readonly<Record<string, unknown>> | undefined;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  resultParser?: AgentHubWorkerResultParser | undefined;
  stopTimeoutMs?: number | undefined;
  streamParserOptions?: { maxLineBytes?: number; maxTotalBytes?: number } | undefined;
}

export interface CursorWorkerTurnSuccess {
  readonly protocolValid: true;
  readonly workerResult: AgentHubWorkerResult;
  readonly sessionId: string;
  readonly durationMs: number;
}

export interface CursorWorkerTurnProtocolFailure {
  readonly protocolValid: false;
  readonly kind: 'worker_result_protocol';
  readonly failure: AgentHubWorkerResultFailure;
  readonly sessionId?: string | undefined;
  readonly durationMs: number;
}

export type CursorWorkerTurnResult = CursorWorkerTurnSuccess | CursorWorkerTurnProtocolFailure;

export type CursorWorkerSessionErrorCode =
  | 'CURSOR_WORKER_SESSION_NOT_STARTED'
  | 'CURSOR_WORKER_SESSION_ALREADY_STARTED'
  | 'CURSOR_WORKER_SESSION_TURN_ALREADY_ACTIVE'
  | 'CURSOR_WORKER_SESSION_CLEANUP_REQUIRED'
  | 'CURSOR_WORKER_SESSION_SESSION_MISMATCH'
  | 'CURSOR_WORKER_SESSION_SESSION_ID_MISSING'
  | 'CURSOR_WORKER_SESSION_TIMEOUT'
  | 'CURSOR_WORKER_SESSION_PROCESS_FAILED'
  | 'CURSOR_WORKER_SESSION_PROTOCOL';

export class CursorWorkerSessionError extends Error {
  public constructor(
    public readonly code: CursorWorkerSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CursorWorkerSessionError';
  }
}

export class CursorWorkerSession {
  readonly #context: AgentRuntimeContext;
  readonly #workspacePath: string | undefined;
  readonly #config: Readonly<Record<string, unknown>> | undefined;
  readonly #spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  readonly #resultParser: AgentHubWorkerResultParser;
  readonly #stopTimeoutMs: number;
  readonly #streamParserOptions: { maxLineBytes?: number; maxTotalBytes?: number } | undefined;

  #started = false;
  #active = false;
  #cleanupRequired = false;
  #sessionId: string | undefined;
  #currentProcess: ChildProcessWithoutNullStreams | null = null;
  #executablePath: string | undefined;
  #turnGeneration = 0;
  #settleActiveTurn: ((error: Error) => void) | null = null;

  public constructor(options: CursorWorkerSessionOptions) {
    this.#context = options.context;
    this.#workspacePath = options.workspacePath;
    this.#config = options.config;
    this.#spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.#resultParser = options.resultParser ?? new AgentHubWorkerResultParser();
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.#streamParserOptions = options.streamParserOptions;
  }

  public get started(): boolean {
    return this.#started;
  }

  public get context(): AgentRuntimeContext {
    return this.#context;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public start(): Promise<void> {
    if (this.#started) {
      return Promise.reject(
        new CursorWorkerSessionError(
          'CURSOR_WORKER_SESSION_ALREADY_STARTED',
          'Cursor worker session is already started',
        ),
      );
    }

    const command = typeof this.#config?.command === 'string' ? this.#config.command : 'agent';
    this.#executablePath = resolveCursorExecutable(command);
    this.#started = true;
    this.#cleanupRequired = false;
    return Promise.resolve();
  }

  public async runTurn(request: { prompt: string; timeoutMs?: number }): Promise<CursorWorkerTurnResult> {
    if (!this.#started) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_NOT_STARTED',
        'Cursor worker session is not started',
      );
    }
    if (this.#cleanupRequired) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_CLEANUP_REQUIRED',
        'Cursor worker session requires cleanup before new turns',
      );
    }
    if (this.#active) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_TURN_ALREADY_ACTIVE',
        'A turn is already active on this Cursor session',
      );
    }

    this.#active = true;
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? 300_000;

    try {
      return await this.#executeTurnProcess(request.prompt, timeoutMs, startTime);
    } catch (err) {
      this.#cleanupRequired = true;
      throw err;
    } finally {
      this.#active = false;
      this.#currentProcess = null;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.#started) return;

    this.#turnGeneration += 1;
    const settle = this.#settleActiveTurn;
    this.#settleActiveTurn = null;
    if (settle !== null) {
      settle(
        new CursorWorkerSessionError(
          'CURSOR_WORKER_SESSION_PROCESS_FAILED',
          'Cursor worker session shut down during active turn',
        ),
      );
    }
    if (this.#currentProcess !== null) {
      await this.#killProcessTree(this.#currentProcess);
      this.#currentProcess = null;
    }

    this.#started = false;
    this.#active = false;
    this.#cleanupRequired = false;
    this.#sessionId = undefined;
  }

  async #executeTurnProcess(prompt: string, timeoutMs: number, startTime: number): Promise<CursorWorkerTurnResult> {
    const instruction = buildAgentHubWorkerResultInstruction();
    const fullPrompt = `${prompt}\n\n${instruction}`;

    const args: string[] = ['--print', '--output-format', 'stream-json'];
    const model = typeof this.#config?.model === 'string' ? this.#config.model : undefined;
    if (model) args.push('--model', model);

    const ownedSessionId = this.#sessionId;
    if (ownedSessionId !== undefined) {
      args.push('--resume', ownedSessionId);
    }

    const executable = this.#executablePath ?? resolveCursorExecutable('agent');
    const spawnOpts: SpawnOptionsWithoutStdio = {
      shell: false,
      cwd: this.#workspacePath,
      windowsHide: true,
    };

    const generation = ++this.#turnGeneration;
    const child = this.#spawnProcess(executable, args, spawnOpts);
    this.#currentProcess = child;

    const parser = new CursorStreamParser(this.#streamParserOptions);
    let stderrText = '';

    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;

      const settleFatal = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.#settleActiveTurn = null;
        clearTimeout(timer);
        reject(error);
        void this.#killProcessTree(child);
      };

      this.#settleActiveTurn = settleFatal;

      const settleOk = (value: { exitCode: number | null; signal: NodeJS.Signals | null }): void => {
        if (settled) return;
        settled = true;
        this.#settleActiveTurn = null;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        settleFatal(
          new CursorWorkerSessionError(
            'CURSOR_WORKER_SESSION_TIMEOUT',
            `Cursor process timed out after ${String(timeoutMs)} ms`,
          ),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        if (generation !== this.#turnGeneration) return;
        try {
          parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        } catch (err) {
          settleFatal(this.#toProtocolError(err));
        }
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        if (generation !== this.#turnGeneration) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderrText.length < 32 * 1024) stderrText += text;
      });

      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(fullPrompt);
      child.stdin.end();

      child.on('error', (err) => {
        if (generation !== this.#turnGeneration) return;
        settleFatal(err);
      });

      child.on('exit', (exitCode, signal) => {
        if (generation !== this.#turnGeneration) return;
        settleOk({ exitCode, signal });
      });
    });

    let finishResult: { sessionId?: string; responseText: string };
    try {
      finishResult = parser.finish();
    } catch (err) {
      throw this.#toProtocolError(err);
    }

    const durationMs = Date.now() - startTime;
    const returnedSessionId = finishResult.sessionId;

    if (ownedSessionId === undefined) {
      if (returnedSessionId === undefined || returnedSessionId.trim().length === 0) {
        throw new CursorWorkerSessionError(
          'CURSOR_WORKER_SESSION_SESSION_ID_MISSING',
          'Cursor first turn completed without a trusted session_id',
        );
      }
      this.#sessionId = returnedSessionId;
    } else if (returnedSessionId === undefined || returnedSessionId.trim().length === 0) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_SESSION_ID_MISSING',
        `Cursor resume turn completed without returning session_id ${ownedSessionId}`,
      );
    } else if (returnedSessionId !== ownedSessionId) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_SESSION_MISMATCH',
        `Cursor resumed session identity mismatch: expected ${ownedSessionId}, got ${returnedSessionId}`,
      );
    }

    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      throw new CursorWorkerSessionError(
        'CURSOR_WORKER_SESSION_PROCESS_FAILED',
        `Cursor process exited with code ${String(outcome.exitCode)}: ${stderrText.slice(0, 1024)}`,
      );
    }

    const parsed = this.#resultParser.parse(finishResult.responseText);
    if (parsed.success) {
      return {
        protocolValid: true,
        workerResult: parsed.result,
        sessionId: this.#sessionId ?? returnedSessionId,
        durationMs,
      };
    }

    return {
      protocolValid: false,
      kind: 'worker_result_protocol',
      failure: parsed.failure,
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      durationMs,
    };
  }

  #toProtocolError(err: unknown): CursorWorkerSessionError {
    if (err instanceof CursorWorkerSessionError) return err;
    if (err instanceof CursorStreamParseError) {
      return new CursorWorkerSessionError('CURSOR_WORKER_SESSION_PROTOCOL', err.message, { cause: err });
    }
    return err instanceof Error
      ? new CursorWorkerSessionError('CURSOR_WORKER_SESSION_PROTOCOL', err.message, { cause: err })
      : new CursorWorkerSessionError('CURSOR_WORKER_SESSION_PROTOCOL', String(err));
  }

  async #killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid === undefined) return;
    const pid = child.pid;

    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#stopTimeoutMs);
          killer.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          killer.on('error', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // ignore fallback
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}
