import { describe, expect, it } from 'vitest';

import { createReviewEvidence, type BuildTestEvidence, type GitWorkspaceChangeSnapshot,
  type ReviewEvidence } from '../src/index.js';
import { evaluateMergeGateSnapshot, snapshotMergeGateInputs } from '../src/workspace/MergeGate.js';
import { evidenceFixture, sourceFixture, taskWorkspace, visibilitySha256 } from './merge-gate-fixtures.js';

describe('MergeGate pure evaluation', () => {
  it('accepts exact passed evidence and ACCEPT review', async () => {
    const fixture = await gateFixture();
    const decision = evaluate(fixture);
    expect(decision).toMatchObject({ eligible: true, reasons: [], taskId: 'TASK-A',
      buildTestEvidenceSha256: fixture.build.evidenceSha256,
      reviewEvidenceSha256: fixture.review.reviewEvidenceSha256 });
    deepFrozen(decision);
  });

  it('denies failed or tampered build evidence', async () => {
    const failed = await gateFixture({ outcome: 'failed' });
    expect(evaluate(failed).reasons).toContain('BUILD_EVIDENCE_NOT_PASSED');
    const passed = await gateFixture();
    const tampered = { ...passed.build, headCommit: 'f'.repeat(40) };
    expect(evaluate({ ...passed, build: tampered }).reasons).toContain('BUILD_EVIDENCE_INVALID');
  });

  it('enforces required phases and exact required command IDs', async () => {
    const fixture = await gateFixture({ commandId: 'verify', phase: 'test' });
    expect(evaluate(fixture, { requiredPhases: ['build'] }).reasons).toContain('REQUIRED_PHASE_NOT_PASSED');
    expect(evaluate(fixture, { requiredCommandIds: ['missing'] }).reasons).toContain('REQUIRED_COMMAND_NOT_PASSED');
    expect(evaluate(fixture, { requiredPhases: ['test'], requiredCommandIds: ['verify'] }).eligible).toBe(true);
  });

  it.each(['REQUEST_REVISION', 'BLOCK'] as const)('denies %s reviews', async (verdict) => {
    const fixture = await gateFixture({ verdict });
    expect(evaluate(fixture).reasons).toContain('REVIEW_NOT_ACCEPTED');
  });

  it('denies review binding mismatch and review digest tampering', async () => {
    const fixture = await gateFixture();
    const other = await evidenceFixture({ commandId: 'other' });
    const otherReview = createReviewEvidence(other.evidence, reviewDecision('ACCEPT'));
    expect(evaluate({ ...fixture, review: otherReview }).reasons).toContain('REVIEW_BINDING_MISMATCH');
    expect(evaluate({ ...fixture, review: { ...fixture.review, summary: 'tampered' } }).reasons)
      .toContain('REVIEW_EVIDENCE_INVALID');
  });

  it('denies stale source head, change-set, and visibility independently', async () => {
    const fixture = await gateFixture();
    const staleHead = sourceFixture(taskWorkspace('TASK-A', 'f'.repeat(40)));
    expect(evaluate({ ...fixture, current: staleHead }).reasons).toContain('STALE_SOURCE');
    expect(evaluate({ ...fixture, current: { ...fixture.current, changeSetSha256: '9'.repeat(64) } }).reasons)
      .toContain('STALE_SOURCE');
    expect(evaluate({ ...fixture, visibility: '8'.repeat(64) }).reasons).toContain('STALE_VISIBILITY');
  });

  it.each(['staged', 'unstaged', 'untracked'] as const)('denies %s source', async (kind) => {
    const fixture = await gateFixture();
    const current = dirty(fixture.current, kind);
    expect(evaluate({ ...fixture, current }).reasons).toContain('UNCOMMITTED_SOURCE');
  });

  it('denies conflicts and no committed changes', async () => {
    const fixture = await gateFixture();
    const conflict = { ...fixture.current, hasConflicts: true, conflicts: [{ path: 'task.txt', kind: 'u' as const, fields: [] }] };
    expect(evaluate({ ...fixture, current: conflict }).reasons).toContain('CONFLICTS');
    const noChanges = { ...fixture.current, committed: { changes: [], patch: { status: 'not-requested' as const } } };
    expect(evaluate({ ...fixture, current: noChanges }).reasons).toContain('NO_COMMITTED_CHANGES');
  });

  it('orders reasons deterministically and computes a stable policy-sensitive digest', async () => {
    const fixture = await gateFixture({ outcome: 'failed', verdict: 'REQUEST_REVISION' });
    const current = { ...dirty(fixture.current, 'untracked'), hasConflicts: true,
      conflicts: [{ path: 'task.txt', kind: 'u' as const, fields: [] }],
      committed: { changes: [], patch: { status: 'not-requested' as const } } };
    const first = evaluate({ ...fixture, current }, { requiredPhases: ['build'], requiredCommandIds: ['missing'] });
    const second = evaluate({ ...fixture, current }, { requiredPhases: ['build'], requiredCommandIds: ['missing'] });
    expect(first.reasons).toEqual([
      'BUILD_EVIDENCE_NOT_PASSED', 'REQUIRED_PHASE_NOT_PASSED', 'REQUIRED_COMMAND_NOT_PASSED',
      'REVIEW_NOT_ACCEPTED', 'UNCOMMITTED_SOURCE', 'CONFLICTS', 'NO_COMMITTED_CHANGES',
    ]);
    expect(second.mergeGateSha256).toBe(first.mergeGateSha256);
    expect(evaluate(fixture, { requiredPhases: ['test'] }).mergeGateSha256).not.toBe(evaluate(fixture).mergeGateSha256);
  });

  it('snapshots and freezes policy before caller mutation', async () => {
    const fixture = await gateFixture();
    const phases: ('build' | 'test')[] = ['test'];
    const ids = ['test'];
    const input = snapshotMergeGateInputs(fixture.build, fixture.review,
      { requiredPhases: phases, requiredCommandIds: ids });
    phases[0] = 'build'; ids[0] = 'missing';
    expect(input.policy).toEqual({ requiredPhases: ['test'], requiredCommandIds: ['test'] });
    deepFrozen(input);
  });
});

