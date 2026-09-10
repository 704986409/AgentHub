import type { ClaudeRawMessage } from './ClaudeJsonlParser.js';
import { ClaudeJsonlParser, type ClaudeJsonlParseError } from './ClaudeJsonlParser.js';
import {
  ClaudeProcessManager,
  type ClaudeProcessExit,
  type ClaudeProcessManagerOptions,
} from './ClaudeProcessManager.js';

export interface ClaudeTurnRequest {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeTurnResult {
  sessionId: string;
  resultText: string;
  exitCode: number;
  messageTypes: string[];
  resumed: boolean;
  processId?: number;
  durationMs: number;
  resultSubtype?: string;
  isError: false;
}

export type ClaudeTurnErrorCode =
  | 'CLAUDE_INVALID_TURN_REQUEST'
  | 'CLAUDE_TURN_ALREADY_ACTIVE'
  | 'CLAUDE_TURN_TIMEOUT'
  | 'CLAUDE_STREAM_PROTOCOL_ERROR'
  | 'CLAUDE_RESULT_MISSING'
  | 'CLAUDE_DUPLICATE_RESULT'
  | 'CLAUDE_SESSION_ID_MISSING'
  | 'CLAUDE_SESSION_ID_MISMATCH'
  | 'CLAUDE_TURN_PROCESS_FAILED'
  | 'CLAUDE_TURN_FAILED';

export class ClaudeTurnError extends Error {
  public constructor(
    public readonly code: ClaudeTurnErrorCode,
    message: string,
    public readonly exitCode?: number | null,
    public readonly signal?: NodeJS.Signals | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeTurnError';
  }
}

export interface ClaudeResumePerTurnTransportOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  defaultCwd?: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  disableTools?: boolean;
  onRawMessage?: (message: ClaudeRawMessage) => void;
  onStderr?: (chunk: Buffer) => void;
  processFactory?: (options: ClaudeProcessManagerOptions) => ClaudeProcessManager;
}

interface TurnCollection {
  sessionIds: string[];
  messageTypes: string[];
  result: ClaudeRawMessage | undefined;
  duplicateResult: boolean;
}

export class ClaudeResumePerTurnTransport {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #defaultCwd: string | undefined;
  readonly #defaultModel: string | undefined;
  readonly #defaultTimeoutMs: number;
  readonly #disableTools: boolean;
  readonly #onRawMessage: ((message: ClaudeRawMessage) => void) | undefined;
  readonly #onStderr: ((chunk: Buffer) => void) | undefined;
  readonly #processFactory: (options: ClaudeProcessManagerOptions) => ClaudeProcessManager;
  #active = false;
  #activeProcess: ClaudeProcessManager | undefined;

  public constructor(options: ClaudeResumePerTurnTransportOptions = {}) {
    this.#command = options.command ?? 'claude';
    this.#env = options.env;
    this.#defaultCwd = options.defaultCwd;
    this.#defaultModel = options.defaultModel;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    validateTimeout(this.#defaultTimeoutMs);
    this.#disableTools = options.disableTools ?? false;
    this.#onRawMessage = options.onRawMessage;
    this.#onStderr = options.onStderr;
    this.#processFactory = options.processFactory ?? ((processOptions) => new ClaudeProcessManager(processOptions));
  }

  public get active(): boolean {
    return this.#active;
  }

