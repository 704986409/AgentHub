import { createHash, randomUUID } from 'node:crypto';

import { AgentStatus, AssignmentStatus, TaskStatus, type Agent, type Assignment, type Task } from '../core/types.js';
import { AgentPoolError, type AgentPool, type AgentPoolEntrySnapshot } from '../runtime/AgentPool.js';
import type { AgentProviderFactory } from '../runtime/providers/AgentProviderFactory.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AssignmentManager } from '../services/assignment-manager.js';
import type { TaskManager } from '../services/task-manager.js';
import {
  TaskRouter,
  type TaskRouteCandidate,
  type TaskRoutingRequirements,
} from './TaskRouter.js';

const defaultSpecVersion = '1.0.0';
const maxTaskIdBytes = 256;
const maxSpecVersionBytes = 128;
const maxRequiredOutputProtocols = 32;
const encoder = new TextEncoder();
const taskFences = new WeakMap<AssignmentManager, Set<string>>();

export interface AgentSchedulerOptions {
  readonly taskManager: TaskManager;
  readonly agentRegistry: AgentRegistry;
  readonly providerFactory: AgentProviderFactory;
  readonly agentPool: AgentPool;
  readonly assignmentManager: AssignmentManager;
}

export interface AgentScheduleRequest {
  readonly taskId: string;
  readonly requirements?: TaskRoutingRequirements;
  readonly specVersion?: string;
}

interface AgentScheduleRequestSnapshot {
  readonly taskId: string;
  readonly requirements?: TaskRoutingRequirements;
  readonly specVersion: string;
}

export type AgentScheduleUnavailableReason =
  | 'REGISTRY_NOT_IDLE'
  | 'POOL_NOT_REGISTERED'
  | 'POOL_NOT_IDLE'
  | 'POOL_BUSY'
  | 'POOL_RESERVED';

export interface AgentScheduleUnavailableDiagnostic {
  readonly agentId: string;
  readonly reason: AgentScheduleUnavailableReason;
}

export interface AgentScheduleReservation {
  readonly version: 1;
  readonly outcome: 'reserved';
  readonly taskId: string;
  readonly projectId: string;
  readonly routePlanSha256: string;
  readonly candidateRank: number;
  readonly agentId: string;
  readonly providerId: string;
  readonly assignmentId: string;
  readonly specVersion: string;
  readonly profileHash: string;
  readonly reservationSha256: string;
}

export interface AgentScheduleUnavailable {
  readonly version: 1;
  readonly outcome: 'no-available-agent';
  readonly taskId: string;
  readonly projectId: string;
  readonly routePlanSha256: string;
  readonly unavailable: readonly AgentScheduleUnavailableDiagnostic[];
  readonly reservationSha256: string;
}

export type AgentScheduleResult = AgentScheduleReservation | AgentScheduleUnavailable;

export type AgentSchedulerErrorCode =
  | 'AGENT_SCHEDULER_INVALID_REQUEST'
  | 'AGENT_SCHEDULER_TASK_NOT_FOUND'
  | 'AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE'
  | 'AGENT_SCHEDULER_TASK_BUSY'
  | 'AGENT_SCHEDULER_POOL_DRAINING'
  | 'AGENT_SCHEDULER_CONTRACT_VIOLATION'
  | 'AGENT_SCHEDULER_ASSIGNMENT_CREATE_FAILED'
  | 'AGENT_SCHEDULER_COMMITTED_WITH_NOTIFICATION_FAILURE'
  | 'AGENT_SCHEDULER_RECONCILIATION_REQUIRED';

export class AgentSchedulerError extends Error {
  public constructor(public readonly code: AgentSchedulerErrorCode) {
    super(errorMessage(code));
    this.name = 'AgentSchedulerError';
  }
}

export class AgentScheduler {
  readonly #taskManager: TaskManager;
  readonly #agentRegistry: AgentRegistry;
  readonly #providerFactory: AgentProviderFactory;
  readonly #agentPool: AgentPool;
  readonly #assignmentManager: AssignmentManager;
  readonly #router = new TaskRouter();

  public constructor(options: AgentSchedulerOptions) {
    if (!isRecord(options)) throw schedulerError('AGENT_SCHEDULER_INVALID_REQUEST');
    this.#taskManager = options.taskManager;
    this.#agentRegistry = options.agentRegistry;
    this.#providerFactory = options.providerFactory;
    this.#agentPool = options.agentPool;
    this.#assignmentManager = options.assignmentManager;
  }

