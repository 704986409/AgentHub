import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { ReviewHandleStore } from '../src/api/ReviewHandleStore.js';
import { recoverLifecycleAfterStartup } from '../src/application/createLocalAgentHubApplication.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { DomainEventType, TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus, type DomainEvent } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import {
  PLAN_RECOVERY_FAILED,
  PlanRecoveryCoordinator,
  type RecoveryClock,
} from '../src/lifecycle/plan-recovery-coordinator.js';
import { PlanLifecycleService, type CreatePlanTaskInput } from '../src/lifecycle/plan-lifecycle.js';
import { ReviewTransitionCoordinator } from '../src/lifecycle/review-transition-coordinator.js';
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

function durableBundle(taskId: string, agentId: string, salt = 'v1'): TaskReviewBundle {
  const dispatch = {
    taskId, projectId: 'PROJECT', agentId, assignmentId: `asg-${taskId}`, providerId: 'fake',
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

function unavailable(taskId: string) {
  return {
    version: 1 as const, outcome: 'no-available-agent' as const, taskId, projectId: 'PROJECT',
    routePlanSha256: '0'.repeat(64), unavailable: [], reservationSha256: '1'.repeat(64),
  };
}

class ManualClock implements RecoveryClock {
  now = 0;
  #seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = ++this.#seq;
    this.timers.set(id, { at: this.now + delayMs, fn: handler });
    return id;
  }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  async flush(recovery: PlanRecoveryCoordinator, add = 0): Promise<void> {
    const target = this.now + add;
    await recovery.idle();
    while (this.timers.size > 0) {
      const next = Math.min(...[...this.timers.values()].map((timer) => timer.at));
      if (next > target) break;
      this.now = next;
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.fn();
      }
      await recovery.idle();
    }
    this.now = target;
  }
}

