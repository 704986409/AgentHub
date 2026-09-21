import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { recoverLifecycleAfterStartup } from '../src/application/createLocalAgentHubApplication.js';
import { PlanExecutionRecoveryService } from '../src/lifecycle/plan-execution-recovery.js';
import { PlanRecoveryCoordinator } from '../src/lifecycle/plan-recovery-coordinator.js';
import { ReviewTransitionCoordinator } from '../src/lifecycle/review-transition-coordinator.js';
import {
  AgentHubHttpServer,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentStatus,
  AssignmentDispatcher,
  AssignmentManager,
  Database,
  EventBus,
  GitWorktreeManager,
  PlanExecutionCoordinator,
  PlanLifecycleService,
  ReviewHandleStore,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskLifecycleOrchestrator,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  TaskStatus,
  type AgentHubApplication,
  type AgentHubWorkerOutcome,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnResult,
  type BuildTestEvidencePlan,
} from '../src/index.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class ControllableSession implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public readonly sessionId = 'controllable-session';
  public started = false;
  public active = false;
  public runCalls = 0;
  public outcome: AgentHubWorkerOutcome = 'COMPLETED';
  public turnGate: Promise<void> | undefined;
  public onTurnStart?: () => void;
  public constructor(outcome: AgentHubWorkerOutcome = 'COMPLETED') { this.outcome = outcome; }
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public async runTurn(): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.onTurnStart?.();
    if (this.turnGate !== undefined) await this.turnGate;
    return {
      providerId: this.providerId, sessionId: this.sessionId, protocol: 'worker-result', protocolValid: true,
      workerResult: {
        protocolVersion: 1, outcome: this.outcome, summary: 'done', changedFiles: [], checks: [],
        blockers: this.outcome === 'BLOCKED' ? ['blocked'] : [],
        questions: this.outcome === 'NEEDS_INPUT' ? ['what next'] : [],
        risks: [], notes: [],
      },
    };
  }
  public shutdown(): Promise<void> { this.started = false; this.active = false; return Promise.resolve(); }
}

class ControllableProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public session: ControllableSession | undefined;
  public outcome: AgentHubWorkerOutcome;
  public constructor(outcome: AgentHubWorkerOutcome = 'COMPLETED') {
    this.outcome = outcome;
  }
  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    if (options.workspacePath === undefined) throw new Error('workspace path required');
    this.session = new ControllableSession(this.outcome);
    return this.session;
  }
}

const testPlan: BuildTestEvidencePlan = {
  commands: [{
    id: 'test', phase: 'test', executable: process.execPath, args: ['-e', 'process.exit(0)'],
    cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {},
  }],
};

const revisionBody = {
  reviewId: 'rev-m', reviewerId: 'human', verdict: 'REQUEST_REVISION', summary: 'revise',
  findings: [{ code: 'FIX', severity: 'error', message: 'fix' }], allowNoChangeCompletion: true,
};

interface RecoveryView {
  dispatch_json: string;
  revision_round: number;
  stage: string;
  turn_may_have_started: number;
}

