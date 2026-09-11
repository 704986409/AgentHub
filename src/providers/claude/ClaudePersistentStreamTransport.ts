import { ClaudeJsonlParseError, ClaudeJsonlParser, type ClaudeRawMessage } from './ClaudeJsonlParser.js';
import {
  ClaudeProcessManager,
  type ClaudeProcessExit,
  type ClaudeProcessManagerOptions,
} from './ClaudeProcessManager.js';

export interface ClaudePersistentStreamTransportOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  model?: string;
  initialSessionId?: string;
  turnTimeoutMs?: number;
  stopTimeoutMs?: number;
  disableTools?: boolean;
  onRawMessage?: (message: ClaudeRawMessage) => void;
  onStderr?: (chunk: Buffer) => void;
  processFactory?: (options: ClaudeProcessManagerOptions) => ClaudeProcessManager;
}

export interface ClaudePersistentTurnRequest {
  prompt: string;
  timeoutMs?: number;
}

export interface ClaudePersistentTurnResult {
  sessionId: string;
  resultText: string;
  messageTypes: string[];
  processId: number;
  durationMs: number;
  resultSubtype?: string;
  isError: false;
}

export type ClaudePersistentErrorCode =
  | 'CLAUDE_PERSISTENT_INVALID_REQUEST'
  | 'CLAUDE_PERSISTENT_ALREADY_RUNNING'
  | 'CLAUDE_PERSISTENT_NOT_STARTED'
  | 'CLAUDE_PERSISTENT_TURN_ALREADY_ACTIVE'
  | 'CLAUDE_PERSISTENT_TURN_TIMEOUT'
  | 'CLAUDE_PERSISTENT_PROCESS_EXITED'
  | 'CLAUDE_PERSISTENT_PROCESS_FAILED'
  | 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR'
  | 'CLAUDE_PERSISTENT_DUPLICATE_RESULT'
  | 'CLAUDE_PERSISTENT_UNEXPECTED_RESULT'
  | 'CLAUDE_PERSISTENT_SESSION_ID_MISSING'
  | 'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH'
  | 'CLAUDE_PERSISTENT_TURN_FAILED'
  | 'CLAUDE_PERSISTENT_SHUTDOWN';

export class ClaudePersistentError extends Error {
  public constructor(
    public readonly code: ClaudePersistentErrorCode,
    message: string,
    public readonly exitCode?: number | null,
    public readonly signal?: NodeJS.Signals | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudePersistentError';
  }
}

type PersistentState = 'STOPPED' | 'STARTING' | 'IDLE' | 'BUSY' | 'STOPPING' | 'FAILED';

interface AssistantTextCollection {
  messageId: string | undefined;
  textParts: string[];
  textLength: number;
}

interface ActiveTurn {
  startedAt: number;
  messageTypes: string[];
  result: ClaudeRawMessage | undefined;
  assistantText: AssistantTextCollection;
  settled: boolean;
  timer: NodeJS.Timeout;
  resolve: (result: ClaudePersistentTurnResult) => void;
  reject: (error: ClaudePersistentError) => void;
}

interface RuntimeGeneration {
  manager: ClaudeProcessManager;
  parser: ClaudeJsonlParser;
  sessionId: string | undefined;
  terminal: boolean;
  failure: ClaudePersistentError | undefined;
  cleanupPromise: Promise<void> | undefined;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onError: (error: Error) => void;
  onExit: (exit: ClaudeProcessExit) => void;
}

const maxReconstructedAssistantChars = 1024 * 1024;

interface StopRuntimeResult {
  released: boolean;
  error: unknown;
}

