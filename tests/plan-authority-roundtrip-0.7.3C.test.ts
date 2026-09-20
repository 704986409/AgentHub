import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import { TaskComplexity, TaskRisk } from '../src/core/types.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { Database } from '../src/database/index.js';
import { EventBus, type DomainEvent } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import { AgentProfileManager, AgentRegistry, TaskManager } from '../src/services/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository } from '../src/repositories/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const step = { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [] as string[], requiredSpecialties: [] as string[], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW };

function collectProposed(events: EventBus): DomainEvent[] {
  const proposed: DomainEvent[] = [];
  events.subscribe((event) => { if (event.eventType === 'PlanProposed') proposed.push(event); });
  return proposed;
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-073c-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const proposed = collectProposed(events);
  const projects = new SqliteProjectRepository(db);
  const project = projects.create({ name: 'P' });
  const profiles = new AgentProfileManager({ agentsDirectory: join(dir, 'agents') });
  const agents = new AgentRegistry(new SqliteAgentRepository(db), profiles, events);
  const leadA = agents.createAgent({ name: 'LeadA', provider: 'codex', model: 'm', position: 'Lead', projectId: project.id });
  const leadB = agents.createAgent({ name: 'LeadB', provider: 'codex', model: 'm', position: 'Lead', projectId: project.id });
  const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
  const service = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
  return { dir, path, db, events, proposed, projects, agents, leadA, leadB, project, tasks, service };
}

function reopen(path: string, agentsDirectory: string) {
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const projects = new SqliteProjectRepository(db);
  const agents = new AgentRegistry(new SqliteAgentRepository(db), new AgentProfileManager({ agentsDirectory }), events);
  const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
  const service = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
  return { db, service, events, tasks };
}

function readSnapshot(db: Database): { intakes: unknown[]; plans: unknown[] } {
  const row = db.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as { value: string };
  return JSON.parse(row.value) as { intakes: unknown[]; plans: unknown[] };
}
function writeSnapshot(db: Database, value: unknown): void {
  db.connection.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(value), 'public_lifecycle_snapshot');
}

