import type { ClaudeRawMessage } from './ClaudeJsonlParser.js';
import { ClaudeJsonlParseError, ClaudeJsonlParser } from './ClaudeJsonlParser.js';
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
  | 'CLAUDE_TURN_PROCESS_OWNERSHIP_UNRESOLVED'
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

interface ClaudeResumeOwnedProcess {
  manager: ClaudeProcessManager;
  parser: ClaudeJsonlParser;
  terminal: boolean;
  finalized: boolean;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onError: (error: Error) => void;
  onExit: (exit: ClaudeProcessExit) => void;
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
  #ownedProcess: ClaudeResumeOwnedProcess | undefined;

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

  public get running(): boolean {
    return this.#ownedProcess?.manager.running === true;
  }

  public async runTurn(request: ClaudeTurnRequest): Promise<ClaudeTurnResult> {
    validateRequest(request);
    if (this.#active) {
      throw new ClaudeTurnError('CLAUDE_TURN_ALREADY_ACTIVE', 'A Claude transport turn is already active');
    }
    if (this.#ownedProcess !== undefined) {
      if (this.#ownedProcess.manager.running) {
        throw new ClaudeTurnError(
          'CLAUDE_TURN_PROCESS_OWNERSHIP_UNRESOLVED',
          'A previous Claude turn still owns a live process',
        );
      }
      this.finalizeOwnedProcess(this.#ownedProcess);
    }
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
    this.#active = true;
    const collection: TurnCollection = { sessionIds: [], messageTypes: [], result: undefined, duplicateResult: false };
    let parseError: ClaudeJsonlParseError | undefined;
    let processError: Error | undefined;
    let terminalFailure = false;
    let rejectParserFailure: ((error: ClaudeTurnError) => void) | undefined;
    const parserFailure = new Promise<never>((_resolve, reject) => {
      rejectParserFailure = reject;
    });
    parserFailure.catch(() => undefined);
    const failOnce = (error: unknown): void => {
      if (terminalFailure) return;
      terminalFailure = true;
      parseError = error instanceof ClaudeJsonlParseError
        ? error
        : new ClaudeJsonlParseError(
          'CLAUDE_JSONL_PARSER_FAILED',
          'Claude JSONL parser failed while consuming stdout',
          parser.lineNumber,
          0,
          { cause: error },
        );
      rejectParserFailure?.(new ClaudeTurnError(
        'CLAUDE_STREAM_PROTOCOL_ERROR',
        'Claude stream-json protocol parsing failed',
        undefined,
        undefined,
        { cause: parseError },
      ));
      void processManager.stop().catch(() => undefined);
    };
    const parser = new ClaudeJsonlParser({
      onMessage: (message) => {
        collectMessage(collection, message);
        notifyObserver(this.#onRawMessage, message);
      },
      onError: failOnce,
    });
    const onStdout = (chunk: Buffer): void => {
      if (ownedProcess.terminal || terminalFailure) return;
      try {
        parser.push(chunk);
      } catch (error) {
        failOnce(error);
      }
    };
    const onStderr = (chunk: Buffer): void => {
      if (!ownedProcess.terminal) notifyObserver(this.#onStderr, chunk);
    };
    const onError = (error: Error): void => {
      if (ownedProcess.terminal) return;
      processError = error;
    };
    const onExit = (): void => this.finalizeOwnedProcess(ownedProcess);
    const ownedProcess: ClaudeResumeOwnedProcess = {
      manager: processManager,
      parser,
      terminal: false,
      finalized: false,
      onStdout,
      onStderr,
      onError,
      onExit,
    };
    this.#ownedProcess = ownedProcess;
    processManager.on('stdout', onStdout);
    processManager.on('stderr', onStderr);
    processManager.on('error', onError);
    processManager.on('exit', onExit);

    let result: ClaudeTurnResult | undefined;
    let primaryError: ClaudeTurnError | undefined;
    try {
      const { exit, processId } = await runProcessTurn(processManager, parser, timeoutMs, parserFailure);
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
      const validated = validateCollection(collection, request.sessionId);
      result = {
        sessionId: validated.sessionId,
        resultText: typeof validated.message.result === 'string' ? validated.message.result : '',
        exitCode: exit.code,
        messageTypes: [...collection.messageTypes],
        resumed,
        ...(processId === undefined ? {} : { processId }),
        durationMs: Date.now() - startedAt,
        ...(typeof validated.message.subtype === 'string' ? { resultSubtype: validated.message.subtype } : {}),
        isError: false,
      };
    } catch (error) {
      primaryError = error instanceof ClaudeTurnError
        ? error
        : new ClaudeTurnError('CLAUDE_TURN_PROCESS_FAILED', 'Claude turn process failed', undefined, undefined, {
          cause: error,
        });
    }

    ownedProcess.terminal = true;
    let cleanupError: unknown;
    try {
      await processManager.stop();
    } catch (error) {
      cleanupError = error;
    } finally {
      if (!processManager.running) this.finalizeOwnedProcess(ownedProcess);
      this.#active = false;
    }

    if (primaryError !== undefined) throw primaryError;
    if (processManager.running) {
      throw new ClaudeTurnError(
        'CLAUDE_TURN_PROCESS_OWNERSHIP_UNRESOLVED',
        'Claude turn completed but its process could not be released',
        undefined,
        undefined,
        cleanupError === undefined ? undefined : { cause: cleanupError },
      );
    }
    if (cleanupError !== undefined) {
      throw new ClaudeTurnError(
        'CLAUDE_TURN_PROCESS_FAILED',
        cleanupError instanceof Error ? cleanupError.message : 'Claude process cleanup failed',
        undefined,
        undefined,
        { cause: cleanupError },
      );
    }
    if (result === undefined) throw new ClaudeTurnError('CLAUDE_TURN_FAILED', 'Claude turn produced no result');
    return result;
  }

  public async shutdown(): Promise<void> {
    const ownedProcess = this.#ownedProcess;
    if (ownedProcess === undefined) return;
    ownedProcess.terminal = true;
    try {
      await ownedProcess.manager.stop();
    } finally {
      if (!ownedProcess.manager.running) this.finalizeOwnedProcess(ownedProcess);
    }
  }

  private finalizeOwnedProcess(ownedProcess: ClaudeResumeOwnedProcess): void {
    if (ownedProcess.finalized) return;
    ownedProcess.finalized = true;
    ownedProcess.terminal = true;
    ownedProcess.manager.off('stdout', ownedProcess.onStdout);
    ownedProcess.manager.off('stderr', ownedProcess.onStderr);
    ownedProcess.manager.off('error', ownedProcess.onError);
    ownedProcess.manager.off('exit', ownedProcess.onExit);
    ownedProcess.parser.end();
    if (this.#ownedProcess === ownedProcess) this.#ownedProcess = undefined;
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
  parserFailure: Promise<never>,
): Promise<{ exit: ClaudeProcessExit; processId?: number }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void processManager.stop().catch(() => undefined);
      reject(new ClaudeTurnError('CLAUDE_TURN_TIMEOUT', `Claude turn timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([processManager.start(), timeout, parserFailure]);
    const processId = processManager.pid;
    const exit = await Promise.race([processManager.waitForExit(), timeout, parserFailure]);
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

function notifyObserver<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Observer callbacks are diagnostic side channels and cannot affect the turn lifecycle.
  }
}
