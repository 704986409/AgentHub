import { describe, expect, it } from 'vitest';

import { EventBus, type DomainEvent } from '../src/events/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { PlanLifecycleService, type CreatePlanTaskInput, type PlanDto } from '../src/lifecycle/plan-lifecycle.js';
import { PlanExecutionCoordinator } from '../src/lifecycle/plan-execution-coordinator.js';

const step = (clientId: string, parentClientId: string | null = null): CreatePlanTaskInput => ({
  clientId, parentClientId, title: clientId, description: `${clientId} work`, acceptanceCriteria: [`${clientId} done`],
  requiredCapabilities: [], requiredSpecialties: [], complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
});

function harness() {
  const taskMap = new Map<string, Record<string, unknown>>();
  const assignmentMap = new Map<string, { id: string; taskId: string; agentId: string }>();
  const busy = new Set<string>();
  let sequence = 0; let createLimit: number | null = null;
  const events = new EventBus(); const seen: DomainEvent[] = [];
  events.subscribe((event) => { seen.push(event); });
  const tasks = {
    getTask: (id: string) => taskMap.get(id) ?? null,
    createTask: (input: Record<string, unknown>) => {
      if (createLimit !== null && taskMap.size >= createLimit) {
        const error = new Error('PLAN_INVALID') as Error & { code: string }; error.code = 'PLAN_INVALID'; throw error;
      }
      const id = `task-${String(++sequence)}`;
      const value = { id, ...input, status: TaskStatus.CREATED, assignmentId: null, assignedAgentId: null };
      taskMap.set(id, value); return value;
    },
  };
  const service = new PlanLifecycleService(
    { findById: (id: string) => id === 'p' ? { id } : null } as never,
    { getAgent: (id: string) => id === 'lead' ? { id, projectId: 'p' } : null } as never,
    events, undefined, tasks as never, { findById: (id: string) => assignmentMap.get(id) ?? null } as never,
  );
  const intake = service.createIntake({ projectId: 'p', createdBy: 'human', goal: 'goal', leadAgentId: 'lead' });
  return { service, intake, tasks, taskMap, assignmentMap, busy, events, seen, setCreateLimit: (n: number | null) => { createLimit = n; } };
}

function runtime(h: ReturnType<typeof harness>) {
  const calls: string[] = []; const prompts: string[] = [];
  const coordinator = new PlanExecutionCoordinator({
    planLifecycle: h.service, tasks: h.tasks as never,
    scheduler: { scheduleTask: (request: { taskId: string; requirements: { requiredOutputProtocols: string[] } }) => {
      calls.push(`schedule:${request.taskId}:${request.requirements.requiredOutputProtocols.join(',')}`);
      if (h.busy.has(request.taskId)) return { outcome: 'busy' };
      return { outcome: 'reserved', taskId: request.taskId, assignmentId: `asg-${request.taskId}`, agentId: 'worker' };
    } } as never,
    dispatcher: { dispatch: (request: { reservation: { taskId: string; assignmentId: string; agentId: string }; turn: { prompt: string; protocol: string }; baseRef: string }) => {
      calls.push(`dispatch:${request.reservation.taskId}:${request.turn.protocol}:${request.baseRef}`);
      prompts.push(request.turn.prompt);
      const task = h.taskMap.get(request.reservation.taskId);
      if (task) { task.status = TaskStatus.IMPLEMENTING; task.assignedAgentId = request.reservation.agentId; task.assignmentId = request.reservation.assignmentId; }
      h.assignmentMap.set(request.reservation.assignmentId, { id: request.reservation.assignmentId, taskId: request.reservation.taskId, agentId: request.reservation.agentId });
      return Promise.resolve({ taskId: request.reservation.taskId, assignmentId: request.reservation.assignmentId, agentId: request.reservation.agentId });
    } } as never,
    taskLifecycle: { prepareReview: (request: { dispatchResult: { taskId: string } }) => {
      calls.push(`review:${request.dispatchResult.taskId}`);
      const task = h.taskMap.get(request.dispatchResult.taskId);
      if (task) task.status = TaskStatus.REVIEWING;
      return Promise.resolve({ outcome: 'review-ready', reviewBundle: { taskId: request.dispatchResult.taskId, reviewBundleSha256: 'c'.repeat(64) } });
    } } as never,
    targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events,
  });
  return { coordinator, calls, prompts };
}

