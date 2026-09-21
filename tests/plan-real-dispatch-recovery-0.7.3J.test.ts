import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ReviewHandleStore } from '../src/api/ReviewHandleStore.js';
import { recoverLifecycleAfterStartup } from '../src/application/createLocalAgentHubApplication.js';
import { ReviewTransitionCoordinator } from '../src/lifecycle/review-transition-coordinator.js';
import {
  AgentPool, AgentProfileManager, AgentProviderFactory, AgentRegistry, AgentScheduler,
  AssignmentManager, AssignmentStatus, Database, EventBus,
  PlanExecutionCoordinator, PlanExecutionRecoveryService, PlanLifecycleService,
  PlanRecoveryCoordinator, SqliteAgentRepository,
  SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository,
  TaskComplexity, TaskManager, TaskRisk, TaskStateMachine, TaskStatus,
  type TaskLifecycleOrchestrator, type TaskLifecyclePreparationResult,
  type AgentProvider, type AgentProviderCapabilities, type AgentProviderSession,
  type AgentProviderTurnRequest, type AgentProviderTurnResult, type CreatedTaskWorkspace,
  type RecoveryClock,
} from '../src/index.js';
import { createAssignmentDispatcherForTest } from
  '../src/orchestration/internal/AssignmentDispatcherTestHarness.js';
import { digest, makeReviewBundle, snapshotTaskReviewBundle, type TaskReviewBundle } from
  '../src/orchestration/lifecycle/TaskLifecycleContract.js';
import type { AgentHubWorkerResult } from '../src/protocol/AgentHubWorkerResult.js';
import type { BuildTestEvidence, GitWorkspaceChangeSnapshot, TaskCommitResult } from '../src/workspace/index.js';
import { canonicalChangeState } from '../src/workspace/GitWorkspaceChangeCapture.js';

const oid = 'a'.repeat(40);
const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});
const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [],
  blockers: [], questions: [], risks: [], notes: [],
};

class Session implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public sessionId: string | undefined;
  public started = false;
  public active = false;
  public startCalls = 0;
  public runCalls = 0;
  public startError: Error | undefined;
  public runError: Error | undefined;
  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.started = true;
    this.sessionId = 'session-a';
    return Promise.resolve();
  }
  public runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.active = request.protocol === 'worker-result';
    this.active = false;
    if (this.runError !== undefined) return Promise.reject(this.runError);
    return Promise.resolve(successResult());
  }
  public shutdown(): Promise<void> {
    this.started = false;
    this.active = false;
    return Promise.resolve();
  }
}

class Provider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public readonly sessions: Session[] = [];
  public startError: Error | undefined;
  public runError: Error | undefined;
  public get runCalls(): number { return this.sessions.reduce((sum, session) => sum + session.runCalls, 0); }
  public createSession(): AgentProviderSession {
    const session = new Session();
    session.startError = this.startError;
    session.runError = this.runError;
    this.sessions.push(session);
    return session;
  }
}

