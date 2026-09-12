import type { EventBus } from '../events/event-bus.js';
import {
  AgentRuntime,
  type AgentRuntimeBinding,
  type AgentRuntimeState,
} from './AgentRuntime.js';
import type {
  AgentProviderId,
  AgentProviderTurnRequest,
  AgentProviderTurnResult,
} from './providers/AgentProvider.js';
import type { AgentProviderFactory } from './providers/AgentProviderFactory.js';

export interface AgentPoolOptions {
  readonly providerFactory: AgentProviderFactory;
  readonly eventBus: EventBus;
}

export interface AgentPoolRegistration {
  readonly agentId: string;
  readonly projectId?: string;
  readonly providerId: AgentProviderId;
  readonly providerConfig?: Readonly<Record<string, unknown>>;
}

export interface AgentPoolEntrySnapshot {
  readonly agentId: string;
  readonly projectId?: string;
  readonly providerId: AgentProviderId;
  readonly state: AgentRuntimeState;
  readonly busy: boolean;
  readonly active: boolean;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly specVersion?: string;
  readonly profileHash?: string;
  readonly sessionId?: string;
}

export type AgentPoolErrorCode =
  | 'AGENT_POOL_INVALID_REGISTRATION'
  | 'AGENT_POOL_INVALID_BINDING'
  | 'AGENT_POOL_AGENT_DUPLICATE'
  | 'AGENT_POOL_AGENT_NOT_FOUND'
  | 'AGENT_POOL_AGENT_BUSY'
  | 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED'
  | 'AGENT_POOL_ASSIGNMENT_MISMATCH'
  | 'AGENT_POOL_OPERATION_BUSY'
  | 'AGENT_POOL_POOL_DRAINING'
  | 'AGENT_POOL_RUNTIME_CONTRACT_VIOLATION'
  | 'AGENT_POOL_SHUTDOWN_FAILED';

export class AgentPoolError extends Error {
  public readonly failedAgentIds: readonly string[] | undefined;

  public constructor(
    public readonly code: AgentPoolErrorCode,
    message: string,
    failedAgentIds?: readonly string[],
  ) {
    super(message);
    this.name = 'AgentPoolError';
    this.failedAgentIds = failedAgentIds === undefined
      ? undefined
      : Object.freeze([...failedAgentIds]);
  }
}

interface AgentPoolRegistrationSnapshot {
  readonly agentId: string;
  readonly projectId?: string;
  readonly providerId: AgentProviderId;
  readonly providerConfig?: Readonly<Record<string, unknown>>;
}

interface PoolEntry {
  readonly registration: AgentPoolRegistrationSnapshot;
  readonly runtime: AgentRuntime;
}

export class AgentPool {
  readonly #providerFactory: AgentProviderFactory;
  readonly #eventBus: EventBus;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #assignmentOwners = new Map<string, string>();
  #draining = false;
  #inputSnapshotReserved = false;
  #drainPromise: Promise<void> | undefined;

  public constructor(options: AgentPoolOptions) {
    if (!isRecord(options)) throw invalidRegistration('Agent pool options are invalid');
    const providerFactory = options.providerFactory;
    const eventBus = options.eventBus;
    if (!isRecord(providerFactory) || !isRecord(eventBus)) {
      throw invalidRegistration('Agent pool options are invalid');
    }
    this.#providerFactory = providerFactory;
    this.#eventBus = eventBus;
  }

  public get size(): number {
    return this.#entries.size;
  }

  public get draining(): boolean {
    return this.#draining;
  }

  public has(agentId: string): boolean {
    return this.#entries.has(agentId);
  }

  public register(registration: AgentPoolRegistration): void {
    this.#ensureNotDraining();
    const snapshot = this.#withInputSnapshotReservation(() => snapshotRegistration(registration));
    this.#ensureNotDraining();
    if (this.#entries.has(snapshot.agentId)) {
      throw new AgentPoolError(
        'AGENT_POOL_AGENT_DUPLICATE',
        `Agent ${snapshot.agentId} is already registered`,
      );
    }
    if (!this.#providerFactory.has(snapshot.providerId)) {
      throw invalidRegistration(`Provider ${snapshot.providerId} is not registered`);
    }
    const runtime = new AgentRuntime({
      agentId: snapshot.agentId,
      providerId: snapshot.providerId,
      providerFactory: this.#providerFactory,
      eventBus: this.#eventBus,
      ...(snapshot.projectId === undefined ? {} : { projectId: snapshot.projectId }),
      ...(snapshot.providerConfig === undefined ? {} : { providerConfig: snapshot.providerConfig }),
    });
    this.#entries.set(snapshot.agentId, { registration: snapshot, runtime });
  }