describe('0.7.3C lifecycle authority round-trip', { timeout: 8_000 }, () => {
  it('rejects same-project Plan lead different from Intake lead', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    expect(() => first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadB.id, summary: 's', tasks: [step], dependencies: [],
    })).toThrow('PLAN_CONFLICT');
    expect(first.service.listIntakes()).toHaveLength(1);
    expect(first.service.listPlans()).toHaveLength(0);
    expect(first.proposed).toHaveLength(0);
    expect(readSnapshot(first.db).plans).toHaveLength(0);
    first.db.close();
  });

  it('HTTP rejects Lead mismatch with conflict', async () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    const app = {
      projects: first.projects, agents: first.agents, agentManagement: {},
      tasks: first.tasks, assignments: {}, assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] }, eventBus: first.events, scheduler: {}, dispatcher: {}, lifecycle: {},
      planLifecycle: first.service, planExecution: { start: () => Promise.resolve({}) },
      buildTestPlan: { commands: [] }, targetBranch: 'main',
    } as unknown as AgentHubApplication;
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;
    try {
      const res = await fetch(`${base}/api/v1/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'wrong-lead' },
        body: JSON.stringify({
          intakeId: intake.intakeId, leadAgentId: first.leadB.id, summary: 's', tasks: [step], dependencies: [],
        }),
      });
      expect(res.status).toBe(409);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('AGENTHUB_API_CONFLICT');
      expect(first.service.listPlans()).toHaveLength(0);
      expect(first.proposed).toHaveLength(0);
      expect(readSnapshot(first.db).plans).toHaveLength(0);
      expect(first.service.listIntakes()).toHaveLength(1);
    } finally {
      await server.stop();
      first.db.close();
    }
  });

  it('does not mutate an existing valid Plan when a later wrong-Lead createPlan is rejected', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    const valid = first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadA.id, summary: 's', tasks: [step], dependencies: [],
    });
    expect(first.proposed).toHaveLength(1);
    expect(() => first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadB.id, summary: 'later', tasks: [step], dependencies: [],
    })).toThrow('PLAN_CONFLICT');
    const remaining = first.service.listPlans();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      planId: valid.planId, leadAgentId: first.leadA.id, currentVersion: 1,
    });
    expect(remaining[0]?.current.proposalHash).toBe(valid.current.proposalHash);
    expect(first.proposed).toHaveLength(1);
    expect(readSnapshot(first.db).plans).toHaveLength(1);
    first.db.close();
  });

  it('valid Plan survives write/restart round-trip', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    const plan = first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadA.id, summary: 's', tasks: [step], dependencies: [],
    });
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    const afterIntake = restored.service.listIntakes()[0];
    const afterPlan = restored.service.getPlan(plan.planId);
    expect(afterIntake?.leadAgentId).toBe(first.leadA.id);
    expect(afterPlan).toMatchObject({
      planId: plan.planId, intakeId: intake.intakeId, projectId: first.project.id,
      leadAgentId: first.leadA.id, currentVersion: 1,
    });
    expect(afterPlan?.leadAgentId).toBe(afterIntake?.leadAgentId);
    expect(afterPlan?.current.proposalHash).toBe(plan.current.proposalHash);
    expect(afterPlan?.decisions).toEqual(plan.decisions);
    restored.db.close();
  });

  it('valid approved Plan survives write/restart round-trip', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    const plan = first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadA.id, summary: 's', tasks: [step], dependencies: [],
    });
    const approved = first.service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    const after = restored.service.getPlan(plan.planId);
    expect(after).toMatchObject({
      planId: plan.planId, leadAgentId: first.leadA.id, currentVersion: 1, state: 'APPROVED',
    });
    expect(after?.current.proposalHash).toBe(approved.current.proposalHash);
    expect(after?.decisions).toHaveLength(1);
    expect(after?.decisions[0]?.decisionId).toBe(approved.decisions[0]?.decisionId);
    restored.db.close();
  });

  it('started/materialized Plan survives restart', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    const plan = first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadA.id, summary: 's', tasks: [step], dependencies: [],
    });
    first.service.decide(plan.planId, 'APPROVE', {
      planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '',
    });
    const definition = first.service.getPlan(plan.planId)?.current.tasks[0];
    if (!definition) throw new Error('fixture');
    const runtimeTaskId = first.service.materializeRuntimeTask(plan.planId, 1, definition);
    const started = first.service.markStarted(plan.planId, 1);
    expect(started.tasks[0]?.runtimeTaskId).toBe(runtimeTaskId);
    first.db.close();
    const restored = reopen(first.path, join(first.dir, 'agents'));
    const after = restored.service.getPlan(plan.planId);
    expect(after).toMatchObject({
      planId: plan.planId, leadAgentId: first.leadA.id, currentVersion: 1, state: 'EXECUTING',
    });
    expect(after?.tasks[0]?.runtimeTaskId).toBe(runtimeTaskId);
    expect(after?.current.proposalHash).toBe(plan.current.proposalHash);
    const row = restored.db.connection.prepare(
      'SELECT runtime_task_id FROM plan_task_materializations WHERE plan_id = ? AND plan_task_id = ?',
    ).get(plan.planId, definition.planTaskId) as { runtime_task_id: string } | undefined;
    expect(row?.runtime_task_id).toBe(runtimeTaskId);
    restored.db.close();
  });

  it('persisted forged Lead mismatch remains fail-closed', () => {
    const first = open();
    const intake = first.service.createIntake({
      projectId: first.project.id, createdBy: 'human', goal: 'goal', leadAgentId: first.leadA.id,
    });
    first.service.createPlan({
      intakeId: intake.intakeId, leadAgentId: first.leadA.id, summary: 's', tasks: [step], dependencies: [],
    });
    const snap = readSnapshot(first.db) as { plans: Array<{ leadAgentId: string; versions: Array<{ leadAgentId: string }> }> };
    const forged = snap.plans[0]; if (!forged) throw new Error('fixture');
    forged.leadAgentId = first.leadB.id;
    for (const version of forged.versions) version.leadAgentId = first.leadB.id;
    writeSnapshot(first.db, snap);
    const restored = reopen(first.path, join(first.dir, 'agents'));
    expect(restored.service.listIntakes()).toEqual([]);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });
});