class Workspace {
  public calls = 0;
  public failFirst = 0;
  public failOnCall: number | undefined;
  public constructor(public readonly repositoryRoot: string) {}
  public createWorkspace(request: { readonly taskId: string; readonly baseRef: string }): Promise<CreatedTaskWorkspace> {
    this.calls += 1;
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      return Promise.reject(new Error('workspace failed'));
    }
    if (this.failOnCall === this.calls) return Promise.reject(new Error('workspace stale'));
    return Promise.resolve({
      taskId: request.taskId, repositoryRoot: this.repositoryRoot,
      worktreePath: join(this.repositoryRoot, '.agenthub', 'worktrees', request.taskId),
      branchName: `agenthub/${request.taskId}`, baseCommit: oid, headCommit: oid, created: true,
    });
  }
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
  async flush(recovery: PlanRecoveryCoordinator, add = 5_000): Promise<void> {
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

describe('0.7.3J real dispatcher failure recovery', { timeout: 20_000 }, () => {
  const directories: string[] = [];
  const databases: Database[] = [];
  const recoveries: PlanRecoveryCoordinator[] = [];
  afterEach(async () => {
    for (const recovery of recoveries.splice(0)) await recovery.stop();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('J1. workspace creation failure resumes the same Assignment', async () => {
    const h = await open(directories, databases);
    h.workspace.failFirst = 1;
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.ASSIGNED);
    expect(h.assignmentStore.list().filter((item) => item.status === AssignmentStatus.DISPATCHING)).toHaveLength(1);
    expect(h.pool.getSnapshot(h.worker.id).reserved).toBe(true);
    expect(h.provider.runCalls).toBe(0);
    const inspected = wired.recoveryService.inspect(runtimeId);
    expect(inspected).toMatchObject({ outcome: 'resumable' });
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
    expect(h.assignmentStore.list().filter((item) => item.status === AssignmentStatus.DISPATCHING)).toHaveLength(0);
    expect(wired.scheduleCalls).toBe(1);
    expect(wired.dispatchedEvents).toBe(1);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.REVIEWING);
  });

  it('J2. accepted workspace revalidation failure requeues instead of hanging', async () => {
    const h = await open(directories, databases);
    h.workspace.failOnCall = 2;
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.QUEUED);
    expect(h.tasks.getTask(runtimeId)?.assignmentId).toBeNull();
    expect(h.pool.getSnapshot(h.worker.id).reserved).toBe(false);
    h.workspace.failOnCall = undefined;
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
    expect(h.assignmentStore.list().filter((item) => item.status === AssignmentStatus.RELEASED)).toHaveLength(1);
    expect(h.assignmentStore.list().filter((item) => item.status === AssignmentStatus.ACTIVE
      || item.status === AssignmentStatus.DISPATCHING)).toHaveLength(1);
  });

  it('J3. clean runtime start failure requeues and continues', async () => {
    const h = await open(directories, databases);
    h.provider.startError = new Error('start failed');
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    h.provider.startError = undefined;
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.REVIEWING);
  });

  it('J4. uncertain owned residue fails closed', async () => {
    const h = await open(directories, databases);
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    const scheduled = h.scheduler.scheduleTask({ taskId: runtimeId, requirements: { requiredOutputProtocols: ['worker-result'] } });
    if (scheduled.outcome !== 'reserved') throw new Error('expected reservation');
    wired.recoveryService.persistReservation(started.planId, scheduled);
    h.assignments.acceptAssignment(scheduled.assignmentId);
    await h.pool.startReserved(scheduled.agentId, {
      taskId: scheduled.taskId, assignmentId: scheduled.assignmentId,
      specVersion: scheduled.specVersion, profileHash: scheduled.profileHash,
    }, { workspacePath: join(h.directory, 'wt') });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(0);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.ASSIGNED);
    expect(h.assignments.getAssignment(scheduled.assignmentId)?.status).toBe(AssignmentStatus.ACCEPTED);
    expect(wired.blocked).toBe(true);
  });

  it('J5/J6. provider turn failure does not duplicate turn or Assignment', async () => {
    const h = await open(directories, databases);
    h.provider.runError = new Error('turn failed');
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
    expect(wired.scheduleCalls).toBe(1);
    expect(h.assignmentStore.list()).toHaveLength(1);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(h.pool.getSnapshot(h.worker.id).state).toBe('OWNED');
  });

  it('J7. review convergence failure does not rerun Provider turn', async () => {
    const h = await open(directories, databases);
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    let failures = 1;
    const wired = wire(h, recoveries, {
      prepareReview: (request: { dispatchResult: { taskId: string; assignmentId: string } }) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('prepareReview failed'));
        }
        return Promise.resolve(reviewReady(h, request.dispatchResult.taskId, request.dispatchResult.assignmentId));
      },
    });
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.REVIEWING);
    expect(wired.prepareCalls).toBe(2);
  });

  it('J8. RESERVED residue is released or resumed', async () => {
    const h = await open(directories, databases);
    h.workspace.failFirst = 1;
    startPlan(h);
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(h.pool.getSnapshot(h.worker.id).reserved).toBe(true);
    await wired.clock.flush(wired.recovery);
    expect(h.pool.getSnapshot(h.worker.id).reserved).toBe(false);
    expect(h.provider.runCalls).toBe(1);
  });

  it('J9. OWNED residue is never blindly requeued', async () => {
    const h = await open(directories, databases);
    h.provider.runError = new Error('turn failed');
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(h.tasks.getTask(runtimeId)?.assignmentId).not.toBeNull();
    expect(h.tasks.getTask(runtimeId)?.status).not.toBe(TaskStatus.QUEUED);
  });

  it('J10. restart recovery resumes or requeues from SQLite', async () => {
    const first = await open(directories, databases);
    first.workspace.failFirst = 8;
    const started = startPlan(first);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(first, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(first.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.ASSIGNED);
    await wired.recovery.stop();
    first.database.close();
    const second = reopen(first, directories, databases);
    const restarted = wire(second, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: restarted.transitions, recovery: restarted.recovery });
    await restarted.clock.flush(restarted.recovery);
    expect(second.provider.runCalls).toBe(1);
    expect(second.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.REVIEWING);
  });

  it('J11. cross-Plan recovery isolation', async () => {
    const h = await open(directories, databases);
    const blocked = startPlan(h, 'blocked');
    const healthy = startPlan(h, 'healthy');
    const blockedId = blocked.tasks[0]?.runtimeTaskId as string;
    const healthyId = healthy.tasks[0]?.runtimeTaskId as string;
    h.provider.runError = new Error('turn failed');
    const wired = wire(h, recoveries);
    const scheduled = h.scheduler.scheduleTask({ taskId: blockedId, requirements: { requiredOutputProtocols: ['worker-result'] } });
    if (scheduled.outcome !== 'reserved') throw new Error('expected reservation');
    wired.recoveryService.persistReservation(blocked.planId, scheduled);
    await h.dispatcher.dispatch({
      reservation: scheduled, baseRef: 'main', turn: { prompt: 'x', protocol: 'worker-result' },
    }).catch(() => undefined);
    h.provider.runError = undefined;
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(h.tasks.getTask(blockedId)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(h.tasks.getTask(healthyId)?.status).toBe(TaskStatus.REVIEWING);
  });

  it('J12/J13/J14. repeated recovery is idempotent with one Review and one dispatch event', async () => {
    const h = await open(directories, databases);
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(wired.reviews.listActive().filter((item) => item.taskId === runtimeId)).toHaveLength(1);
    await wired.clock.flush(wired.recovery);
    await wired.clock.flush(wired.recovery);
    expect(wired.scheduleCalls).toBe(1);
    expect(wired.prepareCalls).toBe(1);
    expect(wired.dispatchedEvents).toBe(1);
    expect(wired.reviews.listActive().filter((item) => item.taskId === runtimeId)).toHaveLength(1);
    expect(h.provider.runCalls).toBe(1);
  });

  it('J15. no-available-agent still eventually reschedules', async () => {
    const h = await open(directories, databases);
    h.pool.unregister(h.worker.id);
    h.pool.unregister(h.lead.id);
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(h.tasks.getTask(runtimeId)?.status).toBe(TaskStatus.CREATED);
    h.pool.register({ agentId: h.worker.id, projectId: h.project.id, providerId: 'fake' });
    h.pool.register({ agentId: h.lead.id, projectId: h.project.id, providerId: 'fake' });
    await wired.clock.flush(wired.recovery);
    expect(h.provider.runCalls).toBe(1);
  });

  it('J16. APPROVED Plan never auto-starts', async () => {
    const h = await open(directories, databases);
    const plan = h.planLifecycle.createPlan({
      intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run',
      tasks: [step('a')], dependencies: [],
    });
    h.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery);
    expect(wired.scheduleCalls).toBe(0);
    expect(h.planLifecycle.getPlan(plan.planId)?.state).toBe('APPROVED');
  });

  it('J17. orphan REVIEWING still fails closed', async () => {
    const h = await open(directories, databases);
    const started = startPlan(h);
    const runtimeId = started.tasks[0]?.runtimeTaskId as string;
    h.tasks.transitionTask(runtimeId, TaskStatus.QUEUED);
    h.tasks.transitionTask(runtimeId, TaskStatus.ASSIGNED);
    h.tasks.transitionTask(runtimeId, TaskStatus.IMPLEMENTING);
    h.tasks.transitionTask(runtimeId, TaskStatus.REVIEWING);
    h.planLifecycle.markReviewPendingByTask(runtimeId, true);
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.clock.flush(wired.recovery, 0);
    expect(wired.transitions.reconciliationRequired).toBe(true);
    expect(h.provider.runCalls).toBe(0);
  });

  it('J18. close() still cancels timers/work', async () => {
    const h = await open(directories, databases);
    h.pool.unregister(h.worker.id);
    h.pool.unregister(h.lead.id);
    startPlan(h);
    const wired = wire(h, recoveries);
    recoverLifecycleAfterStartup({ reviewTransitions: wired.transitions, recovery: wired.recovery });
    await wired.recovery.stop();
    expect(wired.recovery.stopped).toBe(true);
    expect(wired.clock.timers.size).toBe(0);
  });
});

