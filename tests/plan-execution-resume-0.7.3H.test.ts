import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { ReviewHandleStore } from '../src/api/ReviewHandleStore.js';
import { recoverLifecycleAfterStartup } from '../src/application/createLocalAgentHubApplication.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService, type CreatePlanTaskInput } from '../src/lifecycle/plan-lifecycle.js';
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

function step(clientId: string): CreatePlanTaskInput {
  return {
    clientId, parentClientId: null, title: clientId, description: null, acceptanceCriteria: ['done'],
    requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
  };
}

describe('0.7.3H post-reconciliation execution resume', { timeout: 8_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function openSqlite() {
    const directory = await mkdtemp(join(tmpdir(), 'agenthub-073H-'));
    directories.push(directory);
    const database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    databases.push(database);
    return bind(directory, database);
  }

  function bind(directory: string, database: Database) {
    const events = new EventBus();
    const projects = new SqliteProjectRepository(database);
    const project = projects.list()[0] ?? projects.create({ name: 'P' });
    const agents = new AgentRegistry(new SqliteAgentRepository(database),
      new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), events);
    const lead = agents.listAgents()[0] ?? agents.createAgent({
      name: 'Lead', provider: 'codex', model: 'm', position: 'Lead', projectId: project.id,
    });
    const tasks = new TaskManager(new SqliteTaskRepository(database), undefined, events);
    const assignmentStore = new SqliteAssignmentRepository(database);
    const planLifecycle = new PlanLifecycleService(projects, agents, events, database, tasks, assignmentStore);
    const intake = planLifecycle.listIntakes()[0] ?? planLifecycle.createIntake({
      projectId: project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id,
    });
    return { directory, database, events, project, lead, tasks, assignmentStore, planLifecycle, intake };
  }

  function reopen(h: Awaited<ReturnType<typeof openSqlite>>) {
    h.database.close();
    const reopened = new Database(join(h.directory, 'agenthub.db'));
    reopened.initialize();
    databases.push(reopened);
    return bind(h.directory, reopened);
  }

  function forceImplementing(tasks: TaskManager, taskId: string): void {
    const current = tasks.getTask(taskId)?.status;
    if (current === TaskStatus.CREATED) tasks.transitionTask(taskId, TaskStatus.QUEUED);
    if (tasks.getTask(taskId)?.status === TaskStatus.QUEUED) tasks.transitionTask(taskId, TaskStatus.ASSIGNED);
    if (tasks.getTask(taskId)?.status === TaskStatus.ASSIGNED) tasks.transitionTask(taskId, TaskStatus.IMPLEMENTING);
  }

  function execution(h: ReturnType<typeof bind>, calls: string[]) {
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    const coordinator = new PlanExecutionCoordinator({
      planLifecycle: h.planLifecycle, tasks: h.tasks,
      scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => {
        calls.push(`schedule:${taskId}`);
        return { outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: h.lead.id };
      } } as never,
      dispatcher: { dispatch: (request: { reservation: { taskId: string; assignmentId: string; agentId: string } }) => {
        const taskId = request.reservation.taskId;
        calls.push(`dispatch:${taskId}`);
        calls.push(`provider:${taskId}`);
        if (h.assignmentStore.findById(request.reservation.assignmentId) === null) {
          h.assignmentStore.create({
            id: request.reservation.assignmentId, taskId, agentId: request.reservation.agentId,
          });
        }
        h.tasks.updateTask(taskId, {
          assignedAgentId: request.reservation.agentId, assignmentId: request.reservation.assignmentId,
        });
        forceImplementing(h.tasks, taskId);
        return Promise.resolve({
          taskId, assignmentId: request.reservation.assignmentId, agentId: request.reservation.agentId,
        });
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
    return { coordinator, reviews, transitions };
  }

  async function recover(h: ReturnType<typeof bind>, calls: string[]) {
    const wired = execution(h, calls);
    await recoverLifecycleAfterStartup({
      reviewTransitions: wired.transitions, planExecution: wired.coordinator,
    });
    return wired;
  }

  function approveAndStart(
    h: ReturnType<typeof bind>,
    tasks: CreatePlanTaskInput[],
    deps: Array<{ prerequisiteClientId: string; dependentClientId: string }>,
  ) {
    const plan = h.planLifecycle.createPlan({
      intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run', tasks, dependencies: deps,
    });
    const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    for (const definition of approved.current.tasks) {
      h.planLifecycle.materializeRuntimeTask(approved.planId, 1, definition);
    }
    h.planLifecycle.markStarted(approved.planId, 1);
    const current = h.planLifecycle.getPlan(approved.planId);
    if (!current) throw new Error('missing started plan');
    return current;
  }

  function crashAcceptA(h: ReturnType<typeof bind>, runtimeA: string) {
    forceImplementing(h.tasks, runtimeA);
    const reviews = new ReviewHandleStore(h.database);
    const bundle = durableBundle(runtimeA);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { afterTerminalReviewExpiredBeforePlanResolution: () => crash('CRASH_AFTER_EXPIRE') },
    });
    transitions.commitPrepared(bundle, () => { h.tasks.transitionTask(runtimeA, TaskStatus.REVIEWING); });
    transitions.markPlanReviewPending(runtimeA);
    h.tasks.transitionTask(runtimeA, TaskStatus.COMPLETED);
    expect(() => transitions.expireAfterTerminalDecision(bundle.reviewBundleSha256)).toThrow(/CRASH_AFTER_EXPIRE/u);
    expect(h.tasks.getTask(runtimeA)?.status).toBe(TaskStatus.COMPLETED);
    expect(reviews.getActiveForTask(runtimeA)).toBeUndefined();
    expect(h.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === runtimeA)?.reviewPending).toBe(true);
  }

  it('H1. ACCEPT crash then restart dispatches B automatically once', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
    ]);
    const runtimeA = started.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId;
    const runtimeB = started.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing runtime');
    crashAcceptA(h, runtimeA);
    expect(h.planLifecycle.getPlan(started.planId)?.tasks.find((task) => task.runtimeTaskId === runtimeB)?.runtimeState)
      .not.toBe('REVIEWING');

    const restored = reopen(h);
    const calls: string[] = [];
    const recovered = await recover(restored, calls);
    expect(restored.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === runtimeA)?.reviewPending)
      .toBe(false);
    const plan = restored.planLifecycle.getPlan(started.planId);
    expect(plan?.tasks.find((task) => task.runtimeTaskId === runtimeA)?.dependencyState).toBe('SATISFIED');
    expect(plan?.tasks.filter((task) => task.runtimeTaskId === runtimeB)).toHaveLength(1);
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
    expect(calls.filter((item) => item === `schedule:${runtimeB}`)).toHaveLength(1);
    expect(calls.filter((item) => item === `provider:${runtimeB}`)).toHaveLength(1);
    expect(restored.tasks.getTask(runtimeB)?.status).toBe(TaskStatus.REVIEWING);
    expect(recovered.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
    expect(restored.planLifecycle.listReviewAuthority().find((item) => item.runtimeTaskId === runtimeB)?.reviewPending)
      .toBe(true);
    expect(restored.assignmentStore.list().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
  });

  it('H2. recovered B ACCEPT completes the Plan', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
    ]);
    const runtimeA = started.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId;
    const runtimeB = started.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing runtime');
    crashAcceptA(h, runtimeA);
    const restored = reopen(h);
    const recovered = await recover(restored, []);
    const handleB = recovered.reviews.getActiveForTask(runtimeB)?.reviewBundleSha256;
    restored.tasks.transitionTask(runtimeB, TaskStatus.COMPLETED);
    recovered.transitions.expireAfterTerminalDecision(handleB ?? '');
    await recovered.coordinator.afterReview(runtimeB);
    const plan = restored.planLifecycle.refresh(started.planId);
    expect(plan.aggregate.completed).toBe(plan.aggregate.total);
    expect(plan.state).toBe('COMPLETED');
    expect(recovered.reviews.listActive()).toHaveLength(0);
  });

  it('H3. second restart does not duplicate recovered B', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
    ]);
    const runtimeA = started.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId;
    const runtimeB = started.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing runtime');
    crashAcceptA(h, runtimeA);
    const first = reopen(h);
    const firstCalls: string[] = [];
    const firstRecovered = await recover(first, firstCalls);
    const reviewB = firstRecovered.reviews.getActiveForTask(runtimeB)?.reviewBundleSha256;
    const assignmentCount = first.assignmentStore.list().filter((item) => item.taskId === runtimeB).length;
    expect(firstCalls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);

    const second = reopen(first);
    const secondCalls: string[] = [];
    const secondRecovered = await recover(second, secondCalls);
    expect(second.tasks.getTask(runtimeB)?.id).toBe(runtimeB);
    expect(second.planLifecycle.getPlan(started.planId)?.tasks.filter((task) => task.runtimeTaskId === runtimeB))
      .toHaveLength(1);
    expect(secondCalls.filter((item) => item.startsWith('schedule:'))).toHaveLength(0);
    expect(secondCalls.filter((item) => item.startsWith('dispatch:'))).toHaveLength(0);
    expect(secondCalls.filter((item) => item.startsWith('provider:'))).toHaveLength(0);
    expect(second.assignmentStore.list().filter((item) => item.taskId === runtimeB)).toHaveLength(assignmentCount);
    expect(secondRecovered.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
    expect(secondRecovered.reviews.getActiveForTask(runtimeB)?.reviewBundleSha256).toBe(reviewB);
  });

  it('H4. resume dispatches only truly eligible tasks', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b'), step('c'), step('d')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
      { prerequisiteClientId: 'a', dependentClientId: 'c' },
      { prerequisiteClientId: 'b', dependentClientId: 'd' },
    ]);
    const id = (clientId: string) => started.tasks.find((task) => task.clientId === clientId)?.runtimeTaskId ?? '';
    crashAcceptA(h, id('a'));
    const restored = reopen(h);
    const calls: string[] = [];
    await recover(restored, calls);
    expect(calls.filter((item) => item === `dispatch:${id('b')}`)).toHaveLength(1);
    expect(calls.filter((item) => item === `dispatch:${id('c')}`)).toHaveLength(1);
    expect(calls.filter((item) => item === `dispatch:${id('d')}`)).toHaveLength(0);
    expect(restored.tasks.getTask(id('d'))?.status).toBe(TaskStatus.CREATED);
  });

  it('H5. orphan REVIEWING fail-closes and blocks resume', async () => {
    const h = await openSqlite();
    const orphan = approveAndStart(h, [step('r')], []);
    const runtimeR = orphan.tasks[0]?.runtimeTaskId;
    if (!runtimeR) throw new Error('missing R');
    forceImplementing(h.tasks, runtimeR);
    h.tasks.transitionTask(runtimeR, TaskStatus.REVIEWING);
    h.planLifecycle.markReviewPendingByTask(runtimeR, true);

    const eligible = approveAndStart(h, [step('e')], []);
    const runtimeE = eligible.tasks[0]?.runtimeTaskId;
    if (!runtimeE) throw new Error('missing E');

    const restored = reopen(h);
    const calls: string[] = [];
    const wired = execution(restored, calls);
    expect(() => { wired.transitions.reconcile(); }).toThrow(PLAN_REVIEW_RECONCILIATION_REQUIRED);
    await recoverLifecycleAfterStartup({
      reviewTransitions: wired.transitions, planExecution: wired.coordinator,
    });
    expect(wired.transitions.reconciliationRequired).toBe(true);
    expect(calls.filter((item) => item === `schedule:${runtimeE}`)).toHaveLength(0);
    expect(calls.filter((item) => item === `dispatch:${runtimeE}`)).toHaveLength(0);
    expect(restored.tasks.getTask(runtimeE)?.status).toBe(TaskStatus.CREATED);
    const app = {
      projects: { list: () => [] }, agents: { listAgents: () => [] }, tasks: { listTasks: () => [] },
      assignmentQueries: { list: () => [] }, events: { list: () => [] }, eventBus: restored.events,
      planLifecycle: restored.planLifecycle, reviews: wired.reviews, reviewTransitions: wired.transitions,
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${String(address.port)}/api/v1/state`);
      expect(response.status).toBe(503);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('AGENTHUB_API_PLAN_REVIEW_RECONCILIATION_REQUIRED');
    } finally {
      await server.stop();
    }
  });

  it('H6. already-active work is not redispatched', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a')], []);
    const runtimeA = started.tasks[0]?.runtimeTaskId;
    if (!runtimeA) throw new Error('missing A');
    const firstCalls: string[] = [];
    await recover(h, firstCalls);
    expect(firstCalls.filter((item) => item === `dispatch:${runtimeA}`)).toHaveLength(1);
    const restored = reopen(h);
    const secondCalls: string[] = [];
    await recover(restored, secondCalls);
    expect(secondCalls.filter((item) => item === `dispatch:${runtimeA}`)).toHaveLength(0);
    expect(restored.assignmentStore.list().filter((item) => item.taskId === runtimeA)).toHaveLength(1);
    expect(new ReviewHandleStore(restored.database).listActive().filter((item) => item.taskId === runtimeA))
      .toHaveLength(1);
  });

  it('H7. recovery does not auto-start APPROVED Plans', async () => {
    const h = await openSqlite();
    const plan = h.planLifecycle.createPlan({
      intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run',
      tasks: [step('a')], dependencies: [],
    });
    const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const startedEvents: string[] = [];
    h.events.subscribe((event) => { if (event.eventType === 'PlanStarted') startedEvents.push(event.eventType); });
    const calls: string[] = [];
    await recover(h, calls);
    expect(h.planLifecycle.getPlan(approved.planId)?.state).toBe('APPROVED');
    expect(h.planLifecycle.getPlan(approved.planId)?.startedVersion).toBeNull();
    expect(calls).toEqual([]);
    expect(startedEvents).toEqual([]);
  });
});
