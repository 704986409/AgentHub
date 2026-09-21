import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  type AgentHubWorkerOutcome,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnResult,
  type BuildTestEvidencePlan,
} from '../src/index.js';
import { ReviewTransitionCoordinator } from '../src/lifecycle/review-transition-coordinator.js';

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
  public turnGate: Promise<void> | undefined;
  public onTurnStart?: () => void;

  public constructor(
    _workspacePath: string,
    private readonly outcome: AgentHubWorkerOutcome = 'COMPLETED',
  ) {}

  public start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  public async runTurn(): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.onTurnStart?.();
    if (this.turnGate !== undefined) {
      await this.turnGate;
    }
    return {
      providerId: this.providerId,
      sessionId: this.sessionId,
      protocol: 'worker-result',
      protocolValid: true,
      workerResult: {
        protocolVersion: 1,
        outcome: this.outcome,
        summary: 'identical worker result',
        changedFiles: [],
        checks: [],
        blockers: [],
        questions: [],
        risks: [],
        notes: [],
      },
    };
  }

  public shutdown(): Promise<void> {
    this.started = false;
    this.active = false;
    return Promise.resolve();
  }
}

class ControllableProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public session: ControllableSession | undefined;

  public constructor(private readonly outcome: AgentHubWorkerOutcome = 'COMPLETED') {}

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    if (options.workspacePath === undefined) throw new Error('workspace path required');
    this.session = new ControllableSession(options.workspacePath, this.outcome);
    return this.session;
  }
}

const testPlan: BuildTestEvidencePlan = {
  commands: [{
    id: 'test',
    phase: 'test',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: '.',
    timeoutMs: 5_000,
    inheritEnv: [],
    env: {},
  }],
};

interface TestHarness {
  directory: string;
  repositoryRoot: string;
  database: Database;
  bus: EventBus;
  agents: AgentRegistry;
  tasks: TaskManager;
  assignments: AssignmentManager;
  assignmentRepo: SqliteAssignmentRepository;
  pool: AgentPool;
  scheduler: AgentScheduler;
  dispatcher: AssignmentDispatcher;
  worktrees: GitWorktreeManager;
  reviews: ReviewHandleStore;
  transitions: ReviewTransitionCoordinator;
  planLifecycle: PlanLifecycleService;
  coordinator: PlanExecutionCoordinator;
  lifecycle: TaskLifecycleOrchestrator;
  provider: ControllableProvider;
  app: AgentHubApplication;
  server: AgentHubHttpServer;
  baseUrl: string;
  projectId: string;
  agentId: string;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-073L-'));
  const repositoryRoot = join(directory, 'repository');
  execFileSync('git', ['init', '-b', 'main', repositoryRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub Tests'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, 'README.md'), '# AgentHub 0.7.3L Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repositoryRoot, stdio: 'ignore' });

  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agents = new AgentRegistry(
    new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }),
    bus,
  );
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
  const assignmentRepo = new SqliteAssignmentRepository(database);
  const assignments = new AssignmentManager(
    assignmentRepo,
    tasks,
    agents,
    (agentId) => agents.calculateProfileHash(agentId),
    bus,
  );
  const projects = new SqliteProjectRepository(database);
  const project = projects.create({ id: 'project-l', name: 'Revision Test' });
  const agent = agents.createAgent({
    id: 'agent-l',
    projectId: project.id,
    name: 'RevisionWorker',
    provider: 'fake',
    model: 'fake-model',
    position: 'Developer',
    status: AgentStatus.IDLE,
    capabilities: [],
    specialties: [],
    enabled: true,
  });

