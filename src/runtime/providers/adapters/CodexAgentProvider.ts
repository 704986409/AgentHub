import type { AgentRuntimeContext } from '../../../events/agent-runtime-events.js';
import type { EventBus } from '../../../events/event-bus.js';
import { CodexManagerUseCase, type CodexManagerUseCaseOptions } from '../../../manager/CodexManagerUseCase.js';
import {
  CodexEventMapper,
  type CodexEventMapperOptions,
  type CodexEventSource,
} from '../../../providers/codex/CodexEventMapper.js';
import type { ManagerDirectiveTurnResult } from '../../../providers/codex/CodexManagerDirective.js';
import {
  CodexProviderStatus,
  type CodexNotificationHandler,
  type CodexProcessErrorHandler,
  type CodexProcessExitHandler,
  type CodexProtocolErrorHandler,
  type CodexProviderOptions,
  type CodexServerRequestHandler,
} from '../../../providers/codex/CodexProvider.js';
import {
  validateAgentProviderTurnRequest,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../AgentProvider.js';

export const CODEX_AGENT_PROVIDER_ID = 'codex';

export const CODEX_AGENT_PROVIDER_CAPABILITIES: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['manager-directive'] as const),
  sessionContinuation: true,
});

export type CodexAgentProviderErrorCode =
  | 'CODEX_AGENT_PROVIDER_NOT_STARTED'
  | 'CODEX_AGENT_PROVIDER_ALREADY_STARTED'
  | 'CODEX_AGENT_PROVIDER_TURN_ALREADY_ACTIVE'
  | 'CODEX_AGENT_PROVIDER_LIFECYCLE_BUSY'
  | 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED'
  | 'CODEX_AGENT_PROVIDER_SESSION_MISMATCH';

export class CodexAgentProviderError extends Error {
  public constructor(public readonly code: CodexAgentProviderErrorCode, message: string) {
    super(message);
    this.name = 'CodexAgentProviderError';
  }
}

export interface CodexManagerUseCaseLike extends CodexEventSource {
  initialize(): Promise<unknown>;
  shutdown(): Promise<void>;
  runDirectiveTurn(request: { prompt: string; timeoutMs?: number }): Promise<ManagerDirectiveTurnResult>;
  getManagerSession(): { sessionId: string } | undefined;
  getStatus(): CodexProviderStatus;
}

export interface CodexEventMapperLike {
  attach(): void;
  dispose(): void;
}

export interface CodexAgentProviderDependencies {
  readonly createUseCase?: (
    providerOptions: CodexProviderOptions,
    useCaseOptions: CodexManagerUseCaseOptions,
  ) => CodexManagerUseCaseLike;
  readonly createEventMapper?: (options: CodexEventMapperOptions) => CodexEventMapperLike;
}

export class CodexAgentProvider implements AgentProvider {
  public readonly id = CODEX_AGENT_PROVIDER_ID;
  public readonly capabilities = CODEX_AGENT_PROVIDER_CAPABILITIES;
  readonly #createUseCase: NonNullable<CodexAgentProviderDependencies['createUseCase']>;
  readonly #createEventMapper: NonNullable<CodexAgentProviderDependencies['createEventMapper']>;

  public constructor(dependencies: CodexAgentProviderDependencies = {}) {
    this.#createUseCase = dependencies.createUseCase ?? ((providerOptions, useCaseOptions) =>
      CodexManagerUseCase.create(providerOptions, useCaseOptions));
    this.#createEventMapper = dependencies.createEventMapper ?? ((options) => new CodexEventMapper(options));
  }

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    const config = validateCodexConfig(options.config);
    const useCase = this.#createUseCase(config.providerOptions, config.turnOptions);
    return new CodexAgentProviderSession(
      useCase,
      options.eventBus,
      Object.freeze({ ...options.context, provider: CODEX_AGENT_PROVIDER_ID }),
      this.#createEventMapper,
    );
  }
}

class CodexAgentProviderSession implements AgentProviderSession {
  public readonly providerId = CODEX_AGENT_PROVIDER_ID;
  public readonly capabilities = CODEX_AGENT_PROVIDER_CAPABILITIES;
  readonly #mappingSource: IsolatedCodexEventSource;
  readonly #mapper: CodexEventMapperLike;
  #started = false;
  #active = false;
  #cleanupRequired = false;
  #stopping = false;
  #startPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #activeTurnPromise: Promise<AgentProviderTurnResult> | undefined;

