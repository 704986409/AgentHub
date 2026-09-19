import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { PlanLifecycleService, type CreatePlanTaskInput, type PlanDto } from '../src/lifecycle/plan-lifecycle.js';
import { normalizeApiError } from '../src/api/ApiErrors.js';
import { AgentProfileManager, AgentRegistry, TaskManager } from '../src/services/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository } from '../src/repositories/index.js';

const step = (clientId: string, parentClientId: string | null = null): CreatePlanTaskInput => ({
  clientId, parentClientId, title: clientId, description: `${clientId} work`, acceptanceCriteria: [`${clientId} done`],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
});

function memoryHarness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  const assignmentMap = new Map<string, { id: string; taskId: string; agentId: string }>();
  let sequence = 0;
  const events = new EventBus();
  const tasks = {
    getTask: (id: string) => taskMap.get(id) ?? null,
    listTasks: () => [...taskMap.values()],
    findByPlanOrigin: (planId: string, planVersion: number, planTaskId: string) => {
      const matches = [...taskMap.values()].filter((task) =>
        task.originPlanId === planId && task.originPlanVersion === planVersion && task.originPlanTaskId === planTaskId);
      if (matches.length > 1) {
        const error = new Error('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED') as Error & { code: string };
        error.code = 'PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED';
        throw error;
      }
      return matches[0] ?? null;
    },
    bindPlanOrigin: (id: string, planId: string, planVersion: number, planTaskId: string) => {
      const task = taskMap.get(id); if (!task) throw new Error('missing');
      task.originPlanId = planId; task.originPlanVersion = planVersion; task.originPlanTaskId = planTaskId;
      return task;
    },
    createTask: (input: Record<string, unknown>) => {
      const id = `task-${String(++sequence)}`;
      const value = { id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null,
        originPlanId: input.originPlanId ?? null, originPlanVersion: input.originPlanVersion ?? null,
        originPlanTaskId: input.originPlanTaskId ?? null };
      taskMap.set(id, value); return value;
    },
  };
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? { id } : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, undefined, tasks as never, { findById: (id: string) => assignmentMap.get(id) ?? null } as never,
  );
  const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
  return { service, intake, tasks, taskMap, assignmentMap, events };
}

function approve(h: ReturnType<typeof memoryHarness>, tasks: CreatePlanTaskInput[],
  deps: Array<{ prerequisiteClientId: string; dependentClientId: string }>) {
  const plan = h.service.createPlan({ intakeId: h.intake.intakeId, leadAgentId: 'lead', summary: 'run', tasks, dependencies: deps });
  return h.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
}

function startLinked(h: ReturnType<typeof memoryHarness>, deps = true) {
  const approved = approve(h, [step('a'), step('b')], deps ? [{ prerequisiteClientId: 'a', dependentClientId: 'b' }] : []);
  const a = approved.tasks[0], b = approved.tasks[1]; if (!a || !b) throw new Error('fixture');
  h.taskMap.set('ta', { id: 'ta', status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null,
    originPlanId: null, originPlanVersion: null, originPlanTaskId: null });
  h.taskMap.set('tb', { id: 'tb', status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null,
    originPlanId: null, originPlanVersion: null, originPlanTaskId: null });
  h.service.linkRuntimeTask(approved.planId, 1, a.planTaskId, 'ta');
  h.service.linkRuntimeTask(approved.planId, 1, b.planTaskId, 'tb');
  h.service.markStarted(approved.planId, 1);
  return { planId: approved.planId, a, b };
}

