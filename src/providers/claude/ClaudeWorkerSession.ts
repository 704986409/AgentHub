import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import { buildAgentHubWorkerResultInstruction } from '../../protocol/AgentHubWorkerResultInstruction.js';
import {
  AgentHubWorkerResultParser,
  type AgentHubWorkerResultFailure,
} from '../../protocol/AgentHubWorkerResultParser.js';
import {
  ClaudeAutoError,
  ClaudeAutoTransport,
  type ClaudeAutoFallbackEvent,
  type ClaudeAutoTransportOptions,
  type ClaudeAutoTurnResult,
  type ClaudeSelectedTransport,
} from './ClaudeAutoTransport.js';
import { ClaudeEventMapper, type ClaudeExecutionObservation } from './ClaudeEventMapper.js';
import type { ClaudeRawMessage } from './ClaudeJsonlParser.js';

export interface ClaudeWorkerSessionOptions {
  eventBus: EventBus;
  context: AgentRuntimeContext;
  transportOptions?: Omit<ClaudeAutoTransportOptions, 'onRawMessage'>;
  transportFactory?: (options: ClaudeAutoTransportOptions) => ClaudeAutoTransport;
  resultParser?: AgentHubWorkerResultParser;
  onRawMessage?: (message: ClaudeRawMessage) => void;
}

export interface ClaudeWorkerTurnRequest {
  prompt: string;
  timeoutMs?: number;
}

interface ClaudeWorkerTurnMetadata {
  transport: ClaudeSelectedTransport;
  sessionId: string;
  processId?: number;
  durationMs: number;
  resultSubtype?: string;
  fallback?: ClaudeAutoFallbackEvent;
}

export interface ClaudeWorkerTurnSuccess extends ClaudeWorkerTurnMetadata {
  protocolValid: true;
  workerResult: AgentHubWorkerResult;
}

export interface ClaudeWorkerTurnProtocolFailure extends ClaudeWorkerTurnMetadata {
  protocolValid: false;
  kind: 'worker_result_protocol';
  failure: AgentHubWorkerResultFailure;
}

export type ClaudeWorkerTurnResult = ClaudeWorkerTurnSuccess | ClaudeWorkerTurnProtocolFailure;

export type ClaudeWorkerSessionErrorCode =
  | 'CLAUDE_WORKER_SESSION_NOT_STARTED'
  | 'CLAUDE_WORKER_SESSION_ALREADY_STARTED'
  | 'CLAUDE_WORKER_SESSION_TURN_ALREADY_ACTIVE'
  | 'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY'
  | 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED'
  | 'CLAUDE_WORKER_SESSION_INVALID_REQUEST';

export class ClaudeWorkerSessionError extends Error {
  public constructor(
    public readonly code: ClaudeWorkerSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeWorkerSessionError';
  }
}

export class ClaudeWorkerSession {
  readonly #auto: ClaudeAutoTransport;
  readonly #mapper: ClaudeEventMapper;
  readonly #resultParser: AgentHubWorkerResultParser;
  #started = false;
  #cleanupRequired = false;
  #active = false;
  #startPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #activeTurnPromise: Promise<ClaudeWorkerTurnResult> | undefined;
  #rawMappingError: Error | undefined;

