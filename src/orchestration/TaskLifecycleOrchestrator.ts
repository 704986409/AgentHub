import { createHash } from 'node:crypto';

import { AgentStatus, AssignmentStatus, TaskStatus, type Task } from '../core/types.js';
import type { AgentHubWorkerResult } from '../protocol/AgentHubWorkerResult.js';
import type { AgentPool, AgentPoolEntrySnapshot } from '../runtime/AgentPool.js';
import type { AgentProviderTurnResult } from '../runtime/providers/AgentProvider.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AssignmentManager } from '../services/assignment-manager.js';
import type { TaskManager } from '../services/task-manager.js';
import {
  GitMergeError, GitTaskCommitError, GitWorktreeManager, createReviewEvidence,
  type BuildTestEvidence, type BuildTestEvidencePlan, type GitWorkspaceChangeSnapshot,
  type MergeGateDecision, type MergeGatePolicy, type ReviewDecisionInput,
  type ReviewEvidence, type TaskCommitResult, type TaskMergeResult,
} from '../workspace/index.js';
import { snapshotBuildTestEvidence, snapshotBuildTestEvidencePlan,
  snapshotBuildTestEvidenceOptions } from '../workspace/BuildTestEvidenceCollector.js';
import { canonicalChangeState, validateChangePath } from '../workspace/GitWorkspaceChangeCapture.js';
import { snapshotMergeGatePolicy } from '../workspace/MergeGate.js';
import { snapshotAssignmentDispatchResult, snapshotAssignmentTurnResult,
  type AssignmentDispatchResult } from './AssignmentDispatcher.js';

const fences = new WeakMap<AssignmentManager, Set<string>>();
interface LifecycleReceipt {
  readonly mergeResult?: TaskMergeResult;
  readonly result: TaskLifecycleReviewResult;
}
const receipts = new WeakMap<AssignmentManager, Map<string, LifecycleReceipt>>();
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const maxRevisionPromptBytes = 1024 * 1024;

export type TaskLifecycleErrorCode =
  | 'TASK_LIFECYCLE_INVALID_REQUEST' | 'TASK_LIFECYCLE_TASK_BUSY'
  | 'TASK_LIFECYCLE_INVALID_DISPATCH_RESULT' | 'TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'
  | 'TASK_LIFECYCLE_STALE_EXECUTION' | 'TASK_LIFECYCLE_STALE_SOURCE'
  | 'TASK_LIFECYCLE_STALE_PROFILE' | 'TASK_LIFECYCLE_UNSUPPORTED_TURN_PROTOCOL'
  | 'TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED' | 'TASK_LIFECYCLE_COMMIT_FAILED'
  | 'TASK_LIFECYCLE_EVIDENCE_FAILED' | 'TASK_LIFECYCLE_REVIEW_TRANSITION_FAILED'
  | 'TASK_LIFECYCLE_REVISION_FAILED' | 'TASK_LIFECYCLE_GATE_DENIED'
  | 'TASK_LIFECYCLE_MERGE_FAILED' | 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED'
  | 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED';

export class TaskLifecycleError extends Error {
  public readonly mergeResult: TaskMergeResult | undefined;
  public constructor(public readonly code: TaskLifecycleErrorCode, mergeResult?: TaskMergeResult) {
    super(code); this.name = 'TaskLifecycleError'; this.mergeResult = mergeResult;
  }
}

export interface PrepareTaskReviewRequest {
  readonly dispatchResult: AssignmentDispatchResult;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions?: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
}
export interface ApplyTaskReviewRequest {
  readonly reviewBundle: TaskReviewBundle;
  readonly decision: ReviewDecisionInput;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions?: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  readonly targetBranch?: string;
  readonly mergePolicy?: MergeGatePolicy;
  readonly allowNoChangeCompletion?: boolean;
}
export interface TaskReviewBundle {
  readonly version: 1;
  readonly taskId: string; readonly projectId: string; readonly agentId: string;
  readonly assignmentId: string; readonly providerId: string; readonly reservationSha256: string;
  readonly dispatchSha256: string; readonly executionProfileSha256: string;
  readonly taskCommit: TaskCommitResult; readonly buildTestEvidence: BuildTestEvidence;
  readonly source: GitWorkspaceChangeSnapshot; readonly workerResult: AgentHubWorkerResult;
  readonly reviewBundleSha256: string;
}
interface LifecycleBase { readonly lifecycleSha256: string }
export type TaskLifecyclePreparationResult =
  | (LifecycleBase & { readonly outcome: 'review-ready'; readonly reviewBundle: TaskReviewBundle; readonly reviewEvidence?: ReviewEvidence })
  | (LifecycleBase & { readonly outcome: 'blocked' | 'waiting-input'; readonly taskId: string; readonly assignmentId: string })
  | (LifecycleBase & { readonly outcome: 'failed'; readonly taskId: string; readonly assignmentId: string; readonly reviewEvidence?: ReviewEvidence });
export type TaskLifecycleReviewResult =
  | TaskLifecyclePreparationResult
  | (LifecycleBase & { readonly outcome: 'merge-denied'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence; readonly mergeGate: MergeGateDecision })
  | (LifecycleBase & { readonly outcome: 'completed'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence; readonly mergeGate: MergeGateDecision; readonly mergeResult: TaskMergeResult })
  | (LifecycleBase & { readonly outcome: 'completed-no-change'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence });
