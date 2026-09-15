import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  TaskLifecycleError,
  snapshotTaskReviewBundle as legacySnapshotTaskReviewBundle,
} from '../src/orchestration/TaskLifecycleOrchestrator.js';
import {
  TaskLifecycleError as contractTaskLifecycleError,
  bundleConsistent,
  digest,
  lifecycleReceiptKey,
  lifecycleResult,
  makeReviewBundle,
  reviewBundleDigest,
  snapshotApplyRequest,
  snapshotPrepareRequest,
  snapshotTaskReviewBundle,
  type TaskReviewBundle,
} from '../src/orchestration/lifecycle/TaskLifecycleContract.js';
import type { AgentHubWorkerResult } from '../src/protocol/AgentHubWorkerResult.js';
import { createReviewEvidence, type BuildTestEvidence, type BuildTestEvidencePlan,
  type GitWorkspaceChangeSnapshot, type TaskCommitResult } from '../src/workspace/index.js';

const oid = 'a'.repeat(40);
const changeSetSha256 = 'c'.repeat(64);
const sourceVisibilitySha256 = 'd'.repeat(64);
const emptyPatchSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [], blockers: [],
  questions: [], risks: [], notes: [],
};
const plan: BuildTestEvidencePlan = { commands: [{
  id: 'test', phase: 'test', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.',
  timeoutMs: 5_000, inheritEnv: [], env: {},
}] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function dispatchResult() {
  const turnResult = { protocol: 'worker-result' as const, protocolValid: true as const,
    providerId: 'fake', workerResult };
  const identity = {
    version: 1 as const, taskId: 'TASK', projectId: 'PROJECT', agentId: 'AGENT', providerId: 'fake',
    assignmentId: 'ASSIGN', reservationSha256: '1'.repeat(64), executionProfileSha256: '3'.repeat(64),
    workspace: { branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid, created: true },
    assignmentStatus: 'ACTIVE' as const, taskStatus: 'IMPLEMENTING' as const, turnResult,
  };
  const dispatchSha256 = createHash('sha256').update(
    `AgentHub.AssignmentDispatch.v1\0${canonical({ ...identity, turnProtocol: 'worker-result', turnResult })}`,
  ).digest('hex');
  return { ...identity, dispatchSha256 };
}

function source(): GitWorkspaceChangeSnapshot {
  const patch = { status: 'empty' as const, byteLength: 0 as const, sha256: emptyPatchSha256 };
  const layer = { changes: [], patch };
  return {
    taskId: 'TASK', repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: 'agenthub/TASK',
    baseCommit: oid, headCommit: oid, committed: layer, staged: layer, unstaged: layer,
    workingFiles: [], untracked: [], conflicts: [], ignored: { present: false, count: 0, paths: [], truncated: false },
    changedPaths: [], hasConflicts: false, changeSetSha256,
  };
}

function taskCommit(): TaskCommitResult {
  const base = { version: 1 as const, taskId: 'TASK', branchName: 'agenthub/TASK', baseCommit: oid,
    headBefore: oid, headAfter: oid, outcome: 'no-changes' as const };
  return { ...base, taskCommitSha256: digest('AgentHub.TaskCommitResult.v1', base) };
}

function evidence(): BuildTestEvidence {
  return {
    version: 2, taskId: 'TASK', branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid,
    changeSetSha256, sourceVisibilitySha256, build: 'not-run', test: 'passed', outcome: 'passed', commands: [],
    evidenceSha256: 'c7824d636ef7a7880edd635449048186dcdc62b86e251bf65d725e9769a9bffe',
  };
}

function bundle(): TaskReviewBundle {
  const dispatch = {
    taskId: 'TASK', projectId: 'PROJECT', agentId: 'AGENT', assignmentId: 'ASSIGN', providerId: 'fake',
    reservationSha256: '1'.repeat(64), dispatchSha256: '2'.repeat(64), executionProfileSha256: '3'.repeat(64),
  } as never;
  return makeReviewBundle(dispatch, taskCommit(), evidence(), source(), workerResult);
}

describe('TaskLifecycleContract', () => {
  it('accepts a valid bundle and rejects unknown, missing, and tampered fields', () => {
    const value = bundle();
    expect(snapshotTaskReviewBundle(value)).toEqual(value);
    expect(bundleConsistent(value)).toBe(true);
    expect(() => snapshotTaskReviewBundle({ ...value, extra: true })).toThrowError(TaskLifecycleError);
    const missing = { ...value };
    delete (missing as { reviewBundleSha256?: string }).reviewBundleSha256;
    expect(() => snapshotTaskReviewBundle(missing)).toThrowError(TaskLifecycleError);
    expect(() => snapshotTaskReviewBundle({ ...value, reviewBundleSha256: 'f'.repeat(64) }))
      .toThrowError(TaskLifecycleError);
    const inconsistent = { ...value, source: { ...value.source, changeSetSha256: 'f'.repeat(64) } };
    expect(() => snapshotTaskReviewBundle({
      ...inconsistent,
      reviewBundleSha256: reviewBundleDigest(inconsistent),
    })).toThrowError(TaskLifecycleError);
  });

  it('preserves the fixed review bundle, lifecycle, and receipt digests', () => {
    const value = bundle();
    expect(value.taskCommit.taskCommitSha256).toBe('64eea8c8fc973d472b524cb018fcb40e9e0e96cc2899b2abf214ae1bc9f51cf5');
    expect(value.buildTestEvidence.evidenceSha256).toBe('c7824d636ef7a7880edd635449048186dcdc62b86e251bf65d725e9769a9bffe');
    expect(value.reviewBundleSha256).toBe('3486db51fd458f154530154574ab167318c64e509f7a20f281e3e6dc8eb452b7');
    const review = createReviewEvidence(value.buildTestEvidence, {
      reviewId: 'review-1', reviewerId: 'reviewer-1', verdict: 'ACCEPT', summary: 'accepted',
    });
    const input = snapshotApplyRequest({ reviewBundle: value, decision: {
      reviewId: 'review-1', reviewerId: 'reviewer-1', verdict: 'ACCEPT', summary: 'accepted', findings: undefined,
    }, buildTestPlan: plan });
    expect(reviewBundleDigest(value)).toBe(value.reviewBundleSha256);
    expect(review.reviewEvidenceSha256).toBe('1cdd91efcae316363b33e48f16226a673113af0ddfad245685b5b7f969741fa4');
    const result = lifecycleResult({ outcome: 'review-ready' as const, reviewBundle: value });
    expect(result.lifecycleSha256).toBe('ef321673f1287e7e0471b8ad7ccd1c18c0f42f5f2d5d83fbe0ac11f7b915caaf');
    expect(lifecycleReceiptKey(value, review, input)).toBe('630dfe53da48450b6a2b7f0b559fbdce393ea42e3a6a193c07728d275ed18eb8');
  });

  it('keeps the error class identity and recursively freezes snapshots', () => {
    expect(legacySnapshotTaskReviewBundle).toBe(snapshotTaskReviewBundle);
    expect(TaskLifecycleError).toBe(contractTaskLifecycleError);
    const error = new contractTaskLifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
    expect(error).toBeInstanceOf(TaskLifecycleError);
    expect(error.name).toBe('TaskLifecycleError');
    const value = bundle();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.taskCommit)).toBe(true);
    expect(Object.isFrozen(value.source.committed.patch)).toBe(true);
    const mutable = JSON.parse(JSON.stringify(value)) as unknown as { taskId: string; source: { committed: { patch: { status: string } } } } & TaskReviewBundle;
    const snapshot = snapshotTaskReviewBundle(mutable);
    mutable.taskId = 'MUTATED';
    mutable.source.committed.patch.status = 'captured';
    expect(snapshot.taskId).toBe('TASK');
    expect(snapshot.source.committed.patch.status).toBe('empty');
  });

  it('snapshots request defaults, policy, findings, and validation failures', () => {
    const value = bundle();
    const prepared = snapshotPrepareRequest({ dispatchResult: dispatchResult(), buildTestPlan: plan });
    expect(prepared.buildTestPlan.commands[0]?.id).toBe('test');
    const applied = snapshotApplyRequest({ reviewBundle: value, decision: {
      reviewId: 'review-1', reviewerId: 'reviewer-1', verdict: 'ACCEPT', summary: 'accepted', findings: undefined,
    }, buildTestPlan: plan, mergePolicy: { requiredPhases: ['test'], requiredCommandIds: ['test'] } });
    expect(applied.allowNoChangeCompletion).toBe(false);
    expect(applied.targetBranch).toBeUndefined();
    expect(applied.mergePolicy).toEqual({ requiredPhases: ['test'], requiredCommandIds: ['test'] });
    expect(applied.decision.findings).toEqual([]);
    expect(Object.isFrozen(applied.decision.findings)).toBe(true);
    expect(() => snapshotPrepareRequest({ dispatchResult: {}, buildTestPlan: plan })).toThrowError(TaskLifecycleError);
    expect(() => snapshotApplyRequest({ reviewBundle: { ...value, reviewBundleSha256: 'f'.repeat(64) }, decision: {}, buildTestPlan: plan }))
      .toThrowError(TaskLifecycleError);
    expect(() => snapshotApplyRequest({ reviewBundle: value, decision: {
      reviewId: 'review-1', reviewerId: 'reviewer-1', verdict: 'ACCEPT', summary: 'accepted',
    }, buildTestPlan: plan, targetBranch: 'bad\nbranch' })).toThrowError(TaskLifecycleError);
  });

  it('uses the contract error codes for invalid dispatch, request, and bundle boundaries', () => {
    try { snapshotPrepareRequest({ dispatchResult: {}, buildTestPlan: plan }); } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_LIFECYCLE_INVALID_DISPATCH_RESULT' });
    }
    try { snapshotPrepareRequest({ dispatchResult: {}, buildTestPlan: plan, extra: true }); } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_LIFECYCLE_INVALID_REQUEST' });
    }
    try { snapshotApplyRequest({ reviewBundle: {}, decision: {}, buildTestPlan: plan }); } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE' });
    }
  });
});
