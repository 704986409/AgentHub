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
  AssignmentStatus,
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
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public runTurn(): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    return Promise.resolve({
      providerId: this.providerId, sessionId: this.sessionId, protocol: 'worker-result', protocolValid: true,
      workerResult: {
        protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [],
        blockers: [], questions: [], risks: [], notes: [],
      },
    });
  }
  public shutdown(): Promise<void> { this.started = false; this.active = false; return Promise.resolve(); }
}

class ControllableProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public session: ControllableSession | undefined;
  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    if (options.workspacePath === undefined) throw new Error('workspace path required');
    this.session = new ControllableSession();
    return this.session;
  }
}

const testPlan: BuildTestEvidencePlan = {
  commands: [{
    id: 'test', phase: 'test', executable: process.execPath, args: ['-e', 'process.exit(0)'],
    cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {},
  }],
};

const acceptBody = {
  reviewId: 'accept-074a', reviewerId: 'human', verdict: 'ACCEPT', summary: 'ok', findings: [],
  allowNoChangeCompletion: true,
};

function recoveryStage(database: Database, taskId: string): string {
  const row = database.connection.prepare(
    'SELECT stage FROM assignment_dispatch_recovery WHERE task_id = ?',
  ).get(taskId) as { stage: string } | undefined;
  if (row === undefined) throw new Error('missing recovery row');
  return row.stage;
}

function expectPoolClean(pool: AgentPool, agentId: string): void {
  const snap = pool.getSnapshot(agentId);
  expect(snap.state).toBe('IDLE');
  expect(snap.busy).toBe(false);
  expect(snap.active).toBe(false);
  expect(snap.assignmentId).toBeUndefined();
  expect(snap.sessionId).toBeUndefined();
}

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-074a-'));
  const repositoryRoot = join(directory, 'repository');
  execFileSync('git', ['init', '-b', 'main', repositoryRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub Tests'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, 'README.md'), '# AgentHub 0.7.4A Test\n', 'utf8');
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
  const project = projects.create({ id: 'project-074a', name: 'Standalone Convergence' });
  const agent = agents.createAgent({
    id: 'agent-074a', projectId: project.id, name: 'StandaloneWorker', provider: 'fake', model: 'fake-model',
    position: 'Developer', status: AgentStatus.IDLE, capabilities: [], specialties: [], enabled: true,
  });
  const provider = new ControllableProvider();
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
  const lifecycle = new TaskLifecycleOrchestrator({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool,
    worktreeManager: worktrees, reviewTransitions: transitions, assignmentRecovery,
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
    directory, repositoryRoot, database, agents, tasks, assignmentRepo, pool, reviews, provider,
    server, agentId: agent.id, projectId: project.id,
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

async function reopen(h: Awaited<ReturnType<typeof createHarness>>) {
  try { await h.pool.shutdownAll(); } catch { /* already stopped */ }
  try { await h.server.stop(); } catch { /* already stopped */ }
  try { h.database.close(); } catch { /* already closed */ }
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
  const provider = new ControllableProvider();
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: bus });
  pool.register({ agentId: h.agentId, projectId: h.projectId, providerId: 'fake' });
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
    database, tasks, assignmentRepo, agents, reviews, provider, pool,
    baseUrl: `http://${address.host}:${String(address.port)}`,
    async close() {
      await server.stop().catch(() => undefined);
      try { await pool.shutdownAll(); } catch { /* already stopped */ }
      try { database.close(); } catch { /* already closed */ }
    },
  };
}

describe('0.7.4A standalone convergence', { timeout: 180_000 }, () => {
  const harnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.cleanup();
  });

  it('S1 keeps standalone REVIEW_READY across restart and accepts it', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const task = h.tasks.createTask({
      projectId: h.projectId, title: 'Standalone', description: 'converge',
      acceptanceCriteria: ['Pass review'], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    const executed = await fetch(`${h.baseUrl}/api/v1/tasks/${task.id}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'exec-074a' },
      body: JSON.stringify({ baseRef: 'main', prompt: 'do work' }),
    });
    expect(executed.status).toBe(200);
    const handle = (await executed.json() as { data: { reviewHandle: string } }).data.reviewHandle;
    expect(h.tasks.getTask(task.id)?.status).toBe(TaskStatus.REVIEWING);
    expect(h.reviews.getActiveForTask(task.id)?.reviewBundleSha256).toBe(handle);
    expect(recoveryStage(h.database, task.id)).toBe('REVIEW_READY');
    expectPoolClean(h.pool, h.agentId);
    expect(h.assignmentRepo.list()[0]?.status).toBe(AssignmentStatus.ACTIVE);
    expect(h.agents.getAgent(h.agentId)?.status).toBe(AgentStatus.BUSY);
    const callsBeforeRestart = h.provider.session?.runCalls ?? 0;
    expect(callsBeforeRestart).toBe(1);

    const next = await reopen(h);
    try {
      expect(next.tasks.getTask(task.id)?.status).toBe(TaskStatus.REVIEWING);
      expect(next.reviews.getActiveForTask(task.id)?.reviewBundleSha256).toBe(handle);
      expect(next.reviews.resolve(handle).reviewBundleSha256).toBe(handle);
      expect(recoveryStage(next.database, task.id)).toBe('REVIEW_READY');
      expect(next.provider.session?.runCalls ?? 0).toBe(0);
      const ownership = next.pool.inspectAssignmentOwnership(h.agentId, next.assignmentRepo.list()[0]?.id ?? '');
      expect(ownership.state).toBe('ABSENT');
      const accepted = await fetch(`${next.baseUrl}/api/v1/reviews/${handle}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'accept-074a' },
        body: JSON.stringify(acceptBody),
      });
      expect(accepted.status).toBe(200);
      expect(next.tasks.getTask(task.id)?.status).toBe(TaskStatus.COMPLETED);
      expect(next.assignmentRepo.list()[0]?.status).toBe(AssignmentStatus.COMPLETED);
      expect(next.agents.getAgent(h.agentId)?.status).toBe(AgentStatus.IDLE);
      const listed = await fetch(`${next.baseUrl}/api/v1/reviews`);
      expect(((await listed.json()) as { data: unknown[] }).data).toEqual([]);
      expect(next.provider.session?.runCalls ?? 0).toBe(0);
      expect(h.provider.session?.runCalls).toBe(callsBeforeRestart);
    } finally {
      await next.close();
    }
  });
});
