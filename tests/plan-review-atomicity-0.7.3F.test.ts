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
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
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

function durableBundle(taskId: string, salt = 'v1'): TaskReviewBundle {
  const dispatch = {
    taskId, projectId: 'PROJECT', agentId: 'AGENT', assignmentId: `asg-${taskId}`, providerId: 'fake',
    reservationSha256: digest('AgentHub.TestReservation', { taskId, salt }),
    dispatchSha256: digest('AgentHub.TestDispatch', { taskId, salt }),
    executionProfileSha256: '3'.repeat(64),
  } as never;
  return snapshotTaskReviewBundle(makeReviewBundle(dispatch, taskCommit(taskId), evidence(taskId), source(taskId), workerResult));
}

describe('0.7.3F review transition atomicity', { timeout: 8_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function openSqlite() {
    const directory = await mkdtemp(join(tmpdir(), 'agenthub-073F-'));
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
    return { planId: approved.planId, proposalHash: approved.current.proposalHash, runtimeA, runtimeB, definitionA, definitionB };
  }

  function forceImplementing(tasks: TaskManager, taskId: string): void {
    tasks.transitionTask(taskId, TaskStatus.QUEUED);
    tasks.transitionTask(taskId, TaskStatus.ASSIGNED);
    tasks.transitionTask(taskId, TaskStatus.IMPLEMENTING);
  }

  it('1. crash before review persist leaves no orphan REVIEWING', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { beforeAuthoritativeReviewPersist: () => crash('CRASH_BEFORE_REVIEW') },
    });
    expect(() => transitions.commitPrepared(durableBundle(started.runtimeA), () => {
      h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    })).toThrow(/CRASH_BEFORE_REVIEW/u);
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    transitions.reconcile();
    expect(h.tasks.getTask(started.runtimeA)?.status).not.toBe(TaskStatus.REVIEWING);
    expect(reviews.listPublic(h.planLifecycle.listPlans())).toHaveLength(0);
  });

  it('2-3. crash after review durable restores the same handle and reviewPending', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(started.runtimeA);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { afterAuthoritativeReviewPersist: () => crash('CRASH_AFTER_REVIEW') },
    });
    expect(() => transitions.commitPrepared(bundle, () => {
      h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING);
    })).toThrow(/CRASH_AFTER_REVIEW/u);
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.REVIEWING);
    expect(reviews.getActiveForTask(started.runtimeA)?.reviewBundleSha256).toBe(bundle.reviewBundleSha256);
    const restored = new ReviewHandleStore(h.database);
    const recovered = new ReviewTransitionCoordinator({
      database: h.database, reviews: restored, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    recovered.reconcile();
    const listed = restored.listPublic(h.planLifecycle.listPlans());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.review.reviewHandle).toBe(bundle.reviewBundleSha256);
    const link = h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === started.runtimeA);
    expect(link?.reviewPending).toBe(true);
  });

  it('4. REQUEST_REVISION rotation crash leaves exactly one active review', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    const first = durableBundle(started.runtimeA, 'old');
    const second = durableBundle(started.runtimeA, 'new');
    const store = new ReviewHandleStore(h.database);
    store.register(first);
    h.database.connection.prepare(
      'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ).run('public_review_handle_snapshot', JSON.stringify({ schemaVersion: 1, bundles: [first, second] }), new Date().toISOString());
    const restored = new ReviewHandleStore(h.database);
    expect(restored.listActive()).toHaveLength(1);
    expect(restored.getActiveForTask(started.runtimeA)?.reviewBundleSha256).toBe(second.reviewBundleSha256);
    expect(() => restored.resolve(first.reviewBundleSha256)).toThrow();
    restored.replaceActiveForTask(started.runtimeA, second, second.reviewBundleSha256);
    expect(restored.listActive()).toHaveLength(1);
  });

  it('5. ACCEPT cleanup crash expires stale review without rolling back completion', async () => {
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
      failpoints: { afterTaskCompletedBeforeExpire: () => crash('CRASH_BEFORE_EXPIRE') },
    });
    expect(() => transitions.expireAfterTerminalDecision(bundle.reviewBundleSha256)).toThrow(/CRASH_BEFORE_EXPIRE/u);
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    const recovered = new ReviewTransitionCoordinator({
      database: h.database, reviews: new ReviewHandleStore(h.database), planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    recovered.reconcile();
    expect(h.tasks.getTask(started.runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(recovered.reviews.getActiveForTask(started.runtimeA)).toBeUndefined();
    expect(h.planLifecycle.getPlan(started.planId)?.tasks.find((task) => task.runtimeTaskId === started.runtimeA)?.runtimeState)
      .toBe('COMPLETED');
  });

  it('6. dependent dispatch crash does not repeat assignment or review', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    const calls: string[] = [];
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { afterAuthoritativeReviewPersist: () => {
        if (calls.filter((item) => item.startsWith('review:')).length >= 2) crash('CRASH_DEPENDENT');
      } },
    });
    const coordinator = new PlanExecutionCoordinator({
      planLifecycle: h.planLifecycle, tasks: h.tasks,
      scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => {
        calls.push(`schedule:${taskId}`);
        return { outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: 'worker' };
      } } as never,
      dispatcher: { dispatch: (request: { reservation: { taskId: string } }) => {
        calls.push(`dispatch:${request.reservation.taskId}`);
        forceImplementing(h.tasks, request.reservation.taskId);
        return Promise.resolve({ taskId: request.reservation.taskId });
      } } as never,
      taskLifecycle: { prepareReview: (request: { dispatchResult: { taskId: string } }) => {
        calls.push(`review:${request.dispatchResult.taskId}`);
        const bundle = durableBundle(request.dispatchResult.taskId, request.dispatchResult.taskId);
        transitions.commitPrepared(bundle, () => {
          h.tasks.transitionTask(request.dispatchResult.taskId, TaskStatus.REVIEWING);
        });
        return Promise.resolve({ outcome: 'review-ready', reviewBundle: bundle });
      } } as never,
      targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events, reviewTransitions: transitions,
    });
    await coordinator.start(started.planId, { planVersion: 1, proposalHash: started.proposalHash });
    const handleA = reviews.getActiveForTask(started.runtimeA)?.reviewBundleSha256;
    h.tasks.transitionTask(started.runtimeA, TaskStatus.COMPLETED);
    transitions.expireAfterTerminalDecision(handleA ?? '');
    await expect(coordinator.afterReview(started.runtimeA)).rejects.toThrow(/CRASH_DEPENDENT/u);
    expect(calls.filter((item) => item === `dispatch:${started.runtimeB}`)).toHaveLength(1);
    const recovered = new ReviewTransitionCoordinator({
      database: h.database, reviews: new ReviewHandleStore(h.database), planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    recovered.reconcile();
    expect(recovered.reviews.listActive().filter((bundle) => bundle.taskId === started.runtimeB)).toHaveLength(1);
    expect(h.planLifecycle.listPlans().flatMap((plan) => plan.tasks).filter((task) => task.runtimeTaskId === started.runtimeB))
      .toHaveLength(1);
  });

  it('7. exact sqlite restart round trip keeps plan/runtime/review identity', async () => {
    const h = await openSqlite();
    const started = startPlan(h);
    forceImplementing(h.tasks, started.runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(started.runtimeA);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    transitions.commitPrepared(bundle, () => { h.tasks.transitionTask(started.runtimeA, TaskStatus.REVIEWING); });
    transitions.markPlanReviewPending(started.runtimeA);
    const before = h.planLifecycle.getPlan(started.planId);
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
    const restoredReviews = new ReviewHandleStore(reopened);
    new ReviewTransitionCoordinator({
      database: reopened, reviews: restoredReviews, planLifecycle, tasks,
    }).reconcile();
    const after = planLifecycle.getPlan(started.planId);
    const listed = restoredReviews.listPublic(planLifecycle.listPlans());
    expect(after?.planId).toBe(before?.planId);
    expect(after?.current.proposalHash).toBe(started.proposalHash);
    expect(after?.tasks[0]?.runtimeTaskId).toBe(started.runtimeA);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.review.reviewHandle).toBe(bundle.reviewBundleSha256);
    expect(listed[0]?.runtimeTaskId).toBe(started.runtimeA);
    expect(after?.aggregate.reviewing).toBeGreaterThan(0);
  });

  it('8. unrecoverable orphan REVIEWING fail-closes with PLAN_REVIEW_RECONCILIATION_REQUIRED', async () => {
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
    expect(transitions.reconciliationRequired).toBe(true);
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
});

function coded(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}