async function open(directories: string[], databases: Database[]) {
  const directory = await mkdtemp(join(tmpdir(), 'agenthub-073J-'));
  directories.push(directory);
  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  databases.push(database);
  return bind(directory, database);
}

function reopen(
  previous: Awaited<ReturnType<typeof open>>,
  _directories: string[],
  databases: Database[],
) {
  const database = new Database(join(previous.directory, 'agenthub.db'));
  database.initialize();
  databases.push(database);
  return bind(previous.directory, database);
}

function bind(directory: string, database: Database) {
  const events = new EventBus();
  const projects = new SqliteProjectRepository(database);
  const project = projects.list()[0] ?? projects.create({ name: 'P' });
  const agents = new AgentRegistry(new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), events);
  const lead = agents.listAgents().find((agent) => agent.name === 'Lead') ?? agents.createAgent({
    name: 'Lead', provider: 'fake', model: 'm', position: 'Lead', projectId: project.id,
  });
  const worker = agents.listAgents().find((agent) => agent.name === 'Worker') ?? agents.createAgent({
    name: 'Worker', provider: 'fake', model: 'm', position: 'Developer', projectId: project.id,
    routingPriority: 10,
  });
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), events);
  const assignmentStore = new SqliteAssignmentRepository(database);
  const assignments = new AssignmentManager(assignmentStore, tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), events);
  const provider = new Provider();
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: events });
  for (const agent of agents.listAgents()) {
    try { pool.register({ agentId: agent.id, projectId: project.id, providerId: 'fake' }); }
    catch { /* already registered in-process */ }
  }
  const scheduler = new AgentScheduler({
    taskManager: tasks, agentRegistry: agents, providerFactory: factory, agentPool: pool, assignmentManager: assignments,
  });
  const workspace = new Workspace(directory);
  const dispatcher = createAssignmentDispatcherForTest({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments,
    agentPool: pool, worktreeManager: workspace,
  });
  const planLifecycle = new PlanLifecycleService(projects, agents, events, database, tasks, assignmentStore);
  const intake = planLifecycle.listIntakes()[0] ?? planLifecycle.createIntake({
    projectId: project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id,
  });
  return {
    directory, database, events, project, lead, worker, tasks, assignmentStore, assignments,
    provider, pool, scheduler, workspace, dispatcher, planLifecycle, intake,
  };
}

