import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { snapshotAssignmentDispatchResult } from '../src/index.js';

const oid = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const worker = { protocolVersion: 1 as const, outcome: 'COMPLETED' as const, summary: 'done',
  changedFiles: [], checks: [], blockers: [], questions: [], risks: [], notes: [] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validResult() {
  const turnResult = { protocol: 'worker-result' as const, protocolValid: true as const,
    providerId: 'fake', sessionId: 'session', durationMs: 12, workerResult: worker };
  const identity = { version: 1 as const, taskId: 'TASK', projectId: 'PROJECT', agentId: 'AGENT', providerId: 'fake',
    assignmentId: 'ASSIGN', reservationSha256: sha, executionProfileSha256: sha,
    workspace: { branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid, created: true },
    assignmentStatus: 'ACTIVE' as const, taskStatus: 'IMPLEMENTING' as const, turnResult };
  const stableTurnResult = { protocol: turnResult.protocol, protocolValid: turnResult.protocolValid,
    providerId: turnResult.providerId, sessionId: turnResult.sessionId, workerResult: turnResult.workerResult };
  const digestValue = { ...identity, turnProtocol: 'worker-result', turnResult: stableTurnResult };
  const dispatchSha256 = createHash('sha256')
    .update(`AgentHub.AssignmentDispatch.v1\0${canonical(digestValue)}`).digest('hex');
  return { ...identity, dispatchSha256 };
}

describe('Assignment dispatch result contract', () => {
  it('recomputes the digest and deep-freezes a canonical hand-off', () => {
    const result = snapshotAssignmentDispatchResult(validResult());
    expect(result.dispatchSha256).toHaveLength(64);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.turnResult)).toBe(true);
    if (result.turnResult.protocol === 'worker-result' && result.turnResult.protocolValid) {
      expect(Object.isFrozen(result.turnResult.workerResult)).toBe(true);
    }
  });

  it('rejects outer and nested tampering', () => {
    const result = validResult();
    expect(() => snapshotAssignmentDispatchResult({ ...result, taskId: 'TAMPERED' })).toThrow();
    expect(() => snapshotAssignmentDispatchResult({ ...result,
      turnResult: { ...result.turnResult, injected: true } })).toThrow();
    expect(() => snapshotAssignmentDispatchResult({ ...result,
      workspace: { ...result.workspace, injected: true } })).toThrow();
  });
});
