import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  GitWorktreeManager,
  TaskLifecycleOrchestrator,
  TaskStatus,
  type AgentHubWorkerResult,
  type AssignmentDispatchResult,
  type BuildTestEvidence,
  type BuildTestEvidencePlan,
  type GitWorkspaceChangeSnapshot,
} from '../src/index.js';

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

function makeHarness(workerResult: AgentHubWorkerResult) {
  const d = dispatch(workerResult);
  const assignment = { id: d.assignmentId, taskId: d.taskId, agentId: d.agentId,
    status: 'ACTIVE', specVersion: 'v1', profileHash: d.executionProfileSha256 };
  const task = { id: d.taskId, projectId: d.projectId, status: TaskStatus.IMPLEMENTING,
    assignedAgentId: d.agentId, assignmentId: d.assignmentId, acceptanceCriteria: [] };
  const agent = { id: d.agentId, provider: d.providerId, status: 'BUSY', enabled: true };
  const assignments = {
    getAssignment: vi.fn(() => assignment),
    suspendActiveAssignment: vi.fn(), finalizeFailedAssignment: vi.fn(), finalizeCompletedAssignment: vi.fn(),
  };
  const tasks = { getTask: vi.fn(() => task), transitionTask: vi.fn() };
  const agents = { getAgent: vi.fn(() => agent), calculateExecutionProfileHash: vi.fn(() => d.executionProfileSha256) };
  let owned = true;
  const pool = {
    getSnapshot: vi.fn(() => owned
      ? ({ state: 'OWNED', busy: true, active: false, reserved: false,
          taskId: d.taskId, assignmentId: d.assignmentId, specVersion: assignment.specVersion,
          profileHash: assignment.profileHash })
      : ({ state: 'IDLE', busy: false, active: false, reserved: false })),
    shutdown: vi.fn(() => { owned = false; return Promise.resolve(); }), runTurn: vi.fn(),
  };
  const worktrees = Object.assign(Object.create(GitWorktreeManager.prototype) as GitWorktreeManager, {
    inspectWorkspace: vi.fn(() => Promise.resolve({ taskId: d.taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt',
      branchName: d.workspace.branchName, baseCommit: d.workspace.baseCommit, headCommit: d.workspace.headCommit })),
    commitTaskWorkspace: vi.fn(), collectBuildTestEvidence: vi.fn(), captureWorkspaceChanges: vi.fn(),
  });
  const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees } as never);
  return { d, lifecycle, assignments, tasks, agents, pool, worktrees };
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

function evidenceSnapshot(source: GitWorkspaceChangeSnapshot): BuildTestEvidence {
  return { version: 2, taskId: source.taskId, branchName: source.branchName,
    baseCommit: source.baseCommit, headCommit: source.headCommit, changeSetSha256: source.changeSetSha256,
    sourceVisibilitySha256: sha, build: 'not-run', test: 'passed', outcome: 'passed', commands: [], evidenceSha256: sha };
}

