import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { createLocalAgentHubApplication } from '../src/application/index.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { AgentAuthority, TaskComplexity, TaskRisk } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus, type DomainEvent } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import {
  AgentManagementError,
  AgentManagementService,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  TaskManager,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
} from '../src/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository } from '../src/repositories/index.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class FakeProvider implements AgentProvider {
  public constructor(public readonly id: string) {}
  public readonly capabilities = capabilities;
  public createSession(): AgentProviderSession {
    throw new Error('0.7.3D tests must not create provider sessions');
  }
}

const step = { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [] as string[], requiredSpecialties: [] as string[], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW };

function createInput(projectId: string, name: string) {
  return {
    projectId, name, providerId: 'codex', modelId: 'm', position: 'Lead',
    allowedComplexities: [TaskComplexity.SIMPLE], allowedRiskLevels: [TaskRisk.LOW],
    capabilities: [] as string[], specialties: [] as string[],
    authority: AgentAuthority.STANDARD, routingPriority: 1, enabled: true,
  };
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-073d-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = new Database(path); db.initialize(); databases.push(db);
  const events = new EventBus();
  const deleted: DomainEvent[] = [];
  events.subscribe((event) => { if (event.eventType === 'AgentDeleted') deleted.push(event); });
  const projects = new SqliteProjectRepository(db);
  const project = projects.create({ name: 'P' });
  const profiles = new AgentProfileManager({ agentsDirectory: join(dir, 'agents') });
  const agents = new AgentRegistry(new SqliteAgentRepository(db), profiles, events);
  const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
  const assignments = new SqliteAssignmentRepository(db);
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(new FakeProvider('codex'));
  const pool = new AgentPool({ providerFactory, eventBus: events });
  const planLifecycle = new PlanLifecycleService(projects, agents, events, db, tasks, assignments);
  const management = new AgentManagementService({
    agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments, tasks, eventBus: events,
    isLifecycleReferenced: (agentId) => planLifecycle.isLeadReferenced(agentId),
  });
  return { dir, path, db, events, deleted, projects, project, agents, tasks, pool, planLifecycle, management };
}

function reopen(path: string, agentsDirectory: string) {
  const db = new Database(path); db.initialize(); databases.push(db);
  const events = new EventBus();
  const projects = new SqliteProjectRepository(db);
  const agents = new AgentRegistry(new SqliteAgentRepository(db), new AgentProfileManager({ agentsDirectory }), events);
  const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
  const assignments = new SqliteAssignmentRepository(db);
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(new FakeProvider('codex'));
  const pool = new AgentPool({ providerFactory, eventBus: events });
  for (const agent of agents.listAgents()) {
    if (providerFactory.has(agent.provider)) {
      pool.register({ agentId: agent.id, ...(agent.projectId === null ? {} : { projectId: agent.projectId }),
        providerId: agent.provider, providerConfig: { model: agent.model } });
    }
  }
  const planLifecycle = new PlanLifecycleService(projects, agents, events, db, tasks, assignments);
  const management = new AgentManagementService({
    agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments, tasks, eventBus: events,
    isLifecycleReferenced: (agentId) => planLifecycle.isLeadReferenced(agentId),
  });
  return { db, events, projects, agents, tasks, pool, planLifecycle, management };
}

function expectConflict(run: () => unknown): void {
  expect(run).toThrow(AgentManagementError);
  try { run(); } catch (error) {
    expect(error).toMatchObject({ code: 'AGENT_DELETE_LIFECYCLE_REFERENCE_CONFLICT' });
  }
}

