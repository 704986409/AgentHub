import { describe, expect, it, vi } from 'vitest';

import { RevisionCoordinator, RevisionTurnError } from '../src/orchestration/lifecycle/RevisionCoordinator.js';
import type { AgentProviderTurnResult } from '../src/runtime/providers/AgentProvider.js';

const binding = {
  taskId: 'TASK-1',
  agentId: 'AGENT-1',
  assignmentId: 'ASSIGN-1',
  providerId: 'provider-1',
} as const;

const task = (acceptanceCriteria: readonly string[]) => ({
  id: binding.taskId,
  projectId: 'PROJECT-1',
  title: 'Task',
  description: null,
  requiredCapabilities: [],
  requiredSpecialties: [],
  acceptanceCriteria,
  status: 'IMPLEMENTING',
  complexity: 'SIMPLE',
  risk: 'LOW',
  assignedAgentId: binding.agentId,
  assignmentId: binding.assignmentId,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const review = (summary: string, findings: readonly Record<string, unknown>[]) => ({
  version: 1,
  reviewId: 'REVIEW-1',
  reviewerId: 'reviewer-1',
  taskId: binding.taskId,
  branchName: 'agenthub/TASK-1',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  changeSetSha256: 'c'.repeat(64),
  sourceVisibilitySha256: 'd'.repeat(64),
  buildTestEvidenceSha256: 'e'.repeat(64),
  verdict: 'REQUEST_REVISION',
  summary,
  findings,
  reviewEvidenceSha256: 'f'.repeat(64),
});

const validTurn: AgentProviderTurnResult = {
  providerId: binding.providerId,
  sessionId: 'session-1',
  protocol: 'worker-result',
  protocolValid: true,
  workerResult: {
    protocolVersion: 1,
    outcome: 'COMPLETED',
    summary: 'completed',
    changedFiles: [],
    checks: [],
    blockers: [],
    questions: [],
    risks: [],
    notes: [],
  },
};

function makeCoordinator(result: unknown = validTurn) {
  const runTurn = vi.fn(() => Promise.resolve(result as AgentProviderTurnResult));
  return { coordinator: new RevisionCoordinator({ runTurn } as never), runTurn };
}

describe('RevisionCoordinator', () => {
  it('preserves prompt ordering, paths, and acceptance criteria', () => {
    const { coordinator } = makeCoordinator();
    const plan = coordinator.prepare(review('Needs fixes', [
      { severity: 'error', code: 'FIRST', message: 'First finding', path: 'src/first.ts' },
      { severity: 'warning', code: 'SECOND', message: 'Second finding' },
    ]) as never, task(['Must pass', 'Must remain compatible']) as never, binding);

    expect(plan.prompt).toBe([
      'Apply exactly one revision for the current task.',
      '',
      'Review summary: Needs fixes',
      '',
      'Findings:',
      '- [error] FIRST: First finding (src/first.ts)',
      '- [warning] SECOND: Second finding',
      '',
      'Acceptance criteria:',
      '1. Must pass',
      '2. Must remain compatible',
    ].join('\n'));
  });

  it('renders empty findings and acceptance criteria', () => {
    const { coordinator } = makeCoordinator();
    const plan = coordinator.prepare(review('No details', []) as never, task([]) as never, binding);
    expect(plan.prompt).toContain('Findings:\n(none)');
    expect(plan.prompt).toContain('Acceptance criteria:\n(none)');
  });

  it('rejects an oversized UTF-8 prompt before provider execution', () => {
    const { coordinator, runTurn } = makeCoordinator();
    expect(() => coordinator.prepare(review('界'.repeat(600_000), []) as never, task([]) as never, binding))
      .toThrowError(/TASK_LIFECYCLE_INVALID_REQUEST/u);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('runs exactly one turn with the exact binding and worker-result protocol', async () => {
    const { coordinator, runTurn } = makeCoordinator();
    const plan = coordinator.prepare(review('Fix it', []) as never, task([]) as never, binding);
    const result = await coordinator.run(plan);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(binding.agentId, binding.assignmentId, {
      prompt: plan.prompt,
      protocol: 'worker-result',
    });
    expect(result).toMatchObject({ providerId: binding.providerId, protocol: 'worker-result', protocolValid: true });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('normalizes an invalid provider schema to the existing invalid-turn shape', async () => {
    const { coordinator } = makeCoordinator({ providerId: binding.providerId, protocol: 'worker-result', protocolValid: true });
    const result = await coordinator.run(coordinator.prepare(review('Fix it', []) as never, task([]) as never, binding));
    expect(result).toEqual({
      protocol: 'worker-result',
      protocolValid: false,
      providerId: binding.providerId,
      failure: { kind: 'schema_invalid', message: 'invalid revision result' },
    });
  });

  it('does not expose provider error details when a turn rejects', async () => {
    const privateError = 'PRIVATE stderr token / secret / prompt';
    const runTurn = vi.fn(() => Promise.reject(new Error(privateError)));
    const coordinator = new RevisionCoordinator({ runTurn } as never);
    const promise = coordinator.run(coordinator.prepare(review('Fix it', []) as never, task([]) as never, binding));
    const rejection = await promise.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(RevisionTurnError);
    expect(rejection).toMatchObject({ message: 'revision turn failed' });
    expect((rejection as Error).message).not.toContain(privateError);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});