export class ClaudePersistentStreamTransport {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #cwd: string | undefined;
  readonly #model: string | undefined;
  readonly #initialSessionId: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly #stopTimeoutMs: number | undefined;
  readonly #disableTools: boolean;
  readonly #onRawMessage: ((message: ClaudeRawMessage) => void) | undefined;
  readonly #onStderr: ((chunk: Buffer) => void) | undefined;
  readonly #processFactory: (options: ClaudeProcessManagerOptions) => ClaudeProcessManager;
  #state: PersistentState = 'STOPPED';
  #runtime: RuntimeGeneration | undefined;
  #activeTurn: ActiveTurn | undefined;
  #lastSessionId: string | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: ClaudePersistentStreamTransportOptions = {}) {
    validateOptionalText(options.initialSessionId, 'initialSessionId');
    validateOptionalText(options.model, 'model');
    this.#command = options.command ?? 'claude';
    this.#env = options.env;
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#initialSessionId = options.initialSessionId;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    validateTimeout(this.#turnTimeoutMs);
    if (options.stopTimeoutMs !== undefined) validateTimeout(options.stopTimeoutMs);
    this.#stopTimeoutMs = options.stopTimeoutMs;
    this.#disableTools = options.disableTools ?? false;
    this.#onRawMessage = options.onRawMessage;
    this.#onStderr = options.onStderr;
    this.#processFactory = options.processFactory ?? ((processOptions) => new ClaudeProcessManager(processOptions));
  }

  public get running(): boolean {
    return this.#runtime?.manager.running === true;
  }

  public get active(): boolean {
    return this.#activeTurn !== undefined;
  }

  public get processId(): number | undefined {
    return this.#runtime?.manager.pid;
  }

  public get sessionId(): string | undefined {
    return this.#runtime?.sessionId;
  }

  public get lastSessionId(): string | undefined {
    return this.#lastSessionId;
  }

  public async start(): Promise<void> {
    if (this.#runtime !== undefined || this.#state === 'STARTING' || this.#state === 'IDLE' ||
      this.#state === 'BUSY' || this.#state === 'STOPPING') {
      throw new ClaudePersistentError('CLAUDE_PERSISTENT_ALREADY_RUNNING', 'Claude persistent transport is already running');
    }
    this.#state = 'STARTING';
    let manager: ClaudeProcessManager;
    try {
      manager = this.#processFactory({
        command: this.#command,
        args: buildClaudePersistentArgs({
          ...(this.#model === undefined ? {} : { model: this.#model }),
          ...(this.#initialSessionId === undefined ? {} : { initialSessionId: this.#initialSessionId }),
          disableTools: this.#disableTools,
        }),
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        ...(this.#env === undefined ? {} : { env: this.#env }),
        ...(this.#stopTimeoutMs === undefined ? {} : { stopTimeoutMs: this.#stopTimeoutMs }),
      });
    } catch (cause) {
      this.#state = 'STOPPED';
      throw new ClaudePersistentError(
        'CLAUDE_PERSISTENT_PROCESS_FAILED',
        'Unable to create Claude persistent process',
        undefined,
        undefined,
        { cause },
      );
    }
    const runtime = this.createRuntime(manager);
    this.#runtime = runtime;
    this.attachRuntime(runtime);

    try {
      await manager.start();
      if (runtime.failure !== undefined) {
        await runtime.cleanupPromise;
        throw runtime.failure;
      }
      if (this.#runtime !== runtime || !manager.running || manager.pid === undefined) {
        throw new ClaudePersistentError('CLAUDE_PERSISTENT_PROCESS_EXITED', 'Claude persistent process exited during startup');
      }
      this.#state = 'IDLE';
    } catch (cause) {
      const error = cause instanceof ClaudePersistentError
        ? cause
        : new ClaudePersistentError(
          'CLAUDE_PERSISTENT_PROCESS_FAILED',
          'Unable to start Claude persistent process',
          undefined,
          undefined,
          { cause },
        );
      this.failRuntime(runtime, error);
      await runtime.cleanupPromise;
      throw runtime.failure ?? error;
    }
  }

  public async runTurn(request: ClaudePersistentTurnRequest): Promise<ClaudePersistentTurnResult> {
    validatePrompt(request.prompt);
    const timeoutMs = request.timeoutMs ?? this.#turnTimeoutMs;
    validateTimeout(timeoutMs);
    if (this.#activeTurn !== undefined) {
      throw new ClaudePersistentError(
        'CLAUDE_PERSISTENT_TURN_ALREADY_ACTIVE',
        'A Claude persistent turn is already active',
      );
    }
    let runtime = this.#runtime;
    if (runtime?.cleanupPromise !== undefined) {
      await runtime.cleanupPromise;
      runtime = this.#runtime;
    }
    if (runtime === undefined || this.#state !== 'IDLE' || !runtime.manager.running) {
      throw new ClaudePersistentError('CLAUDE_PERSISTENT_NOT_STARTED', 'Claude persistent transport is not running');
    }

    let resolveTurn: ((result: ClaudePersistentTurnResult) => void) | undefined;
    let rejectTurn: ((error: ClaudePersistentError) => void) | undefined;
    const resultPromise = new Promise<ClaudePersistentTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    resultPromise.catch(() => undefined);
    if (resolveTurn === undefined || rejectTurn === undefined) throw new Error('Unable to create persistent turn completion');
    const turn: ActiveTurn = {
      startedAt: Date.now(),
      messageTypes: [],
      result: undefined,
      assistantText: { messageId: undefined, textParts: [], textLength: 0 },
      settled: false,
      timer: setTimeout(() => {
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_TURN_TIMEOUT',
            `Claude persistent turn timed out after ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs),
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.#activeTurn = turn;
    this.#state = 'BUSY';

    try {
      await runtime.manager.write(encodeClaudeUserInput(request.prompt));
    } catch (cause) {
      this.failRuntime(
        runtime,
        new ClaudePersistentError(
          'CLAUDE_PERSISTENT_PROCESS_FAILED',
          'Unable to write Claude persistent turn input',
          undefined,
          undefined,
          { cause },
        ),
      );
    }
    return resultPromise;
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const runtime = this.#runtime;
    if (runtime === undefined) {
      this.#state = 'STOPPED';
      return Promise.resolve();
    }
    this.#state = 'STOPPING';
    const shutdownError = new ClaudePersistentError(
      'CLAUDE_PERSISTENT_SHUTDOWN',
      'Claude persistent transport shut down during an active turn',
    );
    if (this.#activeTurn !== undefined && runtime.failure === undefined) runtime.failure = shutdownError;
    this.#shutdownPromise = (async () => {
      try {
        const outcome = await this.stopRuntime(runtime);
        if (this.#activeTurn !== undefined) this.rejectActiveTurn(runtime.failure ?? shutdownError);
        this.#state = outcome.released ? 'STOPPED' : 'FAILED';
        if (outcome.error !== undefined || !outcome.released) {
          const cleanupError = new ClaudePersistentError(
            'CLAUDE_PERSISTENT_PROCESS_FAILED',
            outcome.error === undefined
              ? 'Claude persistent process remained running after stop completed'
              : 'Unable to stop Claude persistent process',
            undefined,
            undefined,
            outcome.error === undefined ? undefined : { cause: outcome.error },
          );
          if (!outcome.released) runtime.failure ??= cleanupError;
          throw cleanupError;
        }
      } finally {
        this.#shutdownPromise = undefined;
      }
    })();
    return this.#shutdownPromise;
  }

  private createRuntime(manager: ClaudeProcessManager): RuntimeGeneration {
    const runtime = {} as RuntimeGeneration;
    const parser = new ClaudeJsonlParser({
      onMessage: (message) => this.handleMessage(runtime, message),
      onError: (error) => {
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR',
            'Claude persistent stream-json parsing failed',
            undefined,
            undefined,
            { cause: error },
          ),
        );
      },
    });
    Object.assign(runtime, {
      manager,
      parser,
      sessionId: this.#initialSessionId,
      terminal: false,
      failure: undefined,
      cleanupPromise: undefined,
      onStdout: (chunk: Buffer) => {
        if (this.#runtime !== runtime || runtime.terminal || runtime.failure !== undefined || this.#state === 'STOPPING') {
          return;
        }
        try {
          parser.push(chunk);
        } catch (cause) {
          const parserCause = cause instanceof ClaudeJsonlParseError
            ? cause
            : new ClaudeJsonlParseError(
              'CLAUDE_JSONL_PARSER_FAILED',
              'Claude persistent JSONL parser failed while consuming stdout',
              parser.lineNumber,
              0,
              { cause },
            );
          this.failRuntime(
            runtime,
            new ClaudePersistentError(
              'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR',
              'Claude persistent stream-json parsing failed',
              undefined,
              undefined,
              { cause: parserCause },
            ),
          );
        }
      },
      onStderr: (chunk: Buffer) => notifyObserver(this.#onStderr, chunk),
      onError: (cause: Error) => {
        if (this.#state === 'STARTING') return;
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_PROCESS_FAILED',
            'Claude persistent process reported an error',
            undefined,
            undefined,
            { cause },
          ),
        );
      },
      onExit: (exit: ClaudeProcessExit) => this.handleExit(runtime, exit),
    });
    return runtime;
  }

  private attachRuntime(runtime: RuntimeGeneration): void {
    runtime.manager.on('stdout', runtime.onStdout);
    runtime.manager.on('stderr', runtime.onStderr);
    runtime.manager.on('error', runtime.onError);
    runtime.manager.on('exit', runtime.onExit);
  }

  private handleMessage(runtime: RuntimeGeneration, message: ClaudeRawMessage): void {
    if (this.#runtime !== runtime || runtime.terminal || runtime.failure !== undefined) return;
    notifyObserver(this.#onRawMessage, message);
    if ((message.type === 'system' && message.subtype === 'init') || message.type === 'result') {
      if (!this.observeSessionId(runtime, message.session_id)) return;
    }
    const turn = this.#activeTurn;
    if (turn !== undefined && typeof message.type === 'string') turn.messageTypes.push(message.type);
    if (turn !== undefined && message.type === 'user') resetAssistantText(turn.assistantText);
    if (turn !== undefined && message.type === 'assistant') collectAssistantText(turn.assistantText, message);

    if (message.type === 'result') {
      if (turn === undefined) {
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_UNEXPECTED_RESULT',
            'Claude persistent stream emitted a result outside an active turn',
          ),
        );
        return;
      }
      if (turn.result !== undefined) {
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_DUPLICATE_RESULT',
            'Claude persistent stream emitted multiple results for one turn',
          ),
        );
        return;
      }
      turn.result = message;
      if (runtime.sessionId === undefined) {
        this.failRuntime(
          runtime,
          new ClaudePersistentError(
            'CLAUDE_PERSISTENT_SESSION_ID_MISSING',
            'Claude persistent turn completed without a valid session_id',
          ),
        );
        return;
      }
      if (message.is_error === true) {
        this.failRuntime(
          runtime,
          new ClaudePersistentError('CLAUDE_PERSISTENT_TURN_FAILED', 'Claude persistent result reported an error'),
        );
        return;
      }
      setImmediate(() => setImmediate(() => this.completeTurn(runtime, turn)));
      return;
    }

    if (turn === undefined && message.type === 'assistant') {
      this.failRuntime(
        runtime,
        new ClaudePersistentError(
          'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR',
          'Claude persistent stream emitted assistant output while idle',
        ),
      );
    }
  }

  private observeSessionId(runtime: RuntimeGeneration, value: unknown): boolean {
    if (typeof value !== 'string' || value.trim().length === 0) return true;
    if (runtime.sessionId !== undefined && runtime.sessionId !== value) {
      this.failRuntime(
        runtime,
        new ClaudePersistentError(
          'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH',
          'Claude persistent stream returned a conflicting session ID',
        ),
      );
      return false;
    }
    runtime.sessionId = value;
    this.#lastSessionId = value;
    return true;
  }

  private completeTurn(runtime: RuntimeGeneration, turn: ActiveTurn): void {
    if (this.#runtime !== runtime || this.#activeTurn !== turn || runtime.failure !== undefined || turn.settled) return;
    if (!runtime.manager.running || runtime.manager.pid === undefined) {
      this.failRuntime(
        runtime,
        new ClaudePersistentError('CLAUDE_PERSISTENT_PROCESS_EXITED', 'Claude persistent process exited at turn completion'),
      );
      return;
    }
    const result = turn.result;
    const sessionId = runtime.sessionId;
    if (result === undefined || sessionId === undefined) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    this.#activeTurn = undefined;
    this.#state = 'IDLE';
    turn.resolve({
      sessionId,
      resultText: selectResultText(turn.assistantText, result),
      messageTypes: [...turn.messageTypes],
      processId: runtime.manager.pid,
      durationMs: Date.now() - turn.startedAt,
      ...(typeof result.subtype === 'string' ? { resultSubtype: result.subtype } : {}),
      isError: false,
    });
  }

  private handleExit(runtime: RuntimeGeneration, exit: ClaudeProcessExit): void {
    if (this.#runtime !== runtime || runtime.terminal) return;
    const error = runtime.failure ?? new ClaudePersistentError(
      'CLAUDE_PERSISTENT_PROCESS_EXITED',
      'Claude persistent process exited unexpectedly',
      exit.code,
      exit.signal,
    );
    runtime.failure ??= error;
    this.cleanupRuntime(runtime);
    if (this.#activeTurn !== undefined) this.rejectActiveTurn(error);
    this.#state = 'STOPPED';
  }

  private failRuntime(runtime: RuntimeGeneration, error: ClaudePersistentError): void {
    if (this.#runtime !== runtime || runtime.failure !== undefined || runtime.terminal) return;
    runtime.failure = error;
    this.#state = 'FAILED';
    if (this.#activeTurn !== undefined) clearTimeout(this.#activeTurn.timer);
    runtime.cleanupPromise = (async () => {
      const outcome = await this.stopRuntime(runtime);
      if (this.#activeTurn !== undefined) this.rejectActiveTurn(error);
      this.#state = outcome.released ? 'STOPPED' : 'FAILED';
    })();
  }

  private async stopRuntime(runtime: RuntimeGeneration): Promise<StopRuntimeResult> {
    let error: unknown;
    try {
      await runtime.manager.stop();
    } catch (cause) {
      error = cause;
    }
    if (runtime.manager.running) return { released: false, error };
    this.cleanupRuntime(runtime);
    return { released: true, error };
  }

  private rejectActiveTurn(error: ClaudePersistentError): void {
    const turn = this.#activeTurn;
    if (turn === undefined || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    this.#activeTurn = undefined;
    turn.reject(error);
  }

  private cleanupRuntime(runtime: RuntimeGeneration): void {
    if (runtime.terminal) return;
    runtime.terminal = true;
    runtime.manager.off('stdout', runtime.onStdout);
    runtime.manager.off('stderr', runtime.onStderr);
    runtime.manager.off('error', runtime.onError);
    runtime.manager.off('exit', runtime.onExit);
    try {
      runtime.parser.end();
    } catch {
      // Runtime is already terminal; cleanup cannot replace the primary outcome.
    }
    if (this.#runtime === runtime) this.#runtime = undefined;
  }
}

export function buildClaudePersistentArgs(options: {
  model?: string;
  initialSessionId?: string;
  disableTools?: boolean;
} = {}): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (options.initialSessionId !== undefined) args.push('--resume', options.initialSessionId);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.disableTools === true) args.push('--tools', '');
  return args;
}

export function encodeClaudeUserInput(prompt: string): Buffer {
  validatePrompt(prompt);
  return Buffer.from(`${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt },
  })}\n`, 'utf8');
}

// Claude Code can split one logical assistant message across frames sharing
// message.id while terminal result.result contains only an earlier fragment.
function collectAssistantText(collection: AssistantTextCollection, message: ClaudeRawMessage): void {
  const assistantMessage = asRecord(message.message);
  const messageId = nonBlankString(assistantMessage?.id);
  if (messageId === undefined) return;
  if (collection.messageId !== messageId) {
    resetAssistantText(collection);
    collection.messageId = messageId;
  }
  const content = assistantMessage?.content;
  if (!Array.isArray(content)) return;
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) continue;
    const nextLength = collection.textLength + block.text.length;
    if (nextLength > maxReconstructedAssistantChars) {
      throw new Error(`Claude reconstructed assistant text exceeds ${String(maxReconstructedAssistantChars)} characters`);
    }
    collection.textParts.push(block.text);
    collection.textLength = nextLength;
  }
}

function resetAssistantText(collection: AssistantTextCollection): void {
  collection.messageId = undefined;
  collection.textParts = [];
  collection.textLength = 0;
}

function selectResultText(collection: AssistantTextCollection, result: ClaudeRawMessage): string {
  return collection.textLength > 0
    ? collection.textParts.join('')
    : typeof result.result === 'string' ? result.result : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function validatePrompt(prompt: string): void {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ClaudePersistentError('CLAUDE_PERSISTENT_INVALID_REQUEST', 'Claude persistent prompt must not be blank');
  }
}

function validateOptionalText(value: string | undefined, name: string): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new ClaudePersistentError('CLAUDE_PERSISTENT_INVALID_REQUEST', `${name} must not be blank`);
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ClaudePersistentError(
      'CLAUDE_PERSISTENT_INVALID_REQUEST',
      'Claude persistent timeout must be a positive safe integer',
    );
  }
}

function notifyObserver<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Observers are diagnostics only and cannot affect transport state.
  }
}