describe('0.7.3I startup resume failure isolation and eventual rescheduling', { timeout: 8_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  const recoveries: PlanRecoveryCoordinator[] = [];
  afterEach(async () => {
    for (const recovery of recoveries.splice(0)) await recovery.stop();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function openSqlite() {
    const directory = await mkdtemp(join(tmpdir(), 'agenthub-073I-'));
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
    if (tasks.getTask(taskId)?.status === TaskStatus.CREATED) tasks.transitionTask(taskId, TaskStatus.QUEUED);
    if (tasks.getTask(taskId)?.status === TaskStatus.QUEUED) tasks.transitionTask(taskId, TaskStatus.ASSIGNED);
    if (tasks.getTask(taskId)?.status === TaskStatus.ASSIGNED) tasks.transitionTask(taskId, TaskStatus.IMPLEMENTING);
  }

  function approveAndStart(
    h: ReturnType<typeof bind>,
    tasks: CreatePlanTaskInput[],
    deps: Array<{ prerequisiteClientId: string; dependentClientId: string }> = [],
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
    const bundle = durableBundle(runtimeA, h.lead.id);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
      failpoints: { afterTerminalReviewExpiredBeforePlanResolution: () => crash('CRASH_AFTER_EXPIRE') },
    });
    transitions.commitPrepared(bundle, () => { h.tasks.transitionTask(runtimeA, TaskStatus.REVIEWING); });
    transitions.markPlanReviewPending(runtimeA);
    h.tasks.transitionTask(runtimeA, TaskStatus.COMPLETED);
    expect(() => transitions.expireAfterTerminalDecision(bundle.reviewBundleSha256)).toThrow(/CRASH_AFTER_EXPIRE/u);
  }

  function execution(
    h: ReturnType<typeof bind>,
    calls: string[],
    options: {
      clock?: RecoveryClock;
      schedule?: (taskId: string) => { outcome: string };
      failTaskIds?: Set<string>;
      closed?: { value: boolean };
    } = {},
  ) {
    const reviews = new ReviewHandleStore(h.database);
    const transitions = new ReviewTransitionCoordinator({
      database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
    });
    const coordinator = new PlanExecutionCoordinator({
      planLifecycle: h.planLifecycle, tasks: h.tasks,
      scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => {
        if (options.closed?.value) calls.push('schedule-after-close');
        calls.push(`schedule:${taskId}`);
        const scheduled = options.schedule?.(taskId);
        if (scheduled?.outcome === 'no-available-agent') return unavailable(taskId);
        return { outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: h.lead.id };
      } } as never,
      dispatcher: { dispatch: (request: { reservation: { taskId: string; assignmentId: string; agentId: string } }) => {
        const taskId = request.reservation.taskId;
        if (options.closed?.value) calls.push('dispatch-after-close');
        if (options.failTaskIds?.has(taskId)) {
          const error = new Error('PROVIDER_TURN_FAILED') as Error & { code: string };
          error.code = 'PROVIDER_TURN_FAILED';
          throw error;
        }
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
        const bundle = durableBundle(request.dispatchResult.taskId, h.lead.id, request.dispatchResult.taskId);
        transitions.commitPrepared(bundle, () => {
          h.tasks.transitionTask(request.dispatchResult.taskId, TaskStatus.REVIEWING);
        });
        return Promise.resolve({ outcome: 'review-ready', reviewBundle: bundle });
      } } as never,
      targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events, reviewTransitions: transitions,
    });
    const recovery = new PlanRecoveryCoordinator({
      planLifecycle: h.planLifecycle, planExecution: coordinator, reviewTransitions: transitions,
      eventBus: h.events, ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    recoveries.push(recovery);
    return { coordinator, reviews, transitions, recovery };
  }

  function httpApp(h: ReturnType<typeof bind>, wired: ReturnType<typeof execution>): AgentHubApplication {
    return {
      projects: { list: () => [] }, agents: { listAgents: () => [] }, tasks: h.tasks,
      assignmentQueries: { list: () => h.assignmentStore.list(), findById: (id: string) => h.assignmentStore.findById(id) },
      events: { list: () => [] }, eventBus: h.events, planLifecycle: h.planLifecycle, reviews: wired.reviews,
      reviewTransitions: wired.transitions, planExecution: wired.coordinator,
      lifecycle: {
        applyReview: (request: { reviewBundle: TaskReviewBundle; decision: { verdict: string } }) => {
          if (request.decision.verdict !== 'ACCEPT') throw new Error('unexpected verdict');
          h.tasks.transitionTask(request.reviewBundle.taskId, TaskStatus.COMPLETED);
          return Promise.resolve({
            outcome: 'completed-no-change',
            taskId: request.reviewBundle.taskId,
            lifecycleSha256: 'f'.repeat(64),
            reviewEvidence: { verdict: 'ACCEPT' },
          });
        },
      },
    } as unknown as AgentHubApplication;
  }

  it('I1. provider failure does not block API startup', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a')]);
    const runtimeA = started.tasks[0]?.runtimeTaskId;
    if (!runtimeA) throw new Error('missing A');
    const calls: string[] = [];
    const seen: DomainEvent[] = [];
    h.events.subscribe((event) => { seen.push(event); });
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const wired = execution(h, calls, { failTaskIds: new Set([runtimeA]) });
      recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
      const server = new AgentHubHttpServer({ application: httpApp(h, wired), port: 0 });
      const address = await server.start();
      const health = await fetch(`http://${address.host}:${String(address.port)}/api/v1/health`);
      expect(health.status).toBe(200);
      const state = await fetch(`http://${address.host}:${String(address.port)}/api/v1/state`);
      expect(state.status).toBe(200);
      await wired.recovery.idle();
      expect(seen.some((event) => event.eventType === PLAN_RECOVERY_FAILED)).toBe(true);
      expect(rejections).toEqual([]);
      await server.stop();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('I2. one failing Plan does not block another', async () => {
    const h = await openSqlite();
    const planA = approveAndStart(h, [step('a')]);
    const planB = approveAndStart(h, [step('b')]);
    const runtimeA = planA.tasks[0]?.runtimeTaskId;
    const runtimeB = planB.tasks[0]?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing tasks');
    const calls: string[] = [];
    const seen: DomainEvent[] = [];
    h.events.subscribe((event) => { seen.push(event); });
    const wired = execution(h, calls, { failTaskIds: new Set([runtimeA]) });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.idle();
    expect(seen.some((event) => event.eventType === PLAN_RECOVERY_FAILED
      && (event.payload as { planId?: string }).planId === planA.planId)).toBe(true);
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
    expect(wired.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
  });

  it('I3. no-available-agent eventually reschedules without restart', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('b')]);
    const runtimeB = started.tasks[0]?.runtimeTaskId;
    if (!runtimeB) throw new Error('missing B');
    const calls: string[] = [];
    let allow = false;
    const wired = execution(h, calls, {
      schedule: () => ({ outcome: allow ? 'reserved' : 'no-available-agent' }),
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.idle();
    expect(h.planLifecycle.getPlan(started.planId)?.tasks[0]?.dependencyState).toBe('ELIGIBLE');
    expect(h.assignmentStore.list().filter((item) => item.taskId === runtimeB)).toHaveLength(0);
    expect(wired.reviews.listActive()).toHaveLength(0);
    allow = true;
    h.events.publish({ eventType: DomainEventType.AGENT_UNLOCKED, agentId: h.lead.id });
    await wired.recovery.idle();
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
    expect(wired.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
  });

  it('I4. retry is bounded and does not busy-loop', async () => {
    const h = await openSqlite();
    approveAndStart(h, [step('b')]);
    const calls: string[] = [];
    const clock = new ManualClock();
    const wired = execution(h, calls, {
      clock, schedule: () => ({ outcome: 'no-available-agent' }),
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await clock.flush(wired.recovery, 0);
    await clock.flush(wired.recovery, 20_000);
    expect(wired.recovery.passCount).toBeGreaterThan(1);
    expect(wired.recovery.passCount).toBeLessThan(12);
    expect(calls.filter((item) => item.startsWith('schedule:')).length).toBeLessThan(20);
  });

  it('I5. availability event triggers earlier rescan', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('b')]);
    const runtimeB = started.tasks[0]?.runtimeTaskId;
    if (!runtimeB) throw new Error('missing B');
    const calls: string[] = [];
    let allow = false;
    const clock = new ManualClock();
    const wired = execution(h, calls, {
      clock, schedule: () => ({ outcome: allow ? 'reserved' : 'no-available-agent' }),
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await clock.flush(wired.recovery, 0);
    const passes = wired.recovery.passCount;
    allow = true;
    h.events.publish({ eventType: DomainEventType.AGENT_UNLOCKED, agentId: h.lead.id });
    await clock.flush(wired.recovery, 0);
    expect(wired.recovery.passCount).toBe(passes + 1);
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
  });

  it('I6. repeated wakeups coalesce without duplicate dispatch', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('b')]);
    const runtimeB = started.tasks[0]?.runtimeTaskId;
    if (!runtimeB) throw new Error('missing B');
    const calls: string[] = [];
    const wired = execution(h, calls);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    for (let i = 0; i < 20; i += 1) {
      h.events.publish({ eventType: DomainEventType.AGENT_UNLOCKED, agentId: h.lead.id });
    }
    await wired.recovery.idle();
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
    expect(h.assignmentStore.list().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
    expect(wired.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
  });

  it('I7. orphan REVIEWING blocks all resume beyond retry interval', async () => {
    const h = await openSqlite();
    const orphan = approveAndStart(h, [step('r')]);
    const runtimeR = orphan.tasks[0]?.runtimeTaskId;
    if (!runtimeR) throw new Error('missing R');
    forceImplementing(h.tasks, runtimeR);
    h.tasks.transitionTask(runtimeR, TaskStatus.REVIEWING);
    h.planLifecycle.markReviewPendingByTask(runtimeR, true);
    const eligible = approveAndStart(h, [step('e')]);
    const runtimeE = eligible.tasks[0]?.runtimeTaskId;
    if (!runtimeE) throw new Error('missing E');
    const calls: string[] = [];
    const clock = new ManualClock();
    const wired = execution(h, calls, { clock });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await clock.flush(wired.recovery, 10_000);
    expect(wired.transitions.reconciliationRequired).toBe(true);
    expect(calls.filter((item) => item === `schedule:${runtimeE}`)).toHaveLength(0);
    expect(calls.filter((item) => item === `dispatch:${runtimeE}`)).toHaveLength(0);
    const server = new AgentHubHttpServer({ application: httpApp(h, wired), port: 0 });
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

  it('I8. APPROVED Plan never auto-starts across retries and wakeups', async () => {
    const h = await openSqlite();
    const plan = h.planLifecycle.createPlan({
      intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run', tasks: [step('a')], dependencies: [],
    });
    const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const started: string[] = [];
    h.events.subscribe((event) => { if (event.eventType === 'PlanStarted') started.push(event.eventType); });
    const calls: string[] = [];
    const clock = new ManualClock();
    const wired = execution(h, calls, { clock });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await clock.flush(wired.recovery, 0);
    h.events.publish({ eventType: DomainEventType.AGENT_UNLOCKED, agentId: h.lead.id });
    await clock.flush(wired.recovery, 5_000);
    expect(h.planLifecycle.getPlan(approved.planId)?.state).toBe('APPROVED');
    expect(h.planLifecycle.getPlan(approved.planId)?.startedVersion).toBeNull();
    expect(calls).toEqual([]);
    expect(started).toEqual([]);
  });

  it('I9. cross-Plan agent contention eventually progresses', async () => {
    const h = await openSqlite();
    const planA = approveAndStart(h, [step('a')]);
    const planB = approveAndStart(h, [step('b')]);
    const runtimeA = planA.tasks[0]?.runtimeTaskId;
    const runtimeB = planB.tasks[0]?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing tasks');
    const calls: string[] = [];
    let busy = false;
    const wired = execution(h, calls, {
      schedule: (taskId) => {
        if (taskId === runtimeB && busy) return { outcome: 'no-available-agent' };
        if (taskId === runtimeA) busy = true;
        return { outcome: 'reserved' };
      },
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.idle();
    expect(calls.filter((item) => item === `dispatch:${runtimeA}`)).toHaveLength(1);
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(0);
    const handleA = wired.reviews.getActiveForTask(runtimeA)?.reviewBundleSha256;
    h.tasks.transitionTask(runtimeA, TaskStatus.COMPLETED);
    wired.transitions.expireAfterTerminalDecision(handleA ?? '');
    busy = false;
    await wired.coordinator.afterReview(runtimeA);
    h.events.publish({ eventType: DomainEventType.AGENT_UNLOCKED, agentId: h.lead.id });
    await wired.recovery.idle();
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
  });

  it('I10. close cancels recovery timers and work', async () => {
    const h = await openSqlite();
    approveAndStart(h, [step('b')]);
    const calls: string[] = [];
    const closed = { value: false };
    const clock = new ManualClock();
    const wired = execution(h, calls, {
      clock, closed, schedule: () => ({ outcome: 'no-available-agent' }),
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await clock.flush(wired.recovery, 0);
    const scheduled = calls.filter((item) => item.startsWith('schedule:')).length;
    await wired.recovery.stop();
    closed.value = true;
    await clock.flush(wired.recovery, 20_000);
    expect(calls.filter((item) => item.startsWith('schedule:')).length).toBe(scheduled);
    expect(calls.filter((item) => item.includes('after-close'))).toHaveLength(0);
  });

  it('H crash/restart still auto-dispatches B exactly once', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
    ]);
    const runtimeA = started.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId;
    const runtimeB = started.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing runtime');
    crashAcceptA(h, runtimeA);
    const restored = reopen(h);
    const calls: string[] = [];
    const wired = execution(restored, calls);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.idle();
    expect(calls.filter((item) => item === `dispatch:${runtimeB}`)).toHaveLength(1);
    const second = reopen(restored);
    const secondCalls: string[] = [];
    const secondWired = execution(second, secondCalls);
    recoverLifecycleAfterStartup({ reviewTransitions: secondWired.transitions, recovery: secondWired.recovery });
    await secondWired.recovery.idle();
    expect(secondCalls.filter((item) => item.startsWith('dispatch:'))).toHaveLength(0);
    expect(secondWired.reviews.listActive().filter((item) => item.taskId === runtimeB)).toHaveLength(1);
  });

  it('E2E recovered B ACCEPT through Review API completes the Plan', async () => {
    const h = await openSqlite();
    const started = approveAndStart(h, [step('a'), step('b')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' },
    ]);
    const runtimeA = started.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId;
    const runtimeB = started.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId;
    if (!runtimeA || !runtimeB) throw new Error('missing runtime');
    crashAcceptA(h, runtimeA);
    const restored = reopen(h);
    const wired = execution(restored, []);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.idle();
    const server = new AgentHubHttpServer({ application: httpApp(restored, wired), port: 0 });
    const address = await server.start();
    try {
      const listed = await fetch(`http://${address.host}:${String(address.port)}/api/v1/reviews`);
      expect(listed.status).toBe(200);
      const reviews = await listed.json() as { data: Array<{ review: { reviewHandle: string } }> };
      const handle = reviews.data[0]?.review.reviewHandle;
      expect(handle).toBeTruthy();
      const decision = await fetch(
        `http://${address.host}:${String(address.port)}/api/v1/reviews/${handle ?? ''}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'accept-b' },
          body: JSON.stringify({
            reviewId: 'review-b', reviewerId: 'human', verdict: 'ACCEPT', summary: 'ok', findings: [],
            allowNoChangeCompletion: true,
          }),
        },
      );
      expect(decision.status).toBe(200);
      const plan = restored.planLifecycle.refresh(started.planId);
      expect(plan.aggregate.completed).toBe(plan.aggregate.total);
      expect(plan.state).toBe('COMPLETED');
      expect(wired.reviews.listActive()).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });
});