function startPlan(h: ReturnType<typeof bind>, clientId = 'a') {
  const plan = h.planLifecycle.createPlan({
    intakeId: h.intake.intakeId, leadAgentId: h.lead.id, summary: 'run',
    tasks: [step(clientId)], dependencies: [],
  });
  const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
    planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
  });
  for (const definition of approved.current.tasks) {
    h.planLifecycle.materializeRuntimeTask(approved.planId, 1, definition);
  }
  return h.planLifecycle.markStarted(approved.planId, 1);
}

function wire(
  h: ReturnType<typeof bind>,
  recoveries: PlanRecoveryCoordinator[],
  overrides: {
    prepareReview?: (request: { dispatchResult: { taskId: string; assignmentId: string } }) => Promise<unknown>;
  } = {},
) {
  const reviews = new ReviewHandleStore(h.database);
  const transitions = new ReviewTransitionCoordinator({
    database: h.database, reviews, planLifecycle: h.planLifecycle, tasks: h.tasks,
  });
  const recoveryService = new PlanExecutionRecoveryService({
    database: h.database, planLifecycle: h.planLifecycle, tasks: h.tasks,
    assignments: h.assignments, agentPool: h.pool, eventBus: h.events, reviews,
  });
  const clock = new ManualClock();
  let scheduleCalls = 0;
  let prepareCalls = 0;
  let dispatchedEvents = 0;
  let blocked = false;
  h.events.subscribe((event) => {
    if (event.eventType === 'PlanTaskDispatched') dispatchedEvents += 1;
    if (event.eventType === 'PlanAssignmentRecoveryBlocked') blocked = true;
  });
  const scheduler = {
    scheduleTask: (request: Parameters<AgentScheduler['scheduleTask']>[0]) => {
      scheduleCalls += 1;
      return h.scheduler.scheduleTask(request);
    },
  };
  const convergeReview: TaskLifecycleOrchestrator['prepareReview'] = (request) => {
    prepareCalls += 1;
    if (overrides.prepareReview) {
      return overrides.prepareReview(request) as Promise<TaskLifecyclePreparationResult>;
    }
    return Promise.resolve(reviewReady(
      h, request.dispatchResult.taskId, request.dispatchResult.assignmentId, reviews, transitions,
    )) as Promise<TaskLifecyclePreparationResult>;
  };
  const taskLifecycle = {
    prepareReview: convergeReview,
    consumeCompletedTurn: convergeReview,
  } satisfies Pick<TaskLifecycleOrchestrator, 'prepareReview' | 'consumeCompletedTurn'>;
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: h.planLifecycle, tasks: h.tasks, scheduler: scheduler as never,
    dispatcher: h.dispatcher, assignmentRecovery: recoveryService,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycleOrchestrator,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events, reviewTransitions: transitions,
  });
  const recovery = new PlanRecoveryCoordinator({
    planLifecycle: h.planLifecycle, planExecution: coordinator, reviewTransitions: transitions,
    eventBus: h.events, clock,
  });
  recoveries.push(recovery);
  return {
    coordinator, reviews, transitions, recovery, recoveryService, clock,
    get scheduleCalls() { return scheduleCalls; },
    get prepareCalls() { return prepareCalls; },
    get dispatchedEvents() { return dispatchedEvents; },
    get blocked() { return blocked; },
  };
}

