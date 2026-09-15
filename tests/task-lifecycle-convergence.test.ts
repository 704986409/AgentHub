import { describe, expect, it, vi } from 'vitest';

import { AgentStatus, AssignmentStatus, TaskStatus } from '../src/core/types.js';
import { LifecycleConvergence } from '../src/orchestration/lifecycle/LifecycleConvergence.js';
import { RuntimeGuard } from '../src/orchestration/lifecycle/RuntimeGuard.js';

const ids = { agentId: 'agent-1', assignmentId: 'assignment-1', taskId: 'task-1' };

function cleanPool() {
  return { agentId: ids.agentId, providerId: 'fake', state: 'IDLE' as const,
    busy: false, active: false, reserved: false };
}

function runtimeGuard(options: {
  readonly pool?: Record<string, unknown>;
  readonly shutdown?: () => Promise<void>;
  readonly assignment?: Record<string, unknown> | null;
  readonly task?: Record<string, unknown> | null;
  readonly agent?: Record<string, unknown> | null;
  readonly hash?: string | Error;
}) {
  const pool = {
    shutdown: vi.fn(options.shutdown ?? (() => Promise.resolve())),
    getSnapshot: vi.fn(() => options.pool ?? cleanPool()),
  };
  const assignments = { getAssignment: vi.fn(() => options.assignment ?? {
    id: ids.assignmentId, taskId: ids.taskId, agentId: ids.agentId, status: AssignmentStatus.ACTIVE,
  }) };
  const tasks = { getTask: vi.fn(() => options.task ?? {
    id: ids.taskId, status: TaskStatus.REVIEWING, assignmentId: ids.assignmentId, assignedAgentId: ids.agentId,
  }) };
  const agents = {
    getAgent: vi.fn(() => options.agent ?? { id: ids.agentId, status: AgentStatus.BUSY, enabled: true }),
    calculateExecutionProfileHash: vi.fn(() => {
      if (options.hash instanceof Error) throw options.hash;
      return options.hash ?? 'profile-hash';
    }),
  };
  return {
    guard: new RuntimeGuard({ pool, assignments, tasks, agents } as never),
    pool, assignments, tasks, agents,
  };
}

function bundle() {
  return { agentId: ids.agentId, assignmentId: ids.assignmentId, taskId: ids.taskId,
    executionProfileSha256: 'profile-hash' } as never;
}

function convergence() {
  let assignment: Record<string, unknown> | null = {
    id: ids.assignmentId, taskId: ids.taskId, status: AssignmentStatus.ACTIVE,
  };
  let task: Record<string, unknown> | null = {
    id: ids.taskId, status: TaskStatus.REVIEWING, assignedAgentId: ids.agentId, assignmentId: ids.assignmentId,
  };
  const assignments = {
    getAssignment: vi.fn(() => assignment),
    suspendActiveAssignment: vi.fn(),
    finalizeFailedAssignment: vi.fn(),
    finalizeCompletedAssignment: vi.fn(),
  };
  const tasks = { getTask: vi.fn(() => task) };
  return {
    convergence: new LifecycleConvergence(assignments as never, tasks as never), assignments, tasks,
    complete() {
      assignment = { ...assignment, status: AssignmentStatus.COMPLETED };
      task = { ...task, status: TaskStatus.COMPLETED, assignedAgentId: null, assignmentId: null };
    },
  };
}

