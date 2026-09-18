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
import { AntigravityStreamParser } from './AntigravityStreamParser.js';

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
}

export interface AntigravityWorkerTurnSuccess {
  readonly protocolValid: true;
  readonly workerResult: AgentHubWorkerResult;
  readonly conversationId?: string | undefined;
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
  | 'ANTIGRAVITY_WORKER_SESSION_TIMEOUT'
  | 'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED';

export class AntigravityWorkerSessionError extends Error {
  public constructor(
    public readonly code: AntigravityWorkerSessionErrorCode,
    message: string,
  ) {
    super(message);
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

  #started = false;
  #active = false;
  #cleanupRequired = false;
  #conversationId: string | undefined;
  #process: ChildProcessWithoutNullStreams | null = null;
  #executablePath: string | undefined;

  public constructor(options: AntigravityWorkerSessionOptions) {
    this.#context = options.context;
    this.#workspacePath = options.workspacePath;
    this.#config = options.config;
    this.#spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.#resultParser = options.resultParser ?? new AgentHubWorkerResultParser();
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
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
      const result = await this.#executeTurn(request.prompt, timeoutMs, startTime);
      return result;
    } catch (err) {
      this.#cleanupRequired = true;
      throw err;
    } finally {
      this.#active = false;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.#started) return;

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

    const executable = this.#executablePath ?? resolveAntigravityExecutable('agy');
    const spawnOpts: SpawnOptionsWithoutStdio = {
      shell: false,
      cwd: this.#workspacePath,
      windowsHide: true,
    };

    // If persistent process not yet spawned or dead, spawn it
    if (this.#process === null || this.#process.exitCode !== null) {
      this.#process = this.#spawnProcess(executable, args, spawnOpts);
    }

    const child = this.#process;
    const parser = new AntigravityStreamParser();
    let stderrText = '';

    const onData = (chunk: Buffer | string) => {
      parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };

    const onErr = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderrText.length < 32 * 1024) stderrText += text;
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onErr);

    // Frame to write to stdin
    const userFrame = JSON.stringify({ type: 'user_message', content: fullPrompt }) + '\n';

    try {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(userFrame);
    } catch (writeErr) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
        `Failed to write to Antigravity process stdin: ${String(writeErr)}`,
      );
    }

    const outcome = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        void (async () => {
          if (settled) return;
          settled = true;
          child.stdout.off('data', onData);
          child.stderr.off('data', onErr);
          await this.#killProcessTree(child);
          this.#process = null;
          reject(
            new AntigravityWorkerSessionError(
              'ANTIGRAVITY_WORKER_SESSION_TIMEOUT',
              `Antigravity turn timed out after ${String(timeoutMs)} ms`,
            ),
          );
        })();
      }, timeoutMs);

      const checkInterval = setInterval(() => {
        if (settled) return;
        if (parser.isTerminal) {
          settled = true;
          clearTimeout(timer);
          clearInterval(checkInterval);
          child.stdout.off('data', onData);
          child.stderr.off('data', onErr);
          resolve({ exitCode: child.exitCode });
        }
      }, 50);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(checkInterval);
        child.stdout.off('data', onData);
        child.stderr.off('data', onErr);
        this.#process = null;
        reject(err);
      });

      child.on('exit', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(checkInterval);
        child.stdout.off('data', onData);
        child.stderr.off('data', onErr);
        this.#process = null;
        resolve({ exitCode });
      });
    });

    const finishResult = parser.finish();
    const durationMs = Date.now() - startTime;

    // Verify conversation ID identity
    if (this.#conversationId === undefined) {
      if (finishResult.conversationId !== undefined) {
        this.#conversationId = finishResult.conversationId;
      }
    } else if (
      finishResult.conversationId !== undefined &&
      finishResult.conversationId !== this.#conversationId
    ) {
      throw new AntigravityWorkerSessionError(
        'ANTIGRAVITY_WORKER_SESSION_CONVERSATION_MISMATCH',
        `Antigravity conversation identity mismatch: expected ${this.#conversationId}, got ${finishResult.conversationId}`,
      );
    }

    if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      const parsedAttempt = this.#resultParser.parse(finishResult.responseText);
      if (!parsedAttempt.success) {
        throw new AntigravityWorkerSessionError(
          'ANTIGRAVITY_WORKER_SESSION_PROCESS_FAILED',
          `Antigravity process exited with code ${String(outcome.exitCode)}: ${stderrText.slice(0, 1024)}`,
        );
      }
    }

    const parsed = this.#resultParser.parse(finishResult.responseText);
    if (parsed.success) {
      return {
        protocolValid: true,
        workerResult: parsed.result,
        ...(this.#conversationId !== undefined ? { conversationId: this.#conversationId } : {}),
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
          killer.on('exit', () => resolve());
          killer.on('error', () => resolve());
          setTimeout(resolve, this.#stopTimeoutMs);
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
