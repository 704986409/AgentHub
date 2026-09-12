import type { EventBus } from '../events/event-bus.js';
import {
  validateAgentProviderTurnRequest,
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

export type AgentRuntimeErrorCode =
  | 'AGENT_RUNTIME_INVALID_IDENTITY'
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
  #active = false;
  #startPromise: Promise<void> | undefined;
  #activeTurnPromise: Promise<AgentProviderTurnResult> | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: AgentRuntimeOptions) {
    validateIdentity(options);
    this.agentId = options.agentId;
    this.projectId = options.projectId;
    this.providerId = options.providerId;
    this.#providerFactory = options.providerFactory;
    this.#eventBus = options.eventBus;
    this.#providerConfig = options.providerConfig === undefined
      ? undefined
      : Object.freeze({ ...options.providerConfig });
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
    return this.#session?.sessionId;
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

    let snapshot: Readonly<AgentRuntimeBinding>;
    try {
      snapshot = snapshotBinding(binding);
    } catch (error) {
      return rejectPreserving(error);
    }
    this.#binding = snapshot;
    this.#state = 'STARTING';

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
      this.#binding = undefined;
      this.#state = 'IDLE';
      return rejectPreserving(error);
    }
    this.#session = session;
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
    let lifecycle: ProviderSessionLifecycle;
    try {
      lifecycle = inspectSessionLifecycle(session);
    } catch (error) {
      this.#state = 'FAILED';
      return rejectPreserving(error);
    }
    if (!lifecycle.started) {
      this.#state = 'FAILED';
      return Promise.reject(providerContractViolation('Provider session is not started'));
    }
    try {
      validateAgentProviderTurnRequest(request, session.capabilities);
    } catch (error) {
      return rejectPreserving(error);
    }
    if (this.#active) {
      return Promise.reject(new AgentRuntimeError(
        'AGENT_RUNTIME_TURN_ALREADY_ACTIVE',
        'An Agent runtime turn is already active',
      ));
    }

    this.#active = true;
    const current = Promise.resolve().then(() => this.#performTurn(session, request));
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
      if (!inspectSessionLifecycle(session).started) {
        throw providerContractViolation('Provider session did not start');
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
    } catch (error) {
      this.#state = 'FAILED';
      throw error;
    }
    if (lifecycle.started || lifecycle.active) {
      this.#state = 'FAILED';
      throw providerContractViolation('Provider session did not become quiescent after shutdown');
    }
    this.#session = undefined;
    this.#binding = undefined;
    this.#active = false;
    this.#state = 'IDLE';
  }

  #markFailedUnlessStopping(): void {
    if (this.#state === 'OWNED') this.#state = 'FAILED';
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
  if (!isRecord(binding) || !isNonBlankString(binding.taskId) ||
    !isNonBlankString(binding.assignmentId) || !isNonBlankString(binding.specVersion) ||
    !isNonBlankString(binding.profileHash)) {
    throw new AgentRuntimeError(
      'AGENT_RUNTIME_INVALID_BINDING',
      'Agent runtime binding must contain non-blank identifiers',
    );
  }
  return Object.freeze({
    taskId: binding.taskId,
    assignmentId: binding.assignmentId,
    specVersion: binding.specVersion,
    profileHash: binding.profileHash,
  });
}

function validateProviderResult(
  result: AgentProviderTurnResult,
  request: AgentProviderTurnRequest,
  providerId: AgentProviderId,
  sessionId: string | undefined,
): void {
  if (!isRecord(result) || result.providerId !== providerId || result.protocol !== request.protocol ||
    (result.sessionId !== undefined && !isNonBlankString(result.sessionId)) ||
    (result.durationMs !== undefined &&
      (typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0)) ||
    (result.sessionId !== undefined && sessionId !== undefined && result.sessionId !== sessionId)) {
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