  public constructor(options: ClaudeWorkerSessionOptions) {
    this.#mapper = new ClaudeEventMapper({ eventBus: options.eventBus, context: options.context });
    this.#resultParser = options.resultParser ?? new AgentHubWorkerResultParser();
    const transportFactory = options.transportFactory ?? ((transportOptions) =>
      new ClaudeAutoTransport(transportOptions));
    this.#auto = transportFactory({
      ...options.transportOptions,
      onRawMessage: (message) => {
        if (this.#rawMappingError !== undefined) return;
        try {
          this.#mapper.observeRawMessage(message);
        } catch (error) {
          this.#rawMappingError = asError(error, 'Claude raw event mapping failed');
          return;
        }
        notifyRawObserver(options.onRawMessage, message);
      },
    });
  }

  public get started(): boolean {
    return this.#started;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get sessionId(): string | undefined {
    return this.#auto.sessionId;
  }

  public get selectedTransport(): ClaudeSelectedTransport | undefined {
    return this.#auto.selectedTransport;
  }

  public start(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return Promise.reject(new ClaudeWorkerSessionError(
        'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY',
        'Claude worker session shutdown is in progress',
      ));
    }
    if (this.#cleanupRequired) {
      return Promise.reject(cleanupRequiredError());
    }
    if (this.#started || this.#startPromise !== undefined) {
      return Promise.reject(new ClaudeWorkerSessionError(
        'CLAUDE_WORKER_SESSION_ALREADY_STARTED',
        'Claude worker session is already started',
      ));
    }

    const current = Promise.resolve().then(() => this.#performStart());
    this.#startPromise = current;
    void current.then(
      () => {
        if (this.#startPromise === current) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === current) this.#startPromise = undefined;
      },
    );
    return current;
  }

  public runTurn(request: ClaudeWorkerTurnRequest): Promise<ClaudeWorkerTurnResult> {
    return this.#runWorkerTurn(request);
  }

  public runRevision(request: ClaudeWorkerTurnRequest): Promise<ClaudeWorkerTurnResult> {
    return this.#runWorkerTurn(request);
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;

    const current = Promise.resolve().then(() => this.#performShutdown());
    this.#shutdownPromise = current;
    void current.then(
      () => {
        if (this.#shutdownPromise === current) this.#shutdownPromise = undefined;
      },
      () => {
        if (this.#shutdownPromise === current) this.#shutdownPromise = undefined;
      },
    );
    return current;
  }

  #runWorkerTurn(request: ClaudeWorkerTurnRequest): Promise<ClaudeWorkerTurnResult> {
    if (this.#shutdownPromise !== undefined) {
      return Promise.reject(new ClaudeWorkerSessionError(
        'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY',
        'Claude worker session shutdown is in progress',
      ));
    }
    if (this.#cleanupRequired) {
      return Promise.reject(cleanupRequiredError());
    }
    if (!this.#started) {
      return Promise.reject(new ClaudeWorkerSessionError(
        'CLAUDE_WORKER_SESSION_NOT_STARTED',
        'Claude worker session is not started',
      ));
    }
    try {
      validateRequest(request);
    } catch (error) {
      return Promise.reject(asError(error, 'Claude worker request validation failed'));
    }
    if (this.#active) {
      return Promise.reject(new ClaudeWorkerSessionError(
        'CLAUDE_WORKER_SESSION_TURN_ALREADY_ACTIVE',
        'A Claude worker session turn is already active',
      ));
    }

    this.#active = true;
    const current = Promise.resolve().then(() => this.#executeWorkerTurn(request));
    this.#activeTurnPromise = current;
    void current.then(
      () => {
        if (this.#activeTurnPromise === current) this.#activeTurnPromise = undefined;
      },
      () => {
        if (this.#activeTurnPromise === current) this.#activeTurnPromise = undefined;
      },
    );
    return current;
  }

  async #executeWorkerTurn(request: ClaudeWorkerTurnRequest): Promise<ClaudeWorkerTurnResult> {
    try {
      this.#throwRawMappingError();
      this.#mapper.observeExecutionStarted(sessionObservation(this.#auto.sessionId));
      let autoResult: ClaudeAutoTurnResult;
      try {
        autoResult = await this.#auto.runTurn({
          prompt: buildWorkerPrompt(request.prompt),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
      } catch (error) {
        this.#takeRawMappingError();
        this.#mapper.observeExecutionFailure(error, failureObservation(error, this.#auto));
        throw error;
      }

      this.#throwRawMappingError();
      const parsed = this.#resultParser.parse(autoResult.resultText);
      const metadata = resultMetadata(autoResult);
      const observation = resultObservation(autoResult);
      if (parsed.success) {
        this.#mapper.observeWorkerResult(parsed.result, observation);
        return { protocolValid: true, ...metadata, workerResult: parsed.result };
      }

      this.#mapper.observeWorkerResultFailure(parsed.failure, observation);
      return {
        protocolValid: false,
        kind: 'worker_result_protocol',
        ...metadata,
        failure: parsed.failure,
      };
    } finally {
      this.#active = false;
    }
  }

  async #performStart(): Promise<void> {
    this.#takeRawMappingError();
    try {
      await this.#auto.start();
    } catch (error) {
      this.#takeRawMappingError();
      this.#cleanupRequired = requiresCleanupAfterStartFailure(error);
      throw error;
    }

    const rawMappingError = this.#takeRawMappingError();
    if (rawMappingError === undefined) {
      this.#started = true;
      this.#cleanupRequired = false;
      return;
    }

    try {
      await this.#auto.shutdown();
    } catch (cleanupError) {
      this.#cleanupRequired = true;
      throw cleanupError;
    }
    this.#takeRawMappingError();
    this.#cleanupRequired = false;
    throw rawMappingError;
  }

  async #performShutdown(): Promise<void> {
    const start = this.#startPromise;
    if (start !== undefined) await start.catch(() => undefined);

    const activeTurn = this.#activeTurnPromise;
    const activeTurnSettled = activeTurn?.then(
      () => undefined,
      () => undefined,
    );
    await this.#auto.shutdown();
    await activeTurnSettled;
    this.#takeRawMappingError();
    this.#started = false;
    this.#cleanupRequired = false;
  }

  #takeRawMappingError(): Error | undefined {
    const error = this.#rawMappingError;
    this.#rawMappingError = undefined;
    return error;
  }

  #throwRawMappingError(): void {
    const error = this.#takeRawMappingError();
    if (error !== undefined) throw error;
  }
}

