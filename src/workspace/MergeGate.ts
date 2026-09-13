import { createHash } from 'node:crypto';

import { snapshotBuildTestEvidence, type BuildTestEvidence, type EvidenceCommandPhase } from './BuildTestEvidenceCollector.js';
import { canonicalChangeState, type GitWorkspaceChangeSnapshot } from './GitWorkspaceChangeCapture.js';
import { snapshotReviewEvidence, type ReviewEvidence } from './ReviewEvidence.js';
import type { GitEvidenceContextSnapshot } from './GitEvidenceContext.js';

export interface MergeGatePolicy {
  readonly requiredPhases?: readonly EvidenceCommandPhase[];
  readonly requiredCommandIds?: readonly string[];
}
export type MergeGateReason =
  | 'BUILD_EVIDENCE_INVALID'
  | 'BUILD_EVIDENCE_NOT_PASSED'
  | 'REQUIRED_PHASE_NOT_PASSED'
  | 'REQUIRED_COMMAND_NOT_PASSED'
  | 'REVIEW_EVIDENCE_INVALID'
  | 'REVIEW_BINDING_MISMATCH'
  | 'REVIEW_NOT_ACCEPTED'
  | 'STALE_SOURCE'
  | 'STALE_VISIBILITY'
  | 'UNCOMMITTED_SOURCE'
  | 'CONFLICTS'
  | 'NO_COMMITTED_CHANGES';
export interface MergeGateDecision {
  readonly version: 1;
  readonly taskId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changeSetSha256: string;
  readonly sourceVisibilitySha256: string;
  readonly buildTestEvidenceSha256: string;
  readonly reviewEvidenceSha256: string;
  readonly eligible: boolean;
  readonly reasons: readonly MergeGateReason[];
  readonly mergeGateSha256: string;
}

type Validated<T> = { readonly valid: true; readonly value: T } | { readonly valid: false };
export interface MergeGateInputSnapshot {
  readonly build: Validated<BuildTestEvidence>;
  readonly review: Validated<ReviewEvidence>;
  readonly policy: Readonly<{ requiredPhases: readonly EvidenceCommandPhase[]; requiredCommandIds: readonly string[] }>;
}

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const digestPattern = /^[0-9a-f]{64}$/iu;
const reasonOrder: readonly MergeGateReason[] = Object.freeze([
  'BUILD_EVIDENCE_INVALID', 'BUILD_EVIDENCE_NOT_PASSED', 'REQUIRED_PHASE_NOT_PASSED',
  'REQUIRED_COMMAND_NOT_PASSED', 'REVIEW_EVIDENCE_INVALID', 'REVIEW_BINDING_MISMATCH',
  'REVIEW_NOT_ACCEPTED', 'STALE_SOURCE', 'STALE_VISIBILITY', 'UNCOMMITTED_SOURCE', 'CONFLICTS',
  'NO_COMMITTED_CHANGES',
]);
const reasonSet = new Set<string>(reasonOrder);

export function snapshotMergeGateInputs(buildValue: unknown, reviewValue: unknown, policyValue: unknown = {}): MergeGateInputSnapshot {
  const policy = snapshotMergeGatePolicy(policyValue);
  let build: Validated<BuildTestEvidence>;
  let review: Validated<ReviewEvidence>;
  try { build = { valid: true, value: snapshotBuildTestEvidence(buildValue) }; } catch { build = { valid: false }; }
  try { review = { valid: true, value: snapshotReviewEvidence(reviewValue) }; } catch { review = { valid: false }; }
  return deepFreeze({ build, review, policy });
}