describe('0.7.3D lifecycle lead reference integrity', { timeout: 8_000 }, () => {
  it('Intake Lead blocks service delete', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    expectConflict(() => first.management.deleteAgent(lead.id));
    expect(first.agents.getAgent(lead.id)?.id).toBe(lead.id);
    expect(first.planLifecycle.listIntakes()).toHaveLength(1);
    expect(first.deleted).toHaveLength(0);
    expect(first.pool.has(lead.id)).toBe(true);
    first.db.close();
  });

  it('HTTP delete returns 409 through real management and lifecycle wiring', async () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    const app = {
      projects: first.projects, agents: first.agents, agentManagement: first.management,
      tasks: first.tasks, assignments: {}, assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] }, eventBus: first.events, scheduler: {}, dispatcher: {}, lifecycle: {},
      planLifecycle: first.planLifecycle, planExecution: { start: () => Promise.resolve({}) },
      buildTestPlan: { commands: [] }, targetBranch: 'main',
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;
    try {
      const res = await fetch(`${base}/api/v1/agents/${lead.id}`, {
        method: 'DELETE', headers: { 'idempotency-key': 'delete-lead' },
      });
      expect(res.status).toBe(409);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('AGENTHUB_API_CONFLICT');
      expect(first.agents.getAgent(lead.id)?.id).toBe(lead.id);
      expect(first.planLifecycle.listIntakes()).toHaveLength(1);
      expect(first.deleted).toHaveLength(0);
      expect(first.pool.has(lead.id)).toBe(true);
    } finally {
      await server.stop();
      first.db.close();
    }
  });

  it('Plan Lead blocks delete and preserves proposalHash', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    const intake = first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    const plan = first.planLifecycle.createPlan({
      intakeId: intake.intakeId, leadAgentId: lead.id, summary: 's', tasks: [step], dependencies: [],
    });
    expectConflict(() => first.management.deleteAgent(lead.id));
    const remaining = first.planLifecycle.getPlan(plan.planId);
    expect(first.agents.getAgent(lead.id)?.id).toBe(lead.id);
    expect(remaining).toMatchObject({ planId: plan.planId, leadAgentId: lead.id });
    expect(remaining?.current.proposalHash).toBe(plan.current.proposalHash);
    expect(first.deleted).toHaveLength(0);
    first.db.close();
  });

  it('denied delete -> restart preserves Intake/Plan', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    const intake = first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    const plan = first.planLifecycle.createPlan({
      intakeId: intake.intakeId, leadAgentId: lead.id, summary: 's', tasks: [step], dependencies: [],
    });
    expectConflict(() => first.management.deleteAgent(lead.id));
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    expect(restored.agents.getAgent(lead.id)?.id).toBe(lead.id);
    expect(restored.planLifecycle.listIntakes()[0]?.leadAgentId).toBe(lead.id);
    const after = restored.planLifecycle.getPlan(plan.planId);
    expect(after).toMatchObject({ planId: plan.planId, leadAgentId: lead.id, currentVersion: 1 });
    expect(after?.current.proposalHash).toBe(plan.current.proposalHash);
    restored.db.close();
  });

  it('approved Plan denied delete -> restart', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    const intake = first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    const plan = first.planLifecycle.createPlan({
      intakeId: intake.intakeId, leadAgentId: lead.id, summary: 's', tasks: [step], dependencies: [],
    });
    const approved = first.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    expectConflict(() => first.management.deleteAgent(lead.id));
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    const after = restored.planLifecycle.getPlan(plan.planId);
    expect(after).toMatchObject({ state: 'APPROVED', leadAgentId: lead.id });
    expect(after?.current.proposalHash).toBe(approved.current.proposalHash);
    expect(after?.decisions[0]?.decisionId).toBe(approved.decisions[0]?.decisionId);
    expect(restored.agents.getAgent(lead.id)?.id).toBe(lead.id);
    restored.db.close();
  });

  it('started/materialized Plan denied delete -> restart', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    const intake = first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    const plan = first.planLifecycle.createPlan({
      intakeId: intake.intakeId, leadAgentId: lead.id, summary: 's', tasks: [step], dependencies: [],
    });
    first.planLifecycle.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const definition = first.planLifecycle.getPlan(plan.planId)?.current.tasks[0];
    if (!definition) throw new Error('fixture');
    const runtimeTaskId = first.planLifecycle.materializeRuntimeTask(plan.planId, 1, definition);
    first.planLifecycle.markStarted(plan.planId, 1);
    expectConflict(() => first.management.deleteAgent(lead.id));
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    const after = restored.planLifecycle.getPlan(plan.planId);
    expect(after).toMatchObject({ leadAgentId: lead.id, state: 'EXECUTING', planId: plan.planId });
    expect(after?.tasks[0]?.runtimeTaskId).toBe(runtimeTaskId);
    expect(after?.current.proposalHash).toBe(plan.current.proposalHash);
    const row = restored.db.connection.prepare(
      'SELECT runtime_task_id FROM plan_task_materializations WHERE plan_id = ? AND plan_task_id = ?',
    ).get(plan.planId, definition.planTaskId) as { runtime_task_id: string } | undefined;
    expect(row?.runtime_task_id).toBe(runtimeTaskId);
    restored.db.close();
  });

  it('unreferenced Agent still deletes', () => {
    const first = open();
    const unused = first.management.createAgent(createInput(first.project.id, 'Unused'));
    expect(first.pool.has(unused.id)).toBe(true);
    const result = first.management.deleteAgent(unused.id);
    expect(result).toEqual({ agentId: unused.id, deleted: true });
    expect(first.agents.getAgent(unused.id)).toBeNull();
    expect(first.pool.has(unused.id)).toBe(false);
    expect(first.deleted).toHaveLength(1);
    first.db.close();
  });

  it('createIntake vs deleteAgent cannot leave a dangling Lead reference', () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    first.planLifecycle.createIntake({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
    expectConflict(() => first.management.deleteAgent(lead.id));
    expect(first.agents.getAgent(lead.id)).not.toBeNull();
    const other = first.management.createAgent(createInput(first.project.id, 'Other'));
    first.management.deleteAgent(other.id);
    expect(() => first.planLifecycle.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'gone', leadAgentId: other.id,
    })).toThrow('PLAN_NOT_FOUND');
    first.db.close();
  });

  it('HTTP createIntake/createPlan vs deleteAgent never persist a deleted Lead', async () => {
    const first = open();
    const lead = first.management.createAgent(createInput(first.project.id, 'LeadA'));
    const app = {
      projects: first.projects, agents: first.agents, agentManagement: first.management,
      tasks: first.tasks, assignments: {}, assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] }, eventBus: first.events, scheduler: {}, dispatcher: {}, lifecycle: {},
      planLifecycle: first.planLifecycle, planExecution: { start: () => Promise.resolve({}) },
      buildTestPlan: { commands: [] }, targetBranch: 'main',
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;
    try {
      const [deleted, intake] = await Promise.all([
        fetch(`${base}/api/v1/agents/${lead.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'del-race' } }),
        fetch(`${base}/api/v1/intakes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'intake-race' },
          body: JSON.stringify({ projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id }),
        }),
      ]);
      const agentMissing = first.agents.getAgent(lead.id) === null;
      const referenced = first.planLifecycle.listIntakes().some((item) => item.leadAgentId === lead.id)
        || first.planLifecycle.listPlans().some((item) => item.leadAgentId === lead.id);
      expect(agentMissing && referenced).toBe(false);
      expect([deleted.status, intake.status].sort()).toEqual(
        agentMissing ? [200, 404].sort() : [201, 409].sort(),
      );

      if (!agentMissing && first.planLifecycle.listIntakes().length === 1) {
        const [planDelete, createdPlan] = await Promise.all([
          fetch(`${base}/api/v1/agents/${lead.id}`, { method: 'DELETE', headers: { 'idempotency-key': 'del-plan-race' } }),
          fetch(`${base}/api/v1/plans`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': 'plan-race' },
            body: JSON.stringify({
              intakeId: first.planLifecycle.listIntakes()[0]?.intakeId, leadAgentId: lead.id,
              summary: 's', tasks: [step], dependencies: [],
            }),
          }),
        ]);
        const stillMissing = first.agents.getAgent(lead.id) === null;
        const planReferenced = first.planLifecycle.listPlans().some((item) => item.leadAgentId === lead.id);
        expect(stillMissing && planReferenced).toBe(false);
        expect(planDelete.status === 200 && createdPlan.status === 201).toBe(false);
      }
    } finally {
      await server.stop();
      first.db.close();
    }
  });
});