function counts(plan: PlanDto): void {
  const a = plan.aggregate;
  expect(a.pending).toBe(a.blocked + a.eligible);
  expect(a.total).toBe(a.pending + a.running + a.reviewing + a.completed + a.failed);
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sqliteApp() {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-073b-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const projects = new SqliteProjectRepository(db);
  const project = projects.create({ name: 'P' });
  const profiles = new AgentProfileManager({ agentsDirectory: join(dir, 'agents') });
  const agents = new AgentRegistry(new SqliteAgentRepository(db), profiles, events);
  const lead = agents.createAgent({ name: 'Lead', provider: 'codex', model: 'm', position: 'Lead', projectId: project.id });
  const taskRepo = new SqliteTaskRepository(db);
  const tasks = new TaskManager(taskRepo, undefined, events);
  const assignments = new SqliteAssignmentRepository(db);
  const service = new PlanLifecycleService(projects, agents, events, db, tasks, assignments);
  const intake = service.createIntake({ projectId: project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
  return { dir, path, db, events, projects, agents, lead, project, tasks, service, intake };
}

function wrapFailingSettings(db: Database, fail: { remaining: number }): Database {
  const connection = new Proxy(db.connection, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (fail.remaining > 0 && sql.includes('INSERT INTO settings')) {
            fail.remaining -= 1;
            return {
              run: () => {
                const error = new Error('PLAN_INVALID') as Error & { code: string };
                error.code = 'PLAN_INVALID';
                throw error;
              },
              get: stmt.get.bind(stmt),
              all: stmt.all.bind(stmt),
            };
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });
  return { connection } as Database;
}

function runtimeCoordinator(h: ReturnType<typeof memoryHarness>) {
  const calls: string[] = [];
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: h.service, tasks: h.tasks as never,
    scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => {
      calls.push(`schedule:${taskId}`);
      return { outcome: 'reserved', taskId, assignmentId: `asg-${taskId}`, agentId: 'worker' };
    } } as never,
    dispatcher: { dispatch: (request: { reservation: { taskId: string } }) => {
      calls.push(`dispatch:${request.reservation.taskId}`);
      const task = h.taskMap.get(request.reservation.taskId);
      if (task) { task.status = TaskStatus.IMPLEMENTING; task.assignedAgentId = 'worker'; task.assignmentId = `asg-${request.reservation.taskId}`; }
      return Promise.resolve({ taskId: request.reservation.taskId });
    } } as never,
    taskLifecycle: { prepareReview: (request: { dispatchResult: { taskId: string } }) => {
      calls.push(`review:${request.dispatchResult.taskId}`);
      return Promise.resolve({ outcome: 'review-ready', reviewBundle: { taskId: request.dispatchResult.taskId, reviewBundleSha256: 'c'.repeat(64) } });
    } } as never,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events,
  });
  return { coordinator, calls };
}

