import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AssignmentDispatcherError as LegacyError } from '../src/orchestration/AssignmentDispatcher.js';
import {
  AssignmentDispatcherError,
  snapshotAssignmentDispatchResult,
  snapshotAssignmentTurnResult,
} from '../src/orchestration/dispatch/AssignmentDispatchContract.js';

const oid = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const worker = {
  protocolVersion: 1 as const,
  outcome: 'COMPLETED' as const,
  summary: 'done',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) =>
      JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validResult() {
  const turnResult = {
    protocol: 'worker-result' as const,
    protocolValid: true as const,
    providerId: 'fake',
    sessionId: 'session',
    durationMs: 12,
    workerResult: worker,
  };
  const identity = {
    version: 1 as const,
    taskId: 'TASK',
    projectId: 'PROJECT',
    agentId: 'AGENT',
    providerId: 'fake',
    assignmentId: 'ASSIGN',
    reservationSha256: sha,
    executionProfileSha256: sha,
    workspace: { branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid, created: true },
    assignmentStatus: 'ACTIVE' as const,
    taskStatus: 'IMPLEMENTING' as const,
    turnResult,
  };
  const stableTurnResult = {
    protocol: turnResult.protocol,
    protocolValid: turnResult.protocolValid,
    providerId: turnResult.providerId,
    sessionId: turnResult.sessionId,
    workerResult: turnResult.workerResult,
  };
  const digestValue = { ...identity, turnProtocol: 'worker-result', turnResult: stableTurnResult };
  const dispatchSha256 = createHash('sha256')
    .update('AgentHub.AssignmentDispatch.v1\0' + canonical(digestValue))
    .digest('hex');
  return { ...identity, dispatchSha256 };
}

describe('Assignment dispatch contract extraction', () => {
  it('preserves the legacy error class identity', () => {
    expect(AssignmentDispatcherError).toBe(LegacyError);
    expect(new AssignmentDispatcherError('AGENT_DISPATCH_INVALID_REQUEST')).toBeInstanceOf(LegacyError);
  });

  it('snapshots valid results, rejects tampering, and excludes duration from digest', () => {
    const input = validResult();
    const result = snapshotAssignmentDispatchResult(input);
    expect(result.dispatchSha256).toHaveLength(64);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.turnResult)).toBe(true);

    const changedDuration = { ...input, turnResult: { ...input.turnResult, durationMs: 999 } };
    expect(snapshotAssignmentDispatchResult(changedDuration).dispatchSha256).toBe(result.dispatchSha256);
    expect(() => snapshotAssignmentDispatchResult({ ...input, taskId: 'TAMPERED' }))
      .toThrowError(AssignmentDispatcherError);
    expect(() => snapshotAssignmentDispatchResult({ ...input, dispatchSha256: '0'.repeat(64) }))
      .toThrowError(AssignmentDispatcherError);
  });

  it('normalizes provider turns and rejects unknown keys', () => {
    const normalized = snapshotAssignmentTurnResult(validResult().turnResult, 'worker-result', 'fake');
    expect(normalized.providerId).toBe('fake');
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(() => snapshotAssignmentTurnResult(
      { ...validResult().turnResult, unexpected: true }, 'worker-result', 'fake',
    )).toThrowError(AssignmentDispatcherError);
  });
});