export function snapshotMergeGatePolicy(value: unknown = {}): MergeGateInputSnapshot['policy'] {
  if (!isRecord(value)) throw new TypeError('Invalid merge gate policy');
  const rawPhases = value.requiredPhases;
  const rawIds = value.requiredCommandIds;
  if (rawPhases !== undefined && !Array.isArray(rawPhases)) throw new TypeError('Invalid merge gate policy');
  if (rawIds !== undefined && !Array.isArray(rawIds)) throw new TypeError('Invalid merge gate policy');
  const phases = rawPhases === undefined ? [] : rawPhases.slice();
  const ids = rawIds === undefined ? [] : rawIds.slice();
  if (phases.length > 2 || !phases.every((phase): phase is EvidenceCommandPhase => phase === 'build' || phase === 'test') ||
    new Set(phases).size !== phases.length || ids.length > 256 ||
    !ids.every((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(id)) ||
    new Set(ids).size !== ids.length) throw new TypeError('Invalid merge gate policy');
  return deepFreeze({ requiredPhases: Object.freeze(phases), requiredCommandIds: Object.freeze(ids) });
}

/** Value-validates a possibly deserialized gate under the exact snapshotted policy used to create it. */
export function snapshotMergeGateDecision(value: unknown, policyValue: unknown = {}): MergeGateDecision {
  const policy = snapshotMergeGatePolicy(policyValue);
  if (!isRecord(value)) throw new TypeError('Invalid merge gate decision');
  const version = value.version;
  const taskId = value.taskId;
  const branchName = value.branchName;
  const baseCommit = value.baseCommit;
  const headCommit = value.headCommit;
  const changeSetSha256 = value.changeSetSha256;
  const sourceVisibilitySha256 = value.sourceVisibilitySha256;
  const buildTestEvidenceSha256 = value.buildTestEvidenceSha256;
  const reviewEvidenceSha256 = value.reviewEvidenceSha256;
  const eligible = value.eligible;
  const rawReasons = value.reasons;
  const mergeGateSha256 = value.mergeGateSha256;
  if (version !== 1 || !validTaskId(taskId) || !validBranch(branchName) || !validOid(baseCommit) || !validOid(headCommit) ||
    !validDigest(changeSetSha256) || !validDigest(sourceVisibilitySha256) || !validDigest(buildTestEvidenceSha256) ||
    !validDigest(reviewEvidenceSha256) || typeof eligible !== 'boolean' || !Array.isArray(rawReasons) ||
    !validDigest(mergeGateSha256)) throw new TypeError('Invalid merge gate decision');
  const reasons = rawReasons.slice();
  if (!reasons.every((reason): reason is MergeGateReason => typeof reason === 'string' && reasonSet.has(reason)) ||
    reasons.length !== new Set(reasons).size || reasons.some((reason, index) => reasonOrder.indexOf(reason) <= reasonOrder.indexOf(reasons[index - 1] as MergeGateReason)) ||
    eligible !== (reasons.length === 0)) throw new TypeError('Invalid merge gate decision');
  const base: Omit<MergeGateDecision, 'mergeGateSha256'> = { version, taskId, branchName, baseCommit, headCommit,
    changeSetSha256, sourceVisibilitySha256, buildTestEvidenceSha256, reviewEvidenceSha256, eligible,
    reasons: Object.freeze(reasons) };
  if (mergeGateDigest(base, policy) !== mergeGateSha256) throw new TypeError('Invalid merge gate decision');
  return deepFreeze({ ...base, mergeGateSha256 });
}

/** Pure policy evaluation over trusted current captures and entry-snapshotted evidence. */
export function evaluateMergeGateSnapshot(
  taskId: string,
  current: GitWorkspaceChangeSnapshot,
  context: GitEvidenceContextSnapshot,
  input: MergeGateInputSnapshot,
): MergeGateDecision {
  const found = new Set<MergeGateReason>();
  const build = input.build.valid ? input.build.value : undefined;
  const review = input.review.valid ? input.review.value : undefined;
  if (build === undefined) found.add('BUILD_EVIDENCE_INVALID');
  else {
    if (!buildPassed(build)) found.add('BUILD_EVIDENCE_NOT_PASSED');
    if (input.policy.requiredPhases.some((phase) => build[phase] !== 'passed')) found.add('REQUIRED_PHASE_NOT_PASSED');
    if (input.policy.requiredCommandIds.some((id) => !requiredCommandPassed(build, id))) found.add('REQUIRED_COMMAND_NOT_PASSED');
  }
  if (review === undefined) found.add('REVIEW_EVIDENCE_INVALID');
  if (build !== undefined && review !== undefined) {
    if (!reviewBound(build, review)) found.add('REVIEW_BINDING_MISMATCH');
    if (review.verdict !== 'ACCEPT') found.add('REVIEW_NOT_ACCEPTED');
  }
  if (build !== undefined && (build.taskId !== taskId || build.taskId !== current.taskId ||
    build.branchName !== current.branchName || build.baseCommit !== current.baseCommit ||
    build.headCommit !== current.headCommit || build.changeSetSha256 !== current.changeSetSha256)) found.add('STALE_SOURCE');
  if (build !== undefined && build.sourceVisibilitySha256 !== context.sourceVisibilitySha256) found.add('STALE_VISIBILITY');
  if (current.staged.changes.length > 0 || current.unstaged.changes.length > 0 || current.untracked.length > 0) {
    found.add('UNCOMMITTED_SOURCE');
  }
  if (current.hasConflicts || current.conflicts.length > 0) found.add('CONFLICTS');
  if (current.committed.changes.length === 0) found.add('NO_COMMITTED_CHANGES');
  const reasons = Object.freeze(reasonOrder.filter((reason) => found.has(reason)));
  const base: Omit<MergeGateDecision, 'mergeGateSha256'> = {
    version: 1, taskId: current.taskId, branchName: current.branchName, baseCommit: current.baseCommit,
    headCommit: current.headCommit, changeSetSha256: current.changeSetSha256,
    sourceVisibilitySha256: context.sourceVisibilitySha256,
    buildTestEvidenceSha256: build?.evidenceSha256 ?? '0'.repeat(64),
    reviewEvidenceSha256: review?.reviewEvidenceSha256 ?? '0'.repeat(64), eligible: reasons.length === 0, reasons,
  };
  return deepFreeze({ ...base, mergeGateSha256: mergeGateDigest(base, input.policy) });
}

function mergeGateDigest(base: Omit<MergeGateDecision, 'mergeGateSha256'>, policy: MergeGateInputSnapshot['policy']): string {
  return createHash('sha256').update(`AgentHub.MergeGateDecision.v1\0${canonicalChangeState({ ...base, policy })}`).digest('hex');
}
function buildPassed(build: BuildTestEvidence): boolean {
  return build.outcome === 'passed' && build.commands.length > 0 && build.commands.every((command) =>
    command.outcome === 'passed' && command.exitCode === 0 && command.cleanupFailed !== true && command.sourceStable &&
    command.sourceAfter.status === 'captured' && command.sourceAfter.stable &&
    command.sourceAfter.changeSetSha256 === build.changeSetSha256 &&
    command.sourceVisibilityAfter.status === 'captured' && command.sourceVisibilityAfter.stable &&
    command.sourceVisibilityAfter.sourceVisibilitySha256 === build.sourceVisibilitySha256);
}
function requiredCommandPassed(build: BuildTestEvidence, id: string): boolean {
  const commands = build.commands.filter((command) => command.commandId === id);
  return commands.length === 1 && commands[0]?.outcome === 'passed' && commands[0].cleanupFailed !== true &&
    commands[0].sourceStable && commands[0].sourceAfter.status === 'captured' && commands[0].sourceAfter.stable &&
    commands[0].sourceVisibilityAfter.status === 'captured' && commands[0].sourceVisibilityAfter.stable;
}
function reviewBound(build: BuildTestEvidence, review: ReviewEvidence): boolean {
  return review.taskId === build.taskId && review.branchName === build.branchName &&
    review.baseCommit === build.baseCommit && review.headCommit === build.headCommit &&
    review.changeSetSha256 === build.changeSetSha256 && review.sourceVisibilitySha256 === build.sourceVisibilitySha256 &&
    review.buildTestEvidenceSha256 === build.evidenceSha256;
}
function validTaskId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value); }
function validBranch(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function validOid(value: unknown): value is string { return typeof value === 'string' && oidPattern.test(value); }
function validDigest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