describe('0.7.3D production composition wiring', { timeout: 15_000 }, () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('createLocalAgentHubApplication injects PlanLifecycleService into AgentManagementService', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenthub-073d-prod-')); roots.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'AgentHub Test'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: root, windowsHide: true });
    await writeFile(join(root, 'initial.txt'), 'initial\n');
    await execFileAsync('git', ['add', 'initial.txt'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    const owned = await createLocalAgentHubApplication({ repositoryRoot: root, dataDirectory: join(root, 'data') });
    try {
      const app = owned.application;
      const project = app.projects.create({ name: 'P' });
      const lead = app.agentManagement.createAgent({ ...createInput(project.id, 'LeadA'), enabled: false });
      const lifecycle = app.planLifecycle;
      if (!lifecycle) throw new Error('production composition missing planLifecycle');
      lifecycle.createIntake({ projectId: project.id, createdBy: 'human', goal: 'goal', leadAgentId: lead.id });
      expect(lifecycle.isLeadReferenced(lead.id)).toBe(true);
      try {
        app.agentManagement.deleteAgent(lead.id);
        expect.unreachable('expected conflict');
      } catch (error) {
        expect(error).toMatchObject({ code: 'AGENT_DELETE_LIFECYCLE_REFERENCE_CONFLICT' });
      }
      expect(app.agents.getAgent(lead.id)?.id).toBe(lead.id);
    } finally {
      await owned.close();
    }
  });
});
