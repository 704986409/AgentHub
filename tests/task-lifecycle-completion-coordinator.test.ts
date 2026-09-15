import { describe, expect, it, vi } from 'vitest';

import { GitMergeError, type GitWorktreeManager, type MergeGateDecision, type ReviewEvidence } from '../src/workspace/index.js';
import { CompletionCoordinator } from '../src/orchestration/lifecycle/CompletionCoordinator.js';
import { TaskLifecycleError, type TaskReviewBundle } from '../src/orchestration/lifecycle/TaskLifecycleContract.js';

const sha = 'a'.repeat(64);
const oid = 'b'.repeat(40);
const review = { reviewId: 'review', reviewerId: 'human', verdict: 'ACCEPT', summary: 'accepted', findings: [], reviewEvidenceSha256: sha } as unknown as ReviewEvidence;
const source = {
  taskId: 'task-a', branchName: 'agent/task-a', baseCommit: oid, headCommit: oid,
  hasConflicts: false, conflicts: [],
  committed: { changes: [], patch: { status: 'empty', byteLength: 0, sha256: sha } },
  staged: { changes: [], patch: { status: 'empty', byteLength: 0, sha256: sha } },
  unstaged: { changes: [], patch: { status: 'empty', byteLength: 0, sha256: sha } },
  workingFiles: [], untracked: [], changedPaths: [],
  ignored: { present: false, count: 0, paths: [], truncated: false }, changeSetSha256: sha,
  sourceVisibilitySha256: sha,
};
const evidence = {
  outcome: 'passed', commands: [{ outcome: 'passed', exitCode: 0, cleanupFailed: false,
    sourceStable: true, sourceAfter: { status: 'captured', stable: true },
    sourceVisibilityAfter: { status: 'captured', stable: true } }],
  evidenceSha256: sha,
};
const bundle = {
  taskId: 'task-a', taskCommit: { outcome: 'no-changes', baseCommit: oid, headAfter: oid },
  source, buildTestEvidence: evidence,
} as unknown as TaskReviewBundle;
const noChangeGate = (overrides: Record<string, unknown> = {}): MergeGateDecision => ({
  version: 1, taskId: 'task-a', branchName: 'agent/task-a', baseCommit: oid, headCommit: oid,
  eligible: false, reasons: ['NO_COMMITTED_CHANGES'], changeSetSha256: sha,
  sourceVisibilitySha256: sha, buildTestEvidenceSha256: sha, reviewEvidenceSha256: sha,
  mergeGateSha256: sha, ...overrides,
} as unknown as MergeGateDecision);

type FakeWorktrees = {
  evaluateMergeGate: ReturnType<typeof vi.fn>;
  mergeTaskWorkspace: ReturnType<typeof vi.fn>;
};

function makeCoordinator(overrides: Partial<FakeWorktrees> = {}): { worktrees: FakeWorktrees; coordinator: CompletionCoordinator } {
  const worktrees: FakeWorktrees = {
    evaluateMergeGate: vi.fn().mockResolvedValue(noChangeGate()),
    mergeTaskWorkspace: vi.fn().mockResolvedValue({ outcome: 'merged', taskId: 'task-a' }),
    ...overrides,
  };
  return { worktrees, coordinator: new CompletionCoordinator(worktrees as unknown as GitWorktreeManager) };
}


function expectLifecycleCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(TaskLifecycleError);
    expect((error as TaskLifecycleError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('CompletionCoordinator', () => {
  it('preserves no-change preconditions and exact gate semantics', async () => {
    const fixture = makeCoordinator();
    expect(() => fixture.coordinator.validateNoChangeCompletion(bundle, true)).not.toThrow();
    await expect(fixture.coordinator.evaluateNoChangeGate(bundle, review, {})).resolves.toMatchObject({
      eligible: false, reasons: ['NO_COMMITTED_CHANGES'],
    });
    expect(fixture.worktrees.evaluateMergeGate).toHaveBeenCalledWith('task-a', evidence, review, {});
    await expect(fixture.coordinator.evaluateNoChangeGate(bundle, review, {})).resolves.toBeDefined();
    expectLifecycleCode(() => fixture.coordinator.assertNoChangeGateIdentity(noChangeGate(), noChangeGate({ changeSetSha256: 'c'.repeat(64) })), 'TASK_LIFECYCLE_GATE_DENIED');
  });

  it('denies no-change completion when the allow flag is false', () => {
    expectLifecycleCode(() => makeCoordinator().coordinator.validateNoChangeCompletion(bundle, false), 'TASK_LIFECYCLE_GATE_DENIED');
  });

  it('denies no-change completion when head or source identity drifts', () => {
    const headDrift = { ...bundle, taskCommit: { outcome: 'no-changes', baseCommit: oid, headAfter: 'c'.repeat(40) } } as unknown as TaskReviewBundle;
    const dirtySource = { ...bundle, source: { ...source, untracked: [{ path: 'dirty' }] } } as unknown as TaskReviewBundle;
    expectLifecycleCode(() => makeCoordinator().coordinator.validateNoChangeCompletion(headDrift, true), 'TASK_LIFECYCLE_GATE_DENIED');
    expectLifecycleCode(() => makeCoordinator().coordinator.validateNoChangeCompletion(dirtySource, true), 'TASK_LIFECYCLE_GATE_DENIED');
  });

  it('preserves the exact merge request and maps merge failures', async () => {
    const gate = noChangeGate({ eligible: true, reasons: [] });
    const fixture = makeCoordinator({ evaluateMergeGate: vi.fn().mockResolvedValue(gate) });
    const normalBundle = { ...bundle, taskCommit: { outcome: 'committed', baseCommit: oid, headAfter: oid } } as unknown as TaskReviewBundle;
    await fixture.coordinator.merge(normalBundle, review, 'main', gate, { requiredCommandIds: ['test'] });
    expect(fixture.worktrees.mergeTaskWorkspace).toHaveBeenCalledWith({
      taskId: 'task-a', targetBranch: 'main', buildEvidence: evidence, reviewEvidence: review,
      gateDecision: gate, gatePolicy: { requiredCommandIds: ['test'] },
    });

    for (const [gitCode, lifecycleCode] of [
      ['GIT_MERGE_CLEANUP_FAILED', 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED'],
      ['GIT_MERGE_CONTRACT_VIOLATION', 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED'],
      ['GIT_MERGE_FAILED', 'TASK_LIFECYCLE_MERGE_FAILED'],
    ] as const) {
      const failing = makeCoordinator({
        mergeTaskWorkspace: vi.fn().mockRejectedValue(new GitMergeError(gitCode)),
      }).coordinator;
      await expect(failing.merge(normalBundle, review, 'main', gate, {})).rejects.toMatchObject({ code: lifecycleCode });
    }
  });

  it('maps gate evaluation failures without exposing raw errors', async () => {
    const fixture = makeCoordinator({ evaluateMergeGate: vi.fn().mockRejectedValue(new Error('private detail')) });
    await expect(fixture.coordinator.evaluateMergeGate(bundle, review, {})).rejects.toBeInstanceOf(TaskLifecycleError);
    await expect(fixture.coordinator.evaluateMergeGate(bundle, review, {})).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED' });
  });
});