  public unregister(agentId: string): void {
    this.#ensureNotDraining();
    if (this.#inputSnapshotReserved) throw operationBusy();
    const entry = this.#requireEntry(agentId);
    if (entry.runtime.state !== 'IDLE' || entry.runtime.busy || this.#hasAssignmentFor(agentId)) {
      throw new AgentPoolError('AGENT_POOL_AGENT_BUSY', `Agent ${agentId} is busy`);
    }
    this.#entries.delete(agentId);
  }

  public getSnapshot(agentId: string): Readonly<AgentPoolEntrySnapshot> {
    return snapshotEntry(this.#requireEntry(agentId));
  }

  public list(): readonly Readonly<AgentPoolEntrySnapshot>[] {
    return Object.freeze([...this.#entries.values()].map((entry) => snapshotEntry(entry)));
  }

  public start(agentId: string, binding: AgentRuntimeBinding): Promise<void> {
    try {
      this.#ensureNotDraining();
      const entry = this.#requireEntry(agentId);
      const snapshot = this.#withInputSnapshotReservation(() => snapshotBinding(binding));
      this.#ensureNotDraining();
      if (this.#entries.get(agentId) !== entry) {
        throw new AgentPoolError('AGENT_POOL_AGENT_NOT_FOUND', `Agent ${agentId} is not registered`);
      }
      this.#ensureAgentCanStart(entry);
      const currentOwner = this.#assignmentOwners.get(snapshot.assignmentId);
      if (currentOwner !== undefined) {
        throw new AgentPoolError(
          'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
          `Assignment ${snapshot.assignmentId} is already owned`,
        );
      }
      this.#assignmentOwners.set(snapshot.assignmentId, agentId);
      let starting: Promise<void>;
      try {
        starting = entry.runtime.start(snapshot);
      } catch (error) {
        this.#reconcileStartFailure(entry, snapshot.assignmentId);
        throw error;
      }
      return starting.then(
        () => this.#validateStartedEntry(entry, snapshot),
        (error: unknown) => {
          this.#reconcileStartFailure(entry, snapshot.assignmentId);
          throw error;
        },
      );
    } catch (error) {
      return rejectPreserving(error);
    }
  }

  public runTurn(
    agentId: string,
    assignmentId: string,
    request: AgentProviderTurnRequest,
  ): Promise<AgentProviderTurnResult> {
    try {
      this.#ensureNotDraining();
      const entry = this.#requireOwnedEntry(agentId, assignmentId);
      return entry.runtime.runTurn(request);
    } catch (error) {
      return rejectPreserving(error);
    }
  }

  public shutdown(agentId: string, assignmentId: string): Promise<void> {
    try {
      this.#ensureNotDraining();
      const entry = this.#requireOwnedEntry(agentId, assignmentId);
      let stopping: Promise<void>;
      try {
        stopping = entry.runtime.shutdown();
      } catch (error) {
        this.#reconcileShutdownFailure(entry, assignmentId);
        throw error;
      }
      return stopping.then(
        () => this.#reconcileShutdownSuccess(entry, assignmentId),
        (error: unknown) => {
          this.#reconcileShutdownFailure(entry, assignmentId);
          throw error;
        },
      );
    } catch (error) {
      return rejectPreserving(error);
    }
  }

  public shutdownAll(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    this.#draining = true;
    const current = Promise.resolve().then(() => this.#performShutdownAll());
    this.#drainPromise = current;
    void current.finally(() => {
      if (this.#drainPromise === current) {
        this.#drainPromise = undefined;
        this.#draining = false;
      }
    }).catch(() => undefined);
    return current;
  }

  async #performShutdownAll(): Promise<void> {
    const failures: string[] = [];
    const cleanups: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.runtime.state === 'IDLE') {
        if (entry.runtime.busy || entry.runtime.binding !== undefined ||
          this.#hasAssignmentFor(entry.registration.agentId)) {
          failures.push(entry.registration.agentId);
        }
        continue;
      }
      cleanups.push(this.#shutdownEntryForDrain(entry).catch(() => {
        failures.push(entry.registration.agentId);
      }));
    }
    await Promise.all(cleanups);
    if (failures.length > 0) {
      throw new AgentPoolError(
        'AGENT_POOL_SHUTDOWN_FAILED',
        `Agent pool shutdown failed for: ${failures.join(', ')}`,
        failures,
      );
    }
  }

