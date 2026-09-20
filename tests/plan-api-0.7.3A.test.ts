import { describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { snapshotCreateIntake, snapshotCreatePlan, snapshotCreatePlanRevision, snapshotPlanDecision, snapshotPlanStart } from '../src/api/ApiDtos.js';
import { ApiError } from '../src/api/ApiErrors.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskStatus } from '../src/core/types.js';
import { EventBus } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';

const hash = 'a'.repeat(64);
const validTask = { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [], requiredSpecialties: [], complexity: 'SIMPLE', risk: 'LOW' };

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow(ApiError);
  try { run(); } catch (error) {
    expect(error).toMatchObject({ code: 'AGENTHUB_API_INVALID_REQUEST', status: 400 });
  }
}

function harness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const events = new EventBus();
  const tasks = {
    listTasks: () => [...taskMap.values()],
    getTask: (id: string) => taskMap.get(id) ?? null,
    createTask: (input: Record<string, unknown>) => {
      const id = `task-${String(++sequence)}`;
      const value = { id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null,
        createdAt: 't', updatedAt: 't', requiredCapabilities: input.requiredCapabilities ?? [], requiredSpecialties: input.requiredSpecialties ?? [],
        acceptanceCriteria: input.acceptanceCriteria ?? [], complexity: input.complexity, risk: input.risk, projectId: input.projectId, title: input.title, description: input.description ?? null };
      taskMap.set(id, value); return value;
    },
  };
  const project = { id: 'p', name: 'P', description: null, createdAt: 't', updatedAt: 't' };
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? project : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, undefined, tasks as never, { findById: () => null } as never,
  );
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: service, tasks: tasks as never,
    scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => ({ outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: 'worker' }) } as never,
    dispatcher: { dispatch: () => Promise.resolve({}) } as never,
    taskLifecycle: { prepareReview: () => Promise.resolve({ outcome: 'review-ready', reviewBundle: { taskId: 'task-1', reviewBundleSha256: 'e'.repeat(64) } }) } as never,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: events,
  });
  const app = {
    projects: { list: () => [project], findById: (id: string) => id === 'p' ? project : null, create: () => project },
    agents: { listAgents: () => [], getAgent: () => null }, agentManagement: {},
    tasks, assignments: {}, assignmentQueries: { list: () => [], findById: () => null },
    events: { list: () => [] }, eventBus: events, scheduler: {}, dispatcher: {}, lifecycle: {},
    planLifecycle: service, planExecution: coordinator, buildTestPlan: { commands: [] }, targetBranch: 'main',
  } as unknown as AgentHubApplication;
  return { app, service };
}

async function post(base: string, path: string, body: unknown, key: string) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
}

