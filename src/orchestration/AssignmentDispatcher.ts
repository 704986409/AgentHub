import { createHash } from 'node:crypto';

import { AgentStatus, AssignmentStatus, TaskStatus, type Agent, type Assignment, type Task } from '../core/types.js';
import { AgentHubWorkerResultSchema, validateAgentHubWorkerResultSemantics } from '../protocol/AgentHubWorkerResult.js';
import { ManagerDirectiveSchema, validateManagerDirectiveSemantics } from '../protocol/ManagerDirective.js';
import type { AgentPool, AgentPoolEntrySnapshot } from '../runtime/AgentPool.js';
import { AgentRuntimeError } from '../runtime/AgentRuntime.js';
import {
  agentOutputProtocols,
  type AgentOutputProtocol,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../runtime/providers/AgentProvider.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AssignmentManager } from '../services/assignment-manager.js';
import type { TaskManager } from '../services/task-manager.js';
import type { CreatedTaskWorkspace, GitWorktreeManager } from '../workspace/GitWorktreeManager.js';
import {
  snapshotAgentScheduleReservation,
  type AgentScheduleReservation,
} from './AgentScheduler.js';

const encoder = new TextEncoder();
const maxBaseRefBytes = 1024;
const maxPromptBytes = 1024 * 1024;
const maxTimeoutMs = 60 * 60 * 1000;
const dispatchFences = new WeakMap<AssignmentManager, Set<string>>();

export interface AssignmentDispatchRequest {
  readonly reservation: AgentScheduleReservation;
  readonly baseRef: string;
  readonly turn: AgentProviderTurnRequest;
}

interface AssignmentDispatchRequestSnapshot {
  readonly reservation: Readonly<AgentScheduleReservation>;
  readonly baseRef: string;
  readonly turn: Readonly<AgentProviderTurnRequest>;
}

export interface AssignmentDispatchWorkspace {
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly created: boolean;
}

export interface AssignmentDispatchResult {
  readonly version: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly providerId: string;
  readonly assignmentId: string;
  readonly reservationSha256: string;
  readonly workspace: AssignmentDispatchWorkspace;
  readonly assignmentStatus: 'ACTIVE';
  readonly taskStatus: 'IMPLEMENTING';
  readonly turnResult: AgentProviderTurnResult;
  readonly dispatchSha256: string;
}

export type AssignmentDispatcherErrorCode =
  | 'AGENT_DISPATCH_INVALID_REQUEST'
  | 'AGENT_DISPATCH_TASK_BUSY'
  | 'AGENT_DISPATCH_INVALID_RESERVATION'
  | 'AGENT_DISPATCH_STALE_RESERVATION'
  | 'AGENT_DISPATCH_STALE_PROFILE'
  | 'AGENT_DISPATCH_RESERVATION_MISMATCH'
  | 'AGENT_DISPATCH_WORKSPACE_FAILED'
  | 'AGENT_DISPATCH_ACCEPT_FAILED'
  | 'AGENT_DISPATCH_RUNTIME_START_FAILED'
  | 'AGENT_DISPATCH_ACTIVATION_FAILED'
  | 'AGENT_DISPATCH_TURN_FAILED'
  | 'AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION'
  | 'AGENT_DISPATCH_RECONCILIATION_REQUIRED'
  | 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED';

export class AssignmentDispatcherError extends Error {
  public constructor(public readonly code: AssignmentDispatcherErrorCode) {
    super(dispatchErrorMessage(code));
    this.name = 'AssignmentDispatcherError';
  }
}

export interface AssignmentDispatcherOptions {
  readonly taskManager: TaskManager;
  readonly agentRegistry: AgentRegistry;
  readonly assignmentManager: AssignmentManager;
  readonly agentPool: AgentPool;
  readonly worktreeManager: Pick<GitWorktreeManager, 'createWorkspace'>;
}