  async #shutdownEntryForDrain(entry: PoolEntry): Promise<void> {
    try {
      await entry.runtime.shutdown();
    } catch (error) {
      if (isRuntimeClean(entry.runtime)) this.#releaseAssignmentsFor(entry.registration.agentId);
      throw error;
    }
    if (!isRuntimeClean(entry.runtime)) throw runtimeContractViolation(entry.registration.agentId);
    this.#releaseAssignmentsFor(entry.registration.agentId);
  }

  #ensureAgentCanStart(entry: PoolEntry): void {
    const agentId = entry.registration.agentId;
    const hasAssignment = this.#hasAssignmentFor(agentId);
    if (entry.runtime.state !== 'IDLE' || entry.runtime.busy) {
      if (!hasAssignment) throw runtimeContractViolation(agentId);
      throw new AgentPoolError('AGENT_POOL_AGENT_BUSY', `Agent ${agentId} is busy`);
    }
    if (entry.runtime.binding !== undefined || hasAssignment) throw runtimeContractViolation(agentId);
  }

  #validateStartedEntry(entry: PoolEntry, binding: Readonly<AgentRuntimeBinding>): void {
    const runtimeBinding = entry.runtime.binding;
    if (entry.runtime.state !== 'OWNED' || !entry.runtime.busy || runtimeBinding === undefined ||
      runtimeBinding.taskId !== binding.taskId || runtimeBinding.assignmentId !== binding.assignmentId ||
      runtimeBinding.specVersion !== binding.specVersion || runtimeBinding.profileHash !== binding.profileHash ||
      this.#assignmentOwners.get(binding.assignmentId) !== entry.registration.agentId) {
      if (isRuntimeClean(entry.runtime)) this.#deleteOwnerIfExact(binding.assignmentId, entry.registration.agentId);
      throw runtimeContractViolation(entry.registration.agentId);
    }
  }

  #reconcileStartFailure(entry: PoolEntry, assignmentId: string): void {
    if (isRuntimeClean(entry.runtime)) {
      this.#deleteOwnerIfExact(assignmentId, entry.registration.agentId);
    }
  }

  #reconcileShutdownSuccess(entry: PoolEntry, assignmentId: string): void {
    if (!isRuntimeClean(entry.runtime)) throw runtimeContractViolation(entry.registration.agentId);
    this.#deleteOwnerIfExact(assignmentId, entry.registration.agentId);
  }

  #reconcileShutdownFailure(entry: PoolEntry, assignmentId: string): void {
    if (isRuntimeClean(entry.runtime)) {
      this.#deleteOwnerIfExact(assignmentId, entry.registration.agentId);
    }
  }

  #requireOwnedEntry(agentId: string, assignmentId: string): PoolEntry {
    const entry = this.#requireEntry(agentId);
    if (!isNonBlankString(assignmentId) || this.#assignmentOwners.get(assignmentId) !== agentId) {
      throw assignmentMismatch(agentId, assignmentId);
    }
    const binding = entry.runtime.binding;
    if (binding === undefined || binding.assignmentId !== assignmentId ||
      entry.runtime.state === 'IDLE' || !entry.runtime.busy) {
      throw runtimeContractViolation(agentId);
    }
    return entry;
  }

  #requireEntry(agentId: string): PoolEntry {
    const entry = this.#entries.get(agentId);
    if (entry === undefined) {
      throw new AgentPoolError('AGENT_POOL_AGENT_NOT_FOUND', `Agent ${agentId} is not registered`);
    }
    return entry;
  }

  #ensureNotDraining(): void {
    if (this.#draining) {
      throw new AgentPoolError('AGENT_POOL_POOL_DRAINING', 'Agent pool is draining');
    }
  }

  #withInputSnapshotReservation<T>(callback: () => T): T {
    if (this.#inputSnapshotReserved) throw operationBusy();
    this.#inputSnapshotReserved = true;
    try {
      return callback();
    } finally {
      this.#inputSnapshotReserved = false;
    }
  }

  #hasAssignmentFor(agentId: string): boolean {
    return [...this.#assignmentOwners.values()].includes(agentId);
  }

  #deleteOwnerIfExact(assignmentId: string, agentId: string): void {
    if (this.#assignmentOwners.get(assignmentId) === agentId) {
      this.#assignmentOwners.delete(assignmentId);
    }
  }

  #releaseAssignmentsFor(agentId: string): void {
    for (const [assignmentId, owner] of this.#assignmentOwners) {
      if (owner === agentId) this.#assignmentOwners.delete(assignmentId);
    }
  }
}