function recoveryRow(database: Database, taskId: string): RecoveryView {
  const row = database.connection.prepare(
    `SELECT dispatch_json, revision_round, stage, turn_may_have_started
     FROM assignment_dispatch_recovery WHERE task_id = ?`,
  ).get(taskId) as RecoveryView | undefined;
  if (!row?.dispatch_json) throw new Error('missing recovery row');
  return row;
}

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-073M-'));
  const repositoryRoot = join(directory, 'repository');
  execFileSync('git', ['init', '-b', 'main', repositoryRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub Tests'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, 'README.md'), '# AgentHub 0.7.3O Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repositoryRoot, stdio: 'ignore' });
  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agents = new AgentRegistry(new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), bus);
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
  const assignmentRepo = new SqliteAssignmentRepository(database);
  const assignments = new AssignmentManager(assignmentRepo, tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), bus);
  const projects = new SqliteProjectRepository(database);
  const project = projects.create({ id: 'project-m', name: 'Revision Recovery' });
  const agent = agents.createAgent({
    id: 'agent-m', projectId: project.id, name: 'RevisionWorker', provider: 'fake', model: 'fake-model',
    position: 'Developer', status: AgentStatus.IDLE, capabilities: [], specialties: [], enabled: true,
  });
  const provider = new ControllableProvider('COMPLETED');
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(provider);
  const pool = new AgentPool({ providerFactory, eventBus: bus });
  pool.register({ agentId: agent.id, projectId: project.id, providerId: 'fake' });
  const scheduler = new AgentScheduler({
    taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments,
  });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees,
  });
  const reviews = new ReviewHandleStore(database);
  const planLifecycle = new PlanLifecycleService(projects, agents, bus, database, tasks, assignmentRepo);
  const transitions = new ReviewTransitionCoordinator({ database, reviews, planLifecycle, tasks });
  const assignmentRecovery = new PlanExecutionRecoveryService({
    database, planLifecycle, tasks, assignments, agentPool: pool, eventBus: bus, reviews,
  });
  const failpoint: { afterRevisionTurnDurableBeforeReview?: () => void } = {};
  const lifecycle = new TaskLifecycleOrchestrator({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool,
    worktreeManager: worktrees, reviewTransitions: transitions, assignmentRecovery,
    revisionRecoveryFailpoint: failpoint,
  });
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle, tasks, scheduler, dispatcher, taskLifecycle: lifecycle, targetBranch: 'main',
    buildTestPlan: testPlan, eventBus: bus, reviewTransitions: transitions, assignmentRecovery,
  });
  const app = {
    projects, agents, tasks, assignments, assignmentQueries: assignments, events: { list: () => [] },
    eventBus: bus, scheduler, dispatcher, lifecycle, planLifecycle, planExecution: coordinator, reviews,
    assignmentRecovery, reviewTransitions: transitions, buildTestPlan: testPlan, targetBranch: 'main',
  } as unknown as AgentHubApplication;
  const server = new AgentHubHttpServer({ application: app, port: 0 });
  const address = await server.start();
  return {
    directory, repositoryRoot, database, bus, agents, tasks, assignmentRepo, pool, reviews, transitions,
    planLifecycle, coordinator, provider, failpoint, server, agentId: agent.id, projectId: project.id,
    baseUrl: `http://${address.host}:${String(address.port)}`,
    async cleanup() {
      await server.stop().catch(() => undefined);
      try {
        const snapshot = pool.getSnapshot(agent.id);
        if (snapshot.assignmentId !== undefined) await pool.shutdown(agent.id, snapshot.assignmentId);
      } catch { /* pool may already be closed */ }
      try { database.close(); } catch { /* already closed */ }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* windows lock */ }
    },
  };
}

async function setupStartedPlan(h: Awaited<ReturnType<typeof createHarness>>) {
  const intake = h.planLifecycle.createIntake({
    projectId: h.projectId, createdBy: 'human', goal: 'revision recovery', leadAgentId: h.agentId,
  });
  const plan = h.planLifecycle.createPlan({
    intakeId: intake.intakeId, leadAgentId: h.agentId, summary: 'revision recovery',
    tasks: [{
      clientId: 'task-m', parentClientId: null, title: 'Revision Task', description: 'revise',
      acceptanceCriteria: ['Pass review'], requiredCapabilities: [], requiredSpecialties: [],
      complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    }],
    dependencies: [],
  });
  const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
    planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
  });
  const startRes = await fetch(`${h.baseUrl}/api/v1/plans/${approved.planId}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'start-m' },
    body: JSON.stringify({ planVersion: 1, proposalHash: approved.current.proposalHash }),
  });
  expect(startRes.status).toBe(200);
  const reviewsRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
  const reviewsBody = await reviewsRes.json() as { data: Array<{ review: { reviewHandle: string }; runtimeTaskId: string }> };
  const first = reviewsBody.data[0];
  if (!first) throw new Error('expected first review');
  return { planId: approved.planId, handle: first.review.reviewHandle, runtimeTaskId: first.runtimeTaskId };
}

async function waitForStatus(tasks: { getTask(id: string): { status: TaskStatus } | null }, taskId: string, status: TaskStatus): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tasks.getTask(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${status}; current=${tasks.getTask(taskId)?.status ?? 'missing'}`);
}