  const provider = new ControllableProvider('COMPLETED');
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(provider);
  const pool = new AgentPool({ providerFactory, eventBus: bus });
  pool.register({ agentId: agent.id, projectId: project.id, providerId: 'fake' });
  const scheduler = new AgentScheduler({
    taskManager: tasks,
    agentRegistry: agents,
    providerFactory,
    agentPool: pool,
    assignmentManager: assignments,
  });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({
    taskManager: tasks,
    agentRegistry: agents,
    assignmentManager: assignments,
    agentPool: pool,
    worktreeManager: worktrees,
  });
  const reviews = new ReviewHandleStore(database);
  const planLifecycle = new PlanLifecycleService(projects, agents, bus, database, tasks, assignmentRepo);
  const transitions = new ReviewTransitionCoordinator({
    database,
    reviews,
    planLifecycle,
    tasks,
  });
  const lifecycle = new TaskLifecycleOrchestrator({
    taskManager: tasks,
    agentRegistry: agents,
    assignmentManager: assignments,
    agentPool: pool,
    worktreeManager: worktrees,
    reviewTransitions: transitions,
  });
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle,
    tasks,
    scheduler,
    dispatcher,
    taskLifecycle: lifecycle,
    targetBranch: 'main',
    buildTestPlan: testPlan,
    eventBus: bus,
    reviewTransitions: transitions,
  });

  const app = {
    projects,
    agents,
    tasks,
    assignments,
    assignmentQueries: assignments,
    events: { list: () => [] },
    eventBus: bus,
    scheduler,
    dispatcher,
    lifecycle,
    planLifecycle,
    planExecution: coordinator,
    reviews,
    reviewTransitions: transitions,
    buildTestPlan: testPlan,
    targetBranch: 'main',
  } as unknown as AgentHubApplication;

  const server = new AgentHubHttpServer({ application: app, port: 0 });
  const address = await server.start();
  const baseUrl = `http://${address.host}:${String(address.port)}`;

  return {
    directory,
    repositoryRoot,
    database,
    bus,
    agents,
    tasks,
    assignments,
    assignmentRepo,
    pool,
    scheduler,
    dispatcher,
    worktrees,
    reviews,
    transitions,
    planLifecycle,
    coordinator,
    lifecycle,
    provider,
    app,
    server,
    baseUrl,
    projectId: project.id,
    agentId: agent.id,
    async cleanup() {
      await server.stop().catch(() => undefined);
      const snapshot = pool.getSnapshot(agent.id);
      if (snapshot.assignmentId !== undefined) {
        await pool.shutdown(agent.id, snapshot.assignmentId).catch(() => undefined);
      }
      try { database.close(); } catch { /* ignore if already closed */ }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore Windows lock */ }
    },
  };
}

