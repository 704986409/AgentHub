import { AssignmentStatus, TaskStatus } from '../core/types.js';
import type { Database } from '../database/index.js';
import type { EventBus } from '../events/event-bus.js';
import {
  snapshotAgentScheduleReservation,
  type AgentScheduleReservation,
} from '../orchestration/AgentScheduler.js';
import {
  snapshotAssignmentDispatchResult,
  type AssignmentDispatchResult,
} from '../orchestration/dispatch/AssignmentDispatchContract.js';
import type { AgentPool, AgentPoolEntrySnapshot } from '../runtime/AgentPool.js';
import type { AssignmentManager } from '../services/assignment-manager.js';
import type { TaskManager } from '../services/task-manager.js';
import type { ReviewHandleStore } from '../api/ReviewHandleStore.js';
import type { PlanLifecycleService } from './plan-lifecycle.js';

export const PLAN_ASSIGNMENT_RECOVERY_REQUIRED = 'PLAN_ASSIGNMENT_RECOVERY_REQUIRED';
export const PLAN_ASSIGNMENT_RECOVERY_STARTED = 'PlanAssignmentRecoveryStarted';
export const PLAN_ASSIGNMENT_RESUMED = 'PlanAssignmentResumed';
export const PLAN_ASSIGNMENT_REQUEUED = 'PlanAssignmentRequeued';
export const PLAN_ASSIGNMENT_RECOVERY_BLOCKED = 'PlanAssignmentRecoveryBlocked';

export type AssignmentRecoveryStage =
  | 'BEFORE_WORKSPACE'
  | 'WORKSPACE_FAILED'
  | 'ASSIGNMENT_DISPATCHING'
  | 'ASSIGNMENT_ACCEPTED'
  | 'RUNTIME_RESERVED'
  | 'RUNTIME_OWNED'
  | 'TURN_STARTED'
  | 'TURN_COMPLETED'
  | 'REVIEW_PREPARING'
  | 'REVIEW_READY'
  | 'REQUEUED';

export type AssignmentRecoveryResult =
  | { outcome: 'resumable'; assignmentId: string; reservation: Readonly<AgentScheduleReservation> }
  | { outcome: 'requeue-safe'; assignmentId: string }
  | { outcome: 'requeued'; oldAssignmentId: string }
  | { outcome: 'review-resumable'; assignmentId: string; dispatch: Readonly<AssignmentDispatchResult> }
  | { outcome: 'review-ready'; assignmentId: string }
  | { outcome: 'idle' }
  | { outcome: 'reconciliation-required'; code: string };

export interface PlanExecutionRecoveryServiceOptions {
  readonly database: Database;
  readonly planLifecycle: PlanLifecycleService;
  readonly tasks: TaskManager;
  readonly assignments: AssignmentManager;
  readonly agentPool: AgentPool;
  readonly eventBus: EventBus;
  readonly reviews?: ReviewHandleStore;
}

interface RecoveryRow {
  readonly assignment_id: string;
  readonly task_id: string;
  readonly plan_id: string | null;
  readonly reservation_json: string;
  readonly dispatch_json: string | null;
  readonly stage: string;
  readonly turn_may_have_started: number;
  readonly revision_round: number;
}

export class PlanExecutionRecoveryService {
  readonly #database: Database;
  readonly #planLifecycle: PlanLifecycleService;
  readonly #tasks: TaskManager;
  readonly #assignments: AssignmentManager;
  readonly #agentPool: AgentPool;
  readonly #eventBus: EventBus;
  readonly #reviews: ReviewHandleStore | undefined;

  public constructor(options: PlanExecutionRecoveryServiceOptions) {
    this.#database = options.database;
    this.#planLifecycle = options.planLifecycle;
    this.#tasks = options.tasks;
    this.#assignments = options.assignments;
    this.#agentPool = options.agentPool;
    this.#eventBus = options.eventBus;
    this.#reviews = options.reviews;
  }