function reviewReady(
  h: ReturnType<typeof bind>,
  taskId: string,
  assignmentId: string,
  reviews?: ReviewHandleStore,
  transitions?: ReviewTransitionCoordinator,
) {
  const bundle = durableBundle(taskId, h.worker.id, assignmentId);
  const commit = () => {
    if (h.tasks.getTask(taskId)?.status === TaskStatus.IMPLEMENTING) {
      h.tasks.transitionTask(taskId, TaskStatus.REVIEWING);
    }
  };
  if (transitions) transitions.commitPrepared(bundle, commit);
  else {
    reviews?.register(bundle);
    commit();
  }
  return { outcome: 'review-ready' as const, reviewBundle: bundle };
}

function step(clientId: string) {
  return {
    clientId, parentClientId: null, title: clientId, description: null, acceptanceCriteria: ['done'],
    requiredCapabilities: [] as string[], requiredSpecialties: [] as string[],
    complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
  };
}

function durableBundle(taskId: string, agentId: string, assignmentId: string): TaskReviewBundle {
  const dispatch = {
    taskId, projectId: 'PROJECT', agentId, assignmentId,
    providerId: 'fake',
    reservationSha256: digest('AgentHub.TestReservation', { taskId, assignmentId }),
    dispatchSha256: digest('AgentHub.TestDispatch', { taskId, assignmentId }),
    executionProfileSha256: '3'.repeat(64),
  } as never;
  return snapshotTaskReviewBundle(makeReviewBundle(dispatch, taskCommit(taskId), evidence(taskId), source(taskId), workerResult));
}

function source(taskId: string): GitWorkspaceChangeSnapshot {
  const emptyPatchSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const patch = { status: 'empty' as const, byteLength: 0 as const, sha256: emptyPatchSha256 };
  const layer = { changes: [], patch };
  return {
    taskId, repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt', branchName: `agenthub/${taskId}`,
    baseCommit: oid, headCommit: oid, committed: layer, staged: layer, unstaged: layer,
    workingFiles: [], untracked: [], conflicts: [], ignored: { present: false, count: 0, paths: [], truncated: false },
    changedPaths: [], hasConflicts: false, changeSetSha256: 'c'.repeat(64),
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
    changeSetSha256: 'c'.repeat(64), sourceVisibilitySha256: 'd'.repeat(64),
    build: 'not-run' as const, test: 'passed' as const, outcome: 'passed' as const, commands: [] as const,
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

function successResult(): AgentProviderTurnResult {
  return {
    providerId: 'fake', sessionId: 'session-a', durationMs: 7, protocol: 'worker-result', protocolValid: true,
    workerResult,
  };
}