  public async runTurn(request: ClaudeTurnRequest): Promise<ClaudeTurnResult> {
    validateRequest(request);
    if (this.#active) {
      throw new ClaudeTurnError('CLAUDE_TURN_ALREADY_ACTIVE', 'A Claude transport turn is already active');
    }
    this.#active = true;
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const resumed = request.sessionId !== undefined;
    const cwd = request.cwd ?? this.#defaultCwd;
    const processManager = this.#processFactory({
      command: this.#command,
      args: buildClaudeTurnArgs(request, {
        ...(this.#defaultModel === undefined ? {} : { defaultModel: this.#defaultModel }),
        disableTools: this.#disableTools,
      }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.#env === undefined ? {} : { env: this.#env }),
    });
    this.#activeProcess = processManager;
    const collection: TurnCollection = { sessionIds: [], messageTypes: [], result: undefined, duplicateResult: false };
    let parseError: ClaudeJsonlParseError | undefined;
    let processError: Error | undefined;
    const parser = new ClaudeJsonlParser({
      onMessage: (message) => {
        collectMessage(collection, message);
        this.#onRawMessage?.(message);
      },
      onError: (error) => {
        parseError = error;
        void processManager.stop().catch(() => undefined);
      },
    });
    processManager.on('stdout', (chunk: Buffer) => parser.push(chunk));
    processManager.on('stderr', (chunk: Buffer) => this.#onStderr?.(chunk));
    processManager.on('error', (error: Error) => {
      processError = error;
    });

    try {
      const { exit, processId } = await runProcessTurn(processManager, parser, timeoutMs);
      if (parseError !== undefined) {
        throw new ClaudeTurnError(
          'CLAUDE_STREAM_PROTOCOL_ERROR',
          'Claude stream-json protocol parsing failed',
          exit.code,
          exit.signal,
          { cause: parseError },
        );
      }
      if (processError !== undefined) {
        throw new ClaudeTurnError(
          'CLAUDE_TURN_PROCESS_FAILED',
          'Claude process reported an error',
          exit.code,
          exit.signal,
          { cause: processError },
        );
      }
      if (exit.code !== 0) {
        throw new ClaudeTurnError(
          'CLAUDE_TURN_PROCESS_FAILED',
          `Claude process exited with code ${String(exit.code)}`,
          exit.code,
          exit.signal,
        );
      }
      const result = validateCollection(collection, request.sessionId);
      return {
        sessionId: result.sessionId,
        resultText: typeof result.message.result === 'string' ? result.message.result : '',
        exitCode: exit.code,
        messageTypes: [...collection.messageTypes],
        resumed,
        ...(processId === undefined ? {} : { processId }),
        durationMs: Date.now() - startedAt,
        ...(typeof result.message.subtype === 'string' ? { resultSubtype: result.message.subtype } : {}),
        isError: false,
      };
    } catch (error) {
      if (error instanceof ClaudeTurnError) throw error;
      throw new ClaudeTurnError('CLAUDE_TURN_PROCESS_FAILED', 'Claude turn process failed', undefined, undefined, {
        cause: error,
      });
    } finally {
      await processManager.stop();
      parser.end();
      this.#activeProcess = undefined;
      this.#active = false;
    }
  }

  public async shutdown(): Promise<void> {
    await this.#activeProcess?.stop();
  }
}

export function buildClaudeTurnArgs(
  request: Pick<ClaudeTurnRequest, 'prompt' | 'sessionId' | 'model'>,
  options: { defaultModel?: string; disableTools?: boolean } = {},
): string[] {
  const args = ['-p', request.prompt, '--output-format', 'stream-json', '--verbose'];
  if (request.sessionId !== undefined) args.push('--resume', request.sessionId);
  const model = request.model ?? options.defaultModel;
  if (model !== undefined) args.push('--model', model);
  if (options.disableTools === true) args.push('--tools', '');
  return args;
}

async function runProcessTurn(
  processManager: ClaudeProcessManager,
  parser: ClaudeJsonlParser,
  timeoutMs: number,
): Promise<{ exit: ClaudeProcessExit; processId?: number }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void processManager.stop().catch(() => undefined);
      reject(new ClaudeTurnError('CLAUDE_TURN_TIMEOUT', `Claude turn timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([processManager.start(), timeout]);
    const processId = processManager.pid;
    const exit = await Promise.race([processManager.waitForExit(), timeout]);
    parser.end();
    return { exit, ...(processId === undefined ? {} : { processId }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function collectMessage(collection: TurnCollection, message: ClaudeRawMessage): void {
  if (typeof message.type === 'string') collection.messageTypes.push(message.type);
  if (message.type === 'system' && message.subtype === 'init') addSessionId(collection, message.session_id);
  if (message.type === 'result') {
    if (collection.result !== undefined) collection.duplicateResult = true;
    else collection.result = message;
    addSessionId(collection, message.session_id);
  }
}

function addSessionId(collection: TurnCollection, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) collection.sessionIds.push(value);
}

function validateCollection(
  collection: TurnCollection,
  requestedSessionId: string | undefined,
): { sessionId: string; message: ClaudeRawMessage } {
  if (collection.duplicateResult) {
    throw new ClaudeTurnError('CLAUDE_DUPLICATE_RESULT', 'Claude stream contained multiple result messages');
  }
  const result = collection.result;
  if (result === undefined) throw new ClaudeTurnError('CLAUDE_RESULT_MISSING', 'Claude stream did not contain a result message');
  const uniqueSessionIds = [...new Set(collection.sessionIds)];
  if (uniqueSessionIds.length === 0) {
    throw new ClaudeTurnError('CLAUDE_SESSION_ID_MISSING', 'Claude stream did not contain a valid session_id');
  }
  if (uniqueSessionIds.length !== 1 ||
    (requestedSessionId !== undefined && uniqueSessionIds[0] !== requestedSessionId)) {
    throw new ClaudeTurnError('CLAUDE_SESSION_ID_MISMATCH', 'Claude stream returned conflicting session IDs');
  }
  if (result.is_error === true) throw new ClaudeTurnError('CLAUDE_TURN_FAILED', 'Claude result reported an error');
  const sessionId = uniqueSessionIds[0];
  if (sessionId === undefined) throw new ClaudeTurnError('CLAUDE_SESSION_ID_MISSING', 'Claude session_id is missing');
  return { sessionId, message: result };
}

function validateRequest(request: ClaudeTurnRequest): void {
  if (request.prompt.trim().length === 0) {
    throw new ClaudeTurnError('CLAUDE_INVALID_TURN_REQUEST', 'Claude turn prompt must not be blank');
  }
  if (request.sessionId !== undefined && request.sessionId.trim().length === 0) {
    throw new ClaudeTurnError('CLAUDE_INVALID_TURN_REQUEST', 'Claude sessionId must not be blank');
  }
  if (request.model !== undefined && request.model.trim().length === 0) {
    throw new ClaudeTurnError('CLAUDE_INVALID_TURN_REQUEST', 'Claude model must not be blank');
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ClaudeTurnError('CLAUDE_INVALID_TURN_REQUEST', 'Claude turn timeout must be a positive safe integer');
  }
}