async function reopen(h: Awaited<ReturnType<typeof createHarness>>, registerProvider: boolean) {
  await h.pool.shutdownAll();
  await h.server.stop();
  h.database.close();
  const database = new Database(join(h.directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agents = new AgentRegistry(new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(h.directory, 'agents') }), bus);
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
  const assignmentRepo = new SqliteAssignmentRepository(database);
  const assignments = new AssignmentManager(assignmentRepo, tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), bus);
  const projects = new SqliteProjectRepository(database);
  const provider = new ControllableProvider('COMPLETED');
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: bus });
  if (registerProvider) pool.register({ agentId: h.agentId, projectId: h.projectId, providerId: 'fake' });
  const scheduler = new AgentScheduler({
    taskManager: tasks, agentRegistry: agents, providerFactory: factory, agentPool: pool, assignmentManager: assignments,
  });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot: h.repositoryRoot });
  const dispatcher = new AssignmentDispatcher({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees,
  });
  const reviews = new ReviewHandleStore(database);
  const planLifecycle = new PlanLifecycleService(projects, agents, bus, database, tasks, assignmentRepo);
  const transitions = new ReviewTransitionCoordinator({ database, reviews, planLifecycle, tasks });
  const assignmentRecovery = new PlanExecutionRecoveryService({
    database, planLifecycle, tasks, assignments, agentPool: pool, eventBus: bus, reviews,
  });
  const lifecycle = new TaskLifecycleOrchestrator({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool,
    worktreeManager: worktrees, reviewTransitions: transitions, assignmentRecovery,
  });
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle, tasks, scheduler, dispatcher, taskLifecycle: lifecycle, targetBranch: 'main',
    buildTestPlan: testPlan, eventBus: bus, reviewTransitions: transitions, assignmentRecovery,
  });
  const recovery = new PlanRecoveryCoordinator({
    planLifecycle, planExecution: coordinator, reviewTransitions: transitions, eventBus: bus,
  });
  recoverLifecycleAfterStartup({ reviewTransitions: transitions, recovery });
  await recovery.idle();
  await recovery.stop();
  const app = {
    projects, agents, tasks, assignments, assignmentQueries: assignmentRepo, events: { list: () => [] },
    eventBus: bus, scheduler, dispatcher, lifecycle, planLifecycle, planExecution: coordinator, reviews,
    assignmentRecovery, reviewTransitions: transitions, buildTestPlan: testPlan, targetBranch: 'main',
  } as unknown as AgentHubApplication;
  const server = new AgentHubHttpServer({ application: app, port: 0 });
  const address = await server.start();
  return {
    database, tasks, assignmentRepo, agents, reviews, provider, server,
    baseUrl: `http://${address.host}:${String(address.port)}`,
    async close() {
      await server.stop().catch(() => undefined);
      try { await pool.shutdownAll(); } catch { /* already stopped */ }
      try { database.close(); } catch { /* already closed */ }
    },
  };
}

