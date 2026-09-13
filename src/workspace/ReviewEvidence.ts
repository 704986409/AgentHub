import { createHash } from 'node:crypto';
import path from 'node:path';

import { snapshotBuildTestEvidence, type BuildTestEvidence } from './BuildTestEvidenceCollector.js';
import { canonicalChangeState } from './GitWorkspaceChangeCapture.js';

export type ReviewVerdict = 'ACCEPT' | 'REQUEST_REVISION' | 'BLOCK';
export type ReviewFindingSeverity = 'info' | 'warning' | 'error' | 'blocker';

export interface ReviewFindingInput {
  readonly code: string;
  readonly severity: ReviewFindingSeverity;
  readonly message: string;
  readonly path?: string;
}
export interface ReviewDecisionInput {
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings?: readonly ReviewFindingInput[];
}
export type ReviewFinding = ReviewFindingInput;
export interface ReviewEvidence {
  readonly version: 1;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly taskId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changeSetSha256: string;
  readonly sourceVisibilitySha256: string;
  readonly buildTestEvidenceSha256: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly reviewEvidenceSha256: string;
}

export class ReviewEvidenceError extends Error {
  public constructor(public readonly code: 'INVALID_BUILD_EVIDENCE' | 'INVALID_REVIEW_DECISION' | 'INVALID_REVIEW_EVIDENCE') {
    super(code);
    this.name = 'ReviewEvidenceError';
  }
}

const shaPattern = /^[0-9a-f]{64}$/u;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const findingCodePattern = /^[A-Za-z0-9._-]{1,128}$/u;
const verdicts = new Set<ReviewVerdict>(['ACCEPT', 'REQUEST_REVISION', 'BLOCK']);
const severities = new Set<ReviewFindingSeverity>(['info', 'warning', 'error', 'blocker']);

export function createReviewEvidence(buildValue: BuildTestEvidence, decisionValue: ReviewDecisionInput): ReviewEvidence {
  let build: BuildTestEvidence;
  try { build = snapshotBuildTestEvidence(buildValue); } catch {
    throw new ReviewEvidenceError('INVALID_BUILD_EVIDENCE');
  }
  const decision = snapshotDecision(decisionValue);
  const base: Omit<ReviewEvidence, 'reviewEvidenceSha256'> = {
    version: 1,
    reviewId: decision.reviewId,
    reviewerId: decision.reviewerId,
    taskId: build.taskId,
    branchName: build.branchName,
    baseCommit: build.baseCommit,
    headCommit: build.headCommit,
    changeSetSha256: build.changeSetSha256,
    sourceVisibilitySha256: build.sourceVisibilitySha256,
    buildTestEvidenceSha256: build.evidenceSha256,
    verdict: decision.verdict,
    summary: decision.summary,
    findings: decision.findings,
  };
  return deepFreeze({ ...base, reviewEvidenceSha256: reviewEvidenceDigest(base) });
}

export function snapshotReviewEvidence(value: unknown): ReviewEvidence {
  if (!isRecord(value)) throw new ReviewEvidenceError('INVALID_REVIEW_EVIDENCE');
  const version = value.version;
  const reviewId = value.reviewId;
  const reviewerId = value.reviewerId;
  const taskId = value.taskId;
  const branchName = value.branchName;
  const baseCommit = value.baseCommit;
  const headCommit = value.headCommit;
  const changeSetSha256 = value.changeSetSha256;
  const sourceVisibilitySha256 = value.sourceVisibilitySha256;
  const buildTestEvidenceSha256 = value.buildTestEvidenceSha256;
  const verdict = value.verdict;
  const summary = value.summary;
  const rawFindings = value.findings;
  const reviewEvidenceSha256 = value.reviewEvidenceSha256;
  if (version !== 1 || !validReviewIdentity(reviewId) || !validReviewIdentity(reviewerId) || !validTaskId(taskId) ||
    !validBranch(branchName) || !validOid(baseCommit) || !validOid(headCommit) || !validSha(changeSetSha256) ||
    !validSha(sourceVisibilitySha256) || !validSha(buildTestEvidenceSha256) || !validVerdict(verdict) ||
    !validText(summary, 16 * 1024) || !Array.isArray(rawFindings) || rawFindings.length > 256 ||
    !validSha(reviewEvidenceSha256)) throw new ReviewEvidenceError('INVALID_REVIEW_EVIDENCE');
  const findings = Object.freeze(rawFindings.map((finding) => snapshotFinding(finding, 'INVALID_REVIEW_EVIDENCE')));
  validateSemantics(verdict, findings, 'INVALID_REVIEW_EVIDENCE');
  const base: Omit<ReviewEvidence, 'reviewEvidenceSha256'> = { version, reviewId, reviewerId, taskId, branchName,
    baseCommit, headCommit, changeSetSha256, sourceVisibilitySha256, buildTestEvidenceSha256,
    verdict, summary, findings };
  if (reviewEvidenceDigest(base) !== reviewEvidenceSha256) throw new ReviewEvidenceError('INVALID_REVIEW_EVIDENCE');
  return deepFreeze({ ...base, reviewEvidenceSha256 });
}

