import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService, type CreatePlanTaskInput, type PlanDto } from '../src/lifecycle/plan-lifecycle.js';
import {
  AgentAuthority,
  AgentHubHttpServer,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentStatus,
  AssignmentManager,
  Database,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskManager,
  TaskRouter,
  TaskStateMachine,
  type Agent,
  type AgentHubApplication,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type Task,
  type TaskRouteRejectReason,
} from '../src/index.js';

const router = new TaskRouter();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-A', projectId: 'PROJECT-A', title: 'ignored', description: null,
    requiredCapabilities: [], requiredSpecialties: [], acceptanceCriteria: [], status: TaskStatus.CREATED,
    complexity: TaskComplexity.MEDIUM, risk: TaskRisk.MEDIUM, assignedAgentId: null, assignmentId: null,
    originPlanId: null, originPlanVersion: null, originPlanTaskId: null,
    createdAt: 'ignored', updatedAt: 'ignored', ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'AGENT-A', projectId: 'PROJECT-A', name: 'Lead', provider: 'claude', model: 'ignored', position: 'ignored',
    status: AgentStatus.IDLE, allowedComplexities: [TaskComplexity.MEDIUM], allowedRiskLevels: [TaskRisk.MEDIUM],
    capabilities: [], specialties: [], authority: AgentAuthority.STANDARD, routingPriority: 1, enabled: true,
    createdAt: 'ignored', updatedAt: 'ignored', ...overrides,
  };
}

function reasons(plan: ReturnType<TaskRouter['route']>, agentId: string): readonly TaskRouteRejectReason[] {
  return plan.rejected.find((item) => item.agentId === agentId)?.reasons ?? [];
}

describe('lead/worker exclusion router', () => {
  it('B-01 excludes the lead and selects the worker', () => {
    const plan = router.route({
      task: task(),
      agents: [
        agent({ id: 'lead', name: 'E2E02 Lead', routingPriority: 100 }),
        agent({ id: 'worker', name: 'E2E02 Worker', routingPriority: 1 }),
      ],
      providerCapabilities: [
        { providerId: 'claude', outputProtocols: ['worker-result'] },
      ],
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: ['lead'] },
    });
    expect(plan.candidates.map((item) => item.agentId)).toEqual(['worker']);
    expect(reasons(plan, 'lead')).toContain('AGENT_EXCLUDED');
  });

  it('B-02 does not assign the only worker-result agent when that agent is the lead', () => {
    const plan = router.route({
      task: task(),
      agents: [
        agent({ id: 'lead', provider: 'claude' }),
        agent({ id: 'worker', provider: 'codex', name: 'Codex Worker' }),
      ],
      providerCapabilities: [
        { providerId: 'claude', outputProtocols: ['worker-result'] },
        { providerId: 'codex', outputProtocols: ['manager-directive'] },
      ],
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: ['lead'] },
    });
    expect(plan.candidates).toEqual([]);
    expect(reasons(plan, 'lead')).toContain('AGENT_EXCLUDED');
    expect(reasons(plan, 'worker')).toContain('OUTPUT_PROTOCOL_UNSUPPORTED');
    expect(reasons(plan, 'worker')).not.toContain('AGENT_EXCLUDED');
  });

  it('B-04 keeps priority, scope, then agentId ordering after the lead is removed', () => {
    const plan = router.route({
      task: task(),
      agents: [
        agent({ id: 'lead', routingPriority: 99 }),
        agent({ id: 'worker-low', routingPriority: 1, projectId: null }),
        agent({ id: 'worker-high', routingPriority: 9, projectId: 'PROJECT-A' }),
        agent({ id: 'worker-tie-b', routingPriority: 5, projectId: 'PROJECT-A' }),
        agent({ id: 'worker-tie-a', routingPriority: 5, projectId: 'PROJECT-A' }),
      ],
      providerCapabilities: [{ providerId: 'claude', outputProtocols: ['worker-result'] }],
      requirements: { excludedAgentIds: ['lead'] },
    });
    expect(plan.candidates.map((item) => item.agentId)).toEqual([
      'worker-high', 'worker-tie-a', 'worker-tie-b', 'worker-low',
    ]);
  });

  it('B-05 changes routePlanSha256 when the exclusion set changes', () => {
    const base = {
      task: task(),
      agents: [agent({ id: 'lead' }), agent({ id: 'worker' })],
      providerCapabilities: [{ providerId: 'claude', outputProtocols: ['worker-result'] as const }],
    };
    const empty = router.route({ ...base, requirements: { excludedAgentIds: [] } });
    const excluded = router.route({ ...base, requirements: { excludedAgentIds: ['lead'] } });
    expect(empty.routePlanSha256).not.toBe(excluded.routePlanSha256);
  });

  it('B-10 still excludes a lead after both Codex agents can emit worker-result', () => {
    const plan = router.route({
      task: task(),
      agents: [
        agent({ id: 'lead-codex', provider: 'codex', name: 'Lead Codex', routingPriority: 50 }),
        agent({ id: 'worker-codex', provider: 'codex', name: 'Worker Codex', routingPriority: 1 }),
      ],
      providerCapabilities: [{ providerId: 'codex', outputProtocols: ['worker-result', 'manager-directive'] }],
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: ['lead-codex'] },
    });
    expect(plan.candidates.map((item) => item.agentId)).toEqual(['worker-codex']);
    expect(reasons(plan, 'lead-codex')).toEqual(['AGENT_EXCLUDED']);
  });

  it('rejects duplicate or blank exclusion ids', () => {
    const base = {
      task: task(),
      agents: [agent()],
      providerCapabilities: [{ providerId: 'claude', outputProtocols: ['worker-result'] as const }],
    };
    expect(() => router.route({ ...base, requirements: { excludedAgentIds: ['lead', 'lead'] } })).toThrowError(/invalid/i);
    expect(() => router.route({ ...base, requirements: { excludedAgentIds: ['  '] } })).toThrowError(/invalid/i);
  });
});