  public constructor(
    private readonly useCase: CodexManagerUseCaseLike,
    eventBus: EventBus,
    context: AgentRuntimeContext,
    createEventMapper: (options: CodexEventMapperOptions) => CodexEventMapperLike,
  ) {
    this.#mappingSource = new IsolatedCodexEventSource(useCase);
    this.#mapper = createEventMapper({
      eventBus,
      source: this.#mappingSource,
      context,
      resolveSessionId: () => this.useCase.getManagerSession()?.sessionId,
    });
    this.#mapper.attach();
    useCase.onProcessExit(() => {
      this.#quarantineAfterRuntimeFailure();
    });
    useCase.onProtocolError(() => this.#quarantineAfterRuntimeFailure());
    useCase.onProcessError(() => this.#quarantineAfterRuntimeFailure());
  }

  public get started(): boolean {
    return this.#started;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get sessionId(): string | undefined {
    return this.useCase.getManagerSession()?.sessionId;
  }

  public start(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return Promise.reject(lifecycleBusy('shutdown'));
    if (this.#cleanupRequired) return Promise.reject(cleanupRequired());
    if (this.#started || this.#startPromise !== undefined) {
      return Promise.reject(new CodexAgentProviderError(
        'CODEX_AGENT_PROVIDER_ALREADY_STARTED',
        'Codex agent provider session is already started',
      ));
    }
    const current = Promise.resolve().then(() => this.#performStart());
    this.#startPromise = current;
    void current.finally(() => {
      if (this.#startPromise === current) this.#startPromise = undefined;
    }).catch(() => undefined);
    return current;
  }

  public async runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    validateAgentProviderTurnRequest(request, this.capabilities);
    if (this.#shutdownPromise !== undefined) return Promise.reject(lifecycleBusy('shutdown'));
    if (this.#cleanupRequired) return Promise.reject(cleanupRequired());
    if (!this.#started) {
      return Promise.reject(new CodexAgentProviderError(
        'CODEX_AGENT_PROVIDER_NOT_STARTED',
        'Codex agent provider session is not started',
      ));
    }
    if (this.#active) {
      return Promise.reject(new CodexAgentProviderError(
        'CODEX_AGENT_PROVIDER_TURN_ALREADY_ACTIVE',
        'A Codex agent provider turn is already active',
      ));
    }
    this.#active = true;
    const current = this.#performTurn(request);
    this.#activeTurnPromise = current;
    void current.finally(() => {
      if (this.#activeTurnPromise === current) this.#activeTurnPromise = undefined;
    }).catch(() => undefined);
    return await current;
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#stopping = true;
    const current = Promise.resolve().then(() => this.#performShutdown());
    this.#shutdownPromise = current;
    void current.finally(() => {
      if (this.#shutdownPromise === current) this.#shutdownPromise = undefined;
      this.#stopping = false;
    }).catch(() => undefined);
    return current;
  }

  async #performStart(): Promise<void> {
    this.#mappingSource.takeFailure();
    try {
      await this.useCase.initialize();
      this.#throwMappingFailure();
      this.#started = true;
    } catch (error) {
      this.#started = false;
      this.#cleanupRequired = true;
      throw error;
    }
  }

  async #performTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    const startedAt = Date.now();
    try {
      this.#throwMappingFailure();
      const result = await this.useCase.runDirectiveTurn({
        prompt: request.prompt,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      this.#throwMappingFailure();
      return mapCodexResult(result, Date.now() - startedAt);
    } finally {
      this.#active = false;
    }
  }

  async #performShutdown(): Promise<void> {
    const starting = this.#startPromise;
    if (starting !== undefined) await starting.catch(() => undefined);
    const activeTurn = this.#activeTurnPromise;
    const activeSettled = activeTurn?.then(() => undefined, () => undefined);
    try {
      await this.useCase.shutdown();
    } catch (error) {
      this.#started = false;
      this.#cleanupRequired = true;
      await activeSettled;
      throw error;
    }
    await activeSettled;
    this.#started = false;
    this.#active = false;
    this.#cleanupRequired = false;
    this.#throwMappingFailure();
  }

  #throwMappingFailure(): void {
    const failure = this.#mappingSource.takeFailure();
    if (failure !== undefined) throw failure;
  }

  #quarantineAfterRuntimeFailure(): void {
    if (this.#stopping || this.useCase.getStatus() === CodexProviderStatus.STOPPING) return;
    this.#started = false;
    this.#cleanupRequired = true;
  }
}

function mapCodexResult(result: ManagerDirectiveTurnResult, durationMs: number): AgentProviderTurnResult {
  const sessionId = selectCodexSessionId(result);
  const metadata = {
    providerId: CODEX_AGENT_PROVIDER_ID,
    sessionId,
    durationMs,
  };
  if (result.directiveStatus === 'valid' || result.directiveStatus === 'repaired') {
    if (result.directive === null) throw new Error('Codex directive result is internally inconsistent');
    return {
      ...metadata,
      protocol: 'manager-directive',
      directiveStatus: result.directiveStatus,
      directive: result.directive,
    };
  }
  if (result.failure === undefined) throw new Error('Codex invalid directive result is missing failure details');
  return {
    ...metadata,
    protocol: 'manager-directive',
    directiveStatus: 'invalid',
    directive: null,
    failure: { ...result.failure },
  };
}

function selectCodexSessionId(result: ManagerDirectiveTurnResult): string {
  const initial = result.initialTurn.sessionId;
  const repair = result.repairTurn?.sessionId;
  if (result.repairTurn !== undefined &&
    (repair !== initial || result.repairTurn.threadId !== result.initialTurn.threadId)) {
    throw new CodexAgentProviderError(
      'CODEX_AGENT_PROVIDER_SESSION_MISMATCH',
      'Codex directive turns reported inconsistent session identity',
    );
  }
  return repair ?? initial;
}

class IsolatedCodexEventSource implements CodexEventSource {
  #failure: Error | undefined;

  public constructor(private readonly source: CodexEventSource) {}

  public takeFailure(): Error | undefined {
    const failure = this.#failure;
    this.#failure = undefined;
    return failure;
  }

  public onNotification(handler: CodexNotificationHandler): () => void {
    return this.source.onNotification((method, params) => this.#observe(() => handler(method, params)));
  }

  public onServerRequest(handler: CodexServerRequestHandler): () => void {
    return this.source.onServerRequest((request) => this.#observe(() => handler(request)));
  }

  public onProtocolError(handler: CodexProtocolErrorHandler): () => void {
    return this.source.onProtocolError((error) => this.#observe(() => handler(error)));
  }

  public onProcessExit(handler: CodexProcessExitHandler): () => void {
    return this.source.onProcessExit((code, signal) => this.#observe(() => handler(code, signal)));
  }

  public onProcessError(handler: CodexProcessErrorHandler): () => void {
    return this.source.onProcessError((error) => this.#observe(() => handler(error)));
  }

  #observe(callback: () => void): void {
    if (this.#failure !== undefined) return;
    try {
      callback();
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error('Codex event mapping failed', { cause: error });
    }
  }
}

interface ValidatedCodexConfig {
  providerOptions: CodexProviderOptions;
  turnOptions: CodexManagerUseCaseOptions;
}

const codexRootKeys = new Set(['providerOptions', 'turnOptions']);
const codexProviderKeys = new Set(['command', 'args', 'cwd', 'env', 'requestTimeoutMs', 'debug']);
const codexTurnKeys = new Set(['threadRequestTimeoutMs', 'turnTimeoutMs']);

function validateCodexConfig(config: Readonly<Record<string, unknown>> | undefined): ValidatedCodexConfig {
  if (config === undefined) return { providerOptions: {}, turnOptions: {} };
  rejectUnknownKeys(config, codexRootKeys, 'Codex');
  const provider = optionalRecord(config.providerOptions, 'providerOptions');
  const turn = optionalRecord(config.turnOptions, 'turnOptions');
  rejectUnknownKeys(provider, codexProviderKeys, 'Codex providerOptions');
  rejectUnknownKeys(turn, codexTurnKeys, 'Codex turnOptions');
  validateOptionalString(provider.command, 'providerOptions.command');
  validateOptionalString(provider.cwd, 'providerOptions.cwd');
  if (provider.args !== undefined && (!Array.isArray(provider.args) || !provider.args.every((item) => typeof item === 'string'))) {
    invalidCodexConfig('providerOptions.args');
  }
  if (provider.env !== undefined && !isStringRecord(provider.env)) invalidCodexConfig('providerOptions.env');
  if (provider.debug !== undefined && typeof provider.debug !== 'boolean') invalidCodexConfig('providerOptions.debug');
  validateOptionalTimeout(provider.requestTimeoutMs, 'providerOptions.requestTimeoutMs');
  validateOptionalTimeout(turn.threadRequestTimeoutMs, 'turnOptions.threadRequestTimeoutMs');
  validateOptionalTimeout(turn.turnTimeoutMs, 'turnOptions.turnTimeoutMs');
  return {
    providerOptions: { ...provider },
    turnOptions: { ...turn },
  };
}

function optionalRecord(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalidCodexConfig(key);
  return value;
}

function rejectUnknownKeys(config: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, scope: string): void {
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new TypeError(`${scope} config contains unsupported key ${key}`);
  }
}

function validateOptionalString(value: unknown, key: string): void {
  if (value !== undefined && typeof value !== 'string') invalidCodexConfig(key);
}

function validateOptionalTimeout(value: unknown, key: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) invalidCodexConfig(key);
}

function invalidCodexConfig(key: string): never {
  throw new TypeError(`Codex provider config field ${key} is invalid`);
}

function cleanupRequired(): CodexAgentProviderError {
  return new CodexAgentProviderError(
    'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED',
    'Codex agent provider session requires successful shutdown before it can be used',
  );
}

function lifecycleBusy(operation: string): CodexAgentProviderError {
  return new CodexAgentProviderError(
    'CODEX_AGENT_PROVIDER_LIFECYCLE_BUSY',
    `Codex agent provider session ${operation} is in progress`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string | undefined> {
  return isRecord(value) && Object.values(value).every((entry) => entry === undefined || typeof entry === 'string');
}