interface GateFixture {
  readonly build: BuildTestEvidence;
  readonly review: ReviewEvidence;
  readonly current: GitWorkspaceChangeSnapshot;
  readonly visibility: string;
}
async function gateFixture(options: { commandId?: string; phase?: 'build' | 'test'; outcome?: 'passed' | 'failed'; verdict?: 'ACCEPT' | 'REQUEST_REVISION' | 'BLOCK' } = {}): Promise<GateFixture> {
  const { evidence, current } = await evidenceFixture(options);
  return { build: evidence, review: createReviewEvidence(evidence, reviewDecision(options.verdict ?? 'ACCEPT')),
    current, visibility: visibilitySha256 };
}
function reviewDecision(verdict: 'ACCEPT' | 'REQUEST_REVISION' | 'BLOCK') {
  const findings = verdict === 'BLOCK'
    ? [{ code: 'BLOCKER', severity: 'blocker' as const, message: 'blocked' }]
    : verdict === 'REQUEST_REVISION'
      ? [{ code: 'REVISION', severity: 'warning' as const, message: 'revise' }]
      : [];
  return { reviewId: 'review', reviewerId: 'reviewer', verdict, summary: 'review summary', findings };
}
function evaluate(fixture: GateFixture, policy: { requiredPhases?: readonly ('build' | 'test')[]; requiredCommandIds?: readonly string[] } = {}) {
  return evaluateMergeGateSnapshot('TASK-A', fixture.current,
    { sourceVisibilitySha256: fixture.visibility }, snapshotMergeGateInputs(fixture.build, fixture.review, policy));
}
function dirty(current: GitWorkspaceChangeSnapshot, kind: 'staged' | 'unstaged' | 'untracked'): GitWorkspaceChangeSnapshot {
  const change = { path: 'dirty.txt', status: 'A', oldMode: '000000', newMode: '100644', oldObjectId: '0'.repeat(40),
    newObjectId: 'f'.repeat(40), binary: false, addedLines: 1, deletedLines: 0 };
  if (kind === 'untracked') return { ...current, untracked: [{ path: 'dirty.txt', kind: 'regular', size: 1, sha256: '7'.repeat(64) }] };
  return { ...current, [kind]: { changes: [change], patch: { status: 'not-requested' as const } } };
}
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) deepFrozen(nested);
  }
}