function snapshotDecision(value: unknown): Readonly<ReviewDecisionInput & { findings: readonly ReviewFinding[] }> {
  if (!isRecord(value)) throw new ReviewEvidenceError('INVALID_REVIEW_DECISION');
  const reviewId = value.reviewId;
  const reviewerId = value.reviewerId;
  const verdict = value.verdict;
  const summary = value.summary;
  const rawFindings = value.findings;
  if (!validReviewIdentity(reviewId) || !validReviewIdentity(reviewerId) || !validVerdict(verdict) || !validText(summary, 16 * 1024) ||
    (rawFindings !== undefined && !Array.isArray(rawFindings))) throw new ReviewEvidenceError('INVALID_REVIEW_DECISION');
  const findingsInput = rawFindings === undefined ? [] : rawFindings;
  if (findingsInput.length > 256) throw new ReviewEvidenceError('INVALID_REVIEW_DECISION');
  const findings = Object.freeze(findingsInput.map((finding) => snapshotFinding(finding, 'INVALID_REVIEW_DECISION')));
  validateSemantics(verdict, findings, 'INVALID_REVIEW_DECISION');
  return deepFreeze({ reviewId, reviewerId, verdict, summary, findings });
}

function snapshotFinding(value: unknown, code: 'INVALID_REVIEW_DECISION' | 'INVALID_REVIEW_EVIDENCE'): ReviewFinding {
  if (!isRecord(value)) throw new ReviewEvidenceError(code);
  const findingCode = value.code;
  const severity = value.severity;
  const message = value.message;
  const findingPath = value.path;
  if (!validFindingCode(findingCode) || !validSeverity(severity) || !validText(message, 8 * 1024) ||
    (findingPath !== undefined && (!validText(findingPath, 4096) || !safeMetadataPath(findingPath)))) {
    throw new ReviewEvidenceError(code);
  }
  return Object.freeze({ code: findingCode, severity, message, ...(findingPath === undefined ? {} : { path: findingPath }) });
}

function validateSemantics(verdict: ReviewVerdict, findings: readonly ReviewFinding[], code: 'INVALID_REVIEW_DECISION' | 'INVALID_REVIEW_EVIDENCE'): void {
  if (verdict === 'ACCEPT' && findings.some((finding) => finding.severity === 'error' || finding.severity === 'blocker')) {
    throw new ReviewEvidenceError(code);
  }
  if (verdict === 'BLOCK' && !findings.some((finding) => finding.severity === 'blocker')) {
    throw new ReviewEvidenceError(code);
  }
}

function reviewEvidenceDigest(value: Omit<ReviewEvidence, 'reviewEvidenceSha256'>): string {
  return createHash('sha256').update(`AgentHub.ReviewEvidence.v1\0${canonicalChangeState(value)}`).digest('hex');
}
function safeMetadataPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value) || path.isAbsolute(value)) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}
function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= maxBytes;
}
function validReviewIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !value.includes('\0');
}
function validFindingCode(value: unknown): value is string {
  return typeof value === 'string' && findingCodePattern.test(value);
}
function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value) &&
    !value.includes('..') && !value.endsWith('.') &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}
function validBranch(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function validOid(value: unknown): value is string { return typeof value === 'string' && oidPattern.test(value); }
function validSha(value: unknown): value is string { return typeof value === 'string' && shaPattern.test(value); }
function validVerdict(value: unknown): value is ReviewVerdict { return typeof value === 'string' && verdicts.has(value as ReviewVerdict); }
function validSeverity(value: unknown): value is ReviewFindingSeverity { return typeof value === 'string' && severities.has(value as ReviewFindingSeverity); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
