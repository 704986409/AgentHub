import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  GitTaskCommitError,
  GitWorktreeManager,
  TaskLifecycleOrchestrator,
  TaskStatus,
  type AgentHubWorkerResult,
  type AssignmentDispatchResult,
  type BuildTestEvidence,
  type BuildTestEvidencePlan,
  type GitWorkspaceChangeSnapshot,
} from '../src/index.js';
import { ReviewPreparationCoordinator } from '../src/orchestration/lifecycle/ReviewPreparationCoordinator.js';
import { reviewBundleDigest } from '../src/orchestration/lifecycle/TaskLifecycleContract.js';

const oid = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const plan: BuildTestEvidencePlan = { commands: [{ id: 'test', phase: 'test', executable: process.execPath,
  args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {} }] };
const completed: AgentHubWorkerResult = { protocolVersion: 1, outcome: 'COMPLETED', summary: 'done',
  changedFiles: [], checks: [], blockers: [], questions: [], risks: [], notes: [] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function dispatch(workerResult: AgentHubWorkerResult = completed): AssignmentDispatchResult {
  const turnResult = { protocol: 'worker-result' as const, protocolValid: true as const, providerId: 'fake', workerResult };
  const identity = {
    version: 1 as const, taskId: 'TASK', projectId: 'PROJECT', agentId: 'AGENT', providerId: 'fake', assignmentId: 'ASSIGN',
    reservationSha256: sha, executionProfileSha256: sha,
    workspace: { branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid, created: true },
    assignmentStatus: 'ACTIVE' as const, taskStatus: 'IMPLEMENTING' as const, turnResult,
  };
  const dispatchSha256 = createHash('sha256').update(
    `AgentHub.AssignmentDispatch.v1\0${canonical({ ...identity, turnProtocol: 'worker-result', turnResult })}`,
  ).digest('hex');
  return { ...identity, dispatchSha256 };
}

function sourceSnapshot(): GitWorkspaceChangeSnapshot {
  const patch = { status: 'empty' as const, byteLength: 0 as const,
    sha256: createHash('sha256').update('').digest('hex') };
  return { taskId: 'TASK', repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: 'agenthub/TASK',
    baseCommit: oid, headCommit: oid, committed: { changes: [], patch }, staged: { changes: [], patch },
    unstaged: { changes: [], patch }, workingFiles: [], untracked: [], conflicts: [],
    ignored: { present: false, count: 0, paths: [], truncated: false }, changedPaths: [], hasConflicts: false,
    changeSetSha256: sha };
}

function evidenceSnapshot(source: GitWorkspaceChangeSnapshot, outcome: BuildTestEvidence['outcome'] = 'passed'): BuildTestEvidence {
  return { version: 2, taskId: source.taskId, branchName: source.branchName,
    baseCommit: source.baseCommit, headCommit: source.headCommit, changeSetSha256: source.changeSetSha256,
    sourceVisibilitySha256: sha, build: 'not-run', test: 'passed', outcome, commands: [], evidenceSha256: sha };
}

function commitResult(taskId = 'TASK') {
  return { version: 1 as const, taskId, branchName: 'agenthub/TASK', baseCommit: oid,
    headBefore: oid, headAfter: oid, outcome: 'no-changes' as const, taskCommitSha256: sha };
}

function worktree(overrides: Record<string, unknown> = {}) {
  const manager = Object.assign(Object.create(GitWorktreeManager.prototype) as GitWorktreeManager, {
    commitTaskWorkspace: vi.fn().mockResolvedValue(commitResult()),
    collectBuildTestEvidence: vi.fn().mockResolvedValue(evidenceSnapshot(sourceSnapshot())),
    captureWorkspaceChanges: vi.fn().mockResolvedValue(sourceSnapshot()),
    ...overrides,
  });
  return manager;
}

describe('ReviewPreparationCoordinator', () => {
  it('preserves commit, evidence, source order and exact source capture bounds', async () => {
    const calls: string[] = [];
    const manager = worktree({
      commitTaskWorkspace: vi.fn((...args: unknown[]) => { calls.push('commit'); return Promise.resolve(commitResult(args[0] as string)); }),
      collectBuildTestEvidence: vi.fn((...args: unknown[]) => {
        calls.push('evidence');
        expect(args[1]).toBe(plan);
        return evidenceSnapshot(sourceSnapshot());
      }),
      captureWorkspaceChanges: vi.fn((...args: unknown[]) => {
        calls.push('source');
        expect(args[1]).toEqual({ includePatchText: true, maxPatchBytes: 1024 * 1024, maxChangedPaths: 4096,
          maxFingerprintBytes: 64 * 1024 * 1024, maxIgnoredPaths: 4096 });
        return sourceSnapshot();
      }),
    });
    const result = await new ReviewPreparationCoordinator(manager).prepare({ dispatch: dispatch(), workerResult: completed,
      buildTestPlan: plan, evidenceOptions: { maxOutputBytes: 123, maxPreviewBytes: 45 } });
    expect(result.outcome).toBe('prepared');
    expect(calls).toEqual(['commit', 'evidence', 'source']);
    if (result.outcome !== 'prepared') throw new Error('expected prepared result');
    expect(result.reviewBundle.reviewBundleSha256).toBe(reviewBundleDigest(result.reviewBundle));
  });

  it('maps commit errors at the orchestrator boundary and keeps REVIEWING after preparation', async () => {
    const d = dispatch();
    const assignment = { id: d.assignmentId, taskId: d.taskId, agentId: d.agentId, status: 'ACTIVE', specVersion: 'v1', profileHash: d.executionProfileSha256 };
    const task = { id: d.taskId, projectId: d.projectId, status: TaskStatus.IMPLEMENTING, assignedAgentId: d.agentId, assignmentId: d.assignmentId, acceptanceCriteria: [] };
    const agent = { id: d.agentId, provider: d.providerId, status: 'BUSY', enabled: true };
    const tasks = { getTask: vi.fn(() => task), transitionTask: vi.fn() };
    const assignments = { getAssignment: vi.fn(() => assignment), suspendActiveAssignment: vi.fn(), finalizeFailedAssignment: vi.fn(), finalizeCompletedAssignment: vi.fn() };
    let owned = true;
    const pool = { getSnapshot: vi.fn(() => owned ? ({ state: 'OWNED', busy: true, active: false, reserved: false, taskId: d.taskId, assignmentId: d.assignmentId, specVersion: 'v1', profileHash: d.executionProfileSha256 }) : ({ state: 'IDLE', busy: false, active: false, reserved: false })), shutdown: vi.fn(() => { owned = false; return Promise.resolve(); }), runTurn: vi.fn() };
    const manager = worktree({
      inspectWorkspace: vi.fn(() => Promise.resolve({ taskId: d.taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: d.workspace.branchName, baseCommit: d.workspace.baseCommit, headCommit: d.workspace.headCommit })),
    });
    const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: { getAgent: vi.fn(() => agent), calculateExecutionProfileHash: vi.fn(() => d.executionProfileSha256) }, assignmentManager: assignments, agentPool: pool, worktreeManager: manager } as never);
    const result = await lifecycle.prepareReview({ dispatchResult: d, buildTestPlan: plan });
    expect(result.outcome).toBe('review-ready');
    expect(tasks.transitionTask).toHaveBeenCalledWith(d.taskId, TaskStatus.REVIEWING);
    const commitOrder = (manager.commitTaskWorkspace as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const evidenceOrder = (manager.collectBuildTestEvidence as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(commitOrder).toBeDefined();
    expect(evidenceOrder).toBeDefined();
    if (commitOrder === undefined || evidenceOrder === undefined) throw new Error('expected preparation calls');
    expect(commitOrder).toBeLessThan(evidenceOrder);
    const ready = result as Extract<typeof result, { outcome: 'review-ready' }>;
    expect(ready.lifecycleSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(ready.reviewBundle.reviewBundleSha256).toMatch(/^[0-9a-f]{64}$/u);

    owned = true;
    const failing = worktree({
      inspectWorkspace: vi.fn(() => Promise.resolve({ taskId: d.taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: d.workspace.branchName, baseCommit: d.workspace.baseCommit, headCommit: d.workspace.headCommit })),
      commitTaskWorkspace: vi.fn().mockRejectedValue(new GitTaskCommitError('GIT_TASK_COMMIT_FAILED')),
    });
    const failingLifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: { getAgent: vi.fn(() => agent), calculateExecutionProfileHash: vi.fn(() => d.executionProfileSha256) }, assignmentManager: assignments, agentPool: pool, worktreeManager: failing } as never);
    await expect(failingLifecycle.prepareReview({ dispatchResult: d, buildTestPlan: plan })).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_COMMIT_FAILED' });

    owned = true;
    const generic = worktree({
      inspectWorkspace: vi.fn(() => Promise.resolve({ taskId: d.taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: d.workspace.branchName, baseCommit: d.workspace.baseCommit, headCommit: d.workspace.headCommit })),
      commitTaskWorkspace: vi.fn().mockRejectedValue(new Error('private commit detail')),
    });
    const genericLifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: { getAgent: vi.fn(() => agent), calculateExecutionProfileHash: vi.fn(() => d.executionProfileSha256) }, assignmentManager: assignments, agentPool: pool, worktreeManager: generic } as never);
    await expect(genericLifecycle.prepareReview({ dispatchResult: d, buildTestPlan: plan })).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED' });
  });

  it.each([
    ['evidence throw', { collectBuildTestEvidence: vi.fn().mockRejectedValue(new Error('private')) }, 'blocked'],
    ['workspace mutated', { collectBuildTestEvidence: vi.fn().mockResolvedValue(evidenceSnapshot(sourceSnapshot(), 'workspace-mutated')) }, 'blocked'],
    ['infrastructure failed', { collectBuildTestEvidence: vi.fn().mockResolvedValue(evidenceSnapshot(sourceSnapshot(), 'infrastructure-failed')) }, 'blocked'],
    ['source throw', { captureWorkspaceChanges: vi.fn().mockRejectedValue(new Error('private')) }, 'blocked'],
    ['source mismatch', { captureWorkspaceChanges: vi.fn().mockResolvedValue({ ...sourceSnapshot(), changeSetSha256: 'c'.repeat(64) }) }, 'blocked'],
    ['source head mismatch', { captureWorkspaceChanges: vi.fn().mockResolvedValue({ ...sourceSnapshot(), headCommit: 'c'.repeat(40) }) }, 'blocked'],
    ['dirty source', { captureWorkspaceChanges: vi.fn().mockResolvedValue({ ...sourceSnapshot(), untracked: [{ path: 'dirty.txt', kind: 'regular', size: 1, sha256: sha }] }) }, 'blocked'],
  ] as const)('returns the required preparation outcome for %s', async (_name, overrides, expected) => {
    const result = await new ReviewPreparationCoordinator(worktree(overrides)).prepare({ dispatch: dispatch(), workerResult: completed,
      buildTestPlan: plan, evidenceOptions: {} });
    expect(expected).toBe('blocked');
    expect(result.outcome).toBe('evidence-integrity-blocked');
  });
});