export interface TaskLifecycleOrchestratorOptions {
  readonly taskManager: TaskManager; readonly agentRegistry: AgentRegistry;
  readonly assignmentManager: AssignmentManager; readonly agentPool: AgentPool;
  readonly worktreeManager: GitWorktreeManager;
}
interface ReviewPreparationInput {
  readonly dispatch: Readonly<AssignmentDispatchResult>; readonly workerResult: AgentHubWorkerResult;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
}

type ApplySnapshot = ReturnType<typeof snapshotApplyRequest>;

export class TaskLifecycleOrchestrator {
  readonly #tasks: TaskManager; readonly #agents: AgentRegistry;
  readonly #assignments: AssignmentManager; readonly #pool: AgentPool;
  readonly #worktrees: GitWorktreeManager;

  public constructor(options: TaskLifecycleOrchestratorOptions) {
    if (!isRecord(options) || !(options.worktreeManager instanceof GitWorktreeManager)) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
    }
    this.#tasks = options.taskManager; this.#agents = options.agentRegistry;
    this.#assignments = options.assignmentManager; this.#pool = options.agentPool;
    this.#worktrees = options.worktreeManager;
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
    const receipt = receipts.get(this.#assignments)?.get(receiptKey);
    if (receipt !== undefined) {
      if (this.#isCompletionConverged(bundle.assignmentId)) return receipt.result;
      try { this.#finalizeCompleted(bundle.assignmentId, receipt.mergeResult); }
      catch { throw lifecycleError('TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED', receipt.mergeResult); }
      return receipt.result;
    }
    await this.#requireBundleFresh(bundle);
    if (review.verdict === 'BLOCK') {
      await this.#shutdown(bundle); this.#finalizeFailed(bundle.assignmentId);
      return lifecycleResult({ outcome: 'failed' as const, taskId: bundle.taskId, assignmentId: bundle.assignmentId, reviewEvidence: review });
    }
    if (review.verdict === 'REQUEST_REVISION') return this.#revise(bundle, review, input);
    if (bundle.taskCommit.outcome === 'no-changes') {
      if (!input.allowNoChangeCompletion || !buildPassed(bundle.buildTestEvidence) ||
        bundle.taskCommit.headAfter !== bundle.taskCommit.baseCommit || !cleanSource(bundle.source)) {
        throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
      }
      let noChangeGate: MergeGateDecision;
      try {
        noChangeGate = await this.#worktrees.evaluateMergeGate(
          bundle.taskId, bundle.buildTestEvidence, review, input.mergePolicy,
        );
      } catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
      if (noChangeGate.eligible || noChangeGate.reasons.length !== 1 ||
        noChangeGate.reasons[0] !== 'NO_COMMITTED_CHANGES') {
        throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
      }
      await this.#requireBundleFresh(bundle); await this.#shutdown(bundle);
      let finalNoChangeGate: MergeGateDecision;
      try {
        finalNoChangeGate = await this.#worktrees.evaluateMergeGate(
          bundle.taskId, bundle.buildTestEvidence, review, input.mergePolicy,
        );
      } catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
      if (finalNoChangeGate.eligible || finalNoChangeGate.reasons.length !== 1 ||
        finalNoChangeGate.reasons[0] !== 'NO_COMMITTED_CHANGES' ||
        finalNoChangeGate.changeSetSha256 !== noChangeGate.changeSetSha256 ||
        finalNoChangeGate.sourceVisibilitySha256 !== noChangeGate.sourceVisibilitySha256 ||
        finalNoChangeGate.buildTestEvidenceSha256 !== noChangeGate.buildTestEvidenceSha256 ||
        finalNoChangeGate.reviewEvidenceSha256 !== noChangeGate.reviewEvidenceSha256) {
        throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
      }
      const result = lifecycleResult({ outcome: 'completed-no-change' as const, taskId: bundle.taskId, reviewEvidence: review });
      try { this.#finalizeCompleted(bundle.assignmentId); }
      catch (error) {
        if (error instanceof TaskLifecycleError &&
          error.code === 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED') {
          this.#rememberReceipt(receiptKey, { result });
        }
        throw error;
      }
      return result;
    }
    if (input.targetBranch === undefined) throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
    let gate: MergeGateDecision;
    try { gate = await this.#worktrees.evaluateMergeGate(bundle.taskId, bundle.buildTestEvidence, review, input.mergePolicy); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
    if (!gate.eligible) return lifecycleResult({ outcome: 'merge-denied' as const, taskId: bundle.taskId,
      reviewEvidence: review, mergeGate: gate });
    await this.#shutdown(bundle); this.#requirePersistentAfterShutdown(bundle);
    let merge: TaskMergeResult;
    try { merge = await this.#worktrees.mergeTaskWorkspace({ taskId: bundle.taskId,
      targetBranch: input.targetBranch, buildEvidence: bundle.buildTestEvidence, reviewEvidence: review,
      gateDecision: gate, gatePolicy: input.mergePolicy }); }
    catch (error) {
      if (error instanceof GitMergeError &&
        (error.code === 'GIT_MERGE_CLEANUP_FAILED' || error.code === 'GIT_MERGE_CONTRACT_VIOLATION')) {
        throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
      }
      throw lifecycleError('TASK_LIFECYCLE_MERGE_FAILED');
    }
    const result = lifecycleResult({ outcome: 'completed' as const, taskId: bundle.taskId,
      reviewEvidence: review, mergeGate: gate, mergeResult: merge });
    try { this.#finalizeCompleted(bundle.assignmentId, merge); }
    catch (error) {
      if (error instanceof TaskLifecycleError &&
        error.code === 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED') {
        this.#rememberReceipt(receiptKey, { mergeResult: merge, result });
      }
      throw error;
    }
    return result;
  }

  async #revise(bundle: TaskReviewBundle, review: ReviewEvidence, input: ApplySnapshot): Promise<TaskLifecycleReviewResult> {
    const task = this.#tasks.getTask(bundle.taskId);
    if (task === null) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    const prompt = revisionPrompt(review, task);
    this.#transition(bundle.taskId, TaskStatus.REVISION_REQUIRED);
    this.#transition(bundle.taskId, TaskStatus.IMPLEMENTING);
    await this.#requireExecution(bundleToDispatch(bundle), TaskStatus.IMPLEMENTING);
    let raw: AgentProviderTurnResult;
    try { raw = await this.#pool.runTurn(bundle.agentId, bundle.assignmentId, { prompt, protocol: 'worker-result' }); }
    catch {
      let sourceChanged = true;
      try {
        await this.#shutdown(bundle);
        const current = await this.#captureReviewSource(bundle.taskId);
        sourceChanged = !sameSourceIdentity(bundle.source, current) || !cleanSource(current);
      } catch { /* capture ambiguity is quarantined below */ }
      if (sourceChanged) {
        try { this.#worktrees.quarantineWorkspace(bundle.taskId); }
        catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
      }
      try { this.#suspend(bundle.assignmentId, TaskStatus.BLOCKED); }
      catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
      throw lifecycleError('TASK_LIFECYCLE_REVISION_FAILED');
    }
    let turn: AgentProviderTurnResult;
    try { turn = snapshotAssignmentTurnResult(raw, 'worker-result', bundle.providerId); }
    catch {
      turn = { protocol: 'worker-result', protocolValid: false, providerId: bundle.providerId,
        failure: { kind: 'schema_invalid', message: 'invalid revision result' } };
    }
    const revised = await this.#handleTurn({ dispatch: bundleToDispatch(bundle), turnResult: turn,
      buildTestPlan: input.buildTestPlan, evidenceOptions: input.evidenceOptions });
    return revised.outcome === 'review-ready'
      ? lifecycleResult({ outcome: 'review-ready' as const, reviewEvidence: review, reviewBundle: revised.reviewBundle })
      : revised;
  }

  async #handleTurn(input: Omit<ReviewPreparationInput, 'workerResult'> &
    { readonly turnResult: AgentProviderTurnResult }): Promise<TaskLifecyclePreparationResult> {
    const { dispatch, turnResult } = input;
    if (turnResult.protocol !== 'worker-result') throw lifecycleError('TASK_LIFECYCLE_UNSUPPORTED_TURN_PROTOCOL');
    if (!turnResult.protocolValid) {
      await this.#shutdown(dispatch); this.#suspend(dispatch.assignmentId, TaskStatus.BLOCKED);
      return lifecycleResult({ outcome: 'blocked' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    const worker = turnResult.workerResult;
    if (worker.outcome === 'FAILED') {
      await this.#shutdown(dispatch); this.#finalizeFailed(dispatch.assignmentId);
      return lifecycleResult({ outcome: 'failed' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    if (worker.outcome === 'BLOCKED' || worker.outcome === 'NEEDS_INPUT') {
      await this.#shutdown(dispatch);
      const target = worker.outcome === 'BLOCKED' ? TaskStatus.BLOCKED : TaskStatus.WAITING_INPUT;
      this.#suspend(dispatch.assignmentId, target);
      return lifecycleResult({ outcome: worker.outcome === 'BLOCKED' ? 'blocked' as const : 'waiting-input' as const,
        taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
    }
    await this.#requireExecution(dispatch, TaskStatus.IMPLEMENTING);
    return this.#prepareCompleted({ dispatch, workerResult: worker, buildTestPlan: input.buildTestPlan,
      evidenceOptions: input.evidenceOptions });
  }

  async #prepareCompleted(input: ReviewPreparationInput): Promise<TaskLifecyclePreparationResult> {
    let commit: TaskCommitResult;
    try { commit = await this.#worktrees.commitTaskWorkspace(input.dispatch.taskId); }
    catch (error) {
      if (error instanceof GitTaskCommitError) throw lifecycleError('TASK_LIFECYCLE_COMMIT_FAILED');
      throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
    }
    let evidence: BuildTestEvidence;
    try { evidence = await this.#worktrees.collectBuildTestEvidence(input.dispatch.taskId,
      input.buildTestPlan, input.evidenceOptions); }
    catch { return this.#blockEvidenceIntegrity(input.dispatch); }
    if (evidence.outcome === 'workspace-mutated' || evidence.outcome === 'infrastructure-failed') {
      return this.#blockEvidenceIntegrity(input.dispatch);
    }
    let source: GitWorkspaceChangeSnapshot;
    try { source = await this.#captureReviewSource(input.dispatch.taskId); }
    catch { return this.#blockEvidenceIntegrity(input.dispatch); }
    if (!sourceMatchesEvidence(source, evidence) || source.headCommit !== commit.headAfter || !cleanSource(source)) {
      return this.#blockEvidenceIntegrity(input.dispatch);
    }
    const bundle = makeReviewBundle(input.dispatch, commit, evidence, source, input.workerResult);
    this.#transition(input.dispatch.taskId, TaskStatus.REVIEWING);
    return lifecycleResult({ outcome: 'review-ready' as const, reviewBundle: bundle });
  }

  async #blockEvidenceIntegrity(dispatch: Readonly<AssignmentDispatchResult>): Promise<TaskLifecyclePreparationResult> {
    await this.#shutdown(dispatch);
    this.#suspend(dispatch.assignmentId, TaskStatus.BLOCKED);
    return lifecycleResult({ outcome: 'blocked' as const, taskId: dispatch.taskId, assignmentId: dispatch.assignmentId });
  }

  async #requireBundleFresh(bundle: TaskReviewBundle): Promise<void> {
    await this.#requireExecution(bundleToDispatch(bundle), TaskStatus.REVIEWING);
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
    'assignmentId' | 'executionProfileSha256' | 'workspace'>, status: TaskStatus): Promise<void> {
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
    let pool: Readonly<AgentPoolEntrySnapshot>;
    try { pool = this.#pool.getSnapshot(agent.id); } catch { throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION'); }
    if (!ownedPool(pool, dispatch, assignment.specVersion, assignment.profileHash)) {
      throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
    }
    let workspace;
    try { workspace = await this.#worktrees.inspectWorkspace(dispatch.taskId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE'); }
    if (workspace === undefined || workspace.taskId !== dispatch.taskId ||
      workspace.branchName !== dispatch.workspace.branchName || workspace.baseCommit !== dispatch.workspace.baseCommit) {
      throw lifecycleError('TASK_LIFECYCLE_STALE_SOURCE');
    }
  }

  #requirePersistentAfterShutdown(bundle: TaskReviewBundle): void {
    const assignment = this.#assignments.getAssignment(bundle.assignmentId);
    const task = this.#tasks.getTask(bundle.taskId);
    const agent = this.#agents.getAgent(bundle.agentId);
    let hash: string;
    try { hash = this.#agents.calculateExecutionProfileHash(bundle.agentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_PROFILE'); }
    if (assignment === null || assignment.status !== AssignmentStatus.ACTIVE || task === null ||
      task.status !== TaskStatus.REVIEWING || task.assignmentId !== bundle.assignmentId ||
      task.assignedAgentId !== bundle.agentId || agent === null || agent.status !== AgentStatus.BUSY ||
      !agent.enabled || hash !== bundle.executionProfileSha256) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
  }

  async #captureReviewSource(taskId: string): Promise<GitWorkspaceChangeSnapshot> {
    return this.#worktrees.captureWorkspaceChanges(taskId, { includePatchText: true,
      maxPatchBytes: 1024 * 1024, maxChangedPaths: 4096,
      maxFingerprintBytes: 64 * 1024 * 1024, maxIgnoredPaths: 4096 });
  }

  async #shutdown(value: Pick<AssignmentDispatchResult, 'agentId' | 'assignmentId'>): Promise<void> {
    try { await this.#pool.shutdown(value.agentId, value.assignmentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
    this.#requireCleanPool(value);
  }

  #requireCleanPool(value: Pick<AssignmentDispatchResult, 'agentId' | 'assignmentId'>): void {
    let pool: Readonly<AgentPoolEntrySnapshot>;
    try { pool = this.#pool.getSnapshot(value.agentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
    if (pool.state !== 'IDLE' || pool.busy || pool.active || pool.reserved || pool.taskId !== undefined ||
      pool.assignmentId !== undefined || pool.specVersion !== undefined || pool.profileHash !== undefined ||
      pool.sessionId !== undefined) throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED');
  }

  #transition(taskId: string, status: TaskStatus): void {
    try { this.#tasks.transitionTask(taskId, status); }
    catch { if (this.#tasks.getTask(taskId)?.status !== status) {
      throw lifecycleError('TASK_LIFECYCLE_REVIEW_TRANSITION_FAILED');
    } }
  }
  #suspend(assignmentId: string, status: TaskStatus.BLOCKED | TaskStatus.WAITING_INPUT): void {
    try { this.#assignments.suspendActiveAssignment(assignmentId, status); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
  }
  #finalizeFailed(assignmentId: string): void {
    try { this.#assignments.finalizeFailedAssignment(assignmentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
  }
  #finalizeCompleted(assignmentId: string, merge?: TaskMergeResult): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { this.#assignments.finalizeCompletedAssignment(assignmentId); } catch { /* retry exact partial state */ }
      const assignment = this.#assignments.getAssignment(assignmentId);
      const task = assignment === null ? null : this.#tasks.getTask(assignment.taskId);
      if (assignment !== null && assignment.status === AssignmentStatus.COMPLETED &&
        task?.status === TaskStatus.COMPLETED && task.assignedAgentId === null && task.assignmentId === null) return;
    }
    throw lifecycleError('TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED', merge);
  }
  #isCompletionConverged(assignmentId: string): boolean {
    const assignment = this.#assignments.getAssignment(assignmentId);
    const task = assignment === null ? null : this.#tasks.getTask(assignment.taskId);
    return assignment?.status === AssignmentStatus.COMPLETED && task?.status === TaskStatus.COMPLETED &&
      task.assignedAgentId === null && task.assignmentId === null;
  }

  #rememberReceipt(key: string, receipt: LifecycleReceipt): void {
    const byKey = receipts.get(this.#assignments) ?? new Map<string, LifecycleReceipt>();
    byKey.set(key, receipt);
    receipts.set(this.#assignments, byKey);
  }
  #withFence<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const active = fences.get(this.#assignments) ?? new Set<string>();
    if (active.has(taskId)) return rejectPreserving(lifecycleError('TASK_LIFECYCLE_TASK_BUSY'));
    if (!fences.has(this.#assignments)) fences.set(this.#assignments, active);
    active.add(taskId);
    return operation().finally(() => { active.delete(taskId); });
  }
}

function snapshotPrepareRequest(value: unknown): { readonly dispatch: Readonly<AssignmentDispatchResult>;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number } } {
  if (!isRecord(value) || !hasExactKeys(value, ['dispatchResult', 'buildTestPlan'], ['evidenceOptions'])) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  let dispatch: Readonly<AssignmentDispatchResult>;
  try { dispatch = snapshotAssignmentDispatchResult(value.dispatchResult); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_DISPATCH_RESULT'); }
  let plan: BuildTestEvidencePlan;
  let options: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  try {
    plan = snapshotBuildTestEvidencePlan(value.buildTestPlan);
    options = snapshotBuildTestEvidenceOptions(value.evidenceOptions ?? {});
  } catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST'); }
  return deepFreeze({ dispatch, buildTestPlan: plan, evidenceOptions: options });
}

function snapshotApplyRequest(value: unknown): { readonly reviewBundle: TaskReviewBundle;
  readonly decision: ReviewDecisionInput; readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  readonly targetBranch?: string; readonly mergePolicy: MergeGatePolicy;
  readonly allowNoChangeCompletion: boolean } {
  if (!isRecord(value) || !hasExactKeys(value, ['reviewBundle', 'decision', 'buildTestPlan'],
    ['evidenceOptions', 'targetBranch', 'mergePolicy', 'allowNoChangeCompletion'])) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  let bundle: TaskReviewBundle;
  try { bundle = snapshotTaskReviewBundle(value.reviewBundle); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  let plan: BuildTestEvidencePlan;
  let options: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  let policy: MergeGatePolicy;
  let decision: ReviewDecisionInput;
  try {
    plan = snapshotBuildTestEvidencePlan(value.buildTestPlan);
    options = snapshotBuildTestEvidenceOptions(value.evidenceOptions ?? {});
    policy = snapshotMergeGatePolicy(value.mergePolicy ?? {});
    const validated = createReviewEvidence(bundle.buildTestEvidence, value.decision as ReviewDecisionInput);
    decision = deepFreeze({ reviewId: validated.reviewId, reviewerId: validated.reviewerId,
      verdict: validated.verdict, summary: validated.summary, findings: validated.findings });
  } catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST'); }
  const targetBranch = value.targetBranch;
  if (targetBranch !== undefined && (!boundedString(targetBranch, 512, false) || /[\0\r\n]/u.test(targetBranch))) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  if (value.allowNoChangeCompletion !== undefined && typeof value.allowNoChangeCompletion !== 'boolean') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  return deepFreeze({ reviewBundle: bundle, decision,
    buildTestPlan: plan, evidenceOptions: options, ...(targetBranch === undefined ? {} : { targetBranch }),
    mergePolicy: policy, allowNoChangeCompletion: value.allowNoChangeCompletion === true });
}

export function snapshotTaskReviewBundle(value: unknown): TaskReviewBundle {
  if (!isRecord(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const required = ['version', 'taskId', 'projectId', 'agentId', 'assignmentId', 'providerId',
    'reservationSha256', 'dispatchSha256', 'executionProfileSha256', 'taskCommit',
    'buildTestEvidence', 'source', 'workerResult', 'reviewBundleSha256'];
  if (Object.keys(value).length !== required.length ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.version !== 1 ||
    !boundedString(value.taskId, 64, false) || !boundedString(value.projectId, 256, false) ||
    !boundedString(value.agentId, 256, false) || !boundedString(value.assignmentId, 256, false) ||
    !boundedString(value.providerId, 256, false) || !isSha(value.reservationSha256) ||
    !isSha(value.dispatchSha256) || !isSha(value.executionProfileSha256) || !isSha(value.reviewBundleSha256)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const commit = snapshotTaskCommit(value.taskCommit);
  let evidence: BuildTestEvidence;
  try { evidence = snapshotBuildTestEvidence(value.buildTestEvidence); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  const source = snapshotSource(value.source);
  const worker = snapshotWorkerResult(value.workerResult);
  const base = { version: 1 as const, taskId: value.taskId, projectId: value.projectId,
    agentId: value.agentId, assignmentId: value.assignmentId,
    providerId: value.providerId, reservationSha256: value.reservationSha256,
    dispatchSha256: value.dispatchSha256, executionProfileSha256: value.executionProfileSha256,
    taskCommit: commit, buildTestEvidence: evidence, source, workerResult: worker };
  if (!bundleConsistent(base) || reviewBundleDigest(base) !== value.reviewBundleSha256) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ ...base, reviewBundleSha256: value.reviewBundleSha256 });
}

function makeReviewBundle(dispatch: Readonly<AssignmentDispatchResult>, commit: TaskCommitResult,
  evidence: BuildTestEvidence, source: GitWorkspaceChangeSnapshot, worker: AgentHubWorkerResult): TaskReviewBundle {
  const base = { version: 1 as const, taskId: dispatch.taskId, projectId: dispatch.projectId,
    agentId: dispatch.agentId, assignmentId: dispatch.assignmentId, providerId: dispatch.providerId,
    reservationSha256: dispatch.reservationSha256, dispatchSha256: dispatch.dispatchSha256,
    executionProfileSha256: dispatch.executionProfileSha256, taskCommit: commit,
    buildTestEvidence: evidence, source, workerResult: worker };
  return deepFreeze({ ...base, reviewBundleSha256: reviewBundleDigest(base) });
}
function reviewBundleDigest(bundle: Omit<TaskReviewBundle, 'reviewBundleSha256'>): string {
  return digest('AgentHub.TaskReviewBundle.v1', { version: 1, taskId: bundle.taskId,
    projectId: bundle.projectId, agentId: bundle.agentId, assignmentId: bundle.assignmentId,
    providerId: bundle.providerId, reservationSha256: bundle.reservationSha256,
    dispatchSha256: bundle.dispatchSha256, executionProfileSha256: bundle.executionProfileSha256,
    taskCommitSha256: bundle.taskCommit.taskCommitSha256,
    evidenceSha256: bundle.buildTestEvidence.evidenceSha256,
    changeSetSha256: bundle.source.changeSetSha256, workerResult: bundle.workerResult });
}
function bundleConsistent(bundle: Omit<TaskReviewBundle, 'reviewBundleSha256'>): boolean {
  return bundle.taskId === bundle.taskCommit.taskId && bundle.taskId === bundle.buildTestEvidence.taskId &&
    bundle.taskId === bundle.source.taskId && bundle.taskCommit.branchName === bundle.source.branchName &&
    bundle.taskCommit.baseCommit === bundle.source.baseCommit && bundle.taskCommit.headAfter === bundle.source.headCommit &&
    sourceMatchesEvidence(bundle.source, bundle.buildTestEvidence);
}

function snapshotTaskCommit(value: unknown): TaskCommitResult {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'taskId', 'branchName', 'baseCommit', 'headBefore',
    'headAfter', 'outcome', 'taskCommitSha256']) || value.version !== 1 || !boundedString(value.taskId, 64, false) ||
    !boundedString(value.branchName, 512, false) || !isOid(value.baseCommit) || !isOid(value.headBefore) ||
    !isOid(value.headAfter) || !['committed', 'already-committed', 'no-changes'].includes(value.outcome as string) ||
    !isSha(value.taskCommitSha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const base = { version: 1 as const, taskId: value.taskId, branchName: value.branchName,
    baseCommit: value.baseCommit, headBefore: value.headBefore,
    headAfter: value.headAfter, outcome: value.outcome as TaskCommitResult['outcome'] };
  if (digest('AgentHub.TaskCommitResult.v1', base) !== value.taskCommitSha256) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ ...base, taskCommitSha256: value.taskCommitSha256 });
}

function snapshotSource(value: unknown): GitWorkspaceChangeSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'repositoryRoot', 'worktreePath', 'branchName',
    'baseCommit', 'headCommit', 'committed', 'staged', 'unstaged', 'workingFiles', 'untracked', 'conflicts',
    'ignored', 'changedPaths', 'hasConflicts', 'changeSetSha256']) ||
    !boundedString(value.taskId, 64, false) || !boundedString(value.repositoryRoot, 32768, false) ||
    !boundedString(value.worktreePath, 32768, false) || !boundedString(value.branchName, 512, false) ||
    !isOid(value.baseCommit) || !isOid(value.headCommit) || !isSha(value.changeSetSha256)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const committed = snapshotChangeLayer(value.committed);
  const staged = snapshotChangeLayer(value.staged);
  const unstaged = snapshotChangeLayer(value.unstaged);
  const workingFiles = snapshotFingerprints(value.workingFiles, true);
  const untracked = snapshotFingerprints(value.untracked, false);
  const conflicts = snapshotConflicts(value.conflicts);
  const ignored = snapshotIgnored(value.ignored);
  const changedPaths = snapshotPaths(value.changedPaths);
  if (typeof value.hasConflicts !== 'boolean' || value.hasConflicts !== (conflicts.length > 0)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const expectedPaths = uniqueSorted([
    ...committed.changes.map((change) => change.path), ...staged.changes.map((change) => change.path),
    ...unstaged.changes.map((change) => change.path), ...conflicts.map((entry) => entry.path),
    ...untracked.map((entry) => entry.path),
  ]);
  if (!sameStrings(changedPaths, expectedPaths) || !workingFiles.every((entry) =>
    unstaged.changes.some((change) => change.path === entry.path) ||
    conflicts.some((conflict) => conflict.path === entry.path))) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ taskId: value.taskId, repositoryRoot: value.repositoryRoot, worktreePath: value.worktreePath,
    branchName: value.branchName, baseCommit: value.baseCommit, headCommit: value.headCommit,
    committed, staged, unstaged, workingFiles, untracked, conflicts, ignored, changedPaths,
    hasConflicts: value.hasConflicts, changeSetSha256: value.changeSetSha256 });
}

