import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { EventBus } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import type { TaskReviewBundle } from '../src/orchestration/TaskLifecycleOrchestrator.js';

function publicReviewBundle(taskId: string, salt = 'v1'): TaskReviewBundle {
  const handle = createHash('sha256').update(`review:${taskId}:${salt}`).digest('hex');
  const oid = 'a'.repeat(40);
  return {
    taskId,
    assignmentId: `asg-${taskId}`,
    agentId: 'worker',
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
    },
    buildTestEvidence: {
      build: 'not-run',
      test: 'passed',
      outcome: 'passed',
      commands: [],
      evidenceSha256: 'c'.repeat(64),
    },
  } as unknown as TaskReviewBundle;
}

function harness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  const assignmentMap = new Map<string, { id: string; taskId: string; agentId: string }>();
  let sequence = 0;
  let revisionSalt = 0;
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
      const task = taskMap.get(request.dispatchResult.taskId);
      if (task) task.status = TaskStatus.REVIEWING;
      return Promise.resolve({
        outcome: 'review-ready',
        reviewBundle: publicReviewBundle(request.dispatchResult.taskId, `prep-${String(++revisionSalt)}`),
      });
    } } as never,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: events,
  });
  const lifecycle = {
    applyReview: (request: { reviewBundle: TaskReviewBundle; decision: { verdict: string } }) => {
      const task = taskMap.get(request.reviewBundle.taskId);
      if (request.decision.verdict === 'REQUEST_REVISION') {
        if (task) task.status = TaskStatus.REVIEWING;
        return Promise.resolve({
          outcome: 'review-ready',
          reviewBundle: publicReviewBundle(request.reviewBundle.taskId, `rev-${String(++revisionSalt)}`),
        });
      }
      if (request.decision.verdict === 'BLOCK') {
        if (task) task.status = TaskStatus.BLOCKED;
        return Promise.resolve({
          outcome: 'blocked',
          taskId: request.reviewBundle.taskId,
          assignmentId: request.reviewBundle.assignmentId,
          lifecycleSha256: 'd'.repeat(64),
        });
      }
      if (task) task.status = TaskStatus.COMPLETED;
      return Promise.resolve({
        outcome: 'completed',
        taskId: request.reviewBundle.taskId,
        assignmentId: request.reviewBundle.assignmentId,
        lifecycleSha256: 'e'.repeat(64),
      });
    },
    prepareReview: () => Promise.resolve({ outcome: 'review-ready', reviewBundle: publicReviewBundle('standalone') }),
  };
  const scheduler = {
    scheduleTask: ({ taskId }: { taskId: string }) => ({
      outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: 'worker',
    }),
  };
  const dispatcher = {
    dispatch: () => Promise.resolve({ taskId: 'standalone', assignmentId: 'asg-standalone', agentId: 'worker' }),
  };
  const app = {
    projects: { list: () => [project], findById: (id: string) => id === 'p' ? project : null, create: () => project },
    agents: { listAgents: () => [], getAgent: () => null }, agentManagement: {},
    tasks: {
      ...tasks,
      getTask: (id: string) => id === 'standalone'
        ? { id: 'standalone', status: TaskStatus.CREATED }
        : tasks.getTask(id),
    },
    assignments: {}, assignmentQueries: { list: () => [...assignmentMap.values()], findById: (id: string) => assignmentMap.get(id) ?? null },
    events: { list: () => [] }, eventBus: events, scheduler, dispatcher, lifecycle,
    planLifecycle: service, planExecution: coordinator, buildTestPlan: { commands: [] }, targetBranch: 'main',
  } as unknown as AgentHubApplication;
  return { app, service, taskMap };
}

const acceptBody = {
  reviewId: 'review-1',
  reviewerId: 'human',
  verdict: 'ACCEPT',
  summary: 'accepted',
  findings: [],
  allowNoChangeCompletion: true,
};
const revisionBody = {
  reviewId: 'review-2',
  reviewerId: 'human',
  verdict: 'REQUEST_REVISION',
  summary: 'revise',
  findings: [],
  allowNoChangeCompletion: true,
};
const blockBody = {
  reviewId: 'review-3',
  reviewerId: 'human',
  verdict: 'BLOCK',
  summary: 'blocked',
  findings: [{ code: 'stop', severity: 'blocker', message: 'blocked' }],
  allowNoChangeCompletion: true,
};

function requireHandle(value: string | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('missing reviewHandle');
  return value;
}

async function post(base: string, path: string, body: unknown, key: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

describe('0.7.3E lifecycle review roundtrip', { timeout: 8_000 }, () => {
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

  it('5. ACCEPT removes the review and 6. REQUEST_REVISION rotates the handle', async () => {
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
    }, 'start-rev');
    const first = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<{ review: { reviewHandle: string } }> };
    const oldHandle = requireHandle(first.data[0]?.review.reviewHandle);
    const revised = await post(base, `/api/v1/reviews/${oldHandle}/decision`, revisionBody, 'rev-1');
    expect(revised.status).toBe(200);
    const afterRevision = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<{ review: { reviewHandle: string } }> };
    expect(afterRevision.data).toHaveLength(1);
    expect(afterRevision.data[0]?.review.reviewHandle).not.toBe(oldHandle);
    const expired = await post(base, `/api/v1/reviews/${oldHandle}/decision`, acceptBody, 'old-expired');
    expect(expired.status).toBe(410);

    const nextHandle = requireHandle(afterRevision.data[0]?.review.reviewHandle);
    const accepted = await post(base, `/api/v1/reviews/${nextHandle}/decision`, acceptBody, 'accept-1');
    expect(accepted.status).toBe(200);
    const afterAccept = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: unknown[] };
    expect(afterAccept.data).toHaveLength(0);
  });

  it('7. BLOCK does not unlock dependents', async () => {
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
      dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }],
    });
    const approved = service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    await post(base, `/api/v1/plans/${approved.planId}/start`, {
      planVersion: 1, proposalHash: approved.current.proposalHash,
    }, 'start-block');
    const reviews = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: Array<{ review: { reviewHandle: string } }> };
    const blocked = await post(base, `/api/v1/reviews/${requireHandle(reviews.data[0]?.review.reviewHandle)}/decision`, blockBody, 'block-1');
    expect(blocked.status).toBe(200);
    const state = await (await fetch(`${base}/api/v1/state`)).json() as {
      data: { planTasks: Array<{ title: string; runtimeState: string; dependencyState: string }> };
    };
    const dependent = state.data.planTasks.find((task) => task.title === 'B');
    expect(dependent?.dependencyState).toBe('BLOCKED');
    expect(dependent?.runtimeState).toBe('BLOCKED');
    const remaining = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: unknown[] };
    expect(remaining.data).toHaveLength(0);
  });

  it('13. standalone execute reviews still register without polluting lifecycle /reviews', async () => {
    const { app } = harness();
    const base = await listen(app);
    const executed = await post(base, '/api/v1/tasks/standalone/execute', { baseRef: 'main', prompt: 'do work' }, 'exec-1');
    expect(executed.status).toBe(200);
    const body = await executed.json() as { data: { outcome: string; reviewHandle: string } };
    expect(body.data.outcome).toBe('review-ready');
    expect(body.data.reviewHandle).toMatch(/^[0-9a-f]{64}$/u);
    const reviews = await (await fetch(`${base}/api/v1/reviews`)).json() as { data: unknown[] };
    expect(reviews.data).toHaveLength(0);
  });
});