export class AssignmentDispatcher {
  readonly #taskManager: TaskManager;
  readonly #agentRegistry: AgentRegistry;
  readonly #assignmentManager: AssignmentManager;
  readonly #agentPool: AgentPool;
  readonly #worktreeManager: Pick<GitWorktreeManager, 'createWorkspace'>;

  public constructor(options: AssignmentDispatcherOptions) {
    if (!isRecord(options)) throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
    this.#taskManager = options.taskManager;
    this.#agentRegistry = options.agentRegistry;
    this.#assignmentManager = options.assignmentManager;
    this.#agentPool = options.agentPool;
    this.#worktreeManager = options.worktreeManager;
  }

  public dispatch(request: AssignmentDispatchRequest): Promise<Readonly<AssignmentDispatchResult>> {
    let snapshot: Readonly<AssignmentDispatchRequestSnapshot>;
    try {
      snapshot = snapshotDispatchRequest(request);
    } catch (error) {
      return rejectPreserving(error);
    }
    const fence = dispatchFences.get(this.#assignmentManager) ?? new Set<string>();
    if (fence.has(snapshot.reservation.taskId)) {
      return rejectPreserving(dispatchError('AGENT_DISPATCH_TASK_BUSY'));
    }
    if (!dispatchFences.has(this.#assignmentManager)) dispatchFences.set(this.#assignmentManager, fence);
    fence.add(snapshot.reservation.taskId);
    const current = this.#dispatch(snapshot);
    return current.finally(() => fence.delete(snapshot.reservation.taskId));
  }

  async #dispatch(request: Readonly<AssignmentDispatchRequestSnapshot>): Promise<Readonly<AssignmentDispatchResult>> {
    const reservation = request.reservation;
    const initial = this.#requireReservedState(reservation);

    let workspace: Readonly<AssignmentDispatchWorkspace>;
    try {
      workspace = snapshotWorkspace(await this.#worktreeManager.createWorkspace({
        taskId: reservation.taskId,
        baseRef: request.baseRef,
      }));
    } catch {
      throw dispatchError('AGENT_DISPATCH_WORKSPACE_FAILED');
    }

    try {
      this.#assignmentManager.acceptAssignment(reservation.assignmentId);
    } catch {
      const assignment = this.#safeGetAssignment(reservation.assignmentId);
      if (isExactAssignment(assignment, reservation, AssignmentStatus.ACCEPTED)) {
        // The write committed and a later notification failed.
      } else if (isExactAssignment(assignment, reservation, AssignmentStatus.DISPATCHING)) {
        throw dispatchError('AGENT_DISPATCH_ACCEPT_FAILED');
      } else {
        throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
      }
    }
    if (!isExactAssignment(this.#safeGetAssignment(reservation.assignmentId), reservation, AssignmentStatus.ACCEPTED)) {
      throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
    }

    const binding = bindingOf(reservation);
    try {
      await this.#agentPool.startReserved(reservation.agentId, binding);
    } catch {
      const pool = this.#safePoolSnapshot(reservation.agentId);
      if (isExactReservedPool(pool, reservation, initial.agent)) {
        throw dispatchError('AGENT_DISPATCH_RUNTIME_START_FAILED');
      }
      throw dispatchError('AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED');
    }
    if (!isExactOwnedPool(this.#safePoolSnapshot(reservation.agentId), reservation, initial.agent)) {
      throw dispatchError('AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED');
    }

    let activationThrew = false;
    try {
      this.#assignmentManager.activateAssignment(reservation.assignmentId);
    } catch {
      activationThrew = true;
    }
    const activated = this.#readActivationState(reservation);
    if (!isExactActivated(activated, reservation, initial.agent)) {
      if (activationThrew && isExactPreActivation(activated, reservation, initial.agent)) {
        try {
          await this.#agentPool.shutdown(reservation.agentId, reservation.assignmentId);
        } catch {
          throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
        }
        const stopped = this.#safePoolSnapshot(reservation.agentId, true);
        if (!isCleanUnreservedPool(stopped, initial.agent)) {
          throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
        }
        throw dispatchError('AGENT_DISPATCH_ACTIVATION_FAILED');
      }
      throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
    }

    let providerResult: AgentProviderTurnResult;
    try {
      providerResult = await this.#agentPool.runTurn(
        reservation.agentId,
        reservation.assignmentId,
        request.turn,
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError &&
        error.code === 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION') {
        throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
      }
      throw dispatchError('AGENT_DISPATCH_TURN_FAILED');
    }
    const turnResult = snapshotTurnResult(providerResult, request.turn.protocol, reservation.providerId);
    const identity = {
      version: 1 as const,
      taskId: reservation.taskId,
      projectId: reservation.projectId,
      agentId: reservation.agentId,
      providerId: reservation.providerId,
      assignmentId: reservation.assignmentId,
      reservationSha256: reservation.reservationSha256,
      workspace,
      assignmentStatus: 'ACTIVE' as const,
      taskStatus: 'IMPLEMENTING' as const,
      turnResult,
    };
    const digestInput = {
      ...identity,
      turnProtocol: request.turn.protocol,
      turnResult: turnResultForDigest(turnResult),
    };
    return deepFreeze({ ...identity, dispatchSha256: dispatchDigest(digestInput) });
  }

  #requireReservedState(reservation: Readonly<AgentScheduleReservation>): {
    readonly assignment: Assignment;
    readonly task: Task;
    readonly agent: Agent;
  } {
    let assignment: Assignment | null;
    let task: Task | null;
    let agent: Agent | null;
    try {
      assignment = this.#assignmentManager.getAssignment(reservation.assignmentId);
      task = this.#taskManager.getTask(reservation.taskId);
      agent = this.#agentRegistry.getAgent(reservation.agentId);
    } catch {
      throw dispatchError('AGENT_DISPATCH_STALE_RESERVATION');
    }
    if (!isExactAssignment(assignment, reservation, AssignmentStatus.DISPATCHING) ||
      !isExactAssignedTask(task, reservation) || agent === null || agent.id !== reservation.agentId ||
      agent.provider !== reservation.providerId || !agent.enabled || agent.status !== AgentStatus.IDLE) {
      throw dispatchError('AGENT_DISPATCH_STALE_RESERVATION');
    }
    let profileHash: string;
    try {
      profileHash = this.#agentRegistry.calculateProfileHash(agent.id);
    } catch {
      throw dispatchError('AGENT_DISPATCH_STALE_PROFILE');
    }
    if (profileHash !== reservation.profileHash) throw dispatchError('AGENT_DISPATCH_STALE_PROFILE');
    const pool = this.#safePoolSnapshot(agent.id, true);
    if (!isExactReservedPool(pool, reservation, agent)) {
      throw dispatchError('AGENT_DISPATCH_RESERVATION_MISMATCH');
    }
    return { assignment, task, agent };
  }

