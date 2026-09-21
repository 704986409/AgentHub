import { createHash } from 'node:crypto';
import { AgentStatus, AssignmentStatus, TaskStatus } from '../core/types.js';
import type { AgentHubWorkerResult } from '../protocol/AgentHubWorkerResult.js';
import type { AgentPool, AgentPoolEntrySnapshot } from '../runtime/AgentPool.js';
import type { AgentProviderTurnResult } from '../runtime/providers/AgentProvider.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AssignmentManager } from '../services/assignment-manager.js';
import type { TaskManager } from '../services/task-manager.js';
import {
  GitTaskCommitError, GitWorktreeManager, createReviewEvidence,
  type BuildTestEvidencePlan, type GitWorkspaceChangeSnapshot,
  type ReviewEvidence,
} from '../workspace/index.js';
import { type AssignmentDispatchResult } from './AssignmentDispatcher.js';
import { dispatchDigest, turnResultForDigest } from './dispatch/AssignmentDispatchContract.js';
import type { PlanExecutionRecoveryService } from '../lifecycle/plan-execution-recovery.js';
import type { RuntimeOwnershipState } from '../lifecycle/revision-recovery-state.js';
import { CompletionCoordinator } from './lifecycle/CompletionCoordinator.js';
import { LifecycleConvergence } from './lifecycle/LifecycleConvergence.js';
import { RuntimeGuard } from './lifecycle/RuntimeGuard.js';
import { ReviewPreparationCoordinator } from './lifecycle/ReviewPreparationCoordinator.js';
import { RevisionCoordinator, RevisionTurnError } from './lifecycle/RevisionCoordinator.js';
import {
  TaskLifecycleError,
  isRecord,
  lifecycleError,
  lifecycleReceiptKey,
  lifecycleResult,
  snapshotApplyRequest,
  snapshotPrepareRequest,
  sourceMatchesEvidence,
  type ApplyTaskReviewRequest,
  type ApplyTaskReviewSnapshot,
  type PrepareTaskReviewRequest,
  type TaskLifecyclePreparationResult,
  type TaskLifecycleReviewResult,
  type TaskReviewBundle,
} from './lifecycle/TaskLifecycleContract.js';

export { TaskLifecycleError, snapshotTaskReviewBundle } from './lifecycle/TaskLifecycleContract.js';
export type {
  ApplyTaskReviewRequest,
  PrepareTaskReviewRequest,
  TaskLifecycleErrorCode,
  TaskLifecyclePreparationResult,
  TaskLifecycleReviewResult,
  TaskReviewBundle,
} from './lifecycle/TaskLifecycleContract.js';

const fences = new WeakMap<AssignmentManager, Set<string>>();
export interface TaskLifecycleOrchestratorOptions {
  readonly taskManager: TaskManager; readonly agentRegistry: AgentRegistry;
  readonly assignmentManager: AssignmentManager; readonly agentPool: AgentPool;
  readonly worktreeManager: GitWorktreeManager;
  readonly reviewTransitions?: {
    commitPrepared(bundle: TaskReviewBundle, persistReviewing: () => void): void;
    retireForRevision?(taskId: string, priorHandle: string): number;
  };
  readonly assignmentRecovery?: PlanExecutionRecoveryService;
  readonly revisionRecoveryFailpoint?: { afterRevisionTurnDurableBeforeReview?: () => void };
}
interface ReviewPreparationInput {
  readonly dispatch: Readonly<AssignmentDispatchResult>; readonly workerResult: AgentHubWorkerResult;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
}

type ApplySnapshot = ApplyTaskReviewSnapshot;
interface TurnConsumptionContext {
  readonly source: 'LIVE' | 'DURABLE_RECOVERY';
  readonly runtimeOwnership: RuntimeOwnershipState;
}

