import { AssignmentStatus, TaskStatus, type AgentStatus } from '../core/types.js';

/** Semantic stage. Database strings are mapped here and are not compared ad hoc. */
export type DurableExecutionStage =
  | 'INITIAL'
  | 'TURN_STARTED'
  | 'TURN_COMPLETED'
  | 'REVIEW_READY'
  | 'TERMINAL'
  | 'RECONCILIATION_REQUIRED';

export type RuntimeOwnershipState =
  | 'ABSENT'
  | 'OWNED'
  | 'STARTING'
  | 'STOPPING'
  | 'FAILED'
  | 'AMBIGUOUS';

export interface RevisionRecoverySnapshot {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly providerId: string;
  readonly revisionRound: number;
  readonly durableStage: DurableExecutionStage;
  readonly runtimeOwnership: RuntimeOwnershipState;
  readonly taskStatus: TaskStatus;
  readonly assignmentStatus: AssignmentStatus;
  readonly agentStatus: AgentStatus;
  readonly hasActiveReview: boolean;
  readonly reviewHandle?: string;
  readonly dispatchSha256?: string;
  readonly reservationSha256?: string;
  readonly executionProfileSha256?: string;
  readonly turnMayHaveStarted: boolean;
}

export type RevisionRecoveryDecision =
  | { kind: 'NOOP' }
  | { kind: 'RESUME_REVIEW_PREPARATION' }
  | { kind: 'CONVERGE_DURABLE_RESULT' }
  | { kind: 'KEEP_CURRENT_REVIEW' }
  | { kind: 'REBUILD_RUNTIME_FOR_REVISION' }
  | { kind: 'RECONCILIATION_REQUIRED'; reason: string };

export interface RuntimeOwnershipView {
  readonly state: string;
  readonly busy: boolean;
  readonly active: boolean;
  readonly reserved: boolean;
  readonly taskId?: string;
  readonly assignmentId?: string;
  readonly specVersion?: string;
  readonly profileHash?: string;
  readonly sessionId?: string;
}

export interface RuntimeOwnershipExpectation {
  readonly assignmentId: string;
  readonly taskId?: string;
  readonly specVersion?: string;
  readonly profileHash?: string;
}

const INITIAL_STAGES = new Set([
  'BEFORE_WORKSPACE',
  'WORKSPACE_FAILED',
  'ASSIGNMENT_DISPATCHING',
  'ASSIGNMENT_ACCEPTED',
  'RUNTIME_RESERVED',
  'RUNTIME_OWNED',
  'REQUEUED',
]);

export function mapDurableStage(stage: string | undefined): DurableExecutionStage {
  if (stage === undefined) return 'INITIAL';
  if (stage === 'TURN_STARTED') return 'TURN_STARTED';
  if (stage === 'TURN_COMPLETED' || stage === 'REVIEW_PREPARING') return 'TURN_COMPLETED';
  if (stage === 'REVIEW_READY') return 'REVIEW_READY';
  if (stage === 'TERMINAL') return 'TERMINAL';
  if (INITIAL_STAGES.has(stage)) return 'INITIAL';
  return 'RECONCILIATION_REQUIRED';
}

export function classifyRuntimeOwnership(
  pool: RuntimeOwnershipView | undefined,
  expected: RuntimeOwnershipExpectation,
): { readonly state: RuntimeOwnershipState; readonly exact: boolean } {
  if (pool === undefined) return { state: 'ABSENT', exact: false };
  if (pool.state === 'STARTING') return { state: 'STARTING', exact: false };
  if (pool.state === 'STOPPING') return { state: 'STOPPING', exact: false };
  if (pool.state === 'FAILED') return { state: 'FAILED', exact: false };
  const clean = pool.state === 'IDLE' && !pool.busy && !pool.active && !pool.reserved
    && pool.taskId === undefined && pool.assignmentId === undefined
    && pool.specVersion === undefined && pool.profileHash === undefined && pool.sessionId === undefined;
  if (clean) return { state: 'ABSENT', exact: true };
  const exact = pool.state === 'OWNED' && pool.busy && !pool.active && !pool.reserved
    && pool.assignmentId === expected.assignmentId
    && (expected.taskId === undefined || pool.taskId === expected.taskId)
    && (expected.specVersion === undefined || pool.specVersion === expected.specVersion)
    && (expected.profileHash === undefined || pool.profileHash === expected.profileHash);
  if (exact) return { state: 'OWNED', exact: true };
  if (pool.state === 'OWNED') return { state: 'AMBIGUOUS', exact: false };
  return { state: 'AMBIGUOUS', exact: false };
}

/** Read-only. Callers persist the chosen outcome themselves. */
export function decideRevisionRecovery(snapshot: RevisionRecoverySnapshot): RevisionRecoveryDecision {
  if (snapshot.durableStage === 'RECONCILIATION_REQUIRED') {
    return { kind: 'RECONCILIATION_REQUIRED', reason: 'DURABLE_STAGE' };
  }
  if (snapshot.durableStage === 'TURN_STARTED' && snapshot.turnMayHaveStarted && !snapshot.hasActiveReview) {
    if (snapshot.runtimeOwnership === 'OWNED') return { kind: 'NOOP' };
    return { kind: 'RECONCILIATION_REQUIRED', reason: 'TURN_STARTED' };
  }
  if (snapshot.durableStage === 'TURN_COMPLETED' && !snapshot.hasActiveReview
    && snapshot.taskStatus === TaskStatus.IMPLEMENTING
    && snapshot.assignmentStatus === AssignmentStatus.ACTIVE) {
    if (snapshot.runtimeOwnership === 'ABSENT' || snapshot.runtimeOwnership === 'OWNED') {
      return { kind: 'CONVERGE_DURABLE_RESULT' };
    }
    return { kind: 'RECONCILIATION_REQUIRED', reason: 'TURN_COMPLETED_RUNTIME' };
  }
  if (snapshot.durableStage === 'REVIEW_READY' && snapshot.taskStatus === TaskStatus.REVIEWING && snapshot.hasActiveReview) {
    if (snapshot.runtimeOwnership === 'ABSENT') return { kind: 'REBUILD_RUNTIME_FOR_REVISION' };
    if (snapshot.runtimeOwnership === 'OWNED') return { kind: 'KEEP_CURRENT_REVIEW' };
    return { kind: 'RECONCILIATION_REQUIRED', reason: 'REVIEW_READY_RUNTIME' };
  }
  if (snapshot.durableStage === 'TERMINAL') return { kind: 'NOOP' };
  return { kind: 'NOOP' };
}
