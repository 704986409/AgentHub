import {
  GitMergeError,
  type GitWorktreeManager,
  type BuildTestEvidence,
  type GitWorkspaceChangeSnapshot,
  type MergeGateDecision,
  type MergeGatePolicy,
  type ReviewEvidence,
  type TaskMergeResult,
} from '../../workspace/index.js';
import { lifecycleError, type TaskReviewBundle } from './TaskLifecycleContract.js';

/** Coordinates the MergeGate and Git portions of ACCEPT completion. */
export class CompletionCoordinator {
  readonly #worktrees: GitWorktreeManager;

  public constructor(worktrees: GitWorktreeManager) {
    this.#worktrees = worktrees;
  }

  public validateNoChangeCompletion(bundle: TaskReviewBundle, allowNoChangeCompletion: boolean): void {
    if (!allowNoChangeCompletion || !buildPassed(bundle.buildTestEvidence) ||
      bundle.taskCommit.headAfter !== bundle.taskCommit.baseCommit || !cleanSource(bundle.source)) {
      throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
    }
  }

  public async evaluateNoChangeGate(
    bundle: TaskReviewBundle,
    review: ReviewEvidence,
    policy: MergeGatePolicy,
  ): Promise<MergeGateDecision> {
    const gate = await this.#evaluateGate(bundle, review, policy);
    if (gate.eligible || gate.reasons.length !== 1 || gate.reasons[0] !== 'NO_COMMITTED_CHANGES') {
      throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
    }
    return gate;
  }

  public assertNoChangeGateIdentity(first: MergeGateDecision, final: MergeGateDecision): void {
    if (final.eligible || final.reasons.length !== 1 || final.reasons[0] !== 'NO_COMMITTED_CHANGES' ||
      final.changeSetSha256 !== first.changeSetSha256 ||
      final.sourceVisibilitySha256 !== first.sourceVisibilitySha256 ||
      final.buildTestEvidenceSha256 !== first.buildTestEvidenceSha256 ||
      final.reviewEvidenceSha256 !== first.reviewEvidenceSha256) {
      throw lifecycleError('TASK_LIFECYCLE_GATE_DENIED');
    }
  }

  public async evaluateMergeGate(
    bundle: TaskReviewBundle,
    review: ReviewEvidence,
    policy: MergeGatePolicy,
  ): Promise<MergeGateDecision> {
    return this.#evaluateGate(bundle, review, policy);
  }

  public async merge(
    bundle: TaskReviewBundle,
    review: ReviewEvidence,
    targetBranch: string,
    gate: MergeGateDecision,
    policy: MergeGatePolicy,
  ): Promise<TaskMergeResult> {
    try {
      return await this.#worktrees.mergeTaskWorkspace({
        taskId: bundle.taskId,
        targetBranch,
        buildEvidence: bundle.buildTestEvidence,
        reviewEvidence: review,
        gateDecision: gate,
        gatePolicy: policy,
      });
    } catch (error) {
      if (error instanceof GitMergeError &&
        (error.code === 'GIT_MERGE_CLEANUP_FAILED' || error.code === 'GIT_MERGE_CONTRACT_VIOLATION')) {
        throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
      }
      throw lifecycleError('TASK_LIFECYCLE_MERGE_FAILED');
    }
  }

  async #evaluateGate(
    bundle: TaskReviewBundle,
    review: ReviewEvidence,
    policy: MergeGatePolicy,
  ): Promise<MergeGateDecision> {
    try {
      return await this.#worktrees.evaluateMergeGate(bundle.taskId, bundle.buildTestEvidence, review, policy);
    } catch {
      throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
    }
  }
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