export class TaskLifecycleOrchestrator {
  readonly #tasks: TaskManager; readonly #agents: AgentRegistry;
  readonly #assignments: AssignmentManager; readonly #pool: AgentPool;
  readonly #worktrees: GitWorktreeManager;
  readonly #reviewPreparation: ReviewPreparationCoordinator;
  readonly #completionCoordinator: CompletionCoordinator;
  readonly #runtimeGuard: RuntimeGuard;
  readonly #convergence: LifecycleConvergence;
  readonly #revisionCoordinator: RevisionCoordinator;
  readonly #reviewTransitions: TaskLifecycleOrchestratorOptions['reviewTransitions'];
  readonly #assignmentRecovery: PlanExecutionRecoveryService | undefined;
  readonly #revisionRecoveryFailpoint: TaskLifecycleOrchestratorOptions['revisionRecoveryFailpoint'];
  readonly #localRounds = new Map<string, number>();

  public constructor(options: TaskLifecycleOrchestratorOptions) {
    if (!isRecord(options) || !(options.worktreeManager instanceof GitWorktreeManager)) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
    }
    this.#tasks = options.taskManager; this.#agents = options.agentRegistry;
    this.#assignments = options.assignmentManager; this.#pool = options.agentPool;
    this.#worktrees = options.worktreeManager;
    this.#reviewTransitions = options.reviewTransitions;
    this.#assignmentRecovery = options.assignmentRecovery;
    this.#revisionRecoveryFailpoint = options.revisionRecoveryFailpoint;
    this.#reviewPreparation = new ReviewPreparationCoordinator(this.#worktrees);
    this.#completionCoordinator = new CompletionCoordinator(this.#worktrees);
    this.#runtimeGuard = new RuntimeGuard({ pool: this.#pool, assignments: this.#assignments, tasks: this.#tasks, agents: this.#agents });
    this.#convergence = new LifecycleConvergence(this.#assignments, this.#tasks);
    this.#revisionCoordinator = new RevisionCoordinator(this.#pool);
  }

  public prepareReview(request: PrepareTaskReviewRequest): Promise<TaskLifecyclePreparationResult> {
    let input: ReturnType<typeof snapshotPrepareRequest>;
    try { input = snapshotPrepareRequest(request); } catch (error) { return rejectPreserving(error); }
    return this.#withFence(input.dispatch.taskId, async () => {
      await this.#requireExecution(input.dispatch, TaskStatus.IMPLEMENTING);
      return this.#handleTurn({ dispatch: input.dispatch, turnResult: input.dispatch.turnResult,
        buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions });
    });
  }

  public consumeCompletedTurn(request: PrepareTaskReviewRequest): Promise<TaskLifecyclePreparationResult> {
    let input: ReturnType<typeof snapshotPrepareRequest>;
    try { input = snapshotPrepareRequest(request); } catch (error) { return rejectPreserving(error); }
    return this.#withFence(input.dispatch.taskId, () => this.#consumeCompletedTurn(input));
  }

  public applyReview(request: ApplyTaskReviewRequest): Promise<TaskLifecycleReviewResult> {
    let input: ApplySnapshot;
    try { input = snapshotApplyRequest(request); } catch (error) { return rejectPreserving(error); }
    return this.#withFence(input.reviewBundle.taskId, async () => this.#apply(input));
  }

  async #apply(input: ApplySnapshot): Promise<TaskLifecycleReviewResult> {
    const bundle = input.reviewBundle;
    let review: ReviewEvidence;
    try { review = createReviewEvidence(bundle.buildTestEvidence, input.decision); }
    catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST'); }
    const receiptKey = lifecycleReceiptKey(bundle, review, input);
    const receipt = this.#convergence.getReceipt(receiptKey);
    if (receipt !== undefined) {
      if (this.#convergence.isCompletionConverged(bundle.assignmentId)) return receipt.result;
      try { this.#convergence.finalizeCompleted(bundle.assignmentId, receipt.mergeResult); }
      catch { throw lifecycleError('TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED', receipt.mergeResult); }
      return receipt.result;
    }
    await this.#requireBundleFresh(bundle);
    if (review.verdict === 'BLOCK') {
      await this.#shutdownIfRuntimeOwned(bundle); this.#convergence.finalizeFailed(bundle.assignmentId);
      return lifecycleResult({ outcome: 'failed' as const, taskId: bundle.taskId, assignmentId: bundle.assignmentId, reviewEvidence: review });
    }
    if (review.verdict === 'REQUEST_REVISION') return this.#revise(bundle, review, input);
    if (bundle.taskCommit.outcome === 'no-changes') {
      this.#completionCoordinator.validateNoChangeCompletion(bundle, input.allowNoChangeCompletion);
      const noChangeGate = await this.#completionCoordinator.evaluateNoChangeGate(bundle, review, input.mergePolicy);
      await this.#requireBundleFresh(bundle); await this.#shutdownIfRuntimeOwned(bundle);
      const finalNoChangeGate = await this.#completionCoordinator.evaluateNoChangeGate(bundle, review, input.mergePolicy);
      this.#completionCoordinator.assertNoChangeGateIdentity(noChangeGate, finalNoChangeGate);
      const result = lifecycleResult({ outcome: 'completed-no-change' as const, taskId: bundle.taskId, reviewEvidence: review });
      try { this.#convergence.finalizeCompleted(bundle.assignmentId); }
      catch (error) {
        if (error instanceof TaskLifecycleError &&
          error.code === 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED') {
          this.#convergence.rememberReceipt(receiptKey, { result });
        }
        throw error;
      }
      return result;
    }
    if (input.targetBranch === undefined) throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
    const gate = await this.#completionCoordinator.evaluateMergeGate(bundle, review, input.mergePolicy);
    if (!gate.eligible) return lifecycleResult({ outcome: 'merge-denied' as const, taskId: bundle.taskId,
      reviewEvidence: review, mergeGate: gate });
    await this.#shutdownIfRuntimeOwned(bundle); this.#runtimeGuard.requirePersistentAfterShutdown(bundle);
    const merge = await this.#completionCoordinator.merge(bundle, review, input.targetBranch, gate, input.mergePolicy);
    const result = lifecycleResult({ outcome: 'completed' as const, taskId: bundle.taskId,
      reviewEvidence: review, mergeGate: gate, mergeResult: merge });
    try { this.#convergence.finalizeCompleted(bundle.assignmentId, merge); }
    catch (error) {
      if (error instanceof TaskLifecycleError &&
        error.code === 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED') {
        this.#convergence.rememberReceipt(receiptKey, { mergeResult: merge, result });
      }
      throw error;
    }
    return result;
  }

  async #revise(bundle: TaskReviewBundle, review: ReviewEvidence, input: ApplySnapshot): Promise<TaskLifecycleReviewResult> {
    const task = this.#tasks.getTask(bundle.taskId);
    if (task === null) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    await this.#ensureRevisionRuntime(bundle);
    const revisionPlan = this.#revisionCoordinator.prepare(review, task, bundle);
    const round = this.#reviewTransitions?.retireForRevision?.(bundle.taskId, bundle.reviewBundleSha256)
      ?? (() => {
        const next = (this.#localRounds.get(bundle.taskId) ?? 0) + 1;
        this.#localRounds.set(bundle.taskId, next);
        return next;
      })();
    const dispatch = revisionBundleToDispatch(bundle, round);
    this.#assignmentRecovery?.persistRevisionDispatch(dispatch, round);
    this.#transition(bundle.taskId, TaskStatus.REVISION_REQUIRED);
    this.#transition(bundle.taskId, TaskStatus.IMPLEMENTING);
    await this.#requireExecution(dispatch, TaskStatus.IMPLEMENTING);
    let turn: AgentProviderTurnResult;
    try { turn = await this.#revisionCoordinator.run(revisionPlan); }
    catch (error) {
      if (!(error instanceof RevisionTurnError)) throw error;
      try { await this.#runtimeGuard.shutdown(bundle); }
      catch {
        try { this.#worktrees.quarantineWorkspace(bundle.taskId); }
        catch { /* unresolved runtime ownership remains authoritative */ }
        throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED');
      }
      let sourceChanged = true;
      try {
        const current = await this.#captureReviewSource(bundle.taskId);
        sourceChanged = !sameSourceIdentity(bundle.source, current) || !cleanSource(current);
      } catch { /* capture ambiguity is quarantined below */ }
      if (sourceChanged) {
        try { this.#worktrees.quarantineWorkspace(bundle.taskId); }
        catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
      }
      try { this.#convergence.suspend(bundle.assignmentId, TaskStatus.BLOCKED); }
      catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
      throw lifecycleError('TASK_LIFECYCLE_REVISION_FAILED');
    }
    const completed = dispatchWithTurn(dispatch, turn);
    let revised: TaskLifecyclePreparationResult;
    if (this.#assignmentRecovery !== undefined) {
      this.#assignmentRecovery.persistDispatch(completed.assignmentId, completed);
      this.#revisionRecoveryFailpoint?.afterRevisionTurnDurableBeforeReview?.();
      revised = await this.#consumeCompletedTurn({ dispatch: completed,
        buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions });
    } else {
      revised = await this.#handleTurn({ dispatch: completed, turnResult: turn,
        buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions });
    }
    return revised.outcome === 'review-ready'
      ? lifecycleResult({ outcome: 'review-ready' as const, reviewEvidence: review, reviewBundle: revised.reviewBundle })
      : revised;
  }

  async #consumeCompletedTurn(input: ReturnType<typeof snapshotPrepareRequest>): Promise<TaskLifecyclePreparationResult> {
    if (!this.#assignmentRecovery) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    const stage = this.#assignmentRecovery.durableStage(input.dispatch.assignmentId);
    if (stage !== 'TURN_COMPLETED') throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    const durable = this.#assignmentRecovery.durableRevision(input.dispatch.assignmentId);
    if (durable !== undefined && durable.revisionRound >= 1) {
      try { this.#assignmentRecovery.assertCompletedRevisionIdentity(input.dispatch); }
      catch { throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION'); }
    }
    try { await this.#captureReviewSource(input.dispatch.taskId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE'); }
    await this.#runtimeGuard.ensureCleanAfterCompletedTurn(input.dispatch);
    const prepared = await this.#handleTurn({ dispatch: input.dispatch, turnResult: input.dispatch.turnResult,
      buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions },
      { source: 'DURABLE_RECOVERY', runtimeOwnership: 'ABSENT' });
    if (prepared.outcome === 'review-ready') this.#assignmentRecovery.markReviewReady(input.dispatch.assignmentId);
    else this.#assignmentRecovery.markTerminal(input.dispatch.assignmentId);
    return prepared;
  }

  async #handleTurn(input: Omit<ReviewPreparationInput, 'workerResult'> &
    { readonly turnResult: AgentProviderTurnResult },
    context: TurnConsumptionContext = { source: 'LIVE', runtimeOwnership: 'OWNED' }): Promise<TaskLifecyclePreparationResult> {
    const { dispatch, turnResult } = input;
    if (turnResult.protocol !== 'worker-result') throw lifecycleError('TASK_LIFECYCLE_UNSUPPORTED_TURN_PROTOCOL');
    const durable = context.source === 'DURABLE_RECOVERY';
    if (durable && context.runtimeOwnership !== 'ABSENT') {
      throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED');
    }
    if (!turnResult.protocolValid) {
      await this.#releaseLiveRuntime(dispatch, durable);
      this.#convergence.suspend(dispatch.assignmentId, TaskStatus.BLOCKED);
      return lifecycleResult({ outcome: 'blocked' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    const worker = turnResult.workerResult;
    if (worker.outcome === 'FAILED') {
      await this.#releaseLiveRuntime(dispatch, durable);
      this.#convergence.finalizeFailed(dispatch.assignmentId);
      return lifecycleResult({ outcome: 'failed' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    if (worker.outcome === 'BLOCKED' || worker.outcome === 'NEEDS_INPUT') {
      await this.#releaseLiveRuntime(dispatch, durable);
      const target = worker.outcome === 'BLOCKED' ? TaskStatus.BLOCKED : TaskStatus.WAITING_INPUT;
      this.#convergence.suspend(dispatch.assignmentId, target);
      return lifecycleResult({ outcome: worker.outcome === 'BLOCKED' ? 'blocked' as const : 'waiting-input' as const,
        taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    await this.#requireExecution(dispatch, TaskStatus.IMPLEMENTING, { requireOwnedPool: !durable });
    let prepared: Awaited<ReturnType<ReviewPreparationCoordinator['prepare']>>;
    try {
      prepared = await this.#reviewPreparation.prepare({ dispatch, workerResult: worker,
        buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions });
    } catch (error) {
      if (error instanceof GitTaskCommitError) throw lifecycleError('TASK_LIFECYCLE_COMMIT_FAILED');
      throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
    }
    if (prepared.outcome === 'evidence-integrity-blocked') return this.#blockEvidenceIntegrity(dispatch, durable);
    const persistReviewing = (): void => { this.#transition(dispatch.taskId, TaskStatus.REVIEWING); };
    if (this.#reviewTransitions !== undefined) {
      this.#reviewTransitions.commitPrepared(prepared.reviewBundle, persistReviewing);
    } else {
      persistReviewing();
    }
    return lifecycleResult({ outcome: 'review-ready' as const, reviewBundle: prepared.reviewBundle });
  }

  async #releaseLiveRuntime(dispatch: Pick<AssignmentDispatchResult, 'agentId' | 'assignmentId' | 'taskId'>, durable: boolean): Promise<void> {
    if (durable) return;
    await this.#runtimeGuard.ensureCleanAfterCompletedTurn(dispatch);
  }

  async #ensureRevisionRuntime(bundle: TaskReviewBundle): Promise<void> {
    const dispatch = bundleToDispatch(bundle);
    await this.#requireExecution(dispatch, TaskStatus.REVIEWING, { requireOwnedPool: false });
    const assignment = this.#assignments.getAssignment(bundle.assignmentId);
    if (assignment === null) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    const ownership = this.#runtimeGuard.inspectOwnership(bundle.agentId, bundle.assignmentId, {
      taskId: bundle.taskId, specVersion: assignment.specVersion, profileHash: assignment.profileHash,
    });
    if (ownership.state === 'OWNED' && ownership.exact) {
      await this.#requireExecution(dispatch, TaskStatus.REVIEWING);
      return;
    }
    if (ownership.state !== 'ABSENT') throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    let workspace;
    try { workspace = await this.#worktrees.inspectWorkspace(bundle.taskId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE'); }
    if (workspace === undefined || workspace.worktreePath.length === 0) throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE');
    try {
      await this.#pool.start(bundle.agentId, {
        taskId: bundle.taskId,
        assignmentId: bundle.assignmentId,
        specVersion: assignment.specVersion,
        profileHash: assignment.profileHash,
      }, { workspacePath: workspace.worktreePath });
    } catch {
      throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    }
    await this.#requireExecution(dispatch, TaskStatus.REVIEWING);
  }

  async #blockEvidenceIntegrity(dispatch: Readonly<AssignmentDispatchResult>, durable = false): Promise<TaskLifecyclePreparationResult> {
    await this.#releaseLiveRuntime(dispatch, durable);
    this.#convergence.suspend(dispatch.assignmentId, TaskStatus.BLOCKED);
    return lifecycleResult({ outcome: 'blocked' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
  }

  async #shutdownIfRuntimeOwned(binding: { readonly agentId: string; readonly assignmentId: string; readonly taskId?: string }): Promise<void> {
    const ownership = this.#runtimeGuard.inspectOwnership(binding.agentId, binding.assignmentId, {
      ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
    });
    if (this.#assignmentRecovery?.durableStage(binding.assignmentId) === 'REVIEW_READY' && ownership.state === 'ABSENT') return;
    await this.#runtimeGuard.shutdown(binding);
  }

  async #requireBundleFresh(bundle: TaskReviewBundle): Promise<void> {
    const ownership = this.#runtimeGuard.inspectOwnership(bundle.agentId, bundle.assignmentId, { taskId: bundle.taskId });
    const recovered = this.#assignmentRecovery?.durableStage(bundle.assignmentId) === 'REVIEW_READY'
      && ownership.state === 'ABSENT';
    await this.#requireExecution(bundleToDispatch(bundle), TaskStatus.REVIEWING, { requireOwnedPool: !recovered });
    if (!sourceMatchesEvidence(bundle.source, bundle.buildTestEvidence) ||
      bundle.source.headCommit !== bundle.taskCommit.headAfter || !cleanSource(bundle.source)) {
      throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE');
    }
    let current: GitWorkspaceChangeSnapshot;
    try { current = await this.#captureReviewSource(bundle.taskId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE'); }
    if (!sameSourceIdentity(bundle.source, current)) throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE');
  }

  async #requireExecution(dispatch: Pick<AssignmentDispatchResult, 'taskId' | 'projectId' | 'agentId' | 'providerId' |
    'assignmentId' | 'executionProfileSha256' | 'workspace'>, status: TaskStatus,
    options?: { readonly requireOwnedPool?: boolean }): Promise<void> {
    const assignment = this.#assignments.getAssignment(dispatch.assignmentId);
    const task = this.#tasks.getTask(dispatch.taskId);
    const agent = this.#agents.getAgent(dispatch.agentId);
    if (assignment === null || assignment.id !== dispatch.assignmentId || assignment.taskId !== dispatch.taskId ||
      assignment.agentId !== dispatch.agentId || assignment.status !== AssignmentStatus.ACTIVE || task === null ||
      task.projectId !== dispatch.projectId || task.status !== status || task.assignedAgentId !== dispatch.agentId ||
      task.assignmentId !== dispatch.assignmentId || agent === null || !agent.enabled || agent.status !== AgentStatus.BUSY ||
      agent.provider !== dispatch.providerId) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    let executionHash: string;
    try { executionHash = this.#agents.calculateExecutionProfileHash(agent.id); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_PROFILE'); }
    if (executionHash !== dispatch.executionProfileSha256) throw lifecycleError('TASK_LIFECYCLE_STALE_PROFILE');
    if (options?.requireOwnedPool !== false) {
      let pool: Readonly<AgentPoolEntrySnapshot>;
      try { pool = this.#pool.getSnapshot(agent.id); } catch { throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION'); }
      if (!ownedPool(pool, dispatch, assignment.specVersion, assignment.profileHash)) {
        throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
      }
    }
    let workspace;
    try { workspace = await this.#worktrees.inspectWorkspace(dispatch.taskId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE'); }
    if (workspace === undefined || workspace.taskId !== dispatch.taskId ||
      workspace.branchName !== dispatch.workspace.branchName || workspace.baseCommit !== dispatch.workspace.baseCommit) {
      throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE');
    }
  }

  async #captureReviewSource(taskId: string): Promise<GitWorkspaceChangeSnapshot> {
    return this.#worktrees.captureWorkspaceChanges(taskId, { includePatchText: true,
      maxPatchBytes: 1024 * 1024, maxChangedPaths: 4096,
      maxFingerprintBytes: 64 * 1024 * 1024, maxIgnoredPaths: 4096 });
  }

  #transition(taskId: string, status: TaskStatus): void {
    try { this.#tasks.transitionTask(taskId, status); }
    catch { if (this.#tasks.getTask(taskId)?.status !== status) {
      throw lifecycleError('TASK_LIFECYCLE_REVIEW_TRANSITION_FAILED');
    } }
  }
  #withFence<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const active = fences.get(this.#assignments) ?? new Set<string>();
    if (active.has(taskId)) return rejectPreserving(lifecycleError('TASK_LIFECYCLE_TASK_BUSY'));
    if (!fences.has(this.#assignments)) fences.set(this.#assignments, active);
    active.add(taskId);
    return operation().finally(() => { active.delete(taskId); });
  }
}

function bundleToDispatch(bundle: TaskReviewBundle): AssignmentDispatchResult {
  return { version: 1, taskId: bundle.taskId, projectId: bundle.projectId, agentId: bundle.agentId,
    providerId: bundle.providerId, assignmentId: bundle.assignmentId,
    reservationSha256: bundle.reservationSha256, executionProfileSha256: bundle.executionProfileSha256,
    workspace: { branchName: bundle.source.branchName, baseCommit: bundle.source.baseCommit,
      headCommit: bundle.source.headCommit, created: false }, assignmentStatus: 'ACTIVE', taskStatus: 'IMPLEMENTING',
    turnResult: { protocol: 'worker-result', protocolValid: true, providerId: bundle.providerId,
      workerResult: bundle.workerResult }, dispatchSha256: bundle.dispatchSha256 };
}

function makeRevisionReservationSha(priorReservationSha: string, round: number, priorBundleSha: string): string {
  return createHash('sha256')
    .update(`AgentHub.RevisionReservation.v1\0${priorReservationSha}\0${String(round)}\0${priorBundleSha}`)
    .digest('hex');
}

function revisionBundleToDispatch(bundle: TaskReviewBundle, round: number): AssignmentDispatchResult {
  const reservationSha256 = makeRevisionReservationSha(bundle.reservationSha256, round, bundle.reviewBundleSha256);
  const identity = {
    version: 1 as const,
    taskId: bundle.taskId,
    projectId: bundle.projectId,
    agentId: bundle.agentId,
    providerId: bundle.providerId,
    assignmentId: bundle.assignmentId,
    reservationSha256,
    executionProfileSha256: bundle.executionProfileSha256,
    workspace: {
      branchName: bundle.source.branchName,
      baseCommit: bundle.source.baseCommit,
      headCommit: bundle.source.headCommit,
      created: false,
    },
    assignmentStatus: 'ACTIVE' as const,
    taskStatus: 'IMPLEMENTING' as const,
    turnResult: {
      protocol: 'worker-result' as const,
      protocolValid: true as const,
      providerId: bundle.providerId,
      workerResult: bundle.workerResult,
    },
  };
  const digestInput = {
    ...identity,
    turnProtocol: 'worker-result' as const,
    turnResult: turnResultForDigest(identity.turnResult),
  };
  const dispatchSha256 = dispatchDigest(digestInput);
  return { ...identity, dispatchSha256 };
}

function dispatchWithTurn(
  dispatch: AssignmentDispatchResult,
  turn: AgentProviderTurnResult,
): AssignmentDispatchResult {
  const identity = {
    version: dispatch.version,
    taskId: dispatch.taskId,
    projectId: dispatch.projectId,
    agentId: dispatch.agentId,
    providerId: dispatch.providerId,
    assignmentId: dispatch.assignmentId,
    reservationSha256: dispatch.reservationSha256,
    executionProfileSha256: dispatch.executionProfileSha256,
    workspace: dispatch.workspace,
    assignmentStatus: dispatch.assignmentStatus,
    taskStatus: dispatch.taskStatus,
    turnResult: turn,
  };
  const digestInput = {
    ...identity,
    turnProtocol: 'worker-result' as const,
    turnResult: turnResultForDigest(turn),
  };
  return { ...identity, dispatchSha256: dispatchDigest(digestInput) };
}
function ownedPool(pool: Readonly<AgentPoolEntrySnapshot>, dispatch: Pick<AssignmentDispatchResult,
  'taskId' | 'assignmentId'>, specVersion: string, profileHash: string): boolean {
  return pool.state === 'OWNED' && pool.busy && !pool.active && !pool.reserved &&
    pool.taskId === dispatch.taskId && pool.assignmentId === dispatch.assignmentId &&
    pool.specVersion === specVersion && pool.profileHash === profileHash;
}
function cleanSource(source: GitWorkspaceChangeSnapshot): boolean {
  return !source.hasConflicts && source.conflicts.length === 0 && source.staged.changes.length === 0 &&
    source.unstaged.changes.length === 0 && source.untracked.length === 0;
}
function sameSourceIdentity(left: GitWorkspaceChangeSnapshot, right: GitWorkspaceChangeSnapshot): boolean {
  return left.taskId === right.taskId && left.branchName === right.branchName &&
    left.baseCommit === right.baseCommit && left.headCommit === right.headCommit &&
    left.changeSetSha256 === right.changeSetSha256 && cleanSource(right);
}
function rejectPreserving(error: unknown): Promise<never> {
  return Promise.resolve().then(() => { throw error; });
}
