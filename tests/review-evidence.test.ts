import { describe, expect, it } from 'vitest';

import { createReviewEvidence, ReviewEvidenceError, type ReviewFindingInput } from '../src/index.js';
import { snapshotReviewEvidence } from '../src/workspace/ReviewEvidence.js';
import { evidenceFixture } from './merge-gate-fixtures.js';

describe('ReviewEvidence', () => {
  it('creates ACCEPT, REQUEST_REVISION, and BLOCK evidence bound exactly to BuildTestEvidence', async () => {
    const { evidence } = await evidenceFixture();
    const accept = createReviewEvidence(evidence, decision('ACCEPT', []));
    const revision = createReviewEvidence(evidence, decision('REQUEST_REVISION', [finding('warning')]));
    const block = createReviewEvidence(evidence, decision('BLOCK', [finding('blocker')]));
    expect(accept).toMatchObject({ taskId: evidence.taskId, branchName: evidence.branchName,
      buildTestEvidenceSha256: evidence.evidenceSha256, verdict: 'ACCEPT' });
    expect(revision.verdict).toBe('REQUEST_REVISION');
    expect(block.verdict).toBe('BLOCK');
    for (const value of [accept, revision, block]) {
      expect(snapshotReviewEvidence(JSON.parse(JSON.stringify(value)))).toEqual(value);
      deepFrozen(value);
    }
  });

  it('rejects contradictory ACCEPT and BLOCK decisions', async () => {
    const { evidence } = await evidenceFixture();
    expect(() => createReviewEvidence(evidence, decision('ACCEPT', [finding('error')]))).toThrow(ReviewEvidenceError);
    expect(() => createReviewEvidence(evidence, decision('ACCEPT', [finding('blocker')]))).toThrow(ReviewEvidenceError);
    expect(() => createReviewEvidence(evidence, decision('BLOCK', [finding('warning')]))).toThrow(ReviewEvidenceError);
  });

  it('snapshots decision and findings through getters exactly once', async () => {
    const { evidence } = await evidenceFixture();
    let findingsReads = 0;
    let severityReads = 0;
    const rawFinding = Object.defineProperty({ code: 'ACTION', message: 'fix it' }, 'severity', {
      enumerable: true, get: () => { severityReads++; return severityReads === 1 ? 'warning' : 'blocker'; },
    });
    const rawDecision = Object.defineProperty({ reviewId: 'review 1', reviewerId: 'reviewer@example',
      verdict: 'REQUEST_REVISION', summary: 'needs a change' }, 'findings', {
      enumerable: true, get: () => { findingsReads++; return [rawFinding]; },
    });
    const result = createReviewEvidence(evidence, rawDecision as never);
    expect({ findingsReads, severityReads }).toEqual({ findingsReads: 1, severityReads: 1 });
    expect(result.findings[0]?.severity).toBe('warning');
  });

  it('owns caller arrays and objects after creation', async () => {
    const { evidence } = await evidenceFixture();
    const raw = { code: 'WARN', severity: 'warning' as const, message: 'before', path: 'src/file.ts' };
    const findings: ReviewFindingInput[] = [raw];
    const result = createReviewEvidence(evidence, decision('REQUEST_REVISION', findings));
    raw.message = 'after'; findings.push(finding('error'));
    expect(result.findings).toEqual([{ code: 'WARN', severity: 'warning', message: 'before', path: 'src/file.ts' }]);
  });

  it('enforces identity, summary, finding, and collection bounds', async () => {
    const { evidence } = await evidenceFixture();
    for (const invalid of [
      { ...decision('ACCEPT', []), reviewId: '' },
      { ...decision('ACCEPT', []), reviewerId: 'x'.repeat(129) },
      { ...decision('ACCEPT', []), summary: 'x'.repeat(16 * 1024 + 1) },
      { ...decision('REQUEST_REVISION', []), findings: Array.from({ length: 257 }, () => finding('warning')) },
      { ...decision('REQUEST_REVISION', []), findings: [{ ...finding('warning'), code: 'bad code' }] },
      { ...decision('REQUEST_REVISION', []), findings: [{ ...finding('warning'), message: 'x'.repeat(8 * 1024 + 1) }] },
    ]) expect(() => createReviewEvidence(evidence, invalid as never)).toThrow(ReviewEvidenceError);
  });

  it.each(['/absolute.ts', '\\server\\share', 'C:\\drive.ts', '../escape', 'src/../escape', './local'])('rejects unsafe finding path %s', async (unsafePath) => {
    const { evidence } = await evidenceFixture();
    expect(() => createReviewEvidence(evidence, decision('REQUEST_REVISION', [{ ...finding('warning'), path: unsafePath }])))
      .toThrow(ReviewEvidenceError);
  });

  it('has a stable digest that changes with verdict, findings, or BuildTestEvidence binding', async () => {
    const first = await evidenceFixture();
    const second = await evidenceFixture({ commandId: 'different' });
    const base = createReviewEvidence(first.evidence, decision('ACCEPT', []));
    expect(createReviewEvidence(first.evidence, decision('ACCEPT', [])).reviewEvidenceSha256).toBe(base.reviewEvidenceSha256);
    expect(createReviewEvidence(first.evidence, decision('REQUEST_REVISION', [finding('warning')])).reviewEvidenceSha256)
      .not.toBe(base.reviewEvidenceSha256);
    expect(createReviewEvidence(first.evidence, decision('ACCEPT', [finding('info')])).reviewEvidenceSha256)
      .not.toBe(base.reviewEvidenceSha256);
    expect(createReviewEvidence(second.evidence, decision('ACCEPT', [])).reviewEvidenceSha256)
      .not.toBe(base.reviewEvidenceSha256);
  });

  it('rejects tampered BuildTestEvidence and deserialized ReviewEvidence', async () => {
    const { evidence } = await evidenceFixture();
    expect(() => createReviewEvidence({ ...evidence, headCommit: 'f'.repeat(40) }, decision('ACCEPT', [])))
      .toThrowError(ReviewEvidenceError);
    expect(() => createReviewEvidence({ ...evidence, headCommit: 'f'.repeat(40) }, decision('ACCEPT', []))).toThrowError(ReviewEvidenceError);
    const review = createReviewEvidence(evidence, decision('ACCEPT', []));
    expect(() => snapshotReviewEvidence({ ...review, verdict: 'REQUEST_REVISION' })).toThrowError(ReviewEvidenceError);
  });
});

function decision(verdict: 'ACCEPT' | 'REQUEST_REVISION' | 'BLOCK', findings: readonly ReviewFindingInput[]) {
  return { reviewId: 'review 1', reviewerId: 'reviewer@example', verdict, summary: 'bounded review summary', findings };
}
function finding(severity: 'info' | 'warning' | 'error' | 'blocker') {
  return { code: `FINDING.${severity}`, severity, message: `${severity} finding` };
}
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) deepFrozen(nested);
  }
}