async function setupStartedPlan(h: TestHarness) {
  const intake = h.planLifecycle.createIntake({
    projectId: h.projectId,
    createdBy: 'human',
    goal: 'Run revision test',
    leadAgentId: h.agentId,
  });
  const plan = h.planLifecycle.createPlan({
    intakeId: intake.intakeId,
    leadAgentId: h.agentId,
    summary: 'Plan for revision identity',
    tasks: [{
      clientId: 'task-rev',
      parentClientId: null,
      title: 'Revision Task',
      description: 'Implement with revision',
      acceptanceCriteria: ['Pass review'],
      requiredCapabilities: [],
      requiredSpecialties: [],
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    }],
    dependencies: [],
  });
  const approved = h.planLifecycle.decide(plan.planId, 'APPROVE', {
    planVersion: 1,
    proposalHash: plan.current.proposalHash,
    actorId: 'human',
    summary: 'Approved',
  });

  const startRes = await fetch(`${h.baseUrl}/api/v1/plans/${approved.planId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'start-k' },
    body: JSON.stringify({ planVersion: 1, proposalHash: approved.current.proposalHash }),
  });
  expect(startRes.status).toBe(200);

  const reviewsRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
  expect(reviewsRes.status).toBe(200);
  const reviewsBody = await reviewsRes.json() as { data: Array<{ review: { reviewHandle: string; reviewBundleSha256: string }; runtimeTaskId: string }> };
  expect(reviewsBody.data).toHaveLength(1);
  const firstReview = reviewsBody.data[0];
  if (!firstReview) throw new Error('expected first review');

  return { planId: approved.planId, firstReview, runtimeTaskId: firstReview.runtimeTaskId };
}

describe('AgentHub Backend 0.7.3L — Revision Review Identity and Stale Review Fix', { timeout: 180_000 }, () => {
  const harnesses: TestHarness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.cleanup();
  });

  it('7.1 Slow Revision Provider: hides stale review during revision, then exposes exactly one fresh review', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { planId, firstReview, runtimeTaskId } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => { releaseGate = resolve; });
    let turnStartedResolve!: () => void;
    const turnStartedPromise = new Promise<void>((resolve) => { turnStartedResolve = resolve; });
    if (!h.provider.session) throw new Error('expected provider session');
    h.provider.session.turnGate = gatePromise;
    h.provider.session.onTurnStart = turnStartedResolve;

    try {
      const revisionRequest = fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-dec-1' },
        body: JSON.stringify({
          reviewId: 'rev-1',
          reviewerId: 'human',
          verdict: 'REQUEST_REVISION',
          summary: 'need revision',
          findings: [{ code: 'FIX', severity: 'error', message: 'please revise' }],
          allowNoChangeCompletion: true,
        }),
      });

      await turnStartedPromise;

      const taskDuring = h.tasks.getTask(runtimeTaskId);
      expect(taskDuring?.status).toBe(TaskStatus.IMPLEMENTING);

      const planDuring = h.planLifecycle.getPlan(planId);
      const planTaskDuring = planDuring?.tasks.find((t) => t.runtimeTaskId === runtimeTaskId);
      expect(planTaskDuring?.runtimeState).not.toBe('REVIEWING');
      expect(planTaskDuring?.runtimeState).toBe('RUNNING');

      const reviewsDuringRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
      expect(reviewsDuringRes.status).toBe(200);
      const reviewsDuring = await reviewsDuringRes.json() as { data: unknown[] };
      expect(reviewsDuring.data).toEqual([]);

      const stalePostRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'stale-post' },
        body: JSON.stringify({
          reviewId: 'stale-1',
          reviewerId: 'human',
          verdict: 'ACCEPT',
          summary: 'accept stale',
          findings: [],
          allowNoChangeCompletion: true,
        }),
      });
      expect([409, 410]).toContain(stalePostRes.status);

      const agentDuring = h.agents.getAgent(h.agentId);
      expect(agentDuring?.status).toBe(AgentStatus.BUSY);

      const assignmentDuring = h.assignments.getAssignment(taskDuring?.assignmentId ?? '');
      expect(assignmentDuring?.status).toBe(AssignmentStatus.ACTIVE);

      releaseGate();
      const revisionResponse = await revisionRequest;
      expect(revisionResponse.status).toBe(200);
    } finally {
      releaseGate();
    }

    const taskAfter = h.tasks.getTask(runtimeTaskId);
    expect(taskAfter?.status).toBe(TaskStatus.REVIEWING);

    const reviewsAfterRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    expect(reviewsAfterRes.status).toBe(200);
    const reviewsAfter = await reviewsAfterRes.json() as {
      data: Array<{ review: { reviewHandle: string }; runtimeTaskId: string; assignmentId: string; agentId: string }>;
    };
    expect(reviewsAfter.data).toHaveLength(1);
    const secondReview = reviewsAfter.data[0];
    if (!secondReview) throw new Error('expected second review');
    expect(secondReview.runtimeTaskId).toBe(runtimeTaskId);
    expect(secondReview.assignmentId).toBe(taskAfter?.assignmentId);
    expect(secondReview.agentId).toBe(h.agentId);
    expect(secondReview.review.reviewHandle).not.toBe(firstHandle);
  });

  it('7.2 Identical Evidence: generates distinct round identity even when worker and evidence are identical', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview, runtimeTaskId } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    const revisionRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-dec-identical' },
      body: JSON.stringify({
        reviewId: 'rev-2',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'identical revision test',
        findings: [{ code: 'FIX', severity: 'error', message: 'do same thing' }],
        allowNoChangeCompletion: true,
      }),
    });
    expect(revisionRes.status).toBe(200);

    const reviewsAfterRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const reviewsAfter = await reviewsAfterRes.json() as {
      data: Array<{ review: { reviewHandle: string; reviewBundleSha256: string } }>;
    };
    expect(reviewsAfter.data).toHaveLength(1);
    const secondHandle = reviewsAfter.data[0]?.review.reviewHandle;
    if (typeof secondHandle !== 'string') throw new Error('expected secondHandle');
    expect(secondHandle).not.toBe(firstHandle);
    expect(reviewsAfter.data[0]?.review.reviewBundleSha256).toBe(secondHandle);

    const oldHandleRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'old-handle-accept' },
      body: JSON.stringify({
        reviewId: 'old-acc',
        reviewerId: 'human',
        verdict: 'ACCEPT',
        summary: 'try accept old',
        findings: [],
        allowNoChangeCompletion: true,
      }),
    });
    expect(oldHandleRes.status).toBe(410);

    const secondAcceptRes = await fetch(`${h.baseUrl}/api/v1/reviews/${secondHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'second-accept' },
      body: JSON.stringify({
        reviewId: 'second-acc',
        reviewerId: 'human',
        verdict: 'ACCEPT',
        summary: 'accept second review',
        findings: [],
        allowNoChangeCompletion: true,
      }),
    });
    expect(secondAcceptRes.status).toBe(200);
    expect(h.tasks.getTask(runtimeTaskId)?.status).toBe(TaskStatus.COMPLETED);
  });

  it('7.3 Restart During Revision IMPLEMENTING: stale review is not resurrected and authority is consistent', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview, runtimeTaskId } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    h.transitions.retireForRevision(runtimeTaskId, firstHandle);
    h.tasks.transitionTask(runtimeTaskId, TaskStatus.REVISION_REQUIRED);
    h.tasks.transitionTask(runtimeTaskId, TaskStatus.IMPLEMENTING);

    expect(h.tasks.getTask(runtimeTaskId)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(h.reviews.listPublic(h.planLifecycle.listPlans(), h.tasks)).toHaveLength(0);

    await h.server.stop();
    h.database.close();

    const reopenedDb = new Database(join(h.directory, 'agenthub.db'));
    reopenedDb.initialize();

    const restoredTasks = new TaskManager(new SqliteTaskRepository(reopenedDb), new TaskStateMachine(), h.bus);
    const restoredProjects = new SqliteProjectRepository(reopenedDb);
    const restoredAgents = new AgentRegistry(
      new SqliteAgentRepository(reopenedDb),
      new AgentProfileManager({ agentsDirectory: join(h.directory, 'agents') }),
      h.bus,
    );
    const restoredAssignmentRepo = new SqliteAssignmentRepository(reopenedDb);
    const restoredPlanLifecycle = new PlanLifecycleService(
      restoredProjects,
      restoredAgents,
      h.bus,
      reopenedDb,
      restoredTasks,
      restoredAssignmentRepo,
    );
    const restoredReviews = new ReviewHandleStore(reopenedDb);
    const restoredTransitions = new ReviewTransitionCoordinator({
      database: reopenedDb,
      reviews: restoredReviews,
      planLifecycle: restoredPlanLifecycle,
      tasks: restoredTasks,
    });

    expect(() => restoredTransitions.reconcile()).not.toThrow();
    expect(restoredTransitions.reconciliationRequired).toBe(false);

    expect(restoredReviews.listPublic(restoredPlanLifecycle.listPlans(), restoredTasks)).toHaveLength(0);
    expect(restoredReviews.getActiveForTask(runtimeTaskId)).toBeUndefined();
    expect(restoredTasks.getTask(runtimeTaskId)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(() => restoredReviews.resolve(firstHandle)).toThrow();

    reopenedDb.close();
  });

  it('7.4 Restart After Second REVIEWING: restores the exact second review round identity', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview, runtimeTaskId } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    const revisionRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-dec-restart' },
      body: JSON.stringify({
        reviewId: 'rev-restart',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'revision before restart',
        findings: [{ code: 'FIX', severity: 'error', message: 'fix' }],
        allowNoChangeCompletion: true,
      }),
    });
    expect(revisionRes.status).toBe(200);

    const reviewsRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const reviewsData = await reviewsRes.json() as { data: Array<{ review: { reviewHandle: string } }> };
    expect(reviewsData.data).toHaveLength(1);
    const secondHandle = reviewsData.data[0]?.review.reviewHandle;
    if (!secondHandle) throw new Error('expected second handle');

    await h.server.stop();
    h.database.close();

    const reopenedDb = new Database(join(h.directory, 'agenthub.db'));
    reopenedDb.initialize();

    try {
      const restoredTasks = new TaskManager(new SqliteTaskRepository(reopenedDb), new TaskStateMachine(), h.bus);
      const restoredProjects = new SqliteProjectRepository(reopenedDb);
      const restoredAgents = new AgentRegistry(
        new SqliteAgentRepository(reopenedDb),
        new AgentProfileManager({ agentsDirectory: join(h.directory, 'agents') }),
        h.bus,
      );
      const restoredAssignmentRepo = new SqliteAssignmentRepository(reopenedDb);
      const restoredPlanLifecycle = new PlanLifecycleService(
        restoredProjects,
        restoredAgents,
        h.bus,
        reopenedDb,
        restoredTasks,
        restoredAssignmentRepo,
      );
      const restoredReviews = new ReviewHandleStore(reopenedDb);
      const restoredTransitions = new ReviewTransitionCoordinator({
        database: reopenedDb,
        reviews: restoredReviews,
        planLifecycle: restoredPlanLifecycle,
        tasks: restoredTasks,
      });

      restoredTransitions.reconcile();

      const restoredList = restoredReviews.listPublic(restoredPlanLifecycle.listPlans(), restoredTasks);
      expect(restoredList).toHaveLength(1);
      expect(restoredList[0]?.review.reviewHandle).toBe(secondHandle);
      expect(restoredList[0]?.runtimeTaskId).toBe(runtimeTaskId);
      expect(restoredList[0]?.assignmentId).toBe(restoredTasks.getTask(runtimeTaskId)?.assignmentId);
      expect(restoredList[0]?.agentId).toBe(h.agentId);

      expect(() => restoredReviews.resolve(firstHandle)).toThrow();
      expect(restoredReviews.resolve(secondHandle).reviewBundleSha256).toBe(secondHandle);
    } finally {
      reopenedDb.close();
    }
  });

  it('7.5 Final ACCEPT after Revision: completes task and plan with clean terminal state', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { planId, firstReview, runtimeTaskId } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    const revisionRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-final-1' },
      body: JSON.stringify({
        reviewId: 'rev-final',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'requesting revision',
        findings: [{ code: 'FIX', severity: 'error', message: 'fix' }],
        allowNoChangeCompletion: true,
      }),
    });
    expect(revisionRes.status).toBe(200);

    const reviewsRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const secondHandle = ((await reviewsRes.json()) as { data: Array<{ review: { reviewHandle: string } }> }).data[0]?.review.reviewHandle;
    if (!secondHandle) throw new Error('missing second handle');

    const acceptRes = await fetch(`${h.baseUrl}/api/v1/reviews/${secondHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'accept-final-1' },
      body: JSON.stringify({
        reviewId: 'accept-final',
        reviewerId: 'human',
        verdict: 'ACCEPT',
        summary: 'accept final revision',
        findings: [],
        allowNoChangeCompletion: true,
      }),
    });
    expect(acceptRes.status).toBe(200);

    const taskFinal = h.tasks.getTask(runtimeTaskId);
    expect(taskFinal?.status).toBe(TaskStatus.COMPLETED);

    const planFinal = h.planLifecycle.getPlan(planId);
    expect(planFinal?.state).toBe('COMPLETED');

    const reviewsFinalRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const reviewsFinal = await reviewsFinalRes.json() as { data: unknown[] };
    expect(reviewsFinal.data).toEqual([]);

    const agentFinal = h.agents.getAgent(h.agentId);
    expect(agentFinal?.status).toBe(AgentStatus.IDLE);

    const allTasks = h.tasks.listTasks();
    expect(allTasks).toHaveLength(1);
    const allAssignments = h.assignmentRepo.list();
    expect(allAssignments).toHaveLength(1);
  });

  it('8.1 - 8.2 Negative: old handle after REQUEST_REVISION cannot be accepted', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-neg-1' },
      body: JSON.stringify({
        reviewId: 'rev-neg',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'revise',
        findings: [{ code: 'FIX', severity: 'error', message: 'fix' }],
        allowNoChangeCompletion: true,
      }),
    });

    const staleRes = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'stale-accept' },
      body: JSON.stringify({
        reviewId: 'stale-acc',
        reviewerId: 'human',
        verdict: 'ACCEPT',
        summary: 'accept old',
        findings: [],
        allowNoChangeCompletion: true,
      }),
    });
    expect(staleRes.status).toBe(410);

    const reviewsRes = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const secondHandle = ((await reviewsRes.json()) as { data: Array<{ review: { reviewHandle: string } }> }).data[0]?.review.reviewHandle;
    expect(secondHandle).toBeDefined();
    expect(secondHandle).not.toBe(firstHandle);
  });

  it('8.3 - 8.4 Negative: fail-closed prevents exposing review if task is IMPLEMENTING even with stale reviewPending', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { planId, runtimeTaskId } = await setupStartedPlan(h);

    h.tasks.transitionTask(runtimeTaskId, TaskStatus.REVISION_REQUIRED);
    h.tasks.transitionTask(runtimeTaskId, TaskStatus.IMPLEMENTING);

    const plan = h.planLifecycle.getPlan(planId);
    const taskProjection = plan?.tasks.find((t) => t.runtimeTaskId === runtimeTaskId);
    expect(taskProjection?.runtimeState).toBe('RUNNING');

    const reviews = h.reviews.listPublic(h.planLifecycle.listPlans(), h.tasks);
    expect(reviews).toHaveLength(0);

    const response = await fetch(`${h.baseUrl}/api/v1/reviews`);
    const body = await response.json() as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('8.5 Negative: multiple revision rounds generate distinct identities for each round', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview } = await setupStartedPlan(h);
    const handle1 = firstReview.review.reviewHandle;

    const rev1 = await fetch(`${h.baseUrl}/api/v1/reviews/${handle1}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-round-1' },
      body: JSON.stringify({
        reviewId: 'rev-r1',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'first revision',
        findings: [{ code: 'FIX1', severity: 'error', message: 'fix 1' }],
        allowNoChangeCompletion: true,
      }),
    });
    expect(rev1.status).toBe(200);

    const reviews1 = await (await fetch(`${h.baseUrl}/api/v1/reviews`)).json() as { data: Array<{ review: { reviewHandle: string } }> };
    const handle2 = reviews1.data[0]?.review.reviewHandle;
    if (!handle2) throw new Error('missing handle 2');

    const rev2 = await fetch(`${h.baseUrl}/api/v1/reviews/${handle2}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rev-round-2' },
      body: JSON.stringify({
        reviewId: 'rev-r2',
        reviewerId: 'human',
        verdict: 'REQUEST_REVISION',
        summary: 'second revision',
        findings: [{ code: 'FIX2', severity: 'error', message: 'fix 2' }],
        allowNoChangeCompletion: true,
      }),
    });
    expect(rev2.status).toBe(200);

    const reviews2 = await (await fetch(`${h.baseUrl}/api/v1/reviews`)).json() as { data: Array<{ review: { reviewHandle: string } }> };
    const handle3 = reviews2.data[0]?.review.reviewHandle;
    if (!handle3) throw new Error('missing handle 3');

    expect(handle1).not.toBe(handle2);
    expect(handle2).not.toBe(handle3);
    expect(handle1).not.toBe(handle3);
  });

  it('8.6 - 8.7 Negative: idempotency key replay returns same result, distinct key on retired handle fails', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const { firstReview } = await setupStartedPlan(h);
    const firstHandle = firstReview.review.reviewHandle;

    const payload = {
      reviewId: 'rev-idemp',
      reviewerId: 'human',
      verdict: 'REQUEST_REVISION',
      summary: 'idempotent revision',
      findings: [{ code: 'FIX', severity: 'error', message: 'fix' }],
      allowNoChangeCompletion: true,
    };

    const firstCall = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify(payload),
    });
    expect(firstCall.status).toBe(200);
    const body1 = (await firstCall.json()) as { ok: boolean; data: unknown };

    const replayCall = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify(payload),
    });
    expect(replayCall.status).toBe(200);
    const body2 = await replayCall.json() as { ok: boolean; data: unknown };
    expect(body2.ok).toBe(true);
    expect(body2.data).toEqual(body1.data);

    const differentKeyCall = await fetch(`${h.baseUrl}/api/v1/reviews/${firstHandle}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'different-key' },
      body: JSON.stringify(payload),
    });
    expect(differentKeyCall.status).toBe(410);
  });
});