class MockProvider implements AgentProvider {
  public constructor(public readonly id: string, public readonly capabilities: AgentProviderCapabilities) {}
  public createSession(): AgentProviderSession {
    return {
      providerId: this.id,
      capabilities: this.capabilities,
      started: false,
      active: false,
      sessionId: undefined,
      start: () => Promise.resolve(),
      runTurn: () => Promise.reject(new Error('not used')),
      shutdown: () => Promise.resolve(),
    };
  }
}

const temporaryDirectories: string[] = [];
const openDatabases: Database[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function schedulerHarness(codexProtocols: AgentProviderCapabilities['outputProtocols'] = ['manager-directive']) {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-lead-exclusion-'));
  temporaryDirectories.push(root);
  const database = new Database(join(root, 'test.db'));
  database.initialize();
  openDatabases.push(database);
  const eventBus = new EventBus();
  const agents = new AgentRegistry(new SqliteAgentRepository(database), new AgentProfileManager({ agentsDirectory: join(root, 'agents') }), eventBus);
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), eventBus);
  const assignments = new AssignmentManager(new SqliteAssignmentRepository(database), tasks, agents, (id) => agents.calculateProfileHash(id), eventBus);
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(new MockProvider('codex', { outputProtocols: codexProtocols, sessionContinuation: false }));
  providerFactory.register(new MockProvider('claude', { outputProtocols: ['worker-result'], sessionContinuation: true }));
  const pool = new AgentPool({ providerFactory, eventBus });
  const scheduler = new AgentScheduler({ taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments });
  const project = new SqliteProjectRepository(database).create({ name: 'Project' });
  return { agents, tasks, assignments, pool, scheduler, projectId: project.id };
}

function register(harness: ReturnType<typeof schedulerHarness>, input: { id: string; name: string; provider: string; routingPriority: number }) {
  const created = harness.agents.createAgent({
    id: input.id,
    projectId: harness.projectId,
    name: input.name,
    provider: input.provider,
    model: 'model',
    authority: AgentAuthority.STANDARD,
    routingPriority: input.routingPriority,
  });
  harness.pool.register({ agentId: created.id, providerId: input.provider, projectId: harness.projectId });
  return created;
}

