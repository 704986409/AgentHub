import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ReviewHandleStore } from '../src/api/ReviewHandleStore.js';
import { Database } from '../src/database/index.js';
import type { PlanDto } from '../src/lifecycle/plan-lifecycle.js';
import {
  digest,
  makeReviewBundle,
  snapshotTaskReviewBundle,
  type TaskReviewBundle,
} from '../src/orchestration/lifecycle/TaskLifecycleContract.js';
import type { AgentHubWorkerResult } from '../src/protocol/AgentHubWorkerResult.js';
import type { BuildTestEvidence, GitWorkspaceChangeSnapshot, TaskCommitResult } from '../src/workspace/index.js';

const oid = 'a'.repeat(40);
const changeSetSha256 = 'c'.repeat(64);
const sourceVisibilitySha256 = 'd'.repeat(64);
const emptyPatchSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [], blockers: [],
  questions: [], risks: [], notes: [],
};

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

function durableBundle(): TaskReviewBundle {
  const dispatch = {
    taskId: 'TASK', projectId: 'PROJECT', agentId: 'AGENT', assignmentId: 'ASSIGN', providerId: 'fake',
    reservationSha256: '1'.repeat(64), dispatchSha256: '2'.repeat(64), executionProfileSha256: '3'.repeat(64),
  } as never;
  return snapshotTaskReviewBundle(makeReviewBundle(dispatch, taskCommit(), evidence(), source(), workerResult));
}

function reviewingPlan(runtimeTaskId: string, assignmentId: string | null = 'ASSIGN', agentId: string | null = 'AGENT'): PlanDto {
  return {
    planId: 'plan-1',
    intakeId: 'intake-1',
    projectId: 'PROJECT',
    leadAgentId: 'LEAD',
    currentVersion: 1,
    state: 'REVIEWING',
    current: {
      planId: 'plan-1', version: 1, proposalHash: 'a'.repeat(64), leadAgentId: 'LEAD', summary: 's',
      tasks: [], dependencies: [], createdAt: 't',
    },
    tasks: [{
      planTaskId: 'pt-1', clientId: 'a', parentPlanTaskId: null, title: 'A', description: null,
      acceptanceCriteria: ['done'], requiredCapabilities: [], requiredSpecialties: [],
      complexity: 'SIMPLE', risk: 'LOW', planId: 'plan-1', planVersion: 1,
      runtimeTaskId, assignmentId, agentId, dependencyState: 'ELIGIBLE', blockedBy: [], runtimeState: 'REVIEWING',
    }],
    dependencies: [],
    decisions: [],
    aggregate: { total: 1, pending: 0, blocked: 0, eligible: 0, running: 0, reviewing: 1, completed: 0, failed: 0, state: 'REVIEWING' },
    startedVersion: 1, startedAt: 't', createdAt: 't', updatedAt: 't', completedAt: null,
  } as PlanDto;
}

describe('0.7.3E lifecycle review recovery', { timeout: 8_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function openDatabase(): Promise<Database> {
    const directory = await mkdtemp(join(tmpdir(), 'agenthub-review-recovery-'));
    directories.push(directory);
    const database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    databases.push(database);
    return database;
  }

  it('8. Backend restart restores REVIEWING review identity', async () => {
    const database = await openDatabase();
    const first = new ReviewHandleStore(database);
    const bundle = durableBundle();
    const handle = first.register(bundle);
    const plan = reviewingPlan(bundle.taskId);
    expect(first.listPublic([plan])).toHaveLength(1);
    expect(first.listPublic([plan])[0]?.review.reviewHandle).toBe(handle);

    const restored = new ReviewHandleStore(database);
    const listed = restored.listPublic([plan]);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.review.reviewHandle).toBe(handle);
    expect(listed[0]?.runtimeTaskId).toBe('TASK');
    expect(restored.resolve(handle).reviewBundleSha256).toBe(handle);
  });

  it('9. expired handles are not returned after persist or restart', async () => {
    const database = await openDatabase();
    const first = new ReviewHandleStore(database);
    const bundle = durableBundle();
    const handle = first.register(bundle);
    first.expire(handle);
    expect(first.listPublic([reviewingPlan(bundle.taskId)])).toHaveLength(0);
    expect(() => first.resolve(handle)).toThrow();

    const restored = new ReviewHandleStore(database);
    expect(restored.listPublic([reviewingPlan(bundle.taskId)])).toHaveLength(0);
    expect(() => restored.resolve(handle)).toThrow();
  });

  it('10. stale or forged runtime mapping is omitted', () => {
    const store = new ReviewHandleStore();
    const bundle = durableBundle();
    store.register(bundle);
    const mismatchedTask = reviewingPlan('OTHER');
    expect(store.listPublic([mismatchedTask])).toHaveLength(0);
    const mismatchedAssignment = reviewingPlan(bundle.taskId, 'FORGED', 'AGENT');
    expect(store.listPublic([mismatchedAssignment])).toHaveLength(0);
    const original = reviewingPlan(bundle.taskId);
    const firstTask = original.tasks[0];
    if (firstTask === undefined) throw new Error('missing plan task');
    const duplicate: PlanDto = {
      ...original,
      tasks: [
        ...original.tasks,
        { ...firstTask, planTaskId: 'pt-2', planId: 'plan-2' },
      ],
    };
    expect(store.listPublic([duplicate])).toHaveLength(0);
  });
});
