import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskComplexity, TaskRisk } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';
import { AgentProfileManager, AgentRegistry, TaskManager } from '../src/services/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository } from '../src/repositories/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const step = { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW };

function open(options?: { secondProject?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-073b-auth-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const projects = new SqliteProjectRepository(db);
  const projectA = projects.create({ name: 'A' });
  const projectB = options?.secondProject ? projects.create({ name: 'B' }) : undefined;
  const profiles = new AgentProfileManager({ agentsDirectory: join(dir, 'agents') });
  const agents = new AgentRegistry(new SqliteAgentRepository(db), profiles, events);
  const lead = agents.createAgent({ name: 'Lead', provider: 'codex', model: 'm', position: 'Lead', projectId: projectA.id });
  const otherLead = options?.secondProject && projectB
    ? agents.createAgent({ name: 'Other', provider: 'codex', model: 'm', position: 'Lead', projectId: projectB.id })
    : undefined;
  const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
  const service = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
  return { dir, path, db, events, projects, agents, lead, otherLead, projectA, projectB, tasks, service };
}

function restore(path: string, projects: SqliteProjectRepository, agents: AgentRegistry, tasks: TaskManager) {
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const service = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
  return { db, service, events };
}

function readSnapshot(db: Database): Record<string, unknown> {
  const row = db.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}
function writeSnapshot(db: Database, value: unknown): void {
  db.connection.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(value), 'public_lifecycle_snapshot');
}

