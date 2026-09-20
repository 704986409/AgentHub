import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { ReviewHandleStore } from '../src/api/ReviewHandleStore.js';
import { normalizeApiError } from '../src/api/ApiErrors.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import {
  PLAN_REVIEW_RECONCILIATION_REQUIRED,
  ReviewTransitionCoordinator,
} from '../src/lifecycle/review-transition-coordinator.js';
import {
  digest,
  makeReviewBundle,
  snapshotTaskReviewBundle,
  type TaskReviewBundle,
} from '../src/orchestration/lifecycle/TaskLifecycleContract.js';
import type { AgentHubWorkerResult } from '../src/protocol/AgentHubWorkerResult.js';
import { AgentProfileManager, AgentRegistry, TaskManager } from '../src/services/index.js';
import {
  SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository,
} from '../src/repositories/index.js';
import { canonicalChangeState } from '../src/workspace/GitWorkspaceChangeCapture.js';
import type { BuildTestEvidence, GitWorkspaceChangeSnapshot, TaskCommitResult } from '../src/workspace/index.js';

const oid = 'a'.repeat(40);
const changeSetSha256 = 'c'.repeat(64);
const sourceVisibilitySha256 = 'd'.repeat(64);
const emptyPatchSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [], blockers: [],
  questions: [], risks: [], notes: [],
};