describe('0.7.3O recovered revision continuation', { timeout: 240_000 }, () => {
  const harnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.cleanup();
  });

  it('recovered review can request another revision on the same assignment', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const started = await setupStartedPlan(h);
    const assignmentId = h.assignmentRepo.list()[0]?.id;
    const revised = await fetch(`${h.baseUrl}/api/v1/reviews/${started.handle}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-o-1' },
      body: JSON.stringify(revisionBody),
    });
    expect(revised.status).toBe(200);
    const second = (await revised.json() as { data: { reviewHandle: string } }).data.reviewHandle;
    expect(second).not.toBe(started.handle);
    const callsBeforeRestart = h.provider.session?.runCalls ?? 0;
    const next = await reopen(h, true);
    try {
      await waitForStatus(next.tasks, started.runtimeTaskId, TaskStatus.REVIEWING);
      expect(next.provider.session?.runCalls ?? 0).toBe(0);
      const again = await fetch(`${next.baseUrl}/api/v1/reviews/${second}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-o-2' },
        body: JSON.stringify(revisionBody),
      });
      expect(again.status).toBe(200);
      const third = (await again.json() as { data: { reviewHandle: string } }).data.reviewHandle;
      expect(third).not.toBe(second);
      expect(next.tasks.getTask(started.runtimeTaskId)?.status).toBe(TaskStatus.REVIEWING);
      expect(next.tasks.getTask(started.runtimeTaskId)?.assignmentId).toBe(assignmentId);
      expect(next.tasks.getTask(started.runtimeTaskId)?.assignedAgentId).toBe(h.agentId);
      expect(next.tasks.listTasks()).toHaveLength(1);
      expect(next.assignmentRepo.list()).toHaveLength(1);
      expect(next.assignmentRepo.list()[0]?.id).toBe(assignmentId);
      expect(recoveryRow(next.database, started.runtimeTaskId).revision_round).toBe(3);
      expect(next.provider.session?.runCalls).toBe(1);
      expect(h.provider.session?.runCalls).toBe(callsBeforeRestart);
      expect(() => next.reviews.resolve(second)).toThrow();
    } finally {
      await next.close();
    }
  });

  it('keeps the recovered review active when runtime ownership cannot be restored', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const started = await setupStartedPlan(h);
    const revised = await fetch(`${h.baseUrl}/api/v1/reviews/${started.handle}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-o-3' },
      body: JSON.stringify(revisionBody),
    });
    expect(revised.status).toBe(200);
    const second = (await revised.json() as { data: { reviewHandle: string } }).data.reviewHandle;
    const callsBeforeRestart = h.provider.session?.runCalls ?? 0;
    const next = await reopen(h, false);
    try {
      await waitForStatus(next.tasks, started.runtimeTaskId, TaskStatus.REVIEWING);
      const roundBefore = recoveryRow(next.database, started.runtimeTaskId).revision_round;
      expect(roundBefore).toBe(2);
      const denied = await fetch(`${next.baseUrl}/api/v1/reviews/${second}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-o-4' },
        body: JSON.stringify(revisionBody),
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(next.reviews.resolve(second).reviewBundleSha256).toBe(second);
      expect(next.tasks.getTask(started.runtimeTaskId)?.status).toBe(TaskStatus.REVIEWING);
      const row = recoveryRow(next.database, started.runtimeTaskId);
      expect(row.revision_round).toBe(2);
      expect(row.stage).not.toBe('TURN_STARTED');
      expect(next.provider.session?.runCalls ?? 0).toBe(0);
      expect(h.provider.session?.runCalls).toBe(callsBeforeRestart);
    } finally {
      await next.close();
    }
  });

  it('converges durable failed and needs-input outcomes after restart', async () => {
    for (const outcome of ['FAILED', 'NEEDS_INPUT'] as const) {
      const h = await createHarness();
      harnesses.push(h);
      const started = await setupStartedPlan(h);
      if (!h.provider.session) throw new Error('missing session');
      h.provider.outcome = outcome;
      h.failpoint.afterRevisionTurnDurableBeforeReview = () => { throw new Error('CRASH_BEFORE_CONVERGENCE'); };
      const crashed = await fetch(`${h.baseUrl}/api/v1/reviews/${started.handle}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `rev-o-${outcome}` },
        body: JSON.stringify(revisionBody),
      });
      expect(crashed.status).toBeGreaterThanOrEqual(500);
      expect(recoveryRow(h.database, started.runtimeTaskId).stage).toBe('TURN_COMPLETED');
      const next = await reopen(h, true);
      try {
        const expected = outcome === 'FAILED' ? TaskStatus.FAILED : TaskStatus.WAITING_INPUT;
        await waitForStatus(next.tasks, started.runtimeTaskId, expected);
        expect(next.provider.session?.runCalls ?? 0).toBe(0);
        expect(next.tasks.listTasks()).toHaveLength(1);
        expect(next.assignmentRepo.list()).toHaveLength(1);
        expect(() => next.reviews.resolve(started.handle)).toThrow();
        expect(next.reviews.getActiveForTask(started.runtimeTaskId)).toBeUndefined();
      } finally {
        await next.close();
      }
    }
  });
});