describe('0.7.3A lifecycle HTTP snapshots', { timeout: 8_000 }, () => {
  it('rejects malformed lifecycle mutation bodies with deterministic 400', () => {
    expectInvalid(() => snapshotCreateIntake({ projectId: 'p', createdBy: 'human', goal: 'g', leadAgentId: 'lead', extra: true }));
    expectInvalid(() => snapshotCreateIntake({ projectId: null, createdBy: 'human', goal: 'g', leadAgentId: 'lead' }));
    expectInvalid(() => snapshotCreateIntake({ projectId: '   ', createdBy: 'human', goal: 'g', leadAgentId: 'lead' }));
    expectInvalid(() => snapshotCreateIntake({ projectId: `p\0`, createdBy: 'human', goal: 'g', leadAgentId: 'lead' }));
    expectInvalid(() => snapshotCreateIntake({ projectId: 'p'.repeat(300), createdBy: 'human', goal: 'g', leadAgentId: 'lead' }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [{ ...validTask, extra: 1 }], dependencies: [] }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [{ ...validTask, complexity: 'NOPE' }], dependencies: [] }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [{ ...validTask, risk: 1 }], dependencies: [] }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [{}], dependencies: [] }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: Array.from({ length: 1001 }, (_, i) => ({ ...validTask, clientId: `c${String(i)}` })), dependencies: [] }));
    expectInvalid(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [validTask], dependencies: Array.from({ length: 4001 }, () => ({ prerequisiteClientId: 'a', dependentClientId: 'a' })) }));
    expectInvalid(() => snapshotCreatePlanRevision({ basedOnVersion: 0, leadAgentId: 'lead', summary: 's', tasks: [validTask], dependencies: [] }));
    expectInvalid(() => snapshotPlanDecision({ planVersion: '1', proposalHash: hash, actorId: 'human', summary: '' }));
    expectInvalid(() => snapshotPlanDecision({ planVersion: 1, proposalHash: hash, actorId: 'human', summary: '', decisionId: 'client-supplied' }));
    expectInvalid(() => snapshotPlanDecision({ planVersion: 1, proposalHash: 'nope', actorId: 'human', summary: '' }));
    expectInvalid(() => snapshotPlanStart({ planVersion: 1, proposalHash: hash, extra: true }));
    expectInvalid(() => snapshotPlanStart({ planVersion: 1.5, proposalHash: hash }));
  });

  it('serves health 0.7.3C and lifecycle routes with decisionId distinct from Idempotency-Key', async () => {
    const { app, service } = harness();
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start(); const base = `http://${address.host}:${String(address.port)}`;
    try {
      const health = await (await fetch(`${base}/api/v1/health`)).json() as { data: { version: string } };
      expect(health.data.version).toBe('0.7.3C');
      const intakeRes = await post(base, '/api/v1/intakes', { projectId: 'p', createdBy: 'human', goal: 'ship', leadAgentId: 'lead' }, 'intake-1');
      expect(intakeRes.status).toBe(201);
      const intake = (await intakeRes.json() as { data: { intakeId: string } }).data;
      const unknown = await post(base, '/api/v1/plans', { intakeId: intake.intakeId, leadAgentId: 'lead', summary: 's', tasks: [validTask], dependencies: [], extra: true }, 'plan-extra');
      expect(unknown.status).toBe(400);
      expect((await unknown.json() as { error: { code: string } }).error.code).toBe('AGENTHUB_API_INVALID_REQUEST');
      const duplicate = await post(base, '/api/v1/plans', { intakeId: intake.intakeId, leadAgentId: 'lead', summary: 's', tasks: [validTask, { ...validTask, title: 'B' }], dependencies: [] }, 'plan-dup');
      expect(duplicate.status).toBe(400);
      const created = await post(base, '/api/v1/plans', { intakeId: intake.intakeId, leadAgentId: 'lead', summary: 's', tasks: [validTask], dependencies: [] }, 'plan-1');
      expect(created.status).toBe(201);
      const plan = (await created.json() as { data: { planId: string; current: { proposalHash: string } } }).data;
      const decisionBody = { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: 'ok' };
      const approved = await post(base, `/api/v1/plans/${plan.planId}/approve`, decisionBody, 'approve-1');
      expect(approved.status).toBe(200);
      const approvedJson = await approved.json() as { data: { state: string; decisions: Array<{ decisionId: string }> } };
      expect(approvedJson.data.state).toBe('APPROVED');
      expect(approvedJson.data.decisions.at(-1)?.decisionId).not.toBe('approve-1');
      const replay = await post(base, `/api/v1/plans/${plan.planId}/approve`, decisionBody, 'approve-1');
      expect(replay.status).toBe(200);
      expect((await replay.json() as { data: { decisions: Array<{ decisionId: string }> } }).data.decisions.at(-1)?.decisionId).toBe(approvedJson.data.decisions.at(-1)?.decisionId);
      const otherKey = await post(base, `/api/v1/plans/${plan.planId}/approve`, decisionBody, 'approve-2');
      expect(otherKey.status).toBe(409);
      const started = await post(base, `/api/v1/plans/${plan.planId}/start`, { planVersion: 1, proposalHash: plan.current.proposalHash }, 'start-1');
      expect(started.status).toBe(200);
      const startedJson = await started.json() as { data: { tasks: Array<{ runtimeTaskId: string | null }>; state: string } };
      expect(startedJson.data.tasks[0]?.runtimeTaskId).toBeTruthy();
      const state = await (await fetch(`${base}/api/v1/state`)).json() as { data: { plans: unknown[]; planTasks: unknown[]; intakes: unknown[] } };
      expect(state.data.intakes).toHaveLength(1);
      expect(state.data.plans).toHaveLength(1);
      expect(state.data.planTasks).toHaveLength(1);
      expect(service.getPlan(plan.planId)?.tasks[0]?.runtimeTaskId).toBe(startedJson.data.tasks[0]?.runtimeTaskId);
    } finally { await server.stop(); }
  });
});
