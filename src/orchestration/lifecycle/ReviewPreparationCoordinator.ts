import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import {
  GitTaskCommitError,
  type GitWorktreeManager,
  type BuildTestEvidence,
  type BuildTestEvidencePlan,
  type GitWorkspaceChangeSnapshot,
} from '../../workspace/index.js';
import {
  makeReviewBundle,
  sourceMatchesEvidence,
  type TaskReviewBundle,
} from './TaskLifecycleContract.js';
import type { AssignmentDispatchResult } from '../AssignmentDispatcher.js';

export interface ReviewPreparationCoordinatorInput {
  readonly dispatch: Readonly<AssignmentDispatchResult>;
  readonly workerResult: AgentHubWorkerResult;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
}

export type ReviewPreparationCoordinatorResult =
  | { readonly outcome: 'prepared'; readonly reviewBundle: TaskReviewBundle }
  | { readonly outcome: 'evidence-integrity-blocked' };

/** Coordinates workspace evidence preparation without owning lifecycle authority. */
export class ReviewPreparationCoordinator {
  readonly #worktrees: GitWorktreeManager;

  public constructor(worktreeManager: GitWorktreeManager) {
    this.#worktrees = worktreeManager;
  }

  public async prepare(input: ReviewPreparationCoordinatorInput): Promise<ReviewPreparationCoordinatorResult> {
    let commit;
    try { commit = await this.#worktrees.commitTaskWorkspace(input.dispatch.taskId); }
    catch (error) {
      if (error instanceof GitTaskCommitError) throw error;
      throw error;
    }

    let evidence: BuildTestEvidence;
    try {
      evidence = await this.#worktrees.collectBuildTestEvidence(input.dispatch.taskId,
        input.buildTestPlan, input.evidenceOptions);
    } catch {
      return { outcome: 'evidence-integrity-blocked' };
    }
    if (evidence.outcome === 'workspace-mutated' || evidence.outcome === 'infrastructure-failed') {
      return { outcome: 'evidence-integrity-blocked' };
    }

    let source: GitWorkspaceChangeSnapshot;
    try {
      source = await this.#worktrees.captureWorkspaceChanges(input.dispatch.taskId, {
        includePatchText: true,
        maxPatchBytes: 1024 * 1024,
        maxChangedPaths: 4096,
        maxFingerprintBytes: 64 * 1024 * 1024,
        maxIgnoredPaths: 4096,
      });
    } catch {
      return { outcome: 'evidence-integrity-blocked' };
    }
    if (!sourceMatchesEvidence(source, evidence) || source.headCommit !== commit.headAfter || !cleanSource(source)) {
      return { outcome: 'evidence-integrity-blocked' };
    }

    return { outcome: 'prepared', reviewBundle: makeReviewBundle(
      input.dispatch, commit, evidence, source, input.workerResult,
    ) };
  }
}

function cleanSource(source: GitWorkspaceChangeSnapshot): boolean {
  return !source.hasConflicts && source.conflicts.length === 0 && source.staged.changes.length === 0 &&
    source.unstaged.changes.length === 0 && source.untracked.length === 0;
}