  #readActivationState(reservation: Readonly<AgentScheduleReservation>): ActivationState {
    try {
      return {
        assignment: this.#assignmentManager.getAssignment(reservation.assignmentId),
        task: this.#taskManager.getTask(reservation.taskId),
        agent: this.#agentRegistry.getAgent(reservation.agentId),
        pool: this.#agentPool.getSnapshot(reservation.agentId),
      };
    } catch {
      throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
    }
  }

  #safeGetAssignment(id: string): Assignment | null {
    try {
      return this.#assignmentManager.getAssignment(id);
    } catch {
      throw dispatchError('AGENT_DISPATCH_RECONCILIATION_REQUIRED');
    }
  }

  #safePoolSnapshot(agentId: string, reservationBoundary = false): Readonly<AgentPoolEntrySnapshot> {
    try {
      return this.#agentPool.getSnapshot(agentId);
    } catch {
      throw dispatchError(reservationBoundary
        ? 'AGENT_DISPATCH_RESERVATION_MISMATCH'
        : 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED');
    }
  }
}

interface ActivationState {
  readonly assignment: Assignment | null;
  readonly task: Task | null;
  readonly agent: Agent | null;
  readonly pool: Readonly<AgentPoolEntrySnapshot>;
}

function snapshotDispatchRequest(request: AssignmentDispatchRequest): Readonly<AssignmentDispatchRequestSnapshot> {
  let reservationValue: unknown;
  let baseRef: unknown;
  let turnValue: unknown;
  try {
    if (!isRecord(request)) throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
    reservationValue = request.reservation;
    baseRef = request.baseRef;
    turnValue = request.turn;
  } catch {
    throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
  }
  const reservation = snapshotAgentScheduleReservation(reservationValue);
  if (reservation === null) throw dispatchError('AGENT_DISPATCH_INVALID_RESERVATION');
  try {
    if (typeof baseRef !== 'string' || baseRef.length === 0 || /[\0\r\n]/u.test(baseRef) ||
      encoder.encode(baseRef).byteLength > maxBaseRefBytes || !isRecord(turnValue)) {
      throw new TypeError('invalid dispatch request');
    }
    const prompt: unknown = turnValue.prompt;
    const protocol: unknown = turnValue.protocol;
    const timeoutMs: unknown = turnValue.timeoutMs;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 ||
      encoder.encode(prompt).byteLength > maxPromptBytes || typeof protocol !== 'string' ||
      !agentOutputProtocols.includes(protocol as AgentOutputProtocol) ||
      (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) ||
        typeof timeoutMs !== 'number' || timeoutMs <= 0 || timeoutMs > maxTimeoutMs))) {
      throw new TypeError('invalid dispatch turn');
    }
    return deepFreeze({
      reservation,
      baseRef,
      turn: {
        prompt,
        protocol: protocol as AgentOutputProtocol,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    });
  } catch {
    throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
  }
}

