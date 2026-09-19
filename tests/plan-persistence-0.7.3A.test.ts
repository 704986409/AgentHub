import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { Database } from '../src/database/index.js';
import { EventBus } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const step = { clientId: 'a', parentClientId: null, title: 'A', description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW };
const stepB = { ...step, clientId: 'b', title: 'B' };

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-plan-')); dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const taskMap = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const tasks = {
    getTask: (id: string) => taskMap.get(id) ?? null,
    createTask: (input: Record<string, unknown>) => {
      const id = `task-${String(++sequence)}`;
      const value = { id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null };
      taskMap.set(id, value); return value;
    },
  };
  const projects = { findById: (id: string) => id === 'p' ? { id } : null };
  const agents = { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null };
  const db = new Database(path); db.initialize();
  const events = new EventBus();
  const service = new PlanLifecycleService(projects as never, agents as never, events, db, tasks as never);
  return { path, db, service, tasks, taskMap, projects, agents, events };
}

function restore(path: string, tasks: { getTask: (id: string) => unknown }, events = new EventBus()) {
  const db = new Database(path); db.initialize();
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? { id } : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, db, tasks as never,
  );
  return { db, service, events };
}

function readSnapshot(db: Database): Record<string, unknown> {
  const row = db.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}
function writeSnapshot(db: Database, value: unknown): void {
  db.connection.prepare('UPDATE settings SET value=? WHERE key=?').run(typeof value === 'string' ? value : JSON.stringify(value), 'public_lifecycle_snapshot');
}

