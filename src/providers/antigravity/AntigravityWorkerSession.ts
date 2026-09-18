import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import { buildAgentHubWorkerResultInstruction } from '../../protocol/AgentHubWorkerResultInstruction.js';
import {
  AgentHubWorkerResultParser,
  type AgentHubWorkerResultFailure,
} from '../../protocol/AgentHubWorkerResultParser.js';
import { resolveAntigravityExecutable } from './AntigravityExecutableResolver.js';
import { AntigravityStreamParseError, AntigravityStreamParser } from './AntigravityStreamParser.js';

export const ANTIGRAVITY_CONVERSATION_RESUME_FLAG = '--conversation';

export interface AntigravityWorkerSessionOptions {
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

export interface AntigravityWorkerTurnSuccess {
  readonly protocolValid: true;
  readonly workerResult: AgentHubWorkerResult;
  readonly conversationId: string;
  readonly durationMs: number;
}

export interface AntigravityWorkerTurnProtocolFailure {
  readonly protocolValid: false;
  readonly kind: 'worker_result_protocol';
  readonly failure: AgentHubWorkerResultFailure;
  readonly conversationId?: string | undefined;
  readonly durationMs: number;
}

export type AntigravityWorkerTurnResult = AntigravityWorkerTurnSuccess | AntigravityWorkerTurnProtocolFailure;

export type AntigravityWorkerSessionErrorCode =
  | 'ANTIGRAVITY_WORKER_SESSION_NOT_STARTED'
  | 'ANTIGRAVITY_WORKER_SESSION_ALREADY_STARTED'
  | 'ANTIGRAVITY_WORKER_SESSION_TURN_ALREADY_ACTIVE'
  | 'ANTIGRAVITY_WORKER_SESSION_CLEANUP_REQUIRED'
  | 'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_MISMATCH'
  | 'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_ID_MISSING'
  | 'ANTIGRAVITY_WORKER_SESSION_TIMEOUT'
  | 'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED'
  | 'ANTIGRAVITY_WORKER_SESSION_PROTOCOL';

export class AntigravityWorkerSessionError extends Error {
  public constructor(
    public readonly code: AntigravityWorkerSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AntigravityWorkerSessionError';
  }
}

export class AntigravityWorkerSession {
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
  readonly #resumeFlag: string;

  #started = false;
  #active = false;
  #cleanupRequired = false;
  #conversationId: string | undefined;
  #process: ChildProcessWithoutNullStreams | null = null;
  #executablePath: string | undefined;
  #turnGeneration = 0;
  #stdoutListener: ((chunk: Buffer | string) => void) | null = null;
  #stderrListener: ((chunk: Buffer | string) => void) | null = null;
  #settleActiveTurn: ((error: Error) => void) | null = null;

  public constructor(options: AntigravityWorkerSessionOptions) {
    this.#context = options.context;
    this.#workspacePath = options.workspacePath;
    this.#config = options.config;
    this.#spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.#resultParser = options.resultParser ?? new AgentHubWorkerResultParser();
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.#streamParserOptions = options.streamParserOptions;
    const configuredFlag = typeof this.#config?.conversationResumeFlag === 'string'
      ? this.#config.conversationResumeFlag
      : ANTIGRAVITY_CONVERSATION_RESUME_FLAG;
    this.#resumeFlag = configuredFlag === '--resume' ? '--resume' : ANTIGRAVITY_CONVERSATION_RESUME_FLAG;
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
    return this.#conversationId;
  }

  public start(): Promise<void> {
    if (this.#started) {
      return Promise.reject(
        new AntigravityWorkerSessionError(
          'ANTIGRAVITY_WORKER_SESSION_ALREADY_STARTED',
          'Antigravity worker session is already started',
        ),
      );
    }

    const command = typeof this.#config?.command === 'string' ? this.#config.command : 'agy';
    this.#executablePath = resolveAntigravityExecutable(command);
    this.#started = true;
    this.#cleanupRequired = false;
    return Promise.resolve();
  }