function approve(h: ReturnType<typeof harness>, tasks: CreatePlanTaskInput[], deps: Array<{ prerequisiteClientId: string; dependentClientId: string }>) {
  const plan = h.service.createPlan({ intakeId: h.intake.intakeId, leadAgentId: 'lead', summary: 'run', tasks, dependencies: deps });
  const approved = h.service.decide(plan.planId, 'APPROVE', { planVersion: 1, proposalHash: plan.current.proposalHash, actorId: 'human', summary: '' });
  return approved;
}

function counts(plan: PlanDto): void {
  const a = plan.aggregate;
  expect(a.pending).toBe(a.blocked + a.eligible);
  expect(a.total).toBe(a.pending + a.running + a.reviewing + a.completed + a.failed);
}

async function accept(h: ReturnType<typeof harness>, coordinator: PlanExecutionCoordinator, runtimeTaskId: string) {
  const task = h.taskMap.get(runtimeTaskId); if (!task) throw new Error('missing task');
  task.status = TaskStatus.COMPLETED;
  await coordinator.afterReview(runtimeTaskId);
}

describe('0.7.3A plan execution coordinator', { timeout: 8_000 }, () => {
  it('denies start before approval and materializes exactly one runtime Task per PlanTask', async () => {
    const h = harness(); const { coordinator } = runtime(h);
    const draft = h.service.createPlan({ intakeId: h.intake.intakeId, leadAgentId: 'lead', summary: 'draft', tasks: [step('a'), step('b')], dependencies: [] });
    await expect(coordinator.start(draft.planId, { planVersion: 1, proposalHash: draft.current.proposalHash })).rejects.toMatchObject({ code: 'PLAN_NOT_APPROVED' });
    const approved = approve(h, [step('a'), step('b')], []);
    const first = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    expect(first.plan.tasks).toHaveLength(2);
    expect(new Set(first.plan.tasks.map((task) => task.runtimeTaskId)).size).toBe(2);
    expect(first.plan.tasks.every((task) => typeof task.runtimeTaskId === 'string')).toBe(true);
    const created = h.taskMap.size;
    const replay = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    expect(h.taskMap.size).toBe(created);
    expect(replay.plan.tasks.map((task) => task.runtimeTaskId)).toEqual(first.plan.tasks.map((task) => task.runtimeTaskId));
  });

  it('reconciles partial materialization without duplicating existing runtime Tasks', async () => {
    const h = harness(); const { coordinator } = runtime(h);
    const approved = approve(h, [step('a'), step('b')], []);
    h.setCreateLimit(1);
    await expect(coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash })).rejects.toMatchObject({ code: 'PLAN_INVALID' });
    expect([...h.taskMap.keys()]).toEqual(['task-1']);
    h.setCreateLimit(null);
    const recovered = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    expect(recovered.plan.tasks.map((task) => task.runtimeTaskId)).toEqual(['task-1', 'task-2']);
    expect(h.taskMap.size).toBe(2);
  });

  it('schedules only eligible work with worker-result and keeps blocked tasks undispatched', async () => {
    const h = harness(); const { coordinator, calls, prompts } = runtime(h);
    const approved = approve(h, [step('a'), step('b'), step('c')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' }, { prerequisiteClientId: 'b', dependentClientId: 'c' },
    ]);
    const started = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    const [a, b, c] = started.plan.tasks; if (!a || !b || !c || a.runtimeTaskId === null) throw new Error('fixture');
    const runtimeTaskId = a.runtimeTaskId;
    expect(a).toMatchObject({ dependencyState: 'ELIGIBLE', runtimeState: 'REVIEWING', clientId: 'a' });
    expect(b).toMatchObject({ dependencyState: 'BLOCKED', blockedBy: [a.planTaskId], runtimeState: 'BLOCKED' });
    expect(c).toMatchObject({ dependencyState: 'BLOCKED', blockedBy: [b.planTaskId], runtimeState: 'BLOCKED' });
    expect(calls.filter((item) => item.startsWith('schedule:'))).toEqual([`schedule:${runtimeTaskId}:worker-result`]);
    expect(calls).toContain(`dispatch:${runtimeTaskId}:worker-result:main`);
    expect(prompts[0]).toContain('a done');
    expect(started.plan.tasks[0]).toMatchObject({ assignmentId: `asg-${runtimeTaskId}`, agentId: 'worker' });
    counts(started.plan);
    expect(started.plan.aggregate).toMatchObject({ total: 3, reviewing: 1, blocked: 2, eligible: 0, completed: 0, failed: 0, state: 'REVIEWING' });
  });

  it('unlocks A→B→C, fan-in, and never unlocks a failed prerequisite', async () => {
    const linear = harness(); const linearRt = runtime(linear);
    const linearPlan = approve(linear, [step('a'), step('b'), step('c')], [
      { prerequisiteClientId: 'a', dependentClientId: 'b' }, { prerequisiteClientId: 'b', dependentClientId: 'c' },
    ]);
    let current = (await linearRt.coordinator.start(linearPlan.planId, { planVersion: 1, proposalHash: linearPlan.current.proposalHash })).plan;
    await accept(linear, linearRt.coordinator, current.tasks[0]?.runtimeTaskId ?? '');
    current = linear.service.refresh(linearPlan.planId);
    expect(current.tasks[1]).toMatchObject({ dependencyState: 'ELIGIBLE', runtimeState: 'REVIEWING' });
    expect(current.tasks[2]).toMatchObject({ dependencyState: 'BLOCKED' });
    await accept(linear, linearRt.coordinator, current.tasks[1]?.runtimeTaskId ?? '');
    current = linear.service.refresh(linearPlan.planId);
    expect(current.tasks[2]).toMatchObject({ dependencyState: 'ELIGIBLE', runtimeState: 'REVIEWING' });
    await accept(linear, linearRt.coordinator, current.tasks[2]?.runtimeTaskId ?? '');
    current = linear.service.refresh(linearPlan.planId);
    expect(current.state).toBe('COMPLETED');
    expect(current.aggregate.completed).toBe(3);
    counts(current);

    const fan = harness(); const fanRt = runtime(fan);
    const fanPlan = approve(fan, [step('a'), step('b'), step('d')], [
      { prerequisiteClientId: 'a', dependentClientId: 'd' }, { prerequisiteClientId: 'b', dependentClientId: 'd' },
    ]);
    current = (await fanRt.coordinator.start(fanPlan.planId, { planVersion: 1, proposalHash: fanPlan.current.proposalHash })).plan;
    expect(current.tasks.filter((task) => task.runtimeState === 'REVIEWING')).toHaveLength(2);
    expect(current.tasks.find((task) => task.clientId === 'd')).toMatchObject({ dependencyState: 'BLOCKED' });
    const aId = current.tasks.find((task) => task.clientId === 'a')?.runtimeTaskId ?? '';
    await accept(fan, fanRt.coordinator, aId);
    current = fan.service.refresh(fanPlan.planId);
    expect(current.tasks.find((task) => task.clientId === 'd')).toMatchObject({ dependencyState: 'BLOCKED' });
    await accept(fan, fanRt.coordinator, current.tasks.find((task) => task.clientId === 'b')?.runtimeTaskId ?? '');
    current = fan.service.refresh(fanPlan.planId);
    expect(current.tasks.find((task) => task.clientId === 'd')).toMatchObject({ runtimeState: 'REVIEWING', dependencyState: 'ELIGIBLE' });

    const failed = harness(); const failedRt = runtime(failed);
    const failedPlan = approve(failed, [step('a'), step('b')], [{ prerequisiteClientId: 'a', dependentClientId: 'b' }]);
    current = (await failedRt.coordinator.start(failedPlan.planId, { planVersion: 1, proposalHash: failedPlan.current.proposalHash })).plan;
    const failedTask = failed.taskMap.get(current.tasks[0]?.runtimeTaskId ?? ''); if (!failedTask) throw new Error('missing');
    failedTask.status = TaskStatus.FAILED;
    await failedRt.coordinator.afterReview(current.tasks[0]?.runtimeTaskId ?? '');
    current = failed.service.refresh(failedPlan.planId);
    expect(current.state).toBe('FAILED');
    expect(current.tasks[1]).toMatchObject({ dependencyState: 'BLOCKED' });
    expect(current.currentVersion).toBe(1);
  });

  it('keeps Plan incomplete while review is pending and completes exactly once after ACCEPT', async () => {
    const h = harness(); const { coordinator, seen } = { ...runtime(h), seen: h.seen };
    const approved = approve(h, [step('a')], []);
    const started = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    const runtimeTaskId = started.plan.tasks[0]?.runtimeTaskId; if (!runtimeTaskId) throw new Error('fixture');
    const pending = h.taskMap.get(runtimeTaskId); if (!pending) throw new Error('missing');
    pending.status = TaskStatus.COMPLETED;
    const stillOpen = h.service.refresh(approved.planId);
    expect(stillOpen.state).not.toBe('COMPLETED');
    expect(stillOpen.tasks[0]?.runtimeState).toBe('REVIEWING');
    await coordinator.afterReview(runtimeTaskId);
    const done = h.service.refresh(approved.planId);
    expect(done.state).toBe('COMPLETED');
    expect(done.tasks[0]).toMatchObject({ runtimeState: 'COMPLETED', assignmentId: `asg-${runtimeTaskId}`, agentId: 'worker' });
    expect(seen.filter((event) => event.eventType === 'PlanCompleted')).toHaveLength(1);
    await coordinator.afterReview(runtimeTaskId);
    expect(h.service.refresh(approved.planId).state).toBe('COMPLETED');
    expect(seen.filter((event) => event.eventType === 'PlanCompleted')).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('sessionId');
    expect(JSON.stringify(seen)).not.toContain('worktreePath');
  });

  it('does not create a Plan revision on REQUEST_REVISION and preserves BUSY scheduling', async () => {
    const h = harness(); const { coordinator, calls } = runtime(h);
    const approved = approve(h, [step('a'), step('b')], []);
    h.busy.add('task-2');
    const started = await coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    expect(started.plan.currentVersion).toBe(1);
    const reviewing = started.plan.tasks.find((task) => task.runtimeState === 'REVIEWING');
    const idle = started.plan.tasks.find((task) => task.runtimeTaskId === 'task-2');
    expect(reviewing).toBeDefined();
    expect(idle).toMatchObject({ runtimeState: 'ELIGIBLE', assignmentId: null });
    expect(calls.some((item) => item.startsWith('dispatch:task-2'))).toBe(false);
    const task = h.taskMap.get(reviewing?.runtimeTaskId ?? ''); if (!task) throw new Error('missing');
    task.status = TaskStatus.REVISION_REQUIRED;
    await coordinator.afterReview(reviewing?.runtimeTaskId ?? '');
    const after = h.service.refresh(approved.planId);
    expect(after.currentVersion).toBe(1);
    expect(after.state).not.toBe('COMPLETED');
    expect(after.tasks.find((item) => item.planTaskId === reviewing?.planTaskId)?.runtimeState).toBe('RUNNING');
  });

  it('rejects overlapping START while the first dispatch is in flight', async () => {
    const h = harness();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new PlanExecutionCoordinator({
      planLifecycle: h.service, tasks: h.tasks as never,
      scheduler: { scheduleTask: ({ taskId }: { taskId: string }) => ({ outcome: 'reserved', taskId, assignmentId: 'asg', agentId: 'worker' }) } as never,
      dispatcher: { dispatch: async () => { await hold; return {}; } } as never,
      taskLifecycle: { prepareReview: () => Promise.resolve({ outcome: 'review-ready', reviewBundle: { taskId: 'task-1', reviewBundleSha256: 'd'.repeat(64) } }) } as never,
      targetBranch: 'main', buildTestPlan: { commands: [] }, eventBus: h.events,
    });
    const approved = approve(h, [step('a')], []);
    const first = coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash });
    await Promise.resolve();
    await expect(coordinator.start(approved.planId, { planVersion: 1, proposalHash: approved.current.proposalHash })).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    release();
    expect((await first).plan.tasks[0]?.runtimeTaskId).toBe('task-1');
  });
});