  public scheduleTask(request: AgentScheduleRequest): Readonly<AgentScheduleResult> {
    const snapshot = snapshotRequest(request);
    const fence = taskFences.get(this.#assignmentManager) ?? new Set<string>();
    if (fence.has(snapshot.taskId)) throw schedulerError('AGENT_SCHEDULER_TASK_BUSY');
    if (!taskFences.has(this.#assignmentManager)) taskFences.set(this.#assignmentManager, fence);
    fence.add(snapshot.taskId);
    try {
      return this.#schedule(snapshot);
    } finally {
      fence.delete(snapshot.taskId);
    }
  }

  #schedule(request: Readonly<AgentScheduleRequestSnapshot>): Readonly<AgentScheduleResult> {
    const task = this.#taskManager.getTask(request.taskId);
    if (task === null) throw schedulerError('AGENT_SCHEDULER_TASK_NOT_FOUND');
    requireScheduleable(task);

    let routePlan;
    try {
      const descriptors = this.#providerFactory.list().map((descriptor) => ({
        providerId: descriptor.id,
        outputProtocols: descriptor.capabilities.outputProtocols,
      }));
      routePlan = this.#router.route({
        task,
        agents: this.#agentRegistry.listAgents(),
        providerCapabilities: descriptors,
        ...(request.requirements === undefined ? {} : { requirements: request.requirements }),
      });
    } catch {
      throw schedulerError('AGENT_SCHEDULER_INVALID_REQUEST');
    }
    if (this.#agentPool.draining) throw schedulerError('AGENT_SCHEDULER_POOL_DRAINING');

    const unavailable: AgentScheduleUnavailableDiagnostic[] = [];
    for (const candidate of routePlan.candidates) {
      const currentTask = this.#taskManager.getTask(task.id);
      if (currentTask === null || !isScheduleable(currentTask)) {
        throw schedulerError('AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE');
      }
      const agent = this.#agentRegistry.getAgent(candidate.agentId);
      const registryReason = this.#registryAvailability(agent, candidate, task.projectId);
      if (registryReason !== undefined) {
        unavailable.push({ agentId: candidate.agentId, reason: registryReason });
        continue;
      }
      if (agent === null) throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
      const poolAvailability = this.#poolAvailability(agent, candidate);
      if (typeof poolAvailability === 'string') {
        unavailable.push({ agentId: candidate.agentId, reason: poolAvailability });
        continue;
      }

      const assignmentId = randomUUID();
      let profileHash: string;
      try {
        profileHash = this.#agentRegistry.calculateProfileHash(agent.id);
      } catch {
        throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
      }
      const binding = {
        taskId: task.id,
        assignmentId,
        specVersion: request.specVersion,
        profileHash,
      };
      try {
        const reservation = this.#agentPool.reserve(agent.id, binding);
        if (reservation.agentId !== agent.id || reservation.taskId !== binding.taskId ||
          reservation.assignmentId !== binding.assignmentId || reservation.specVersion !== binding.specVersion ||
          reservation.profileHash !== binding.profileHash) {
          throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
        }
      } catch (error) {
        const reason = reservationFailureReason(error);
        if (reason !== undefined) {
          unavailable.push({ agentId: candidate.agentId, reason });
          continue;
        }
        throw translatePoolFailure(error);
      }

      let created: Assignment;
      try {
        created = this.#assignmentManager.createAssignment({
          id: assignmentId,
          taskId: task.id,
          agentId: agent.id,
          specVersion: request.specVersion,
          profileHash,
        });
      } catch {
        this.#reconcileCreateFailure(agent.id, task.id, assignmentId, request.specVersion, profileHash);
      }
      let persisted: Assignment | null;
      let persistedTask: Task | null;
      try {
        persisted = this.#assignmentManager.getAssignment(assignmentId);
        persistedTask = this.#taskManager.getTask(task.id);
      } catch {
        throw schedulerError('AGENT_SCHEDULER_RECONCILIATION_REQUIRED');
      }
      if (!isExactAssignment(created, assignmentId, task.id, agent.id, request.specVersion, profileHash) ||
        !isExactAssignment(persisted, assignmentId, task.id, agent.id, request.specVersion, profileHash) ||
        !isExactAssignedTask(persistedTask, agent.id, assignmentId)) {
        throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
      }
      return reservedResult({
        taskId: task.id,
        projectId: task.projectId,
        routePlanSha256: routePlan.routePlanSha256,
        candidateRank: candidate.rank,
        agentId: agent.id,
        providerId: candidate.providerId,
        assignmentId,
        specVersion: request.specVersion,
        profileHash,
      });
    }
    return unavailableResult(task, routePlan.routePlanSha256, unavailable);
  }

  #registryAvailability(
    agent: Agent | null,
    candidate: TaskRouteCandidate,
    projectId: string,
  ): AgentScheduleUnavailableReason | undefined {
    if (agent === null || !agent.enabled || agent.status !== AgentStatus.IDLE) return 'REGISTRY_NOT_IDLE';
    if (agent.provider !== candidate.providerId ||
      (agent.projectId !== null && agent.projectId !== projectId) ||
      (agent.projectId === null ? 'global' : 'project') !== candidate.scope) {
      throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
    }
    return undefined;
  }

  #poolAvailability(
    agent: Agent,
    candidate: TaskRouteCandidate,
  ): AgentPoolEntrySnapshot | AgentScheduleUnavailableReason {
    let snapshot: Readonly<AgentPoolEntrySnapshot>;
    try {
      snapshot = this.#agentPool.getSnapshot(agent.id);
    } catch (error) {
      if (error instanceof AgentPoolError && error.code === 'AGENT_POOL_AGENT_NOT_FOUND') return 'POOL_NOT_REGISTERED';
      throw translatePoolFailure(error);
    }
    const expectedProjectId = agent.projectId === null ? undefined : agent.projectId;
    if (snapshot.providerId !== candidate.providerId || snapshot.projectId !== expectedProjectId) {
      throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
    }
    if (snapshot.state !== 'IDLE') return 'POOL_NOT_IDLE';
    if (snapshot.busy || snapshot.active) return 'POOL_BUSY';
    if (snapshot.reserved) return 'POOL_RESERVED';
    if (snapshot.taskId !== undefined || snapshot.assignmentId !== undefined ||
      snapshot.specVersion !== undefined || snapshot.profileHash !== undefined) {
      throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
    }
    return snapshot;
  }

  #reconcileCreateFailure(
    agentId: string,
    taskId: string,
    assignmentId: string,
    specVersion: string,
    profileHash: string,
  ): never {
    let assignment: Assignment | null;
    let task: Task | null;
    try {
      assignment = this.#assignmentManager.getAssignment(assignmentId);
      task = this.#taskManager.getTask(taskId);
    } catch {
      throw schedulerError('AGENT_SCHEDULER_RECONCILIATION_REQUIRED');
    }
    if (assignment === null && task !== null && isScheduleable(task)) {
      try {
        this.#agentPool.releaseReservation(agentId, assignmentId);
      } catch {
        throw schedulerError('AGENT_SCHEDULER_RECONCILIATION_REQUIRED');
      }
      throw schedulerError('AGENT_SCHEDULER_ASSIGNMENT_CREATE_FAILED');
    }
    if (isExactAssignment(assignment, assignmentId, taskId, agentId, specVersion, profileHash) &&
      isExactAssignedTask(task, agentId, assignmentId)) {
      throw schedulerError('AGENT_SCHEDULER_COMMITTED_WITH_NOTIFICATION_FAILURE');
    }
    throw schedulerError('AGENT_SCHEDULER_RECONCILIATION_REQUIRED');
  }
}