describe('V0.7.0F lifecycle convergence and runtime guards', () => {
  it('shuts down with the exact agent and assignment ownership', async () => {
    const h = runtimeGuard({});
    await h.guard.shutdown(ids);
    expect(h.pool.shutdown).toHaveBeenCalledOnce();
    expect(h.pool.shutdown).toHaveBeenCalledWith(ids.agentId, ids.assignmentId);
  });

  it.each([
    ['shutdown failure', runtimeGuard({ shutdown: () => Promise.reject(new Error('private')) })],
    ['dirty pool', runtimeGuard({ pool: { ...cleanPool(), state: 'OWNED', busy: true, taskId: ids.taskId } })],
  ] as const)('fails closed for %s without persistent mutation', async (_name, h) => {
    await expect(h.guard.shutdown(ids)).rejects.toMatchObject({
      code: 'TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED',
    });
    expect(h.assignments.getAssignment).not.toHaveBeenCalled();
    expect(h.tasks.getTask).not.toHaveBeenCalled();
  });

  it('preserves persistent ownership and exact stale-profile mappings', () => {
    const good = runtimeGuard({});
    expect(() => good.guard.requirePersistentAfterShutdown(bundle())).not.toThrow();

    const profile = runtimeGuard({ hash: new Error('profile unavailable') });
    expect(() => profile.guard.requirePersistentAfterShutdown(bundle())).toThrowError('TASK_LIFECYCLE_STALE_PROFILE');

    const stale = runtimeGuard({ task: { id: ids.taskId, status: TaskStatus.COMPLETED } });
    expect(() => stale.guard.requirePersistentAfterShutdown(bundle())).toThrowError('TASK_LIFECYCLE_STALE_EXECUTION');
  });

  it.each([TaskStatus.BLOCKED, TaskStatus.WAITING_INPUT] as const)(
    'preserves suspend mapping for %s', (status) => {
      const h = convergence();
      h.convergence.suspend(ids.assignmentId, status);
      expect(h.assignments.suspendActiveAssignment).toHaveBeenCalledWith(ids.assignmentId, status);
    },
  );

  it('maps suspend and failed-finalization errors to reconciliation', () => {
    const h = convergence();
    h.assignments.suspendActiveAssignment.mockImplementation(() => { throw new Error('private'); });
    expect(() => h.convergence.suspend(ids.assignmentId, TaskStatus.BLOCKED)).toThrowError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
    h.assignments.suspendActiveAssignment.mockReset();
    h.assignments.finalizeFailedAssignment.mockImplementation(() => { throw new Error('private'); });
    expect(() => h.convergence.finalizeFailed(ids.assignmentId)).toThrowError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED');
  });

  it('converges immediately and retries partial completion state at most three times', () => {
    const immediate = convergence();
    immediate.assignments.finalizeCompletedAssignment.mockImplementation(() => immediate.complete());
    expect(() => immediate.convergence.finalizeCompleted(ids.assignmentId)).not.toThrow();
    expect(immediate.assignments.finalizeCompletedAssignment).toHaveBeenCalledOnce();

    const partial = convergence();
    partial.assignments.finalizeCompletedAssignment.mockImplementationOnce(() => { throw new Error('partial'); });
    partial.assignments.finalizeCompletedAssignment.mockImplementationOnce(() => partial.complete());
    partial.convergence.finalizeCompleted(ids.assignmentId);
    expect(partial.assignments.finalizeCompletedAssignment).toHaveBeenCalledTimes(2);

    const exhausted = convergence();
    const mergeResult = { mergeResultSha256: 'merge-result' } as never;
    exhausted.assignments.finalizeCompletedAssignment.mockImplementation(() => { throw new Error('still partial'); });
    let thrown: unknown;
    try { exhausted.convergence.finalizeCompleted(ids.assignmentId, mergeResult); }
    catch (error: unknown) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { readonly code?: unknown }).code).toBe('TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED');
    expect((thrown as { readonly mergeResult?: unknown }).mergeResult).toBe(mergeResult);
    expect(exhausted.assignments.finalizeCompletedAssignment).toHaveBeenCalledTimes(3);
  });

  it('keeps a process-local receipt and replays only convergence', () => {
    const h = convergence();
    const result = { outcome: 'completed', lifecycleSha256: 'lifecycle' } as never;
    const mergeResult = { mergeResultSha256: 'merge-result' } as never;
    h.convergence.rememberReceipt('receipt-key', { result, mergeResult });
    expect(h.convergence.getReceipt('receipt-key')).toEqual({ result, mergeResult });
    h.assignments.finalizeCompletedAssignment.mockImplementation(() => h.complete());
    h.convergence.finalizeCompleted(ids.assignmentId, h.convergence.getReceipt('receipt-key')?.mergeResult);
    expect(h.assignments.finalizeCompletedAssignment).toHaveBeenCalledOnce();
    expect(h.convergence.getReceipt('receipt-key')?.result).toBe(result);
  });
});