function snapshotChangeLayer(value: unknown): GitWorkspaceChangeSnapshot['committed'] {
  if (!isRecord(value) || !hasExactKeys(value, ['changes', 'patch']) || !Array.isArray(value.changes) ||
    !isSortedByPath(value.changes)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const changes = value.changes.map((change) => snapshotTrackedChange(change));
  return deepFreeze({ changes, patch: snapshotPatch(value.patch) });
}
function snapshotTrackedChange(value: unknown): GitWorkspaceChangeSnapshot['committed']['changes'][number] {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'status', 'oldMode', 'newMode', 'oldObjectId',
    'newObjectId', 'binary', 'addedLines', 'deletedLines']) || !safeChangePath(value.path) ||
    typeof value.status !== 'string' || !/^[AMDTU]$/u.test(value.status) ||
    typeof value.oldMode !== 'string' || !/^(?:000000|100644|100755|120000|160000)$/u.test(value.oldMode) ||
    typeof value.newMode !== 'string' || !/^(?:000000|100644|100755|120000|160000)$/u.test(value.newMode) ||
    !isOid(value.oldObjectId) || !isOid(value.newObjectId) || typeof value.binary !== 'boolean' ||
    !nullableCount(value.addedLines) || !nullableCount(value.deletedLines) ||
    (value.binary ? value.addedLines !== null || value.deletedLines !== null :
      value.addedLines === null || value.deletedLines === null)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ path: value.path, status: value.status, oldMode: value.oldMode, newMode: value.newMode,
    oldObjectId: value.oldObjectId, newObjectId: value.newObjectId, binary: value.binary,
    addedLines: value.addedLines, deletedLines: value.deletedLines });
}
function snapshotPatch(value: unknown): GitWorkspaceChangeSnapshot['committed']['patch'] {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  if (value.status === 'captured') {
    if (!hasExactKeys(value, ['status', 'text', 'byteLength', 'sha256']) ||
      typeof value.text !== 'string' || !nonNegativeInteger(value.byteLength) ||
      value.byteLength !== Buffer.byteLength(value.text, 'utf8') || !isSha(value.sha256) ||
      shaText(value.text) !== value.sha256) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ status: 'captured', text: value.text, byteLength: value.byteLength, sha256: value.sha256 });
  }
  if (value.status === 'empty') {
    if (!hasExactKeys(value, ['status', 'byteLength', 'sha256']) || value.byteLength !== 0 ||
      value.sha256 !== shaText('')) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ status: 'empty', byteLength: 0, sha256: value.sha256 });
  }
  if ((value.status === 'omitted-limit' || value.status === 'not-requested') && hasExactKeys(value, ['status'])) {
    return deepFreeze({ status: value.status });
  }
  throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
}
function snapshotFingerprints(value: unknown, allowMissing: boolean): GitWorkspaceChangeSnapshot['workingFiles'] {
  if (!Array.isArray(value) || !isSortedByPath(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  return deepFreeze(value.map((entry) => snapshotFingerprint(entry, allowMissing)));
}
function snapshotFingerprint(value: unknown, allowMissing: boolean): GitWorkspaceChangeSnapshot['workingFiles'][number] {
  if (!isRecord(value) || !safeChangePath(value.path) || typeof value.kind !== 'string') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  if (value.kind === 'regular') {
    if (!hasExactKeys(value, ['path', 'kind', 'size', 'sha256']) || !nonNegativeInteger(value.size) ||
      !isSha(value.sha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ path: value.path, kind: 'regular', size: value.size, sha256: value.sha256 });
  }
  if (value.kind === 'symlink') {
    if (!hasExactKeys(value, ['path', 'kind', 'size', 'linkTargetSha256']) || !nonNegativeInteger(value.size) ||
      !isSha(value.linkTargetSha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ path: value.path, kind: 'symlink', size: value.size, linkTargetSha256: value.linkTargetSha256 });
  }
  if (value.kind === 'gitlink') {
    if (!hasExactKeys(value, ['path', 'kind', 'headCommit']) || !isOid(value.headCommit)) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    }
    return deepFreeze({ path: value.path, kind: 'gitlink', headCommit: value.headCommit });
  }
  if (allowMissing && value.kind === 'missing' && hasExactKeys(value, ['path', 'kind'])) {
    return deepFreeze({ path: value.path, kind: 'missing' });
  }
  throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
}
function snapshotConflicts(value: unknown): GitWorkspaceChangeSnapshot['conflicts'] {
  if (!Array.isArray(value) || !isSortedByPath(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  return deepFreeze(value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'kind', 'fields']) || !safeChangePath(entry.path) ||
      entry.kind !== 'u' || !Array.isArray(entry.fields) || entry.fields.length !== 10 ||
      !entry.fields.every((field) => typeof field === 'string')) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    }
    return deepFreeze({ path: entry.path, kind: 'u' as const, fields: [...entry.fields] });
  }));
}
function snapshotIgnored(value: unknown): GitWorkspaceChangeSnapshot['ignored'] {
  if (!isRecord(value) || !hasExactKeys(value, ['present', 'count', 'paths', 'truncated']) ||
    typeof value.present !== 'boolean' || !nonNegativeInteger(value.count) || typeof value.truncated !== 'boolean') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const paths = snapshotPaths(value.paths);
  if (value.present !== (value.count > 0) || value.count < paths.length ||
    (value.truncated ? value.count <= paths.length : value.count !== paths.length)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ present: value.present, count: value.count, paths, truncated: value.truncated });
}
function snapshotPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(safeChangePath) || !isSortedUniqueStrings(value)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze([...value]);
}
function safeChangePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { validateChangePath(value); return true; } catch { return false; }
}
function isSortedByPath(value: readonly unknown[]): boolean {
  let previous: string | undefined;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || (previous !== undefined && previous > entry.path)) return false;
    previous = entry.path;
  }
  return true;
}
function isSortedUniqueStrings(value: readonly unknown[]): value is readonly string[] {
  for (let index = 0; index < value.length; index++) {
    const current = value[index];
    if (typeof current !== 'string' || (index > 0 && (value[index - 1] as string) >= current)) return false;
  }
  return true;
}
function uniqueSorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function nullableCount(value: unknown): value is number | null { return value === null || nonNegativeInteger(value); }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function shaText(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function snapshotWorkerResult(value: unknown): AgentHubWorkerResult {
  let result: AgentProviderTurnResult;
  try { result = snapshotAssignmentTurnResult({ protocol: 'worker-result', protocolValid: true,
    providerId: 'bundle-validation', workerResult: value }, 'worker-result', 'bundle-validation'); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  if (result.protocol !== 'worker-result' || !result.protocolValid) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return result.workerResult;
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
function ownedPool(pool: Readonly<AgentPoolEntrySnapshot>, dispatch: Pick<AssignmentDispatchResult,
  'taskId' | 'assignmentId'>, specVersion: string, profileHash: string): boolean {
  return pool.state === 'OWNED' && pool.busy && !pool.active && !pool.reserved &&
    pool.taskId === dispatch.taskId && pool.assignmentId === dispatch.assignmentId &&
    pool.specVersion === specVersion && pool.profileHash === profileHash;
}
function sourceMatchesEvidence(source: GitWorkspaceChangeSnapshot, evidence: BuildTestEvidence): boolean {
  return source.taskId === evidence.taskId && source.branchName === evidence.branchName &&
    source.baseCommit === evidence.baseCommit && source.headCommit === evidence.headCommit &&
    source.changeSetSha256 === evidence.changeSetSha256;
}
function sameSourceIdentity(left: GitWorkspaceChangeSnapshot, right: GitWorkspaceChangeSnapshot): boolean {
  return left.taskId === right.taskId && left.branchName === right.branchName &&
    left.baseCommit === right.baseCommit && left.headCommit === right.headCommit &&
    left.changeSetSha256 === right.changeSetSha256 && cleanSource(right);
}
function cleanSource(source: GitWorkspaceChangeSnapshot): boolean {
  return !source.hasConflicts && source.conflicts.length === 0 && source.staged.changes.length === 0 &&
    source.unstaged.changes.length === 0 && source.untracked.length === 0;
}
function buildPassed(evidence: BuildTestEvidence): boolean {
  return evidence.outcome === 'passed' && evidence.commands.length > 0 && evidence.commands.every((command) =>
    command.outcome === 'passed' && command.exitCode === 0 && command.cleanupFailed !== true &&
    command.sourceStable && command.sourceAfter.status === 'captured' && command.sourceAfter.stable &&
    command.sourceVisibilityAfter.status === 'captured' && command.sourceVisibilityAfter.stable);
}
function revisionPrompt(review: ReviewEvidence, task: Task): string {
  const lines = ['Apply exactly one revision for the current task.', '', `Review summary: ${review.summary}`,
    '', 'Findings:'];
  if (review.findings.length === 0) lines.push('(none)');
  for (const finding of review.findings) lines.push(
    `- [${finding.severity}] ${finding.code}: ${finding.message}${finding.path === undefined ? '' : ` (${finding.path})`}`,
  );
  lines.push('', 'Acceptance criteria:');
  if (task.acceptanceCriteria.length === 0) lines.push('(none)');
  else task.acceptanceCriteria.forEach((criterion, index) => lines.push(`${String(index + 1)}. ${criterion}`));
  const prompt = lines.join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > maxRevisionPromptBytes) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  return prompt;
}
function lifecycleResult<T extends Record<string, unknown>>(value: T): T & LifecycleBase {
  return deepFreeze({ ...value, lifecycleSha256: digest('AgentHub.TaskLifecycleResult.v1', lifecycleIdentity(value)) });
}
function lifecycleReceiptKey(bundle: TaskReviewBundle, review: ReviewEvidence, input: ApplySnapshot): string {
  return digest('AgentHub.TaskLifecycleReceipt.v1', {
    taskId: bundle.taskId,
    assignmentId: bundle.assignmentId,
    reviewBundleSha256: bundle.reviewBundleSha256,
    reviewEvidenceSha256: review.reviewEvidenceSha256,
    targetBranch: input.targetBranch ?? null,
    mergePolicy: input.mergePolicy,
    allowNoChangeCompletion: input.allowNoChangeCompletion,
  });
}
function lifecycleIdentity(value: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'reviewBundle' && isRecord(nested)) result.reviewBundleSha256 = nested.reviewBundleSha256;
    else if (key === 'reviewEvidence' && isRecord(nested)) result.reviewEvidenceSha256 = nested.reviewEvidenceSha256;
    else if (key === 'mergeGate' && isRecord(nested)) result.mergeGateSha256 = nested.mergeGateSha256;
    else if (key === 'mergeResult' && isRecord(nested)) result.mergeResultSha256 = nested.mergeResultSha256;
    else if (key !== 'source') result[key] = nested;
  }
  return result;
}
function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0${canonicalChangeState(value)}`).digest('hex');
}
function boundedString(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}
function isOid(value: unknown): value is string { return typeof value === 'string' && oidPattern.test(value); }
function isSha(value: unknown): value is string { return typeof value === 'string' && shaPattern.test(value); }
function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
function lifecycleError(code: TaskLifecycleErrorCode, merge?: TaskMergeResult): TaskLifecycleError {
  return new TaskLifecycleError(code, merge);
}
function rejectPreserving(error: unknown): Promise<never> {
  return Promise.resolve().then(() => { throw error; });
}
