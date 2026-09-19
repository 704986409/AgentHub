import { describe, expect, it } from 'vitest';

import { EventBus, type DomainEvent } from '../src/events/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { PlanLifecycleService, type CreatePlanTaskInput, type PlanDto } from '../src/lifecycle/plan-lifecycle.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';
import { snapshotCreatePlan, snapshotPlanDecision, snapshotPlanStart } from '../src/api/ApiDtos.js';

const step = (clientId: string, parentClientId: string | null = null): CreatePlanTaskInput => ({
  clientId, parentClientId, title: clientId, description: null, acceptanceCriteria: ['done'],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
});

function harness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  const assignmentMap = new Map<string, { id: string; taskId: string; agentId: string }>();
  let sequence = 0;
  const events = new EventBus();
  const seen: DomainEvent[] = [];
  events.subscribe((event) => { seen.push(event); });
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
  const service = new PlanLifecycleService(projects as never, agents as never, events, undefined, tasks as never,
    { findById: (id: string) => assignmentMap.get(id) ?? null } as never);
  const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
  return { service, intake, tasks, taskMap, assignmentMap, events, seen };
}

function counts(plan: PlanDto): void {
  const a = plan.aggregate;
  expect(a.pending).toBe(a.blocked + a.eligible);
  expect(a.total).toBe(a.pending + a.running + a.reviewing + a.completed + a.failed);
}