function snapshotRequest(request: AgentScheduleRequest): Readonly<AgentScheduleRequestSnapshot> {
  try {
    if (!isRecord(request)) throw new TypeError('invalid request');
    const taskId: unknown = request.taskId;
    const specVersionValue: unknown = request.specVersion;
    const requirementsValue: unknown = request.requirements;

    if (!validTaskId(taskId)) throw new TypeError('invalid task ID');
    const specVersion = specVersionValue === undefined ? defaultSpecVersion : specVersionValue;
    if (!validSpecVersion(specVersion)) throw new TypeError('invalid spec version');

    let requirements: TaskRoutingRequirements | undefined;
    if (requirementsValue !== undefined) {
      if (!isRecord(requirementsValue)) throw new TypeError('invalid requirements');
      const minimumAuthority = requirementsValue.minimumAuthority;
      const protocolsValue = requirementsValue.requiredOutputProtocols;
      if (minimumAuthority !== undefined && typeof minimumAuthority !== 'string') {
        throw new TypeError('invalid minimum authority');
      }
      const requiredOutputProtocols = protocolsValue === undefined
        ? undefined
        : snapshotProtocolArray(protocolsValue);
      requirements = deepFreeze({
        ...(minimumAuthority === undefined ? {} : { minimumAuthority }),
        ...(requiredOutputProtocols === undefined ? {} : { requiredOutputProtocols }),
      } as TaskRoutingRequirements);
    }
    return deepFreeze({
      taskId,
      specVersion,
      ...(requirements === undefined ? {} : { requirements }),
    });
  } catch {
    throw schedulerError('AGENT_SCHEDULER_INVALID_REQUEST');
  }
}

function snapshotProtocolArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError('invalid required output protocols');
  const length = value.length;
  if (length > maxRequiredOutputProtocols) throw new TypeError('invalid required output protocols');
  const protocols: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const protocol: unknown = value[index];
    if (typeof protocol !== 'string') throw new TypeError('invalid required output protocol');
    protocols.push(protocol);
  }
  return Object.freeze(protocols);
}

