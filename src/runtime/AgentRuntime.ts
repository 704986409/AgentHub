import type { EventBus } from '../events/event-bus.js';
import {
  AgentProviderError,
  agentOutputProtocols,
  validateAgentProviderTurnRequest,
  type AgentOutputProtocol,
  type AgentProviderCapabilities,
  type AgentProviderId,
  type AgentProviderSession,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from './providers/AgentProvider.js';
import type { AgentProviderFactory } from './providers/AgentProviderFactory.js';

export type AgentRuntimeState = 'IDLE' | 'STARTING' | 'OWNED' | 'STOPPING' | 'FAILED';

export interface AgentRuntimeIdentity {
  readonly agentId: string;
  readonly projectId?: string;
  readonly providerId: AgentProviderId;
}

export interface AgentRuntimeOptions extends AgentRuntimeIdentity {
  readonly providerFactory: AgentProviderFactory;
  readonly eventBus: EventBus;
  readonly providerConfig?: Readonly<Record<string, unknown>>;
}

export interface AgentRuntimeBinding {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly specVersion: string;
  readonly profileHash: string;
}

interface AgentRuntimeTurnSnapshot {
  readonly prompt: string;
  readonly protocol: AgentOutputProtocol;
  readonly timeoutMs?: number;
}

export type AgentRuntimeErrorCode =
  | 'AGENT_RUNTIME_INVALID_IDENTITY'
  | 'AGENT_RUNTIME_INVALID_CONFIG'
  | 'AGENT_RUNTIME_INVALID_BINDING'
  | 'AGENT_RUNTIME_ALREADY_OWNED'
  | 'AGENT_RUNTIME_NOT_OWNED'
  | 'AGENT_RUNTIME_TURN_ALREADY_ACTIVE'
  | 'AGENT_RUNTIME_LIFECYCLE_BUSY'
  | 'AGENT_RUNTIME_CLEANUP_REQUIRED'
  | 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION';

export class AgentRuntimeError extends Error {
  public constructor(public readonly code: AgentRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export class AgentRuntime {
  public readonly agentId: string;
  public readonly projectId: string | undefined;
  public readonly providerId: AgentProviderId;
  readonly #providerFactory: AgentProviderFactory;
  readonly #eventBus: EventBus;
  readonly #providerConfig: Readonly<Record<string, unknown>> | undefined;
  #state: AgentRuntimeState = 'IDLE';
  #binding: Readonly<AgentRuntimeBinding> | undefined;
  #session: AgentProviderSession | undefined;
  #sessionCapabilities: Readonly<AgentProviderCapabilities> | undefined;
  #sessionId: string | undefined;
  #active = false;
  #startPromise: Promise<void> | undefined;
  #activeTurnPromise: Promise<AgentProviderTurnResult> | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: AgentRuntimeOptions) {
    if (!isRecord(options)) validateIdentity(options);
    const agentId = options.agentId;
    const projectId = options.projectId;
    const providerId = options.providerId;
    const providerFactory = options.providerFactory;
    const eventBus = options.eventBus;
    const providerConfig = options.providerConfig;
    validateIdentity({ agentId, providerId, ...(projectId === undefined ? {} : { projectId }) });
    if (providerConfig !== undefined && !isRecord(providerConfig)) {
      throw new AgentRuntimeError(
        'AGENT_RUNTIME_INVALID_CONFIG',
        'Agent runtime provider config must be an object',
      );
    }
    this.agentId = agentId;
    this.projectId = projectId;
    this.providerId = providerId;
    this.#providerFactory = providerFactory;
    this.#eventBus = eventBus;
    this.#providerConfig = providerConfig === undefined
      ? undefined
      : Object.freeze({ ...providerConfig });
  }

  public get state(): AgentRuntimeState {
    return this.#state;
  }

  public get busy(): boolean {
    return this.#state !== 'IDLE';
  }

  public get active(): boolean {
    return this.#active;
  }

  public get binding(): Readonly<AgentRuntimeBinding> | undefined {
    return this.#binding === undefined ? undefined : Object.freeze({ ...this.#binding });
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public start(binding: AgentRuntimeBinding): Promise<void> {
    if (this.#state === 'STARTING' || this.#state === 'STOPPING') {
      return Promise.reject(lifecycleBusy(this.#state));
    }
    if (this.#state === 'OWNED') {
      return Promise.reject(new AgentRuntimeError(
        'AGENT_RUNTIME_ALREADY_OWNED',
        'Agent runtime already owns an assignment',
      ));
    }
    if (this.#state === 'FAILED') return Promise.reject(cleanupRequired());

    this.#state = 'STARTING';

    let snapshot: Readonly<AgentRuntimeBinding>;
    try {
      snapshot = snapshotBinding(binding);
    } catch (error) {
      const state = this.#currentState();
      if (state !== 'STARTING') return Promise.reject(lifecycleErrorForState(state));
      this.#state = 'IDLE';
      return rejectPreserving(error);
    }
    const reservedState = this.#currentState();
    if (reservedState !== 'STARTING') {
      return Promise.reject(lifecycleErrorForState(reservedState));
    }
    this.#binding = snapshot;

    let capabilities: Readonly<AgentProviderCapabilities>;
    try {
      const descriptor = this.#providerFactory.list().find(({ id }) => id === this.providerId);
      if (descriptor === undefined) {
        throw new AgentProviderError(
          'AGENT_PROVIDER_NOT_FOUND',
          `Agent provider ${this.providerId} is not registered`,
        );
      }
      capabilities = snapshotRuntimeCapabilities(descriptor.capabilities);
    } catch (error) {
      const state = this.#currentState();
      if (state !== 'STARTING') return Promise.reject(lifecycleErrorForState(state));
      this.#binding = undefined;
      this.#state = 'IDLE';
      return rejectPreserving(error);
    }

    let session: AgentProviderSession;
    try {
      session = this.#providerFactory.createSession(this.providerId, {
        eventBus: this.#eventBus,
        context: {
          agentId: this.agentId,
          ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
          taskId: snapshot.taskId,
          assignmentId: snapshot.assignmentId,
        },
        ...(this.#providerConfig === undefined ? {} : { config: this.#providerConfig }),
      });
    } catch (error) {
      const state = this.#currentState();
      if (state !== 'STARTING') return Promise.reject(lifecycleErrorForState(state));
      this.#binding = undefined;
      this.#state = 'IDLE';
      return rejectPreserving(error);
    }
    this.#session = session;
    this.#sessionCapabilities = capabilities;

    let lifecycle: ProviderSessionLifecycle;
    try {
      lifecycle = inspectSessionLifecycle(session);
      this.#sessionId = lifecycle.sessionId;
    } catch (error) {
      const state = this.#currentState();
      if (state !== 'STARTING') return Promise.reject(lifecycleErrorForState(state));
      this.#state = 'FAILED';
      return rejectPreserving(error);
    }
    const state = this.#currentState();
    if (state !== 'STARTING' || this.#session !== session) {
      return Promise.reject(lifecycleErrorForState(state));
    }
    if (lifecycle.started || lifecycle.active) {
      this.#state = 'FAILED';
      return Promise.reject(providerContractViolation('Provider session was not fresh and quiescent'));
    }

    const current = Promise.resolve().then(() => this.#performStart(session));
    this.#startPromise = current;
    void current.finally(() => {
      if (this.#startPromise === current) this.#startPromise = undefined;
    }).catch(() => undefined);
    return current;
  }

  public runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    if (this.#state === 'STARTING' || this.#state === 'STOPPING') {
      return Promise.reject(lifecycleBusy(this.#state));
    }
    if (this.#state === 'FAILED') return Promise.reject(cleanupRequired());
    const session = this.#session;
    if (this.#state !== 'OWNED' || session === undefined) {
      return Promise.reject(new AgentRuntimeError(
        'AGENT_RUNTIME_NOT_OWNED',
        'Agent runtime does not own an assignment',
      ));
    }
    if (this.#active) {
      return Promise.reject(new AgentRuntimeError(
        'AGENT_RUNTIME_TURN_ALREADY_ACTIVE',
        'An Agent runtime turn is already active',
      ));
    }

    this.#active = true;
    const capabilities = this.#sessionCapabilities;
    if (capabilities === undefined) {
      this.#state = 'FAILED';
      return this.#rejectTurnPreflight(
        session,
        providerContractViolation('Provider session capabilities are unavailable'),
        true,
      );
    }
    let snapshot: Readonly<AgentRuntimeTurnSnapshot>;
    try {
      snapshot = snapshotTurnRequest(request);
      validateAgentProviderTurnRequest(snapshot, capabilities);
      this.#ensureReservedTurnStillOwned(session);
    } catch (error) {
      return this.#rejectTurnPreflight(session, error);
    }

    let lifecycle: ProviderSessionLifecycle;
    try {
      lifecycle = inspectSessionLifecycle(session);
      this.#sessionId = lifecycle.sessionId;
    } catch (error) {
      const failedByPreflight = this.#currentState() === 'OWNED';
      if (failedByPreflight) this.#state = 'FAILED';
      return this.#rejectTurnPreflight(session, error, failedByPreflight);
    }
    try {
      this.#ensureReservedTurnStillOwned(session);
    } catch (error) {
      return this.#rejectTurnPreflight(session, error);
    }
    if (!lifecycle.started) {
      this.#state = 'FAILED';
      return this.#rejectTurnPreflight(
        session,
        providerContractViolation('Provider session is not started'),
        true,
      );
    }
    if (lifecycle.active) {
      this.#state = 'FAILED';
      return this.#rejectTurnPreflight(
        session,
        providerContractViolation('Provider session is already active'),
        true,
      );
    }

    const current = Promise.resolve().then(() => this.#performTurn(session, snapshot));
    this.#activeTurnPromise = current;
    void current.finally(() => {
      if (this.#activeTurnPromise === current) this.#activeTurnPromise = undefined;
    }).catch(() => undefined);
    return current;
  }

  public shutdown(): Promise<void> {
    if (this.#state === 'IDLE') return Promise.resolve();
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#state = 'STOPPING';
    const current = Promise.resolve().then(() => this.#performShutdown());
    this.#shutdownPromise = current;
    void current.finally(() => {
      if (this.#shutdownPromise === current) this.#shutdownPromise = undefined;
    }).catch(() => undefined);
    return current;
  }

  async #performStart(session: AgentProviderSession): Promise<void> {
    try {
      await session.start();
      const lifecycle = inspectSessionLifecycle(session);
      this.#sessionId = lifecycle.sessionId;
      if (!lifecycle.started || lifecycle.active) {
        throw providerContractViolation('Provider session did not start in a quiescent state');
      }
      if (this.#state === 'STARTING') this.#state = 'OWNED';
    } catch (error) {
      if (this.#state === 'STARTING') this.#state = 'FAILED';
      throw error;
    }
  }

  async #performTurn(
    session: AgentProviderSession,
    request: AgentProviderTurnRequest,
  ): Promise<AgentProviderTurnResult> {
    try {
      let result: AgentProviderTurnResult;
      try {
        result = await session.runTurn(request);
      } catch (error) {
        let lifecycle: ProviderSessionLifecycle;
        try {
          lifecycle = inspectSessionLifecycle(session);
          this.#sessionId = lifecycle.sessionId;
        } catch (inspectionError) {
          this.#markFailedUnlessStopping();
          throw inspectionError;
        }
        if (lifecycle.active) {
          this.#markFailedUnlessStopping();
          throw providerContractViolation('Provider session remained active after a rejected turn');
        }
        if (!lifecycle.started) this.#markFailedUnlessStopping();
        throw error;
      }

      let lifecycle: ProviderSessionLifecycle;
      try {
        lifecycle = inspectSessionLifecycle(session);
        this.#sessionId = lifecycle.sessionId;
      } catch (error) {
        this.#markFailedUnlessStopping();
        throw error;
      }
      if (lifecycle.active) {
        this.#markFailedUnlessStopping();
        throw providerContractViolation('Provider session remained active after a settled turn');
      }
      try {
        validateProviderResult(result, request, this.providerId, lifecycle.sessionId);
      } catch (error) {
        this.#markFailedUnlessStopping();
        throw error;
      }
      if (!lifecycle.started) this.#markFailedUnlessStopping();
      return result;
    } finally {
      this.#active = false;
    }
  }

  async #performShutdown(): Promise<void> {
    const starting = this.#startPromise;
    if (starting !== undefined) await starting.catch(() => undefined);
    const session = this.#session;
    if (session === undefined) {
      this.#sessionCapabilities = undefined;
      this.#sessionId = undefined;
      this.#binding = undefined;
      this.#state = 'IDLE';
      return;
    }
    const activeTurn = this.#activeTurnPromise;
    const activeSettled = activeTurn?.then(() => undefined, () => undefined);
    try {
      await session.shutdown();
    } catch (error) {
      this.#state = 'FAILED';
      throw error;
    }
    await activeSettled;
    let lifecycle: ProviderSessionLifecycle;
    try {
      lifecycle = inspectSessionLifecycle(session);
      this.#sessionId = lifecycle.sessionId;
    } catch (error) {
      this.#state = 'FAILED';
      throw error;
    }
    if (lifecycle.started || lifecycle.active) {
      this.#state = 'FAILED';
      throw providerContractViolation('Provider session did not become quiescent after shutdown');
    }
    this.#session = undefined;
    this.#sessionCapabilities = undefined;
    this.#sessionId = undefined;
    this.#binding = undefined;
    this.#active = false;
    this.#state = 'IDLE';
  }

  #markFailedUnlessStopping(): void {
    if (this.#state === 'OWNED') this.#state = 'FAILED';
  }

  #currentState(): AgentRuntimeState {
    return this.#state;
  }

  #ensureReservedTurnStillOwned(session: AgentProviderSession): void {
    if (this.#state === 'FAILED') throw cleanupRequired();
    if (this.#state === 'STARTING' || this.#state === 'STOPPING') {
      throw lifecycleBusy(this.#state);
    }
    if (this.#state !== 'OWNED' || this.#session !== session) {
      throw new AgentRuntimeError(
        'AGENT_RUNTIME_NOT_OWNED',
        'Agent runtime does not own this provider session',
      );
    }
    if (!this.#active) {
      throw providerContractViolation('Agent runtime turn reservation was lost');
    }
  }

  #rejectTurnPreflight(
    session: AgentProviderSession,
    error: unknown,
    failedByPreflight = false,
  ): Promise<never> {
    this.#active = false;
    const state = this.#currentState();
    if (failedByPreflight && state === 'FAILED' && this.#session === session) {
      return rejectPreserving(error);
    }
    if (state !== 'OWNED' || this.#session !== session) {
      return Promise.reject(lifecycleErrorForState(state));
    }
    return rejectPreserving(error);
  }
}

interface ProviderSessionLifecycle {
  readonly started: boolean;
  readonly active: boolean;
  readonly sessionId: string | undefined;
}

function inspectSessionLifecycle(session: AgentProviderSession): ProviderSessionLifecycle {
  let started: unknown;
  let active: unknown;
  let sessionId: unknown;
  try {
    started = session.started;
    active = session.active;
    sessionId = session.sessionId;
  } catch {
    throw providerContractViolation('Provider session lifecycle could not be inspected');
  }
  if (typeof started !== 'boolean' || typeof active !== 'boolean' ||
    (sessionId !== undefined && !isNonBlankString(sessionId))) {
    throw providerContractViolation('Provider session lifecycle is invalid');
  }
  return { started, active, sessionId };
}

function snapshotRuntimeCapabilities(value: unknown): Readonly<AgentProviderCapabilities> {
  if (!isRecord(value)) {
    throw providerContractViolation('Provider session capabilities are invalid');
  }
  const sessionContinuation = value.sessionContinuation;
  const outputProtocols = value.outputProtocols;
  if (typeof sessionContinuation !== 'boolean' ||
    !Array.isArray(outputProtocols) || outputProtocols.length === 0) {
    throw providerContractViolation('Provider session capabilities are invalid');
  }
  const protocols: AgentOutputProtocol[] = [];
  for (const protocol of outputProtocols) {
    if (typeof protocol !== 'string' ||
      !agentOutputProtocols.includes(protocol as AgentOutputProtocol) ||
      protocols.includes(protocol as AgentOutputProtocol)) {
      throw providerContractViolation('Provider session capabilities are invalid');
    }
    protocols.push(protocol as AgentOutputProtocol);
  }
  return Object.freeze({
    outputProtocols: Object.freeze(protocols),
    sessionContinuation,
  });
}

function validateIdentity(identity: AgentRuntimeIdentity): void {
  if (!isRecord(identity) || !isNonBlankString(identity.agentId) || !isNonBlankString(identity.providerId) ||
    (identity.projectId !== undefined && !isNonBlankString(identity.projectId))) {
    throw new AgentRuntimeError(
      'AGENT_RUNTIME_INVALID_IDENTITY',
      'Agent runtime identity must contain non-blank identifiers',
    );
  }
}

function snapshotBinding(binding: AgentRuntimeBinding): Readonly<AgentRuntimeBinding> {
  if (!isRecord(binding)) throw invalidBinding();
  const taskId = binding.taskId;
  const assignmentId = binding.assignmentId;
  const specVersion = binding.specVersion;
  const profileHash = binding.profileHash;
  if (!isNonBlankString(taskId) || !isNonBlankString(assignmentId) ||
    !isNonBlankString(specVersion) || !isNonBlankString(profileHash)) {
    throw invalidBinding();
  }
  return Object.freeze({ taskId, assignmentId, specVersion, profileHash });
}

function invalidBinding(): AgentRuntimeError {
  return new AgentRuntimeError(
    'AGENT_RUNTIME_INVALID_BINDING',
    'Agent runtime binding must contain non-blank identifiers',
  );
}

function snapshotTurnRequest(request: AgentProviderTurnRequest): Readonly<AgentRuntimeTurnSnapshot> {
  if (!isRecord(request)) {
    return request;
  }
  const prompt = request.prompt;
  const protocol = request.protocol;
  const timeoutMs = request.timeoutMs;
  return Object.freeze({
    prompt,
    protocol,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function validateProviderResult(
  result: AgentProviderTurnResult,
  request: AgentProviderTurnRequest,
  providerId: AgentProviderId,
  sessionId: string | undefined,
): void {
  if (!isRecord(result)) throw providerContractViolation('Provider returned inconsistent turn metadata');
  const resultProviderId = result.providerId;
  const protocol = result.protocol;
  const resultSessionId = result.sessionId;
  const durationMs = result.durationMs;
  if (resultProviderId !== providerId || protocol !== request.protocol ||
    (resultSessionId !== undefined && !isNonBlankString(resultSessionId)) ||
    (durationMs !== undefined &&
      (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) ||
    (resultSessionId !== undefined && sessionId !== undefined && resultSessionId !== sessionId)) {
    throw providerContractViolation('Provider returned inconsistent turn metadata');
  }
}

function lifecycleBusy(state: AgentRuntimeState): AgentRuntimeError {
  return new AgentRuntimeError(
    'AGENT_RUNTIME_LIFECYCLE_BUSY',
    `Agent runtime lifecycle is busy in state ${state}`,
  );
}

function cleanupRequired(): AgentRuntimeError {
  return new AgentRuntimeError(
    'AGENT_RUNTIME_CLEANUP_REQUIRED',
    'Agent runtime requires successful shutdown before reuse',
  );
}

function lifecycleErrorForState(state: AgentRuntimeState): AgentRuntimeError {
  return state === 'FAILED' ? cleanupRequired() : lifecycleBusy(state);
}

function providerContractViolation(message: string): AgentRuntimeError {
  return new AgentRuntimeError('AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION', message);
}

function rejectPreserving(error: unknown): Promise<never> {
  return Promise.resolve().then(() => { throw error; });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