  public persistReservation(
    planId: string,
    reservation: Readonly<AgentScheduleReservation>,
    stage: AssignmentRecoveryStage = 'ASSIGNMENT_DISPATCHING',
  ): void {
    const snapshot = snapshotAgentScheduleReservation(reservation);
    if (snapshot === null) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    this.#upsert({
      assignmentId: snapshot.assignmentId,
      taskId: snapshot.taskId,
      planId,
      reservation: snapshot,
      dispatchJson: this.#row(snapshot.assignmentId)?.dispatch_json ?? null,
      stage,
      turnMayHaveStarted: this.#row(snapshot.assignmentId)?.turn_may_have_started === 1,
      revisionRound: this.#row(snapshot.assignmentId)?.revision_round ?? 0,
    });
  }

  public persistRevisionDispatch(dispatch: Readonly<AssignmentDispatchResult>, round: number): void {
    if (!Number.isInteger(round) || round < 1) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    const row = this.#row(dispatch.assignmentId);
    if (!row) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    const snapshot = snapshotAssignmentDispatchResult(dispatch);
    this.#upsert({
      assignmentId: dispatch.assignmentId,
      taskId: row.task_id,
      planId: row.plan_id,
      reservation: parseReservation(row.reservation_json),
      dispatchJson: JSON.stringify(snapshot),
      stage: 'TURN_STARTED',
      turnMayHaveStarted: true,
      revisionRound: round,
    });
  }

  public markReviewReady(assignmentId: string): void {
    const row = this.#row(assignmentId);
    if (!row) return;
    this.#upsert({
      assignmentId,
      taskId: row.task_id,
      planId: row.plan_id,
      reservation: parseReservation(row.reservation_json),
      dispatchJson: row.dispatch_json,
      stage: 'REVIEW_READY',
      turnMayHaveStarted: row.turn_may_have_started === 1,
      revisionRound: row.revision_round,
    });
  }

  public persistDispatch(assignmentId: string, dispatch: Readonly<AssignmentDispatchResult>): void {
    const row = this.#row(assignmentId);
    if (!row) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    this.#upsert({
      assignmentId,
      taskId: row.task_id,
      planId: row.plan_id,
      reservation: parseReservation(row.reservation_json),
      dispatchJson: JSON.stringify(snapshotAssignmentDispatchResult(dispatch)),
      stage: 'TURN_COMPLETED',
      turnMayHaveStarted: true,
      revisionRound: row.revision_round,
    });
  }

  public recordDispatchFailure(assignmentId: string, error: unknown): void {
    const row = this.#row(assignmentId);
    if (!row) return;
    const code = errorCode(error);
    const turnMayHaveStarted = row.turn_may_have_started === 1 ||
      code === 'AGENT_DISPATCH_TURN_FAILED' ||
      code === 'AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION';
    this.#upsert({
      assignmentId,
      taskId: row.task_id,
      planId: row.plan_id,
      reservation: parseReservation(row.reservation_json),
      dispatchJson: row.dispatch_json,
      stage: stageForError(code, row.stage),
      turnMayHaveStarted,
      revisionRound: row.revision_round,
    });
  }

  public inspectAssignment(assignmentId: string): AssignmentRecoveryResult {
    const assignment = this.#assignments.getAssignment(assignmentId);
    if (assignment === null) return { outcome: 'idle' };
    return this.inspect(assignment.taskId);
  }

  public inspect(runtimeTaskId: string): AssignmentRecoveryResult {
    const task = this.#tasks.getTask(runtimeTaskId);
    if (task === null) return { outcome: 'idle' };
    const link = this.#planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === runtimeTaskId);
    const assignment = task.assignmentId === null ? null : this.#assignments.getAssignment(task.assignmentId);
    const row = assignment === null ? this.#rowByTask(runtimeTaskId) : this.#row(assignment.id);
    const handle = this.#reviews?.getActiveForTask(runtimeTaskId);
    if (row?.stage === 'TURN_STARTED' && row.turn_may_have_started === 1 && handle === undefined) {
      this.#blocked(assignment?.id ?? row.assignment_id, runtimeTaskId, PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
      return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
    }
    if (handle !== undefined || task.status === TaskStatus.REVIEWING || link?.reviewPending === true) {
      if (handle !== undefined) {
        return { outcome: 'review-ready', assignmentId: assignment?.id ?? handle.assignmentId };
      }
      const dispatch = row?.dispatch_json ? parseDispatch(row.dispatch_json) : null;
      if (dispatch !== null && assignment !== null) {
        return { outcome: 'review-resumable', assignmentId: assignment.id, dispatch };
      }
      return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
    }
    if (assignment === null) return { outcome: 'idle' };

    this.#eventBus.publish({
      eventType: PLAN_ASSIGNMENT_RECOVERY_STARTED,
      payload: { planId: row?.plan_id ?? null, taskId: runtimeTaskId, assignmentId: assignment.id },
    });

    const pool = this.#safePool(assignment.agentId);
    const reservation = row ? parseReservation(row.reservation_json) : null;
    const dispatch = row?.dispatch_json ? parseDispatch(row.dispatch_json) : null;
    const turnMayHaveStarted = row?.turn_may_have_started === 1 ||
      assignment.status === AssignmentStatus.ACTIVE ||
      pool?.state === 'OWNED';

    if (dispatch !== null && (task.status === TaskStatus.IMPLEMENTING || assignment.status === AssignmentStatus.ACTIVE)) {
      return { outcome: 'review-resumable', assignmentId: assignment.id, dispatch };
    }
    if (turnMayHaveStarted || assignment.status === AssignmentStatus.ACTIVE) {
      this.#blocked(assignment.id, runtimeTaskId, PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
      return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
    }
    if (assignment.status === AssignmentStatus.DISPATCHING) {
      if (reservation === null || !this.#canResumeDispatching(assignment.agentId, reservation, pool)) {
        this.#blocked(assignment.id, runtimeTaskId, PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
        return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
      }
      return { outcome: 'resumable', assignmentId: assignment.id, reservation };
    }
    if (assignment.status === AssignmentStatus.ACCEPTED) {
      if (!this.#canSafelyRequeue(assignment.agentId, assignment.id, pool)) {
        this.#blocked(assignment.id, runtimeTaskId, PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
        return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
      }
      return { outcome: 'requeue-safe', assignmentId: assignment.id };
    }
    return { outcome: 'idle' };
  }

  public ensureReserved(reservation: Readonly<AgentScheduleReservation>): void {
    const pool = this.#safePool(reservation.agentId);
    if (pool === null) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    if (isMatchingReservation(pool, reservation)) return;
    if (!isCleanPool(pool)) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    this.#agentPool.reserve(reservation.agentId, {
      taskId: reservation.taskId,
      assignmentId: reservation.assignmentId,
      specVersion: reservation.specVersion,
      profileHash: reservation.profileHash,
    });
  }

  public async requeue(assignmentId: string): Promise<AssignmentRecoveryResult> {
    const assignment = this.#assignments.getAssignment(assignmentId);
    if (assignment === null) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
    const pool = this.#safePool(assignment.agentId);
    if (!this.#canSafelyRequeue(assignment.agentId, assignment.id, pool)) {
      this.#blocked(assignment.id, assignment.taskId, PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
      return { outcome: 'reconciliation-required', code: PLAN_ASSIGNMENT_RECOVERY_REQUIRED };
    }
    if (pool?.state === 'FAILED' && pool.assignmentId === assignment.id) {
      await this.#agentPool.shutdown(assignment.agentId, assignment.id);
    }
    if (this.#safePool(assignment.agentId)?.reserved === true
      && this.#safePool(assignment.agentId)?.reservedAssignmentId === assignment.id) {
      this.#agentPool.releaseReservation(assignment.agentId, assignment.id);
    }
    this.#database.connection.transaction(() => {
      this.#assignments.requeueDispatchResidue(assignment.id);
      const row = this.#row(assignment.id);
      if (row) {
        this.#upsert({
          assignmentId: assignment.id,
          taskId: row.task_id,
          planId: row.plan_id,
          reservation: parseReservation(row.reservation_json),
          dispatchJson: row.dispatch_json,
          stage: 'REQUEUED',
          turnMayHaveStarted: false,
          revisionRound: row.revision_round,
        });
      }
    })();
    this.#eventBus.publish({
      eventType: PLAN_ASSIGNMENT_REQUEUED,
      payload: { oldAssignmentId: assignment.id, taskId: assignment.taskId },
    });
    return { outcome: 'requeued', oldAssignmentId: assignment.id };
  }

  public loadDispatch(assignmentId: string): Readonly<AssignmentDispatchResult> | null {
    const row = this.#row(assignmentId);
    return row?.dispatch_json ? parseDispatch(row.dispatch_json) : null;
  }

  #canResumeDispatching(
    _agentId: string,
    reservation: Readonly<AgentScheduleReservation>,
    pool: Readonly<AgentPoolEntrySnapshot> | null,
  ): boolean {
    if (pool === null) return false;
    return isMatchingReservation(pool, reservation) || isCleanPool(pool);
  }

  #canSafelyRequeue(
    _agentId: string,
    assignmentId: string,
    pool: Readonly<AgentPoolEntrySnapshot> | null,
  ): boolean {
    if (pool === null) return false;
    if (pool.state === 'OWNED' || pool.active) return false;
    if (pool.state === 'FAILED') {
      return pool.assignmentId === undefined || pool.assignmentId === assignmentId;
    }
    if (pool.busy || pool.assignmentId !== undefined) return false;
    if (pool.reserved) return pool.reservedAssignmentId === assignmentId;
    return isCleanPool(pool);
  }

  #safePool(agentId: string): Readonly<AgentPoolEntrySnapshot> | null {
    try {
      return this.#agentPool.getSnapshot(agentId);
    } catch {
      return null;
    }
  }

  #blocked(assignmentId: string, taskId: string, code: string): void {
    this.#eventBus.publish({
      eventType: PLAN_ASSIGNMENT_RECOVERY_BLOCKED,
      payload: { assignmentId, taskId, code },
    });
  }

  #row(assignmentId: string): RecoveryRow | undefined {
    return this.#database.connection
      .prepare('SELECT * FROM assignment_dispatch_recovery WHERE assignment_id = ?')
      .get(assignmentId) as RecoveryRow | undefined;
  }

  #rowByTask(taskId: string): RecoveryRow | undefined {
    return this.#database.connection
      .prepare(`SELECT * FROM assignment_dispatch_recovery WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(taskId) as RecoveryRow | undefined;
  }

  #upsert(input: {
    assignmentId: string;
    taskId: string;
    planId: string | null;
    reservation: Readonly<AgentScheduleReservation>;
    dispatchJson: string | null;
    stage: string;
    turnMayHaveStarted: boolean;
    revisionRound: number;
  }): void {
    const now = new Date().toISOString();
    this.#database.connection.prepare(`
      INSERT INTO assignment_dispatch_recovery
        (assignment_id, task_id, plan_id, reservation_json, dispatch_json, stage, turn_may_have_started,
         revision_round, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        task_id = excluded.task_id,
        plan_id = excluded.plan_id,
        reservation_json = excluded.reservation_json,
        dispatch_json = excluded.dispatch_json,
        stage = excluded.stage,
        turn_may_have_started = excluded.turn_may_have_started,
        revision_round = excluded.revision_round,
        updated_at = excluded.updated_at
    `).run(
      input.assignmentId,
      input.taskId,
      input.planId,
      JSON.stringify(input.reservation),
      input.dispatchJson,
      input.stage,
      input.turnMayHaveStarted ? 1 : 0,
      input.revisionRound,
      now,
    );
  }
}

function parseReservation(json: string): Readonly<AgentScheduleReservation> {
  const parsed = snapshotAgentScheduleReservation(JSON.parse(json) as unknown);
  if (parsed === null) throw coded(PLAN_ASSIGNMENT_RECOVERY_REQUIRED);
  return parsed;
}

function parseDispatch(json: string): Readonly<AssignmentDispatchResult> {
  return snapshotAssignmentDispatchResult(JSON.parse(json) as unknown);
}

function isMatchingReservation(
  pool: Readonly<AgentPoolEntrySnapshot>,
  reservation: Readonly<AgentScheduleReservation>,
): boolean {
  return pool.reserved && pool.state === 'IDLE' && !pool.busy && !pool.active &&
    pool.reservedTaskId === reservation.taskId &&
    pool.reservedAssignmentId === reservation.assignmentId &&
    pool.reservedSpecVersion === reservation.specVersion &&
    pool.reservedProfileHash === reservation.profileHash &&
    pool.taskId === undefined && pool.assignmentId === undefined;
}

function isCleanPool(pool: Readonly<AgentPoolEntrySnapshot>): boolean {
  return pool.state === 'IDLE' && !pool.busy && !pool.active && !pool.reserved &&
    pool.taskId === undefined && pool.assignmentId === undefined &&
    pool.specVersion === undefined && pool.profileHash === undefined && pool.sessionId === undefined;
}

function stageForError(code: string, fallback: string): string {
  if (code === 'AGENT_DISPATCH_WORKSPACE_FAILED') return 'WORKSPACE_FAILED';
  if (code === 'AGENT_DISPATCH_ACCEPT_FAILED' || code === 'AGENT_DISPATCH_WORKSPACE_STALE') return 'ASSIGNMENT_ACCEPTED';
  if (code === 'AGENT_DISPATCH_RUNTIME_START_FAILED') return 'RUNTIME_RESERVED';
  if (code === 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED') return 'RUNTIME_OWNED';
  if (code === 'AGENT_DISPATCH_TURN_FAILED') return 'TURN_STARTED';
  return fallback;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const codedError = error as Error & { code?: string };
    if (typeof codedError.code === 'string' && codedError.code.length > 0) return codedError.code;
    return error.message;
  }
  return PLAN_ASSIGNMENT_RECOVERY_REQUIRED;
}

function coded(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}