describe('0.7.3B suspended-state projection', { timeout: 8_000 }, () => {
  const suspended: Array<{ status: TaskStatus; expected: string }> = [
    { status: TaskStatus.BLOCKED, expected: 'BLOCKED' },
    { status: TaskStatus.WAITING_INPUT, expected: 'WAITING_INPUT' },
    { status: TaskStatus.WAITING_DEPENDENCY, expected: 'BLOCKED' },
    { status: TaskStatus.PAUSED, expected: 'PAUSED' },
  ];

  it.each(suspended)('$status is non-terminal and non-schedulable', ({ status, expected }) => {
    const h = memoryHarness();
    const started = startLinked(h);
    const task = h.taskMap.get('ta'); if (!task) throw new Error('missing');
    task.status = status;
    const plan = h.service.refresh(started.planId);
    expect(plan.tasks[0]?.runtimeState).toBe(expected);
    expect(plan.tasks[0]?.runtimeState).not.toBe('FAILED');
    expect(plan.tasks[0]?.runtimeState).not.toBe('ELIGIBLE');
    expect(plan.tasks[1]).toMatchObject({ dependencyState: 'BLOCKED', blockedBy: [started.a.planTaskId] });
    expect(plan.state).toBe('EXECUTING');
    expect(plan.state).not.toBe('FAILED');
    expect(plan.state).not.toBe('COMPLETED');
    expect(h.service.eligibleTasks(started.planId).map((item) => item.planTaskId)).not.toContain(started.a.planTaskId);
    expect(h.service.eligibleTasks(started.planId).map((item) => item.planTaskId)).not.toContain(started.b.planTaskId);
    counts(plan);
  });

  it('keeps FAILED terminal and maps CANCELLED to FAILED', () => {
    const failed = memoryHarness();
    const failedStart = startLinked(failed);
    const failedTask = failed.taskMap.get('ta'); if (!failedTask) throw new Error('missing');
    failedTask.status = TaskStatus.FAILED;
    const failedPlan = failed.service.refresh(failedStart.planId);
    expect(failedPlan.tasks[0]?.runtimeState).toBe('FAILED');
    expect(failedPlan.state).toBe('FAILED');
    expect(failedPlan.tasks[1]).toMatchObject({ dependencyState: 'BLOCKED' });

    const cancelled = memoryHarness();
    const cancelledStart = startLinked(cancelled);
    const cancelledTask = cancelled.taskMap.get('ta'); if (!cancelledTask) throw new Error('missing');
    cancelledTask.status = TaskStatus.CANCELLED;
    const cancelledPlan = cancelled.service.refresh(cancelledStart.planId);
    expect(cancelledPlan.tasks[0]?.runtimeState).toBe('FAILED');
    expect(cancelledPlan.state).toBe('FAILED');
  });

  it('schedules only CREATED/QUEUED work with satisfied dependencies', () => {
    const h = memoryHarness();
    const started = startLinked(h, false);
    expect(h.service.eligibleTasks(started.planId).map((item) => item.runtimeTaskId).sort()).toEqual(['ta', 'tb']);
    const queued = h.taskMap.get('tb'); if (!queued) throw new Error('missing');
    queued.status = TaskStatus.QUEUED;
    expect(h.service.eligibleTasks(started.planId).map((item) => item.runtimeTaskId).sort()).toEqual(['ta', 'tb']);
    const waiting = h.taskMap.get('ta'); if (!waiting) throw new Error('missing');
    waiting.status = TaskStatus.WAITING_INPUT;
    expect(h.service.eligibleTasks(started.planId).map((item) => item.runtimeTaskId)).toEqual(['tb']);
    const blocked = h.taskMap.get('tb'); if (!blocked) throw new Error('missing');
    blocked.status = TaskStatus.BLOCKED;
    expect(h.service.eligibleTasks(started.planId)).toEqual([]);
    blocked.status = TaskStatus.PAUSED;
    expect(h.service.eligibleTasks(started.planId)).toEqual([]);
    blocked.status = TaskStatus.ASSIGNED; blocked.assignedAgentId = 'worker'; blocked.assignmentId = 'asg';
    expect(h.service.eligibleTasks(started.planId)).toEqual([]);
  });

  it('does not follow-up dispatch a suspended prerequisite or its dependent', async () => {
    const h = memoryHarness();
    const { coordinator, calls } = runtimeCoordinator(h);
    const approved = approve(h, [step('a'), step('b')], [{ prerequisiteClientId: 'a', dependentClientId: 'b' }]);
    const started = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    const runtimeTaskId = started.plan.tasks[0]?.runtimeTaskId; if (!runtimeTaskId) throw new Error('fixture');
    const task = h.taskMap.get(runtimeTaskId); if (!task) throw new Error('missing');
    task.status = TaskStatus.WAITING_INPUT;
    calls.length = 0;
    await coordinator.afterReview(runtimeTaskId);
    expect(calls.filter((item) => item.startsWith('schedule:'))).toEqual([]);
    expect(calls.filter((item) => item.startsWith('dispatch:'))).toEqual([]);
    const after = h.service.refresh(approved.planId);
    expect(after.tasks[0]?.runtimeState).toBe('WAITING_INPUT');
    expect(after.tasks[1]?.dependencyState).toBe('BLOCKED');
    expect(after.state).toBe('EXECUTING');
  });
});