describe('lead/worker exclusion scheduler', () => {
  it('B-03 assigns the worker and leaves the lead idle when both support worker-result', () => {
    const harness = schedulerHarness();
    const lead = register(harness, { id: 'lead', name: 'E2E02 Lead', provider: 'claude', routingPriority: 10 });
    const worker = register(harness, { id: 'worker', name: 'E2E02 Worker', provider: 'claude', routingPriority: 1 });
    const created = harness.tasks.createTask({ projectId: harness.projectId, title: 'runtime', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const result = harness.scheduler.scheduleTask({
      taskId: created.id,
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: [lead.id] },
    });
    expect(result.outcome).toBe('reserved');
    if (result.outcome !== 'reserved') return;
    expect(result.agentId).toBe(worker.id);
    expect(harness.agents.getAgent(lead.id)?.status).toBe(AgentStatus.IDLE);
    expect(harness.tasks.getTask(created.id)?.assignedAgentId).toBe(worker.id);
    expect(harness.assignments.getAssignment(result.assignmentId)?.agentId).toBe(worker.id);
  });

  it('B-09 keeps standalone scheduling when no agent is excluded', () => {
    const harness = schedulerHarness();
    const leadNamed = register(harness, { id: 'named-lead', name: 'Lead', provider: 'claude', routingPriority: 1 });
    const created = harness.tasks.createTask({ projectId: harness.projectId, title: 'standalone', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const result = harness.scheduler.scheduleTask({
      taskId: created.id,
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: [] },
    });
    expect(result).toMatchObject({ outcome: 'reserved', agentId: leadNamed.id });
  });

  it('B-10 scheduler still prefers the non-lead Codex agent once Codex can emit worker-result', () => {
    const harness = schedulerHarness(['worker-result']);
    const lead = register(harness, { id: 'lead-codex', name: 'Lead Codex', provider: 'codex', routingPriority: 20 });
    const worker = register(harness, { id: 'worker-codex', name: 'Worker Codex', provider: 'codex', routingPriority: 1 });
    const created = harness.tasks.createTask({ projectId: harness.projectId, title: 'future', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const result = harness.scheduler.scheduleTask({
      taskId: created.id,
      requirements: { requiredOutputProtocols: ['worker-result'], excludedAgentIds: [lead.id] },
    });
    expect(result).toMatchObject({ outcome: 'reserved', agentId: worker.id });
    expect(harness.agents.getAgent(lead.id)?.status).toBe(AgentStatus.IDLE);
    expect(harness.tasks.getTask(created.id)?.assignedAgentId).toBe(worker.id);
  });
});

const step = (clientId: string): CreatePlanTaskInput => ({
  clientId, parentClientId: null, title: clientId, description: `${clientId} work`, acceptanceCriteria: [`${clientId} done`],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
});

function planHarness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const events = new EventBus();
  const tasks = {
    getTask: (id: string) => taskMap.get(id) ?? null,
    createTask: (input: Record<string, unknown>) => {
      const id = `task-${String(++sequence)}`;
      const value = { id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null };
      taskMap.set(id, value);
      return value;
    },
  };
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? { id } : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, undefined, tasks as never, { findById: () => null } as never,
  );
  const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
  const schedules: Array<{ taskId: string; requirements: { excludedAgentIds?: readonly string[]; requiredOutputProtocols?: readonly string[] } }> = [];
  let reserve = false;
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: service,
    tasks: tasks as never,
    scheduler: { scheduleTask: (request: { taskId: string; requirements: { excludedAgentIds?: readonly string[]; requiredOutputProtocols?: readonly string[] } }) => {
      schedules.push(request);
      if (!reserve) return { outcome: 'no-available-agent' };
      return { outcome: 'reserved', taskId: request.taskId, assignmentId: `asg-${request.taskId}`, agentId: 'worker' };
    } } as never,
    dispatcher: { dispatch: (request: { reservation: { taskId: string; assignmentId: string; agentId: string } }) => {
      const task = taskMap.get(request.reservation.taskId);
      if (task) {
        task.status = TaskStatus.IMPLEMENTING;
        task.assignedAgentId = request.reservation.agentId;
        task.assignmentId = request.reservation.assignmentId;
      }
      return Promise.resolve(request.reservation);
    } } as never,
    taskLifecycle: { prepareReview: () => Promise.resolve({ outcome: 'blocked' }) } as never,
    targetBranch: 'main',
    buildTestPlan: { commands: [] },
    eventBus: events,
  });
  return { service, intake, coordinator, schedules, taskMap, setReserve: (value: boolean) => { reserve = value; } };
}

