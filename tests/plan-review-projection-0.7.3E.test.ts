import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { EventBus } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import type { TaskReviewBundle } from '../src/orchestration/TaskLifecycleOrchestrator.js';

const PRIVATE_KEYS = ['cwd', 'env', 'environment', 'worktreePath', 'repositoryRoot', 'sessionId', 'profileHash', 'executionProfileSha256'];

function publicReviewBundle(taskId: string, extra: Record<string, unknown> = {}): TaskReviewBundle {
  const handle = createHash('sha256').update(`review:${taskId}:${JSON.stringify(extra)}`).digest('hex');
  const oid = 'a'.repeat(40);
  return {
    taskId,
    assignmentId: typeof extra.assignmentId === 'string' ? extra.assignmentId : `asg-${taskId}`,
    agentId: typeof extra.agentId === 'string' ? extra.agentId : 'worker',
    providerId: 'fake',
    reviewBundleSha256: handle,
    workerResult: { summary: 'done', blockers: [], questions: [], risks: [], notes: [] },
    source: {
      branchName: `agenthub/${taskId}`,
      baseCommit: oid,
      headCommit: oid,
      changedPaths: [],
      changeSetSha256: 'b'.repeat(64),
      committed: { patch: { status: 'empty' } },
      cwd: 'C:/secret-cwd',
      env: { TOKEN: 'secret' },
      worktreePath: 'C:/repo/wt',
      repositoryRoot: 'C:/repo',
    },
    buildTestEvidence: {
      build: 'not-run',
      test: 'passed',
      outcome: 'passed',
      commands: [],
      evidenceSha256: 'c'.repeat(64),
    },
    ...extra,
  } as unknown as TaskReviewBundle;
}

function harness(prepare: (taskId: string) => TaskReviewBundle = (taskId) => publicReviewBundle(taskId)) {
  const taskMap = new Map<string, Record<string, unknown>>();
  const assignmentMap = new Map<string, { id: string; taskId: string; agentId: string }>();
  let sequence = 0;
  const events = new EventBus();
  const tasks = {
    listTasks: () => [...taskMap.values()],
    getTask: (id: string) => taskMap.get(id) ?? null,
    createTask: (input: Record<string, unknown>) => {
      const id = `task-${String(++sequence)}`;
      const value = {
        id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null,
        createdAt: 't', updatedAt: 't',
        requiredCapabilities: input.requiredCapabilities ?? [],
        requiredSpecialties: input.requiredSpecialties ?? [],
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        complexity: input.complexity, risk: input.risk, projectId: input.projectId,
        title: input.title, description: input.description ?? null,
      };
      taskMap.set(id, value); return value;
    },
  };
  const project = { id: 'p', name: 'P', description: null, createdAt: 't', updatedAt: 't' };
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? project : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, undefined, tasks as never, { findById: (id: string) => assignmentMap.get(id) ?? null } as never,
  );
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: service, tasks: tasks as never,
    scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => ({
      outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: 'worker',
    }) } as never,
    dispatcher: { dispatch: (request: { reservation: { taskId: string; assignmentId: string; agentId: string } }) => {
      const task = taskMap.get(request.reservation.taskId);
      if (task) {
        task.status = TaskStatus.IMPLEMENTING;
        task.assignedAgentId = request.reservation.agentId;
        task.assignmentId = request.reservation.assignmentId;
      }
      assignmentMap.set(request.reservation.assignmentId, {
        id: request.reservation.assignmentId, taskId: request.reservation.taskId, agentId: request.reservation.agentId,
      });
      return Promise.resolve({
        taskId: request.reservation.taskId,
        assignmentId: request.reservation.assignmentId,
        agentId: request.reservation.agentId,
      });
    } } as never,
    taskLifecycle: { prepareReview: (request: { dispatchResult: { taskId: string } }) => {
      return Promise.resolve({ outcome: 'review-ready', reviewBundle: prepare(request.dispatchResult.taskId) });
    } } as never,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: events,
  });
  const app = {
    projects: { list: () => [project], findById: (id: string) => id === 'p' ? project : null, create: () => project },
    agents: { listAgents: () => [], getAgent: () => null }, agentManagement: {},
    tasks, assignments: {}, assignmentQueries: { list: () => [...assignmentMap.values()], findById: (id: string) => assignmentMap.get(id) ?? null },
    events: { list: () => [] }, eventBus: events, scheduler: {}, dispatcher: {}, lifecycle: {},
    planLifecycle: service, planExecution: coordinator, buildTestPlan: { commands: [] }, targetBranch: 'main',
  } as unknown as AgentHubApplication;
  return { app, service, taskMap };
}