describe('0.7.3B persistence authority validation', { timeout: 8_000 }, () => {
  it('rejects Intake lead/project mismatch', () => {
    const first = open({ secondProject: true });
    first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    const snap = readSnapshot(first.db) as { intakes: Array<{ projectId: string }> };
    const intake = snap.intakes[0]; if (!intake || !first.projectB) throw new Error('fixture');
    intake.projectId = first.projectB.id;
    writeSnapshot(first.db, snap);
    const restored = restore(first.path, first.projects, first.agents, first.tasks);
    expect(restored.service.listIntakes()).toEqual([]);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });

  it('rejects Plan project != Intake project', () => {
    const first = open({ secondProject: true });
    const intake = first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: first.lead.id, summary: 's', tasks: [step], dependencies: [] });
    const snap = readSnapshot(first.db) as { plans: Array<{ projectId: string }> };
    const plan = snap.plans[0]; if (!plan || !first.projectB) throw new Error('fixture');
    plan.projectId = first.projectB.id;
    writeSnapshot(first.db, snap);
    const restored = restore(first.path, first.projects, first.agents, first.tasks);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });

  it('rejects Plan lead != Intake lead', () => {
    const first = open({ secondProject: true });
    const intake = first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: first.lead.id, summary: 's', tasks: [step], dependencies: [] });
    const sameProjectLead = first.agents.createAgent({ name: 'Lead2', provider: 'codex', model: 'm', position: 'Lead', projectId: first.projectA.id });
    const snap = readSnapshot(first.db) as { plans: Array<{ leadAgentId: string; versions: Array<{ leadAgentId: string }> }> };
    const plan = snap.plans[0]; if (!plan) throw new Error('fixture');
    plan.leadAgentId = sameProjectLead.id;
    for (const version of plan.versions) version.leadAgentId = sameProjectLead.id;
    writeSnapshot(first.db, snap);
    const restored = restore(first.path, first.projects, first.agents, first.tasks);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });

  it('rejects Plan lead that belongs to the wrong project', () => {
    const first = open({ secondProject: true });
    const intake = first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: first.lead.id, summary: 's', tasks: [step], dependencies: [] });
    first.db.close();
    const db = new Database(first.path); db.initialize();
    const events = new EventBus();
    const projects = new SqliteProjectRepository(db);
    const agents = {
      getAgent: (id: string) => id === first.lead.id ? { id, projectId: first.projectB?.id } : null,
    };
    const tasks = new TaskManager(new SqliteTaskRepository(db));
    const restored = new PlanLifecycleService(projects, agents as never, events, db, tasks, new SqliteAssignmentRepository(db));
    expect(restored.listIntakes()).toEqual([]);
    expect(restored.listPlans()).toEqual([]);
    db.close();
  });

  it('rejects a missing project after snapshot', () => {
    const first = open();
    first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    first.db.close();
    const db = new Database(first.path); db.initialize();
    const restored = new PlanLifecycleService(
      { findById: () => null } as never,
      { getAgent: (id: string) => id === first.lead.id ? { id, projectId: first.projectA.id } : null } as never,
      new EventBus(), db, { getTask: () => null } as never, new SqliteAssignmentRepository(db),
    );
    expect(restored.listIntakes()).toEqual([]);
    expect(restored.listPlans()).toEqual([]);
    db.close();
  });

  it('upgrades a valid 0.7.3A snapshot without rematerializing', () => {
    const first = open();
    const intake = first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    const plan = first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: first.lead.id, summary: 's', tasks: [step], dependencies: [] });
    first.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
    const planTaskId = plan.tasks[0]?.planTaskId; if (!planTaskId) throw new Error('fixture');
    const runtime = first.tasks.createTask({ projectId: first.projectA.id, title: 'A', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    first.service.linkRuntimeTask(plan.planId, 1, planTaskId, runtime.id);
    first.service.markStarted(plan.planId, 1);
    first.db.connection.prepare('UPDATE tasks SET origin_plan_id = NULL, origin_plan_version = NULL, origin_plan_task_id = NULL WHERE id = ?').run(runtime.id);
    first.db.connection.prepare('DELETE FROM plan_task_materializations').run();
    const before = first.service.getPlan(plan.planId);
    first.db.close();

    const db = new Database(first.path); db.initialize();
    const events = new EventBus();
    const projects = new SqliteProjectRepository(db);
    const agents = new AgentRegistry(new SqliteAgentRepository(db), new AgentProfileManager({ agentsDirectory: join(first.dir, 'agents') }), events);
    const tasks = new TaskManager(new SqliteTaskRepository(db), undefined, events);
    const restored = new PlanLifecycleService(projects, agents, events, db, tasks, new SqliteAssignmentRepository(db));
    const after = restored.getPlan(plan.planId);
    expect(after).toMatchObject({ planId: plan.planId, currentVersion: 1 });
    expect(after?.tasks[0]?.runtimeTaskId).toBe(runtime.id);
    expect(after?.decisions).toHaveLength(before?.decisions.length ?? 0);
    expect(tasks.listTasks()).toHaveLength(1);
    expect(tasks.getTask(runtime.id)?.originPlanId).toBe(plan.planId);
    const row = db.connection.prepare('SELECT runtime_task_id FROM plan_task_materializations WHERE plan_id = ? AND plan_task_id = ?')
      .get(plan.planId, planTaskId) as { runtime_task_id: string } | undefined;
    expect(row?.runtime_task_id).toBe(runtime.id);
    db.close();
  });

  it('does not restore a non-boolean reviewPending flag', () => {
    const first = open();
    const intake = first.service.createIntake({ projectId: first.projectA.id, createdBy: 'human', goal: 'goal', leadAgentId: first.lead.id });
    const plan = first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: first.lead.id, summary: 's', tasks: [step], dependencies: [] });
    first.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
    const planTaskId = plan.tasks[0]?.planTaskId; if (!planTaskId) throw new Error('fixture');
    const runtime = first.tasks.createTask({ projectId: first.projectA.id, title: 'A', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    first.service.linkRuntimeTask(plan.planId, 1, planTaskId, runtime.id);
    const snap = readSnapshot(first.db) as { plans: Array<{ runtimeLinks: Array<{ reviewPending: unknown }> }> };
    const link = snap.plans[0]?.runtimeLinks[0]; if (!link) throw new Error('fixture');
    link.reviewPending = 'yes';
    writeSnapshot(first.db, snap);
    const restored = restore(first.path, first.projects, first.agents, first.tasks);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });
});