describe('0.7.3A plan versioning and graph', { timeout: 8_000 }, () => {
  it('creates immutable versions and forbids same-version reapproval after REQUEST_CHANGES', () => {
    const { service: s, intake } = harness();
    const v1 = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'v1', tasks: [step('a')], dependencies: [] });
    expect(v1).toMatchObject({ currentVersion: 1, state: 'WAITING_APPROVAL' });
    expect(v1.current.proposalHash).toMatch(/^[a-f0-9]{64}$/u);
    const approved = s.decide(v1.planId, 'APPROVE', { planVersion: 1, proposalHash: v1.current.proposalHash, actorId: 'human', summary: '' });
    expect(approved.state).toBe('APPROVED');
    expect(approved.decisions.at(-1)?.decisionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(approved.decisions.at(-1)?.decisionId).not.toBe('idempotency-key');
    expect(() => s.decide(v1.planId, 'APPROVE', { planVersion: 1, proposalHash: 'b'.repeat(64), actorId: 'human', summary: '' })).toThrow('PLAN_STALE');
  });

  it('requires a new immutable version after REQUEST_CHANGES', () => {
    const { service: s, intake } = harness();
    const v1 = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'v1', tasks: [step('a')], dependencies: [] });
    s.decide(v1.planId, 'REQUEST_CHANGES', { planVersion: 1, proposalHash: v1.current.proposalHash, actorId: 'human', summary: 'revise' });
    expect(() => s.decide(v1.planId, 'APPROVE', { planVersion: 1, proposalHash: v1.current.proposalHash, actorId: 'human', summary: '' })).toThrow('PLAN_INVALID_STATE');
    const v2 = s.createRevision(v1.planId, { basedOnVersion: 1, leadAgentId: 'lead', summary: 'v2', tasks: [step('a')], dependencies: [] });
    expect(v2).toMatchObject({ currentVersion: 2, state: 'WAITING_APPROVAL' });
    expect(v2.current.proposalHash).not.toBe(v1.current.proposalHash);
    expect(v2.current.version).toBe(2);
    expect(s.decide(v2.planId, 'APPROVE', { planVersion: 2, proposalHash: v2.current.proposalHash, actorId: 'human', summary: '' }).decisions.at(-1)?.decisionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(() => s.decide(v2.planId, 'APPROVE', { planVersion: 1, proposalHash: v1.current.proposalHash, actorId: 'human', summary: '' })).toThrow('PLAN_STALE');
  });

  it('rejects parent and dependency graph corruption before mutation', () => {
    const { service: s, intake } = harness();
    const base = { intakeId: intake.intakeId, leadAgentId: 'lead' as const, summary: 'x' };
    const before = s.listPlans().length;
    expect(() => s.createPlan({ ...base, tasks: [step('a'), step('a')], dependencies: [] })).toThrow('PLAN_DUPLICATE_CLIENT');
    expect(() => s.createPlan({ ...base, tasks: [step('a', 'missing')], dependencies: [] })).toThrow('PLAN_UNKNOWN_PARENT');
    expect(() => s.createPlan({ ...base, tasks: [step('a', 'a')], dependencies: [] })).toThrow('PLAN_PARENT_CYCLE');
    expect(() => s.createPlan({ ...base, tasks: [step('a', 'b'), step('b', 'a')], dependencies: [] })).toThrow('PLAN_PARENT_CYCLE');
    expect(() => s.createPlan({ ...base, tasks: [step('a')], dependencies: [{ prerequisiteClientId: 'missing', dependentClientId: 'a' }] })).toThrow('PLAN_UNKNOWN_DEPENDENCY');
    expect(() => s.createPlan({ ...base, tasks: [step('a')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'missing' }] })).toThrow('PLAN_UNKNOWN_DEPENDENCY');
    expect(() => s.createPlan({ ...base, tasks: [step('a')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'a' }] })).toThrow('PLAN_CYCLE');
    expect(() => s.createPlan({ ...base, tasks: [step('a'), step('b')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }, { prerequisiteClientId: 'a', dependentClientId: 'b' }] })).toThrow('PLAN_DUPLICATE_EDGE');
    expect(() => s.createPlan({ ...base, tasks: [step('a'), step('b')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }, { prerequisiteClientId: 'b', dependentClientId: 'a' }] })).toThrow('PLAN_CYCLE');
    expect(s.listPlans()).toHaveLength(before);
  });

  it('computes blockedBy from authoritative runtime completion', () => {
    const { service: s, intake, taskMap } = harness();
    const p = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'linear', tasks: [step('a'), step('b')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }] });
    s.decide(p.planId, 'APPROVE', { planVersion: 1, proposalHash: p.current.proposalHash, actorId: 'human', summary: '' });
    const a = p.tasks[0], b = p.tasks[1]; if (!a || !b) throw new Error('fixture');
    s.linkRuntimeTask(p.planId, 1, a.planTaskId, 'ta'); s.linkRuntimeTask(p.planId, 1, b.planTaskId, 'tb');
    taskMap.set('ta', { id: 'ta', status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null });
    taskMap.set('tb', { id: 'tb', status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null });
    s.markStarted(p.planId, 1);
    expect(s.getPlan(p.planId)?.tasks[1]).toMatchObject({ dependencyState: 'BLOCKED', blockedBy: [a.planTaskId] });
    taskMap.set('ta', { id: 'ta', status: TaskStatus.COMPLETED, assignmentId: 'aa', assignedAgentId: 'worker' });
    expect(s.refresh(p.planId).tasks[1]).toMatchObject({ dependencyState: 'ELIGIBLE', blockedBy: [] });
  });

  it('keeps dependents blocked until review is resolved and runtime is COMPLETED', () => {
    const { service: s, intake, taskMap } = harness();
    const p = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'review-gate', tasks: [step('a'), step('b')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }] });
    s.decide(p.planId, 'APPROVE', { planVersion: 1, proposalHash: p.current.proposalHash, actorId: 'human', summary: '' });
    const a = p.tasks[0], b = p.tasks[1]; if (!a || !b) throw new Error('fixture');
    s.linkRuntimeTask(p.planId, 1, a.planTaskId, 'ta'); s.linkRuntimeTask(p.planId, 1, b.planTaskId, 'tb');
    taskMap.set('ta', { id: 'ta', status: TaskStatus.COMPLETED, assignmentId: 'aa', assignedAgentId: 'worker' });
    taskMap.set('tb', { id: 'tb', status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null });
    s.markStarted(p.planId, 1);
    s.markReviewPendingByTask('ta', true);
    const reviewing = s.refresh(p.planId);
    expect(reviewing.tasks[0]).toMatchObject({ runtimeState: 'REVIEWING', dependencyState: 'ELIGIBLE' });
    expect(reviewing.tasks[1]).toMatchObject({ dependencyState: 'BLOCKED', blockedBy: [a.planTaskId] });
    expect(reviewing.state).toBe('REVIEWING');
    counts(reviewing);
    s.markReviewPendingByTask('ta', false);
    const unlocked = s.refresh(p.planId);
    expect(unlocked.tasks[0]).toMatchObject({ runtimeState: 'COMPLETED', dependencyState: 'SATISFIED' });
    expect(unlocked.tasks[1]).toMatchObject({ dependencyState: 'ELIGIBLE', blockedBy: [] });
  });

  it('uses TaskManager, Scheduler, Dispatcher and review preparation for start', async () => {
    const { service: s, intake, tasks } = harness();
    const p = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'run', tasks: [step('a'), step('b')], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }] });
    const approved = s.decide(p.planId, 'APPROVE', { planVersion: 1, proposalHash: p.current.proposalHash, actorId: 'human', summary: '' });
    const calls: string[] = [];
    const coordinator = new PlanExecutionCoordinator({
      planLifecycle: s, tasks: tasks as never,
      scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => { calls.push(`schedule:${taskId}`); return { outcome: 'reserved', taskId, assignmentId: 'assignment', agentId: 'worker' }; } } as never,
      dispatcher: { dispatch: () => { calls.push('dispatch'); return Promise.resolve({}); } } as never,
      taskLifecycle: { prepareReview: () => { calls.push('review'); return Promise.resolve({ outcome: 'review-ready', reviewBundle: { taskId: 'task-1', reviewBundleSha256: 'a'.repeat(64) } }); } } as never,
      targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: new EventBus(),
    });
    const result = await coordinator.start(p.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    expect(result.plan.tasks.map((x) => x.runtimeTaskId)).toEqual(['task-1', 'task-2']);
    expect(calls).toEqual(['schedule:task-1', 'dispatch', 'review']);
    expect(result.plan.tasks[1]?.dependencyState).toBe('BLOCKED');
    expect(result.plan.tasks[0]?.runtimeState).toBe('REVIEWING');
  });

  it('rejects overlapping approvals and revisions with one authoritative winner', async () => {
    const { service: s, intake } = harness();
    const p = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'race', tasks: [step('a')], dependencies: [] });
    const input = { planVersion: 1, proposalHash: p.current.proposalHash, actorId: 'human', summary: '' };
    const approvalRace = await Promise.allSettled([
      Promise.resolve().then(() => s.decide(p.planId, 'APPROVE', input)),
      Promise.resolve().then(() => s.decide(p.planId, 'REQUEST_CHANGES', input)),
      Promise.resolve().then(() => s.decide(p.planId, 'REJECT', input)),
    ]);
    expect(approvalRace.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(approvalRace.filter((item) => item.status === 'rejected')).toHaveLength(2);
    expect(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED']).toContain(s.getPlan(p.planId)?.state);
    const revise = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'rev', tasks: [step('a')], dependencies: [] });
    s.decide(revise.planId, 'REQUEST_CHANGES', { planVersion: 1, proposalHash: revise.current.proposalHash, actorId: 'human', summary: 'x' });
    const revisionInput = { basedOnVersion: 1, leadAgentId: 'lead' as const, summary: 'v2', tasks: [step('a')], dependencies: [] };
    const revisionRace = await Promise.allSettled([
      Promise.resolve().then(() => s.createRevision(revise.planId, revisionInput)),
      Promise.resolve().then(() => s.createRevision(revise.planId, { ...revisionInput, summary: 'v2-b' })),
    ]);
    expect(revisionRace.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(s.getPlan(revise.planId)?.currentVersion).toBe(2);
  });

  it('emits public lifecycle events without runtime secrets', () => {
    const { service: s, intake, seen } = harness();
    const p = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'events', tasks: [step('a')], dependencies: [] });
    s.decide(p.planId, 'APPROVE', { planVersion: 1, proposalHash: p.current.proposalHash, actorId: 'human', summary: '' });
    const types = seen.map((event) => event.eventType);
    expect(types).toEqual(expect.arrayContaining(['IntakeCreated', 'PlanProposed', 'PlanApprovalDecision']));
    const raw = JSON.stringify(seen);
    for (const banned of ['cwd', 'env', 'environment', 'executable', 'sessionId', 'worktreePath', 'repositoryRoot']) {
      expect(raw).not.toContain(banned);
    }
  });

  it('strictly rejects unknown fields and malformed lifecycle DTOs', () => {
    expect(() => snapshotCreatePlan({ intakeId: 'i', leadAgentId: 'lead', summary: 's', tasks: [{ ...step('a'), extra: true }], dependencies: [] })).toThrow();
    expect(() => snapshotPlanDecision({ planVersion: 1, proposalHash: 'a'.repeat(64), actorId: 'human', summary: '', decisionId: 'client' })).toThrow();
    expect(() => snapshotPlanDecision({ planVersion: 1, proposalHash: 'x', actorId: 'human', summary: '' })).toThrow();
    expect(() => snapshotPlanStart({ planVersion: 1, proposalHash: 'a'.repeat(64), extra: true })).toThrow();
  });
});