describe('0.7.3B materialization uniqueness', { timeout: 8_000 }, () => {
  it('reuses the same runtime Task after create succeeds and link persistence fails', () => {
    const first = sqliteApp();
    const approved = first.service.createPlan({
      intakeId: first.intake.intakeId, leadAgentId: first.lead.id, summary: 'm', tasks: [step('a')], dependencies: [],
    });
    first.service.decide(approved.planId, 'APPROVE', { planVersion: 1, proposalHash: approved.current.proposalHash, actorId: 'human', summary: '' });
    const definition = approved.current.tasks[0]; if (!definition) throw new Error('fixture');
    first.db.close();

    const fail = { remaining: 1 };
    const db = new Database(first.path); db.initialize();
    const wrapped = wrapFailingSettings(db, fail);
    const events = new EventBus();
    const projects = new SqliteProjectRepository(db);
    const agents = new AgentRegistry(new SqliteAgentRepository(db), new AgentProfileManager({ agentsDirectory: join(first.dir, 'agents') }), events);
    const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
    const service = new PlanLifecycleService(projects, agents, events, wrapped, tasks, new SqliteAssignmentRepository(db));
    expect(() => service.materializeRuntimeTask(approved.planId, 1, definition)).toThrow('PLAN_INVALID');
    expect(tasks.listTasks()).toHaveLength(1);
    const original = tasks.listTasks()[0]; if (!original) throw new Error('missing');
    const reused = service.materializeRuntimeTask(approved.planId, 1, definition);
    expect(reused).toBe(original.id);
    expect(tasks.listTasks()).toHaveLength(1);
    db.close();
  });

  it('replays a committed materialization without creating a second Task', () => {
    const app = sqliteApp();
    const approved = app.service.createPlan({
      intakeId: app.intake.intakeId, leadAgentId: app.lead.id, summary: 'm', tasks: [step('a')], dependencies: [],
    });
    app.service.decide(approved.planId, 'APPROVE', { planVersion: 1, proposalHash: approved.current.proposalHash, actorId: 'human', summary: '' });
    const definition = approved.current.tasks[0]; if (!definition) throw new Error('fixture');
    const first = app.service.materializeRuntimeTask(approved.planId, 1, definition);
    const second = app.service.materializeRuntimeTask(approved.planId, 1, definition);
    expect(second).toBe(first);
    expect(app.tasks.listTasks()).toHaveLength(1);
    app.db.close();
  });

  it('fails closed on ambiguous duplicate origin identity and does not create a third Task', () => {
    const h = memoryHarness();
    const approved = approve(h, [step('a')], []);
    const definition = approved.current.tasks[0]; if (!definition) throw new Error('fixture');
    h.taskMap.set('dup-1', { id: 'dup-1', status: TaskStatus.CREATED, originPlanId: approved.planId, originPlanVersion: 1, originPlanTaskId: definition.planTaskId });
    h.taskMap.set('dup-2', { id: 'dup-2', status: TaskStatus.CREATED, originPlanId: approved.planId, originPlanVersion: 1, originPlanTaskId: definition.planTaskId });
    expect(() => h.service.materializeRuntimeTask(approved.planId, 1, definition)).toThrow('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
    expect(h.taskMap.size).toBe(2);
    expect(normalizeApiError(Object.assign(new Error('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED'), { code: 'PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED' }))).toMatchObject({
      code: 'AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED', status: 503,
    });
  });

  it('fails closed when the mapped runtime Task is missing and does not recreate it', () => {
    const h = memoryHarness();
    const approved = approve(h, [step('a')], []);
    const definition = approved.current.tasks[0]; if (!definition) throw new Error('fixture');
    h.service.linkRuntimeTask(approved.planId, 1, definition.planTaskId, 'missing-runtime');
    expect(() => h.service.materializeRuntimeTask(approved.planId, 1, definition)).toThrow('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED');
    expect(h.taskMap.size).toBe(0);
  });

  it('reuses the same runtimeTaskId after process restart', () => {
    const first = sqliteApp();
    const approved = first.service.createPlan({
      intakeId: first.intake.intakeId, leadAgentId: first.lead.id, summary: 'm', tasks: [step('a')], dependencies: [],
    });
    first.service.decide(approved.planId, 'APPROVE', { planVersion: 1, proposalHash: approved.current.proposalHash, actorId: 'human', summary: '' });
    const definition = approved.current.tasks[0]; if (!definition) throw new Error('fixture');
    const runtimeTaskId = first.service.materializeRuntimeTask(approved.planId, 1, definition);
    expect(first.tasks.listTasks()).toHaveLength(1);
    first.db.close();

    const db = new Database(first.path); db.initialize();
    const events = new EventBus();
    const projects = new SqliteProjectRepository(db);
    const agents = new AgentRegistry(new SqliteAgentRepository(db), new AgentProfileManager({ agentsDirectory: join(first.dir, 'agents') }), events);
    const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
    const service = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
    const reused = service.materializeRuntimeTask(approved.planId, 1, definition);
    expect(reused).toBe(runtimeTaskId);
    expect(tasks.listTasks()).toHaveLength(1);
    db.close();
  });
});