function snapshotWorkspace(value: CreatedTaskWorkspace): Readonly<AssignmentDispatchWorkspace> {
  if (!isRecord(value) || !isNonBlankString(value.branchName) || !isNonBlankString(value.baseCommit) ||
    !isNonBlankString(value.headCommit) || typeof value.created !== 'boolean') {
    throw new TypeError('invalid workspace result');
  }
  return deepFreeze({
    branchName: value.branchName,
    baseCommit: value.baseCommit,
    headCommit: value.headCommit,
    created: value.created,
  });
}

function snapshotTurnResult(
  value: AgentProviderTurnResult,
  protocol: AgentOutputProtocol,
  providerId: string,
): AgentProviderTurnResult {
  if (!isRecord(value) || value.protocol !== protocol || value.providerId !== providerId ||
    (value.sessionId !== undefined && !isNonBlankString(value.sessionId)) ||
    (value.durationMs !== undefined && (typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0))) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  const metadata = {
    providerId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
  };
  if (protocol === 'worker-result') {
    if (value.protocol !== 'worker-result' || typeof value.protocolValid !== 'boolean') {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    if (value.protocolValid) {
      const parsed = AgentHubWorkerResultSchema.safeParse(value.workerResult);
      if (!parsed.success || validateAgentHubWorkerResultSemantics(parsed.data).length > 0) {
        throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
      }
      return deepFreeze({ ...metadata, protocol, protocolValid: true as const, workerResult: parsed.data });
    }
    const failure = snapshotFailure(value.failure, workerFailureKinds);
    return deepFreeze({ ...metadata, protocol, protocolValid: false as const, failure });
  }
  if (value.protocol !== 'manager-directive' ||
    !['valid', 'repaired', 'invalid'].includes(value.directiveStatus)) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  if (value.directiveStatus === 'invalid') {
    const failure = snapshotFailure(value.failure, managerFailureKinds);
    return deepFreeze({ ...metadata, protocol, directiveStatus: 'invalid', directive: null, failure });
  }
  const parsed = ManagerDirectiveSchema.safeParse(value.directive);
  if (!parsed.success || validateManagerDirectiveSemantics(parsed.data).length > 0) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  return deepFreeze({ ...metadata, protocol, directiveStatus: value.directiveStatus, directive: parsed.data });
}

const workerFailureKinds = new Set([
  'missing_result', 'multiple_results', 'result_too_large', 'malformed_json', 'schema_invalid', 'semantic_invalid',
]);
const managerFailureKinds = new Set([
  'missing_directive', 'multiple_directives', 'malformed_json', 'schema_invalid', 'semantic_invalid',
  'initial_turn_failed', 'repair_turn_failed',
]);

function snapshotFailure(value: unknown, kinds: ReadonlySet<string>): { readonly kind: never; readonly message: string } {
  if (!isRecord(value) || typeof value.kind !== 'string' || !kinds.has(value.kind) ||
    typeof value.message !== 'string') {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  return deepFreeze({ kind: value.kind as never, message: value.message });
}

function bindingOf(reservation: Readonly<AgentScheduleReservation>) {
  return deepFreeze({
    taskId: reservation.taskId,
    assignmentId: reservation.assignmentId,
    specVersion: reservation.specVersion,
    profileHash: reservation.profileHash,
  });
}

function isExactAssignment(
  assignment: Assignment | null,
  reservation: Readonly<AgentScheduleReservation>,
  status: AssignmentStatus,
): assignment is Assignment {
  return assignment !== null && assignment.id === reservation.assignmentId &&
    assignment.assignmentId === reservation.assignmentId && assignment.taskId === reservation.taskId &&
    assignment.agentId === reservation.agentId && assignment.specVersion === reservation.specVersion &&
    assignment.profileHash === reservation.profileHash && assignment.status === status;
}

function isExactAssignedTask(task: Task | null, reservation: Readonly<AgentScheduleReservation>): task is Task {
  return task !== null && task.id === reservation.taskId && task.projectId === reservation.projectId &&
    task.status === TaskStatus.ASSIGNED && task.assignedAgentId === reservation.agentId &&
    task.assignmentId === reservation.assignmentId;
}

function matchesPoolIdentity(pool: Readonly<AgentPoolEntrySnapshot>, agent: Agent): boolean {
  return pool.agentId === agent.id && pool.providerId === agent.provider &&
    pool.projectId === (agent.projectId ?? undefined);
}

function isExactReservedPool(
  pool: Readonly<AgentPoolEntrySnapshot>,
  reservation: Readonly<AgentScheduleReservation>,
  agent: Agent,
): boolean {
  return matchesPoolIdentity(pool, agent) && pool.state === 'IDLE' && !pool.busy && !pool.active &&
    pool.reserved && pool.reservedTaskId === reservation.taskId &&
    pool.reservedAssignmentId === reservation.assignmentId &&
    pool.reservedSpecVersion === reservation.specVersion &&
    pool.reservedProfileHash === reservation.profileHash && pool.taskId === undefined &&
    pool.assignmentId === undefined && pool.specVersion === undefined && pool.profileHash === undefined &&
    pool.sessionId === undefined;
}

function isExactOwnedPool(
  pool: Readonly<AgentPoolEntrySnapshot>,
  reservation: Readonly<AgentScheduleReservation>,
  agent: Agent,
): boolean {
  return matchesPoolIdentity(pool, agent) && pool.state === 'OWNED' && pool.busy && !pool.active &&
    !pool.reserved && pool.taskId === reservation.taskId &&
    pool.assignmentId === reservation.assignmentId && pool.specVersion === reservation.specVersion &&
    pool.profileHash === reservation.profileHash;
}

function isCleanUnreservedPool(pool: Readonly<AgentPoolEntrySnapshot>, agent: Agent): boolean {
  return matchesPoolIdentity(pool, agent) && pool.state === 'IDLE' && !pool.busy && !pool.active &&
    !pool.reserved && pool.taskId === undefined && pool.assignmentId === undefined &&
    pool.specVersion === undefined && pool.profileHash === undefined && pool.sessionId === undefined;
}

function isExactActivated(
  state: ActivationState,
  reservation: Readonly<AgentScheduleReservation>,
  initialAgent: Agent,
): boolean {
  return isExactAssignment(state.assignment, reservation, AssignmentStatus.ACTIVE) &&
    state.task !== null && state.task.status === TaskStatus.IMPLEMENTING &&
    state.task.projectId === reservation.projectId && state.task.assignedAgentId === reservation.agentId &&
    state.task.assignmentId === reservation.assignmentId && state.agent !== null &&
    state.agent.id === initialAgent.id && state.agent.status === AgentStatus.BUSY && state.agent.enabled &&
    state.agent.provider === reservation.providerId && isExactOwnedPool(state.pool, reservation, state.agent);
}

function isExactPreActivation(
  state: ActivationState,
  reservation: Readonly<AgentScheduleReservation>,
  initialAgent: Agent,
): boolean {
  return isExactAssignment(state.assignment, reservation, AssignmentStatus.ACCEPTED) &&
    isExactAssignedTask(state.task, reservation) && state.agent !== null &&
    state.agent.id === initialAgent.id && state.agent.status === AgentStatus.IDLE && state.agent.enabled &&
    state.agent.provider === reservation.providerId && isExactOwnedPool(state.pool, reservation, state.agent);
}

function turnResultForDigest(result: AgentProviderTurnResult): unknown {
  const stable: Record<string, unknown> = { ...result };
  delete stable.durationMs;
  return stable;
}

function dispatchDigest(value: unknown): string {
  return createHash('sha256')
    .update(`AgentHub.AssignmentDispatch.v1\0${canonicalJson(value)}`)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compare).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
}

function deepFreeze<T>(value: T, seen = new WeakSet()): Readonly<T> {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dispatchError(code: AssignmentDispatcherErrorCode): AssignmentDispatcherError {
  return new AssignmentDispatcherError(code);
}

function dispatchErrorMessage(code: AssignmentDispatcherErrorCode): string {
  const messages: Record<AssignmentDispatcherErrorCode, string> = {
    AGENT_DISPATCH_INVALID_REQUEST: 'Assignment dispatch request is invalid',
    AGENT_DISPATCH_TASK_BUSY: 'Task is already being dispatched',
    AGENT_DISPATCH_INVALID_RESERVATION: 'Assignment reservation is invalid',
    AGENT_DISPATCH_STALE_RESERVATION: 'Assignment reservation is stale',
    AGENT_DISPATCH_STALE_PROFILE: 'Agent profile no longer matches the reservation',
    AGENT_DISPATCH_RESERVATION_MISMATCH: 'Agent pool reservation does not match',
    AGENT_DISPATCH_WORKSPACE_FAILED: 'Task workspace could not be prepared',
    AGENT_DISPATCH_ACCEPT_FAILED: 'Assignment acceptance failed before commit',
    AGENT_DISPATCH_RUNTIME_START_FAILED: 'Reserved runtime failed to start cleanly',
    AGENT_DISPATCH_ACTIVATION_FAILED: 'Assignment activation failed before commit',
    AGENT_DISPATCH_TURN_FAILED: 'Initial provider turn failed',
    AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION: 'Provider returned an invalid turn result',
    AGENT_DISPATCH_RECONCILIATION_REQUIRED: 'Assignment dispatch state requires reconciliation',
    AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED: 'Runtime ownership requires reconciliation',
  };
  return messages[code];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function rejectPreserving(error: unknown): Promise<never> {
  return Promise.resolve().then(() => { throw error; });
}