function snapshotRegistration(registration: AgentPoolRegistration): AgentPoolRegistrationSnapshot {
  if (!isRecord(registration)) throw invalidRegistration('Agent pool registration is invalid');
  const agentId = registration.agentId;
  const projectId = registration.projectId;
  const providerId = registration.providerId;
  const providerConfig = registration.providerConfig;
  if (!isNonBlankString(agentId) || !isNonBlankString(providerId) ||
    (projectId !== undefined && !isNonBlankString(projectId)) ||
    (providerConfig !== undefined && !isRecord(providerConfig))) {
    throw invalidRegistration('Agent pool registration is invalid');
  }
  const configSnapshot = providerConfig === undefined
    ? undefined
    : Object.freeze({ ...providerConfig });
  return Object.freeze({
    agentId,
    providerId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(configSnapshot === undefined ? {} : { providerConfig: configSnapshot }),
  });
}

function snapshotBinding(binding: AgentRuntimeBinding): Readonly<AgentRuntimeBinding> {
  if (!isRecord(binding)) throw invalidBinding();
  const taskId = binding.taskId;
  const assignmentId = binding.assignmentId;
  const specVersion = binding.specVersion;
  const profileHash = binding.profileHash;
  if (!isNonBlankString(taskId) || !isNonBlankString(assignmentId) ||
    !isNonBlankString(specVersion) || !isNonBlankString(profileHash)) throw invalidBinding();
  return Object.freeze({ taskId, assignmentId, specVersion, profileHash });
}

function snapshotEntry(entry: PoolEntry): Readonly<AgentPoolEntrySnapshot> {
  const binding = entry.runtime.binding;
  const sessionId = entry.runtime.sessionId;
  return Object.freeze({
    agentId: entry.registration.agentId,
    providerId: entry.registration.providerId,
    ...(entry.registration.projectId === undefined ? {} : { projectId: entry.registration.projectId }),
    state: entry.runtime.state,
    busy: entry.runtime.busy,
    active: entry.runtime.active,
    ...(binding === undefined ? {} : binding),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function isRuntimeClean(runtime: AgentRuntime): boolean {
  return runtime.state === 'IDLE' && !runtime.busy && runtime.binding === undefined;
}

function invalidRegistration(message: string): AgentPoolError {
  return new AgentPoolError('AGENT_POOL_INVALID_REGISTRATION', message);
}

function invalidBinding(): AgentPoolError {
  return new AgentPoolError(
    'AGENT_POOL_INVALID_BINDING',
    'Agent pool binding must contain non-blank identifiers',
  );
}

function assignmentMismatch(agentId: string, assignmentId: string): AgentPoolError {
  return new AgentPoolError(
    'AGENT_POOL_ASSIGNMENT_MISMATCH',
    `Assignment ${assignmentId} is not owned by agent ${agentId}`,
  );
}

function runtimeContractViolation(agentId: string): AgentPoolError {
  return new AgentPoolError(
    'AGENT_POOL_RUNTIME_CONTRACT_VIOLATION',
    `Agent ${agentId} runtime ownership is inconsistent`,
  );
}

function operationBusy(): AgentPoolError {
  return new AgentPoolError(
    'AGENT_POOL_OPERATION_BUSY',
    'Agent pool input operation is already being reserved',
  );
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