function validTaskId(value: unknown): value is string {
  return isNonBlankString(value) && !value.includes('\0') && encoder.encode(value).byteLength <= maxTaskIdBytes;
}

function validSpecVersion(value: unknown): value is string {
  return isNonBlankString(value) && !/[\0\r\n]/u.test(value) &&
    encoder.encode(value).byteLength <= maxSpecVersionBytes;
}

function requireScheduleable(task: Task): void {
  if (!isScheduleable(task)) throw schedulerError('AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE');
}

function isScheduleable(task: Task): boolean {
  return (task.status === TaskStatus.CREATED || task.status === TaskStatus.QUEUED) &&
    task.assignedAgentId === null && task.assignmentId === null;
}

function isExactAssignment(
  assignment: Assignment | null,
  assignmentId: string,
  taskId: string,
  agentId: string,
  specVersion: string,
  profileHash: string,
): assignment is Assignment {
  return assignment !== null && assignment.id === assignmentId && assignment.assignmentId === assignmentId &&
    assignment.taskId === taskId && assignment.agentId === agentId && assignment.specVersion === specVersion &&
    assignment.profileHash === profileHash && assignment.status === AssignmentStatus.DISPATCHING;
}

function isExactAssignedTask(task: Task | null, agentId: string, assignmentId: string): task is Task {
  return task !== null && task.status === TaskStatus.ASSIGNED && task.assignedAgentId === agentId &&
    task.assignmentId === assignmentId;
}

function reservationFailureReason(error: unknown): AgentScheduleUnavailableReason | undefined {
  if (!(error instanceof AgentPoolError)) return undefined;
  if (error.code === 'AGENT_POOL_AGENT_NOT_FOUND') return 'POOL_NOT_REGISTERED';
  if (error.code === 'AGENT_POOL_AGENT_BUSY') return 'POOL_RESERVED';
  if (error.code === 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED' || error.code === 'AGENT_POOL_OPERATION_BUSY') {
    return 'POOL_BUSY';
  }
  return undefined;
}

function translatePoolFailure(error: unknown): AgentSchedulerError {
  if (error instanceof AgentSchedulerError) return error;
  if (error instanceof AgentPoolError && error.code === 'AGENT_POOL_POOL_DRAINING') {
    return schedulerError('AGENT_SCHEDULER_POOL_DRAINING');
  }
  return schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
}

function reservedResult(input: Omit<AgentScheduleReservation, 'version' | 'outcome' | 'reservationSha256'>):
Readonly<AgentScheduleReservation> {
  const identity = { version: 1 as const, outcome: 'reserved' as const, ...input };
  return deepFreeze({ ...identity, reservationSha256: reservationDigest(identity) });
}

function unavailableResult(
  task: Task,
  routePlanSha256: string,
  unavailable: readonly AgentScheduleUnavailableDiagnostic[],
): Readonly<AgentScheduleUnavailable> {
  const identity = {
    version: 1 as const,
    outcome: 'no-available-agent' as const,
    taskId: task.id,
    projectId: task.projectId,
    routePlanSha256,
    unavailable: unavailable.map((item) => ({ ...item })),
  };
  return deepFreeze({ ...identity, reservationSha256: reservationDigest(identity) });
}

function reservationDigest(value: unknown): string {
  return createHash('sha256')
    .update(`AgentHub.AgentScheduleReservation.v1\0${canonicalJson(value)}`)
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
  throw schedulerError('AGENT_SCHEDULER_CONTRACT_VIOLATION');
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

function schedulerError(code: AgentSchedulerErrorCode): AgentSchedulerError {
  return new AgentSchedulerError(code);
}

function errorMessage(code: AgentSchedulerErrorCode): string {
  const messages: Record<AgentSchedulerErrorCode, string> = {
    AGENT_SCHEDULER_INVALID_REQUEST: 'Agent scheduling request is invalid',
    AGENT_SCHEDULER_TASK_NOT_FOUND: 'Task was not found for scheduling',
    AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE: 'Task is not scheduleable',
    AGENT_SCHEDULER_TASK_BUSY: 'Task is already being scheduled',
    AGENT_SCHEDULER_POOL_DRAINING: 'Agent pool is draining',
    AGENT_SCHEDULER_CONTRACT_VIOLATION: 'Agent scheduling contract is inconsistent',
    AGENT_SCHEDULER_ASSIGNMENT_CREATE_FAILED: 'Assignment creation failed before commit',
    AGENT_SCHEDULER_COMMITTED_WITH_NOTIFICATION_FAILURE: 'Assignment committed but notification failed',
    AGENT_SCHEDULER_RECONCILIATION_REQUIRED: 'Assignment reservation requires reconciliation',
  };
  return messages[code];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