describe('0.7.3A lifecycle persistence validation', { timeout: 8_000 }, () => {
  it('restores a valid schemaVersion 1 snapshot', () => {
    const first = open();
    const intake = first.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    const plan = first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'summary', tasks: [step], dependencies: [] });
    first.db.close();
    const restored = restore(first.path, first.tasks);
    expect(restored.service.getPlan(plan.planId)).toMatchObject({ currentVersion: 1, state: 'WAITING_APPROVAL' });
    restored.db.close();
  });

  it('rejects syntactically valid forged terminal state fail-closed', () => {
    const first = open();
    const intake = first.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    first.service.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'summary', tasks: [step], dependencies: [] });
    const forged = readSnapshot(first.db) as { plans: Array<{ state: string }> };
    const plan = forged.plans[0]; if (!plan) throw new Error('fixture'); plan.state = 'COMPLETED';
    writeSnapshot(first.db, forged);
    const restored = restore(first.path, first.tasks);
    expect(restored.service.listPlans()).toEqual([]);
    first.db.close(); restored.db.close();
  });

  it('ignores invalid JSON and proposalHash mismatch fail-closed', () => {
    const jsonCase = open();
    jsonCase.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    jsonCase.db.connection.pragma('ignore_check_constraints = ON');
    writeSnapshot(jsonCase.db, '{');
    jsonCase.db.close();
    const ignoredJson = restore(jsonCase.path, jsonCase.tasks);
    expect(ignoredJson.service.listPlans()).toEqual([]);
    expect(ignoredJson.service.listIntakes()).toEqual([]);
    ignoredJson.db.close();

    const hashCase = open();
    const intake = hashCase.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    hashCase.service.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'summary', tasks: [step], dependencies: [] });
    const snapshot = readSnapshot(hashCase.db) as { plans: Array<{ versions: Array<{ proposalHash: string }> }> };
    const version = snapshot.plans[0]?.versions[0]; if (!version) throw new Error('fixture');
    version.proposalHash = 'f'.repeat(64);
    writeSnapshot(hashCase.db, snapshot);
    hashCase.db.close();
    const ignoredHash = restore(hashCase.path, hashCase.tasks);
    expect(ignoredHash.service.listPlans()).toEqual([]);
    ignoredHash.db.close();
  });

  it('rejects unknown dependency nodes, duplicate runtime mappings, and missing runtime targets', () => {
    const unknownDep = open();
    const intake = unknownDep.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    unknownDep.service.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'g', tasks: [step, stepB], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }] });
    const depSnap = readSnapshot(unknownDep.db) as { plans: Array<{ versions: Array<{ dependencies: Array<{ prerequisitePlanTaskId: string }> }> }> };
    const edge = depSnap.plans[0]?.versions[0]?.dependencies[0]; if (!edge) throw new Error('fixture');
    edge.prerequisitePlanTaskId = 'missing-node';
    writeSnapshot(unknownDep.db, depSnap);
    const ignoredDep = restore(unknownDep.path, unknownDep.tasks);
    expect(ignoredDep.service.listPlans()).toEqual([]);
    unknownDep.db.close(); ignoredDep.db.close();

    const missing = open();
    const missingIntake = missing.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    const missingPlan = missing.service.createPlan({ intakeId: missingIntake.intakeId, leadAgentId: 'lead', summary: 'g', tasks: [step], dependencies: [] });
    missing.service.decide(missingPlan.planId, 'APPROVE', { planVersion: 1, proposalHash: missingPlan.current.proposalHash, actorId: 'human', summary: '' });
    const planTaskId = missingPlan.tasks[0]?.planTaskId; if (!planTaskId) throw new Error('fixture');
    missing.service.linkRuntimeTask(missingPlan.planId, 1, planTaskId, 'task-missing');
    missing.taskMap.clear();
    const missingSnap = readSnapshot(missing.db);
    const ignoredMissing = restore(missing.path, missing.tasks);
    expect(ignoredMissing.service.listPlans()).toEqual([]);
    missing.db.close(); ignoredMissing.db.close();
    expect(missingSnap).toBeDefined();

    const dup = open();
    const dupIntake = dup.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    const dupPlan = dup.service.createPlan({ intakeId: dupIntake.intakeId, leadAgentId: 'lead', summary: 'g', tasks: [step, stepB], dependencies: [] });
    dup.service.decide(dupPlan.planId, 'APPROVE', { planVersion: 1, proposalHash: dupPlan.current.proposalHash, actorId: 'human', summary: '' });
    const firstId = dupPlan.tasks[0]?.planTaskId; const secondId = dupPlan.tasks[1]?.planTaskId;
    if (!firstId || !secondId) throw new Error('fixture');
    dup.tasks.createTask({ projectId: 'p', title: 'A' });
    dup.service.linkRuntimeTask(dupPlan.planId, 1, firstId, 'task-1');
    const snap = readSnapshot(dup.db) as { plans: Array<{ runtimeLinks: Array<Record<string, unknown>> }> };
    const links = snap.plans[0]?.runtimeLinks; if (!links) throw new Error('fixture');
    links.push({ planTaskId: secondId, runtimeTaskId: 'task-1', createdAt: new Date().toISOString(), reviewPending: false });
    writeSnapshot(dup.db, snap);
    const ignoredDup = restore(dup.path, dup.tasks);
    expect(ignoredDup.service.listPlans()).toEqual([]);
    dup.db.close(); ignoredDup.db.close();
  });

  it('does not trust forged COMPLETED when runtime work is incomplete and preserves real completion after restart', () => {
    const forged = open();
    const intake = forged.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    const plan = forged.service.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'g', tasks: [step], dependencies: [] });
    forged.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
    const planTaskId = plan.tasks[0]?.planTaskId; if (!planTaskId) throw new Error('fixture');
    const runtime = forged.tasks.createTask({ projectId: 'p', title: 'A', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    forged.service.linkRuntimeTask(plan.planId, 1, planTaskId, runtime.id);
    forged.service.markStarted(plan.planId, 1);
    const snap = readSnapshot(forged.db) as { plans: Array<{ state: string; startedVersion: number | null }> };
    const stored = snap.plans[0]; if (!stored) throw new Error('fixture'); stored.state = 'COMPLETED';
    writeSnapshot(forged.db, snap);
    const recomputed = restore(forged.path, forged.tasks);
    expect(recomputed.service.getPlan(plan.planId)?.state).not.toBe('COMPLETED');
    forged.db.close(); recomputed.db.close();

    const done = open();
    const doneIntake = done.service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
    const donePlan = done.service.createPlan({ intakeId: doneIntake.intakeId, leadAgentId: 'lead', summary: 'g', tasks: [step], dependencies: [] });
    done.service.decide(donePlan.planId, 'APPROVE', { planVersion: 1, proposalHash: donePlan.current.proposalHash, actorId: 'human', summary: '' });
    const doneTaskId = donePlan.tasks[0]?.planTaskId; if (!doneTaskId) throw new Error('fixture');
    const runtimeTask = done.tasks.createTask({ projectId: 'p', title: 'A', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    done.service.linkRuntimeTask(donePlan.planId, 1, doneTaskId, runtimeTask.id);
    done.service.markStarted(donePlan.planId, 1);
    const storedTask = done.taskMap.get(runtimeTask.id); if (!storedTask) throw new Error('missing');
    storedTask.status = TaskStatus.COMPLETED;
    expect(done.service.refresh(donePlan.planId).state).toBe('COMPLETED');
    done.db.close();
    const restoredDone = restore(done.path, done.tasks);
    expect(restoredDone.service.getPlan(donePlan.planId)?.state).toBe('COMPLETED');
    restoredDone.db.close();
  });
});