async function post(base: string, path: string, body: unknown, key: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

describe('0.7.3E lifecycle review projection', { timeout: 8_000 }, () => {
  const servers: AgentHubHttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function listen(app: AgentHubApplication): Promise<string> {
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    servers.push(server);
    const address = await server.start();
    return `http://${address.host}:${String(address.port)}`;
  }

  it('1-2. start review-ready appears on GET /reviews with the store handle', async () => {
    const { app, service } = harness();
    const base = await listen(app);
    const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'g', leadAgentId: 'lead' });
    const plan = service.createPlan({
      intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'run',
      tasks: [{ clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
        requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW }],
      dependencies: [],
    });
    const approved = service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const started = await post(base, `/api/v1/plans/${approved.planId}/start`, {
      planVersion: 1, proposalHash: approved.current.proposalHash,
    }, 'start-a');
    expect(started.status).toBe(200);
    const reviews = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<Record<string, unknown>> };
    expect(reviews.data).toHaveLength(1);
    const item = reviews.data[0] as { runtimeTaskId: string; review: { reviewHandle: string; reviewBundleSha256: string; taskId: string } };
    expect(item.review.reviewHandle).toMatch(/^[0-9a-f]{64}$/u);
    expect(item.review.reviewHandle).toBe(item.review.reviewBundleSha256);
    expect(item.review.taskId).toBe(item.runtimeTaskId);
  });

  it('3. non-review-ready tasks are omitted from GET /reviews', async () => {
    const { app, service } = harness((taskId) => publicReviewBundle(taskId));
    const base = await listen(app);
    const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'g', leadAgentId: 'lead' });
    const plan = service.createPlan({
      intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'run',
      tasks: [
        { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
        { clientId: 'b', parentClientId: null, title: 'B', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
      ],
      dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }],
    });
    const approved = service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    await post(base, `/api/v1/plans/${approved.planId}/start`, {
      planVersion: 1, proposalHash: approved.current.proposalHash,
    }, 'start-dep');
    const state = await (await fetch(`${base}/api/v1/state`)).json() as {
      data: { planTasks: Array<{ title: string; runtimeState: string; runtimeTaskId: string | null }> };
    };
    const reviews = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<{ runtimeTaskId: string }> };
    const blocked = state.data.planTasks.find((task) => task.title === 'B');
    expect(blocked?.runtimeState).toBe('BLOCKED');
    expect(reviews.data).toHaveLength(1);
    expect(reviews.data.some((item) => item.runtimeTaskId === blocked?.runtimeTaskId)).toBe(false);
  });

  it('4. parallel A/B reviews are both returned', async () => {
    const { app, service } = harness();
    const base = await listen(app);
    const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'g', leadAgentId: 'lead' });
    const plan = service.createPlan({
      intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'run',
      tasks: [
        { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
        { clientId: 'b', parentClientId: null, title: 'B', description: null, acceptanceCriteria: ['done'],
          requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW },
      ],
      dependencies: [],
    });
    const approved = service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    await post(base, `/api/v1/plans/${approved.planId}/start`, {
      planVersion: 1, proposalHash: approved.current.proposalHash,
    }, 'start-ab');
    const reviews = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<{ runtimeTaskId: string }> };
    expect(reviews.data).toHaveLength(2);
    expect(new Set(reviews.data.map((item) => item.runtimeTaskId)).size).toBe(2);
  });

  it('11-12-14. public DTO omits private runtime fields and matches /state REVIEWING identity', async () => {
    const { app, service } = harness();
    const base = await listen(app);
    const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'g', leadAgentId: 'lead' });
    const plan = service.createPlan({
      intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'run',
      tasks: [{ clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
        requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW }],
      dependencies: [],
    });
    const approved = service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    await post(base, `/api/v1/plans/${approved.planId}/start`, {
      planVersion: 1, proposalHash: approved.current.proposalHash,
    }, 'start-public');
    const encoded = JSON.stringify(await (await fetch(`${base}/api/v1/reviews`)).json());
    for (const key of PRIVATE_KEYS) expect(encoded.toLowerCase().includes(key.toLowerCase())).toBe(false);
    const [reviews, state] = await Promise.all([
      (await fetch(`${base}/api/v1/reviews`)).json() as Promise<{ data: Array<{ planId: string; planTaskId: string; runtimeTaskId: string }> }>,
      (await fetch(`${base}/api/v1/state`)).json() as Promise<{ data: { planTasks: Array<{ planId: string; planTaskId: string; runtimeTaskId: string | null; runtimeState: string }> } }>,
    ]);
    const reviewing = state.data.planTasks.filter((task) => task.runtimeState === 'REVIEWING');
    expect(reviewing).toHaveLength(1);
    expect(reviews.data[0]?.planId).toBe(reviewing[0]?.planId);
    expect(reviews.data[0]?.planTaskId).toBe(reviewing[0]?.planTaskId);
    expect(reviews.data[0]?.runtimeTaskId).toBe(reviewing[0]?.runtimeTaskId);
  });
});
