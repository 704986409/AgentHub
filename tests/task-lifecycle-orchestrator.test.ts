import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  GitWorktreeManager,
  TaskLifecycleOrchestrator,
  TaskStatus,
  type AgentHubWorkerResult,
  type AssignmentDispatchResult,
  type BuildTestEvidencePlan,
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
  });
  const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees } as never);
  return { d, lifecycle, assignments, tasks, pool, worktrees };
}

describe('TaskLifecycleOrchestrator focused lifecycle outcomes', () => {
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
});