function approved(h: ReturnType<typeof planHarness>, tasks: CreatePlanTaskInput[]): PlanDto {
  const plan = h.service.createPlan({ intakeId: h.intake.intakeId, leadAgentId: 'lead', summary: 'run', tasks, dependencies: [] });
  return h.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
}

describe('lead/worker exclusion plan lifecycle', () => {
  it('B-06 B-07 B-08 start, resume, and afterReview all exclude the plan lead', async () => {
    const h = planHarness();
    const plan = approved(h, [step('a'), step('b')]);
    await h.coordinator.start(plan.planId, { planVersion: 1, proposalHash: plan.current.proposalHash });
    expect(h.schedules.length).toBeGreaterThan(0);
    for (const call of h.schedules) expect(call.requirements.excludedAgentIds).toEqual(['lead']);
    const afterStart = h.schedules.length;
    await h.coordinator.resume(plan.planId);
    expect(h.schedules.length).toBeGreaterThan(afterStart);
    for (const call of h.schedules) expect(call.requirements.excludedAgentIds).toEqual(['lead']);
    h.setReserve(true);
    const runtimeTaskId = h.service.getPlan(plan.planId)?.tasks.find((item) => item.runtimeTaskId)?.runtimeTaskId;
    expect(runtimeTaskId).toBeTruthy();
    await h.coordinator.afterReview(runtimeTaskId ?? '');
    const reserved = h.schedules.filter((call) => call.requirements.excludedAgentIds?.[0] === 'lead');
    expect(reserved.length).toBe(h.schedules.length);
    const started = h.service.getPlan(plan.planId);
    expect(started?.tasks.some((item) => item.agentId === 'lead')).toBe(false);
  });
});

describe('lead/worker exclusion execute API', () => {
  it('B-09 standalone execute still reaches the scheduler', async () => {
    let scheduled = false;
    const app = {
      tasks: { getTask: () => ({ id: 'standalone' }), listTasks: () => [] },
      planLifecycle: { ownsRuntimeTask: () => false, listPlans: () => [], listIntakes: () => [] },
      scheduler: { scheduleTask: () => { scheduled = true; return { outcome: 'no-available-agent' }; } },
      projects: { list: () => [], findById: () => null },
      agents: { listAgents: () => [], getAgent: () => null },
      assignments: { list: () => [] },
      assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] },
      eventBus: new EventBus(),
      buildTestPlan: { commands: [] },
      targetBranch: 'main',
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${String(address.port)}/api/v1/tasks/standalone/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'standalone-1' },
        body: JSON.stringify({ baseRef: 'main', prompt: 'work' }),
      });
      expect(response.status).toBe(409);
      expect(scheduled).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('rejects ordinary execute for a plan-owned runtime task before scheduling', async () => {
    let scheduled = false;
    const app = {
      tasks: { getTask: () => ({ id: 'runtime-1' }), listTasks: () => [] },
      planLifecycle: { ownsRuntimeTask: (id: string) => id === 'runtime-1', listPlans: () => [], listIntakes: () => [] },
      scheduler: { scheduleTask: () => { scheduled = true; return { outcome: 'reserved' }; } },
      projects: { list: () => [], findById: () => null },
      agents: { listAgents: () => [], getAgent: () => null },
      assignments: { list: () => [] },
      assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] },
      eventBus: new EventBus(),
      buildTestPlan: { commands: [] },
      targetBranch: 'main',
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${String(address.port)}/api/v1/tasks/runtime-1/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'owned-1' },
        body: JSON.stringify({ baseRef: 'main', prompt: 'work' }),
      });
      const body = await response.json() as { error: { code: string } };
      expect(response.status).toBe(409);
      expect(body.error.code).toBe('PLAN_OWNED_TASK_REQUIRES_PLAN_LIFECYCLE');
      expect(scheduled).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