describe('TaskLifecycleOrchestrator focused lifecycle outcomes', () => {
  it('fences concurrent lifecycle mutations for the same task', async () => {
    const h = makeHarness(completed);
    let rejectCommit!: (error: Error) => void;
    h.worktrees.commitTaskWorkspace = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectCommit = reject;
    }));
    const first = h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan });
    await Promise.resolve();
    await expect(h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan }))
      .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TASK_BUSY' });
    rejectCommit(new Error('controlled commit failure'));
    await expect(first).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED' });
  });

  it.each([
    ['FAILED', 'failed', 'finalizeFailedAssignment'],
    ['BLOCKED', 'blocked', 'suspendActiveAssignment'],
    ['NEEDS_INPUT', 'waiting-input', 'suspendActiveAssignment'],
  ] as const)('handles %s without commit, evidence, or merge', async (outcome, expected, method) => {
    const worker: AgentHubWorkerResult = { ...completed, outcome,
      blockers: outcome === 'BLOCKED' ? ['blocked'] : [], questions: outcome === 'NEEDS_INPUT' ? ['question'] : [] };
    const h = makeHarness(worker);
    const result = await h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan });
    expect(result.outcome).toBe(expected);
    expect(h.pool.shutdown).toHaveBeenCalledTimes(1);
    expect(h.assignments[method]).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid dispatch result before any lifecycle side effect', async () => {
    const h = makeHarness(completed);
    await expect(h.lifecycle.prepareReview({ dispatchResult: { ...h.d, taskId: 'TAMPERED' }, buildTestPlan: plan }))
      .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_INVALID_DISPATCH_RESULT' });
    expect(h.pool.shutdown.mock.calls).toHaveLength(0);
    expect(h.worktrees.inspectWorkspace.mock.calls).toHaveLength(0);
  });

  it.each([
    ['collector throw', () => Promise.reject(new Error('private infrastructure detail')), false],
    ['workspace-mutated', () => Promise.resolve({ ...evidenceSnapshot(sourceSnapshot()), outcome: 'workspace-mutated' }), false],
    ['infrastructure-failed', () => Promise.resolve({ ...evidenceSnapshot(sourceSnapshot()), outcome: 'infrastructure-failed' }), false],
    ['source capture failure', () => Promise.resolve(evidenceSnapshot(sourceSnapshot())), true],
  ] as const)('closes %s and rejects retry before another commit', async (_name, collect, captureFails) => {
    const h = makeHarness(completed);
    h.worktrees.commitTaskWorkspace = vi.fn().mockResolvedValue({ version: 1, taskId: h.d.taskId,
      branchName: h.d.workspace.branchName, baseCommit: oid, headBefore: oid, headAfter: oid,
      outcome: 'no-changes', taskCommitSha256: sha });
    h.worktrees.collectBuildTestEvidence = vi.fn().mockImplementation(collect);
    h.worktrees.captureWorkspaceChanges = captureFails
      ? vi.fn().mockRejectedValue(new Error('private capture detail'))
      : vi.fn().mockResolvedValue(sourceSnapshot());
    const first = await h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan });
    expect(first.outcome).toBe('blocked');
    expect(h.pool.shutdown).toHaveBeenCalledTimes(1);
    expect(h.assignments.suspendActiveAssignment).toHaveBeenCalledWith(h.d.assignmentId, TaskStatus.BLOCKED);
    await expect(h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan }))
      .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_STALE_EXECUTION' });
    expect((h.worktrees.commitTaskWorkspace as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it.each([
    ['evidence/source mismatch', { changeSetSha256: 'c'.repeat(64) }],
    ['dirty source', { untracked: [{ path: 'unexpected.txt', kind: 'regular', size: 1, sha256: sha }] }],
    ['head drift', { headCommit: 'c'.repeat(40) }],
  ] as const)('closes %s before REVIEWING', async (_name, override) => {
    const h = makeHarness(completed);
    const source = sourceSnapshot();
    h.worktrees.commitTaskWorkspace = vi.fn().mockResolvedValue({ version: 1, taskId: h.d.taskId,
      branchName: h.d.workspace.branchName, baseCommit: oid, headBefore: oid, headAfter: oid,
      outcome: 'no-changes', taskCommitSha256: sha });
    h.worktrees.collectBuildTestEvidence = vi.fn().mockResolvedValue(evidenceSnapshot(source));
    h.worktrees.captureWorkspaceChanges = vi.fn().mockResolvedValue({ ...source, ...override });
    await expect(h.lifecycle.prepareReview({ dispatchResult: h.d, buildTestPlan: plan }))
      .resolves.toMatchObject({ outcome: 'blocked' });
    expect(h.tasks.transitionTask).not.toHaveBeenCalled();
    expect(h.assignments.suspendActiveAssignment).toHaveBeenCalledWith(h.d.assignmentId, TaskStatus.BLOCKED);
  });
});