function crash(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

function source(taskId: string): GitWorkspaceChangeSnapshot {
  const patch = { status: 'empty' as const, byteLength: 0 as const, sha256: emptyPatchSha256 };
  const layer = { changes: [], patch };
  return {
    taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: `agenthub/${taskId}`,
    baseCommit: oid, headCommit: oid, committed: layer, staged: layer, unstaged: layer,
    workingFiles: [], untracked: [], conflicts: [], ignored: { present: false, count: 0, paths: [], truncated: false },
    changedPaths: [], hasConflicts: false, changeSetSha256,
  };
}

function taskCommit(taskId: string): TaskCommitResult {
  const base = { version: 1 as const, taskId, branchName: `agenthub/${taskId}`, baseCommit: oid,
    headBefore: oid, headAfter: oid, outcome: 'no-changes' as const };
  return { ...base, taskCommitSha256: digest('AgentHub.TaskCommitResult.v1', base) };
}

function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'durationMs' || key === 'preview' || key === 'previewTruncated' || key === 'executableName' || key === 'cwd') continue;
      result[key] = canonicalEvidence((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function evidence(taskId: string): BuildTestEvidence {
  const base = {
    version: 2 as const, taskId, branchName: `agenthub/${taskId}`, baseCommit: oid, headCommit: oid,
    changeSetSha256, sourceVisibilitySha256, build: 'not-run' as const, test: 'passed' as const,
    outcome: 'passed' as const, commands: [] as const,
  };
  return {
    ...base,
    evidenceSha256: createHash('sha256').update(canonicalChangeState(canonicalEvidence(base))).digest('hex'),
  };
}

function durableBundle(taskId: string, salt = 'v1'): TaskReviewBundle {
  const dispatch = {
    taskId, projectId: 'PROJECT', agentId: 'AGENT', assignmentId: `asg-${taskId}`, providerId: 'fake',
    reservationSha256: digest('AgentHub.TestReservation', { taskId, salt }),
    dispatchSha256: digest('AgentHub.TestDispatch', { taskId, salt }),
    executionProfileSha256: '3'.repeat(64),
  } as never;
  return snapshotTaskReviewBundle(makeReviewBundle(dispatch, taskCommit(taskId), evidence(taskId), source(taskId), workerResult));
}

function coded(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

describe('0.7.3G terminal review cleanup reconciliation', { timeout: 8_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function openSqlite() {
    const directory = await mkdtemp(join(tmpdir(), 'agenthub-073G-'));
    directories.push(directory);
    const database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    databases.push(database);
    const events = new EventBus();
    const projects = new SqliteProjectRepository(database);
    const project = projects.create({ name: 'P' });
    const agents = new AgentRegistry(new SqliteAgentRepository(database),
      new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), events);
    const lead = agents.createAgent({ name: 'Lead', provider: 'codex', model: 'm', position: 'Lead', projectId: project.id });
    const tasks = new TaskManager(new SqliteTaskRepository(database), undefined, events);
    const assignments = new SqliteAssignmentRepository(database);
    const planLifecycle = new PlanLifecycleService(projects, agents, events, database, tasks, assignments);
    const intake = planLifecycle.createIntake({
      projectId: project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id,
    });
    return { directory, database, events, project, lead, tasks, planLifecycle, intake };
  }

  function startPlan(h: Awaited<ReturnType<typeof openSqlite>>) {
    const plan = h.planLifecycle.createPlan({
      intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run',
      tasks: [
        { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
        { clientId: 'b', parentClientId: null, title: 'B', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
      ],
      dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }],
    });
    const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const definitionA = approved.current.tasks[0];
    const definitionB = approved.current.tasks[1];
    if (!definitionA || !definitionB) throw new Error('missing plan tasks');
    const runtimeA = h.planLifecycle.materializeRuntimeTask(approved.planId, 1, definitionA);
    const runtimeB = h.planLifecycle.materializeRuntimeTask(approved.planId, 1, definitionB);
    h.planLifecycle.markStarted(approved.planId, 1);
    return { planId: approved.planId, runtimeA, runtimeB, definitionA };
  }

  function forceImplementing(tasks: TaskManager, taskId: string): void {
    tasks.transitionTask(taskId, TaskStatus.QUEUED);
    tasks.transitionTask(taskId, TaskStatus.ASSIGNED);
    tasks.transitionTask(taskId, TaskStatus.IMPLEMENTING);
  }

  function reopen(h: Awaited<ReturnType<typeof openSqlite>>) {
    h.database.close();
    const reopened = new Database(join(h.directory, 'agenthub.db'));
    reopened.initialize();
    databases.push(reopened);
    const events = new EventBus();
    const projects = new SqliteProjectRepository(reopened);
    const agents = new AgentRegistry(new SqliteAgentRepository(reopened),
      new AgentProfileManager({ agentsDirectory: join(h.directory, 'agents') }), events);
    const tasks = new TaskManager(new SqliteTaskRepository(reopened), undefined, events);
    const planLifecycle = new PlanLifecycleService(projects, agents, events, reopened, tasks, new SqliteAssignmentRepository(reopened));
    const reviews = new ReviewHandleStore(reopened);
    const transitions = new ReviewTransitionCoordinator({
      database: reopened, reviews, planLifecycle, tasks,
    });
    return { reopened, tasks, planLifecycle, reviews, transitions };
  }

  it('A. ACCEPT crash after Review expire clears stale reviewPending on restart', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(started.runtimeA);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { afterTerminalReviewExpiredBeforePlanResolution: () => crash('CRASH_AFTER_EXPIRE') },
    });
    transitions.commitPrepared(bundle, () => { h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING); });
    transitions.markPlanReviewPending(started.runtimeA);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.COMPLETED);
    expect(() => transitions.expireAfterTerminalDecision(bundle.reviewBundleSha256)).toThrow(/CRASH_AFTER_EXPIRE/u);
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(true);

    const restored = reopen(h);
    restored.transitions.reconcile();
    expect(restored.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(restored.reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    expect(restored.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
    const plan = restored.planLifecycle.getPlan(started.planId);
    const taskA = plan?.tasks.find((task) => task.runtimeTaskId === started.runtimeA);
    const taskB = plan?.tasks.find((task) => task.runtimeTaskId === started.runtimeB);
    expect(taskA?.dependencyState).toBe('SATISFIED');
    expect(taskA?.runtimeState).toBe('COMPLETED');
    expect(taskB?.blockedBy).not.toContain(started.definitionA.planTaskId);
    expect(taskB?.dependencyState).toBe('ELIGIBLE');
    expect(restored.reviews.listActive().filter((item) => item.taskId === started.runtimeA)).toHaveLength(0);

    restored.reopened.close();
    const second = reopen({ ...h, database: restored.reopened });
    second.transitions.reconcile();
    expect(second.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
  });

  it('1. post-expire COMPLETED residue repair persists reviewPending=false', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    h.planLifecycle.markReviewPendingByTask(started.runtimeA, true);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.COMPLETED);
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    transitions.reconcile();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
    const restored = reopen(h);
    restored.transitions.reconcile();
    expect(restored.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(restored.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
  });

  it('2. stale active Review on COMPLETED is still expired and pending cleared', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(started.runtimeA);
    reviews.register(bundle);
    h.planLifecycle.markReviewPendingByTask(started.runtimeA, true);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.COMPLETED);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    transitions.reconcile();
    expect(reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
  });

  it('3. orphan REVIEWING still fail-closes with public 503', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    h.planLifecycle.markReviewPendingByTask(started.runtimeA, true);
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    expect(() => transitions.reconcile()).toThrow(PLAN_REVIEW_RECONCILIATION_REQUIRED);
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(true);
    const normalized = normalizeApiError(coded(PLAN_REVIEW_RECONCILIATION_REQUIRED));
    expect(normalized.code).toBe('AGENTHUB_API_PLAN_REVIEW_RECONCILIATION_REQUIRED');
    expect(normalized.status).toBe(503);
    const app = {
      projects: { list: () => [] }, agents: { listAgents: () => [] }, tasks: { listTasks: () => [] },
      assignmentQueries: { list: () => [] }, events: { list: () => [] }, eventBus: h.events,
      planLifecycle: h.planLifecycle, reviews, reviewTransitions: transitions,
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${String(address.port)}/api/v1/reviews`);
      expect(response.status).toBe(503);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('AGENTHUB_API_PLAN_REVIEW_RECONCILIATION_REQUIRED');
    } finally {
      await server.stop();
    }
  });

  it('4. Review exists with missing Plan flag still fills reviewPending', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(started.runtimeA);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    transitions.commitPrepared(bundle, () => { h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING); });
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
    transitions.reconcile();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(true);
    expect(reviews.getActiveForTask(started.runtimeA)?.reviewBundleSha256).toBe(bundle.reviewBundleSha256);
  });

  it('5. clean terminal state is idempotent across restart', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    h.tasks.transitionTask(started.runtimeA, TaskStatus.COMPLETED);
    const reviews = new ReviewHandleStore(h.database);
    const first = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    first.reconcile();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
    const restored = reopen(h);
    restored.transitions.reconcile();
    expect(restored.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(restored.reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    expect(restored.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA)?.reviewPending).toBe(false);
  });

  it('REQUEST_REVISION keeps exactly one active Review', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    const oldBundle = durableBundle(started.runtimeA, 'old');
    const newBundle = durableBundle(started.runtimeA, 'new');
    const reviews = new ReviewHandleStore(h.database);
    reviews.register(oldBundle);
    reviews.replaceActiveForTask(started.runtimeA, newBundle, oldBundle.reviewBundleSha256);
    expect(reviews.listActive().filter((item) => item.taskId === started.runtimeA)).toHaveLength(1);
    expect(reviews.getActiveForTask(started.runtimeA)?.reviewBundleSha256).toBe(newBundle.reviewBundleSha256);
    expect(() => reviews.resolve(oldBundle.reviewBundleSha256)).toThrow();
  });
});