function cleanupRequiredError(): ClaudeWorkerSessionError {
  return new ClaudeWorkerSessionError(
    'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED',
    'Claude worker session requires successful shutdown before it can be used',
  );
}

function requiresCleanupAfterStartFailure(error: unknown): boolean {
  return error instanceof ClaudeAutoError && (
    error.code === 'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED'
    || error.code === 'CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED'
  );
}

function validateRequest(request: ClaudeWorkerTurnRequest): void {
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new ClaudeWorkerSessionError(
      'CLAUDE_WORKER_SESSION_INVALID_REQUEST',
      'Claude worker prompt must be a non-empty string',
    );
  }
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new ClaudeWorkerSessionError(
      'CLAUDE_WORKER_SESSION_INVALID_REQUEST',
      'Claude worker timeout must be a positive safe integer',
    );
  }
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function buildWorkerPrompt(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${buildAgentHubWorkerResultInstruction()}`;
}

function notifyRawObserver(
  observer: ((message: ClaudeRawMessage) => void) | undefined,
  message: ClaudeRawMessage,
): void {
  if (observer === undefined) return;
  try {
    observer(message);
  } catch {
    // Diagnostic observers are best-effort and must not affect worker execution.
  }
}

function sessionObservation(sessionId: string | undefined): ClaudeExecutionObservation {
  return sessionId === undefined ? {} : { sessionId };
}

function resultObservation(result: ClaudeAutoTurnResult): ClaudeExecutionObservation {
  return {
    transport: result.transport,
    sessionId: result.sessionId,
    ...(result.processId === undefined ? {} : { processId: result.processId }),
  };
}

function failureObservation(
  error: unknown,
  auto: ClaudeAutoTransport,
): ClaudeExecutionObservation {
  const errorTransport = error instanceof ClaudeAutoError ? error.transport : undefined;
  const errorSessionId = error instanceof ClaudeAutoError ? error.sessionId : undefined;
  const transport = errorTransport ?? auto.selectedTransport;
  const sessionId = errorSessionId ?? auto.sessionId;
  return {
    ...(transport === undefined ? {} : { transport }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function resultMetadata(result: ClaudeAutoTurnResult): ClaudeWorkerTurnMetadata {
  return {
    transport: result.transport,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
    ...(result.processId === undefined ? {} : { processId: result.processId }),
    ...(result.resultSubtype === undefined ? {} : { resultSubtype: result.resultSubtype }),
    ...(result.fallback === undefined ? {} : { fallback: { ...result.fallback } }),
  };
}