  public async runTurn(request: { prompt: string; timeoutMs?: number }): Promise<AntigravityWorkerTurnResult> {
    if (!this.#started) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_NOT_STARTED',
        'Antigravity worker session is not started',
      );
    }
    if (this.#cleanupRequired) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_CLEANUP_REQUIRED',
        'Antigravity worker session requires cleanup before new turns',
      );
    }
    if (this.#active) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_TURN_ALREADY_ACTIVE',
        'A turn is already active on this Antigravity session',
      );
    }

    this.#active = true;
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? 300_000;

    try {
      return await this.#executeTurn(request.prompt, timeoutMs, startTime);
    } catch (err) {
      this.#cleanupRequired = true;
      throw err;
    } finally {
      this.#active = false;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.#started) return;

    this.#turnGeneration += 1;
    const settle = this.#settleActiveTurn;
    this.#settleActiveTurn = null;
    if (settle !== null) {
      settle(
        new AntigravityWorkerSessionError(
          'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
          'Antigravity worker session shut down during active turn',
        ),
      );
    }
    this.#detachListeners();
    if (this.#process !== null) {
      await this.#killProcessTree(this.#process);
      this.#process = null;
    }

    this.#started = false;
    this.#active = false;
    this.#cleanupRequired = false;
    this.#conversationId = undefined;
  }

  async #executeTurn(prompt: string, timeoutMs: number, startTime: number): Promise<AntigravityWorkerTurnResult> {
    const instruction = buildAgentHubWorkerResultInstruction();
    const fullPrompt = `${prompt}\n\n${instruction}`;

    const args: string[] = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    const model = typeof this.#config?.model === 'string' ? this.#config.model : undefined;
    if (model) args.push('--model', model);

    const ownedConversationId = this.#conversationId;
    const processAlive = this.#process !== null && this.#process.exitCode === null;
    if (!processAlive && ownedConversationId !== undefined) {
      args.push(this.#resumeFlag, ownedConversationId);
    }

    const executable = this.#executablePath ?? resolveAntigravityExecutable('agy');
    const spawnOpts: SpawnOptionsWithoutStdio = {
      shell: false,
      cwd: this.#workspacePath,
      windowsHide: true,
    };

    const generation = ++this.#turnGeneration;

    if (!processAlive) {
      this.#detachListeners();
      this.#process = this.#spawnProcess(executable, args, spawnOpts);
    }

    const child = this.#process;
    if (child === null) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
        'Antigravity process is not available',
      );
    }

    const parser = new AntigravityStreamParser(this.#streamParserOptions);
    let stderrText = '';

    const outcome = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false;

      const settleFatal = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.#settleActiveTurn = null;
        clearTimeout(timer);
        this.#detachListeners();
        if (generation === this.#turnGeneration) this.#process = null;
        reject(error);
        void this.#killProcessTree(child);
      };

      this.#settleActiveTurn = settleFatal;

      const settleOk = (value: { exitCode: number | null }): void => {
        if (settled) return;
        settled = true;
        this.#settleActiveTurn = null;
        clearTimeout(timer);
        this.#detachListeners();
        resolve(value);
      };

      const timer = setTimeout(() => {
        settleFatal(
          new AntigravityWorkerSessionError(
            'ANTIGRAVITY_WORKER_SESSION_TIMEOUT',
            `Antigravity turn timed out after ${String(timeoutMs)} ms`,
          ),
        );
      }, timeoutMs);

      const onData = (chunk: Buffer | string): void => {
        if (generation !== this.#turnGeneration) return;
        try {
          parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          if (parser.isTerminal) {
            settleOk({ exitCode: child.exitCode });
          }
        } catch (err) {
          settleFatal(this.#toProtocolError(err));
        }
      };

      const onErr = (chunk: Buffer | string): void => {
        if (generation !== this.#turnGeneration) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderrText.length < 32 * 1024) stderrText += text;
      };

      this.#stdoutListener = onData;
      this.#stderrListener = onErr;
      child.stdout.on('data', onData);
      child.stderr.on('data', onErr);

      try {
        child.stdin.setDefaultEncoding('utf8');
        child.stdin.write(`${JSON.stringify({ type: 'user_message', content: fullPrompt })}\n`);
      } catch (writeErr) {
        settleFatal(
          new AntigravityWorkerSessionError(
            'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
            `Failed to write to Antigravity process stdin: ${String(writeErr)}`,
          ),
        );
        return;
      }

      const onError = (err: Error): void => {
        if (generation !== this.#turnGeneration) return;
        child.off('exit', onExit);
        settleFatal(err);
      };
      const onExit = (exitCode: number | null): void => {
        if (generation !== this.#turnGeneration) return;
        child.off('error', onError);
        this.#process = null;
        settleOk({ exitCode });
      };
      child.once('error', onError);
      child.once('exit', onExit);
    });

    let finishResult: { conversationId?: string; responseText: string };
    try {
      finishResult = parser.finish();
    } catch (err) {
      throw this.#toProtocolError(err);
    }

    const durationMs = Date.now() - startTime;
    const returnedConversationId = finishResult.conversationId;

    if (ownedConversationId === undefined) {
      if (returnedConversationId === undefined || returnedConversationId.trim().length === 0) {
        throw new AntigravityWorkerSessionError(
          'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_ID_MISSING',
          'Antigravity first turn completed without a trusted conversation_id',
        );
      }
      this.#conversationId = returnedConversationId;
    } else if (returnedConversationId === undefined || returnedConversationId.trim().length === 0) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_ID_MISSING',
        `Antigravity resume turn completed without returning conversation_id ${ownedConversationId}`,
      );
    } else if (returnedConversationId !== ownedConversationId) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_MISMATCH',
        `Antigravity conversation identity mismatch: expected ${ownedConversationId}, got ${returnedConversationId}`,
      );
    }

    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
        `Antigravity process exited with code ${String(outcome.exitCode)}: ${stderrText.slice(0, 1024)}`,
      );
    }

    const parsed = this.#resultParser.parse(finishResult.responseText);
    if (parsed.success) {
      return {
        protocolValid: true,
        workerResult: parsed.result,
        conversationId: this.#conversationId ?? returnedConversationId,
        durationMs,
      };
    }

    return {
      protocolValid: false,
      kind: 'worker_result_protocol',
      failure: parsed.failure,
      ...(this.#conversationId !== undefined ? { conversationId: this.#conversationId } : {}),
      durationMs,
    };
  }

  #detachListeners(): void {
    const child = this.#process;
    if (child !== null && this.#stdoutListener !== null) {
      child.stdout.off('data', this.#stdoutListener);
    }
    if (child !== null && this.#stderrListener !== null) {
      child.stderr.off('data', this.#stderrListener);
    }
    this.#stdoutListener = null;
    this.#stderrListener = null;
  }

  #toProtocolError(err: unknown): AntigravityWorkerSessionError {
    if (err instanceof AntigravityWorkerSessionError) return err;
    if (err instanceof AntigravityStreamParseError) {
      return new AntigravityWorkerSessionError('ANTIGRAVITY_WORKER_SESSION_PROTOCOL', err.message, { cause: err });
    }
    return err instanceof Error
      ? new AntigravityWorkerSessionError('ANTIGRAVITY_WORKER_SESSION_PROTOCOL', err.message, { cause: err })
      : new AntigravityWorkerSessionError('ANTIGRAVITY_WORKER_SESSION_PROTOCOL', String(err));
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
        // fallback
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}
