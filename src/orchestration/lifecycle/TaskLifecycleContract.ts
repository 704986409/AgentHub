import { createHash } from 'node:crypto';

import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import type { AgentProviderTurnResult } from '../../runtime/providers/AgentProvider.js';
import {
  createReviewEvidence,
  type BuildTestEvidence,
  type BuildTestEvidencePlan,
  type GitWorkspaceChangeSnapshot,
  type MergeGateDecision,
  type MergeGatePolicy,
  type ReviewDecisionInput,
  type ReviewEvidence,
  type TaskCommitResult,
  type TaskMergeResult,
} from '../../workspace/index.js';
import {
  snapshotBuildTestEvidence,
  snapshotBuildTestEvidencePlan,
  snapshotBuildTestEvidenceOptions,
} from '../../workspace/BuildTestEvidenceCollector.js';
import { canonicalChangeState, validateChangePath } from '../../workspace/GitWorkspaceChangeCapture.js';
import { snapshotMergeGatePolicy } from '../../workspace/MergeGate.js';
import {
  snapshotAssignmentDispatchResult,
  snapshotAssignmentTurnResult,
  type AssignmentDispatchResult,
} from '../AssignmentDispatcher.js';

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const shaPattern = /^[0-9a-f]{64}$/u;

export type TaskLifecycleErrorCode =
  | 'TASK_LIFECYCLE_INVALID_REQUEST' | 'TASK_LIFECYCLE_TASK_BUSY'
  | 'TASK_LIFECYCLE_INVALID_DISPATCH_RESULT' | 'TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'
  | 'TASK_LIFECYCLE_STALE_EXECUTION' | 'TASK_LIFECYCLE_STALE_SOURCE'
  | 'TASK_LIFECYCLE_STALE_PROFILE' | 'TASK_LIFECYCLE_UNSUPPORTED_TURN_PROTOCOL'
  | 'TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED' | 'TASK_LIFECYCLE_COMMIT_FAILED'
  | 'TASK_LIFECYCLE_EVIDENCE_FAILED' | 'TASK_LIFECYCLE_REVIEW_TRANSITION_FAILED'
  | 'TASK_LIFECYCLE_REVISION_FAILED' | 'TASK_LIFECYCLE_GATE_DENIED'
  | 'TASK_LIFECYCLE_MERGE_FAILED' | 'TASK_LIFECYCLE_RECONCILIATION_REQUIRED'
  | 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED';

export class TaskLifecycleError extends Error {
  public readonly mergeResult: TaskMergeResult | undefined;
  public constructor(public readonly code: TaskLifecycleErrorCode, mergeResult?: TaskMergeResult) {
    super(code); this.name = 'TaskLifecycleError'; this.mergeResult = mergeResult;
  }
}

export interface PrepareTaskReviewRequest {
  readonly dispatchResult: AssignmentDispatchResult;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions?: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
}
export interface ApplyTaskReviewRequest {
  readonly reviewBundle: TaskReviewBundle;
  readonly decision: ReviewDecisionInput;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions?: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  readonly targetBranch?: string;
  readonly mergePolicy?: MergeGatePolicy;
  readonly allowNoChangeCompletion?: boolean;
}
export interface TaskReviewBundle {
  readonly version: 1;
  readonly taskId: string; readonly projectId: string; readonly agentId: string;
  readonly assignmentId: string; readonly providerId: string; readonly reservationSha256: string;
  readonly dispatchSha256: string; readonly executionProfileSha256: string;
  readonly taskCommit: TaskCommitResult; readonly buildTestEvidence: BuildTestEvidence;
  readonly source: GitWorkspaceChangeSnapshot; readonly workerResult: AgentHubWorkerResult;
  readonly reviewBundleSha256: string;
}
interface LifecycleBase { readonly lifecycleSha256: string }
export type TaskLifecyclePreparationResult =
  | (LifecycleBase & { readonly outcome: 'review-ready'; readonly reviewBundle: TaskReviewBundle; readonly reviewEvidence?: ReviewEvidence })
  | (LifecycleBase & { readonly outcome: 'blocked' | 'waiting-input'; readonly taskId: string; readonly assignmentId: string })
  | (LifecycleBase & { readonly outcome: 'failed'; readonly taskId: string; readonly assignmentId: string; readonly reviewEvidence?: ReviewEvidence });
export type TaskLifecycleReviewResult =
  | TaskLifecyclePreparationResult
  | (LifecycleBase & { readonly outcome: 'merge-denied'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence; readonly mergeGate: MergeGateDecision })
  | (LifecycleBase & { readonly outcome: 'completed'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence; readonly mergeGate: MergeGateDecision; readonly mergeResult: TaskMergeResult })
  | (LifecycleBase & { readonly outcome: 'completed-no-change'; readonly taskId: string; readonly reviewEvidence: ReviewEvidence });

export type PrepareTaskReviewSnapshot = ReturnType<typeof snapshotPrepareRequest>;
export type ApplyTaskReviewSnapshot = ReturnType<typeof snapshotApplyRequest>;

export function snapshotPrepareRequest(value: unknown): { readonly dispatch: Readonly<AssignmentDispatchResult>;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number } } {
  if (!isRecord(value) || !hasExactKeys(value, ['dispatchResult', 'buildTestPlan'], ['evidenceOptions'])) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  let dispatch: Readonly<AssignmentDispatchResult>;
  try { dispatch = snapshotAssignmentDispatchResult(value.dispatchResult); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_DISPATCH_RESULT'); }
  let plan: BuildTestEvidencePlan;
  let options: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  try {
    plan = snapshotBuildTestEvidencePlan(value.buildTestPlan);
    options = snapshotBuildTestEvidenceOptions(value.evidenceOptions ?? {});
  } catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST'); }
  return deepFreeze({ dispatch, buildTestPlan: plan, evidenceOptions: options });
}

export function snapshotApplyRequest(value: unknown): { readonly reviewBundle: TaskReviewBundle;
  readonly decision: ReviewDecisionInput; readonly buildTestPlan: BuildTestEvidencePlan;
  readonly evidenceOptions: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  readonly targetBranch?: string; readonly mergePolicy: MergeGatePolicy;
  readonly allowNoChangeCompletion: boolean } {
  if (!isRecord(value) || !hasExactKeys(value, ['reviewBundle', 'decision', 'buildTestPlan'],
    ['evidenceOptions', 'targetBranch', 'mergePolicy', 'allowNoChangeCompletion'])) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  let bundle: TaskReviewBundle;
  try { bundle = snapshotTaskReviewBundle(value.reviewBundle); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  let plan: BuildTestEvidencePlan;
  let options: { readonly maxOutputBytes?: number; readonly maxPreviewBytes?: number };
  let policy: MergeGatePolicy;
  let decision: ReviewDecisionInput;
  try {
    plan = snapshotBuildTestEvidencePlan(value.buildTestPlan);
    options = snapshotBuildTestEvidenceOptions(value.evidenceOptions ?? {});
    policy = snapshotMergeGatePolicy(value.mergePolicy ?? {});
    const validated = createReviewEvidence(bundle.buildTestEvidence, value.decision as ReviewDecisionInput);
    decision = deepFreeze({ reviewId: validated.reviewId, reviewerId: validated.reviewerId,
      verdict: validated.verdict, summary: validated.summary, findings: validated.findings });
  } catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST'); }
  const targetBranch = value.targetBranch;
  if (targetBranch !== undefined && (!boundedString(targetBranch, 512, false) || /[\0\r\n]/u.test(targetBranch))) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  if (value.allowNoChangeCompletion !== undefined && typeof value.allowNoChangeCompletion !== 'boolean') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  return deepFreeze({ reviewBundle: bundle, decision,
    buildTestPlan: plan, evidenceOptions: options, ...(targetBranch === undefined ? {} : { targetBranch }),
    mergePolicy: policy, allowNoChangeCompletion: value.allowNoChangeCompletion === true });
}

export function snapshotTaskReviewBundle(value: unknown): TaskReviewBundle {
  if (!isRecord(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const required = ['version', 'taskId', 'projectId', 'agentId', 'assignmentId', 'providerId',
    'reservationSha256', 'dispatchSha256', 'executionProfileSha256', 'taskCommit',
    'buildTestEvidence', 'source', 'workerResult', 'reviewBundleSha256'];
  if (Object.keys(value).length !== required.length ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || value.version !== 1 ||
    !boundedString(value.taskId, 64, false) || !boundedString(value.projectId, 256, false) ||
    !boundedString(value.agentId, 256, false) || !boundedString(value.assignmentId, 256, false) ||
    !boundedString(value.providerId, 256, false) || !isSha(value.reservationSha256) ||
    !isSha(value.dispatchSha256) || !isSha(value.executionProfileSha256) || !isSha(value.reviewBundleSha256)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const commit = snapshotTaskCommit(value.taskCommit);
  let evidence: BuildTestEvidence;
  try { evidence = snapshotBuildTestEvidence(value.buildTestEvidence); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  const source = snapshotSource(value.source);
  const worker = snapshotWorkerResult(value.workerResult);
  const base = { version: 1 as const, taskId: value.taskId, projectId: value.projectId,
    agentId: value.agentId, assignmentId: value.assignmentId,
    providerId: value.providerId, reservationSha256: value.reservationSha256,
    dispatchSha256: value.dispatchSha256, executionProfileSha256: value.executionProfileSha256,
    taskCommit: commit, buildTestEvidence: evidence, source, workerResult: worker };
  if (!bundleConsistent(base) || reviewBundleDigest(base) !== value.reviewBundleSha256) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ ...base, reviewBundleSha256: value.reviewBundleSha256 });
}

export function makeReviewBundle(dispatch: Readonly<AssignmentDispatchResult>, commit: TaskCommitResult,
  evidence: BuildTestEvidence, source: GitWorkspaceChangeSnapshot, worker: AgentHubWorkerResult): TaskReviewBundle {
  const base = { version: 1 as const, taskId: dispatch.taskId, projectId: dispatch.projectId,
    agentId: dispatch.agentId, assignmentId: dispatch.assignmentId, providerId: dispatch.providerId,
    reservationSha256: dispatch.reservationSha256, dispatchSha256: dispatch.dispatchSha256,
    executionProfileSha256: dispatch.executionProfileSha256, taskCommit: commit,
    buildTestEvidence: evidence, source, workerResult: worker };
  return deepFreeze({ ...base, reviewBundleSha256: reviewBundleDigest(base) });
}
export function reviewBundleDigest(bundle: Omit<TaskReviewBundle, 'reviewBundleSha256'>): string {
  return digest('AgentHub.TaskReviewBundle.v1', { version: 1, taskId: bundle.taskId,
    projectId: bundle.projectId, agentId: bundle.agentId, assignmentId: bundle.assignmentId,
    providerId: bundle.providerId, reservationSha256: bundle.reservationSha256,
    dispatchSha256: bundle.dispatchSha256, executionProfileSha256: bundle.executionProfileSha256,
    taskCommitSha256: bundle.taskCommit.taskCommitSha256,
    evidenceSha256: bundle.buildTestEvidence.evidenceSha256,
    changeSetSha256: bundle.source.changeSetSha256, workerResult: bundle.workerResult });
}
export function bundleConsistent(bundle: Omit<TaskReviewBundle, 'reviewBundleSha256'>): boolean {
  return bundle.taskId === bundle.taskCommit.taskId && bundle.taskId === bundle.buildTestEvidence.taskId &&
    bundle.taskId === bundle.source.taskId && bundle.taskCommit.branchName === bundle.source.branchName &&
    bundle.taskCommit.baseCommit === bundle.source.baseCommit && bundle.taskCommit.headAfter === bundle.source.headCommit &&
    sourceMatchesEvidence(bundle.source, bundle.buildTestEvidence);
}

export function snapshotTaskCommit(value: unknown): TaskCommitResult {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'taskId', 'branchName', 'baseCommit', 'headBefore',
    'headAfter', 'outcome', 'taskCommitSha256']) || value.version !== 1 || !boundedString(value.taskId, 64, false) ||
    !boundedString(value.branchName, 512, false) || !isOid(value.baseCommit) || !isOid(value.headBefore) ||
    !isOid(value.headAfter) || !['committed', 'already-committed', 'no-changes'].includes(value.outcome as string) ||
    !isSha(value.taskCommitSha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const base = { version: 1 as const, taskId: value.taskId, branchName: value.branchName,
    baseCommit: value.baseCommit, headBefore: value.headBefore,
    headAfter: value.headAfter, outcome: value.outcome as TaskCommitResult['outcome'] };
  if (digest('AgentHub.TaskCommitResult.v1', base) !== value.taskCommitSha256) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ ...base, taskCommitSha256: value.taskCommitSha256 });
}

export function snapshotSource(value: unknown): GitWorkspaceChangeSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'repositoryRoot', 'worktreePath', 'branchName',
    'baseCommit', 'headCommit', 'committed', 'staged', 'unstaged', 'workingFiles', 'untracked', 'conflicts',
    'ignored', 'changedPaths', 'hasConflicts', 'changeSetSha256']) ||
    !boundedString(value.taskId, 64, false) || !boundedString(value.repositoryRoot, 32768, false) ||
    !boundedString(value.worktreePath, 32768, false) || !boundedString(value.branchName, 512, false) ||
    !isOid(value.baseCommit) || !isOid(value.headCommit) || !isSha(value.changeSetSha256)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const committed = snapshotChangeLayer(value.committed);
  const staged = snapshotChangeLayer(value.staged);
  const unstaged = snapshotChangeLayer(value.unstaged);
  const workingFiles = snapshotFingerprints(value.workingFiles, true);
  const untracked = snapshotFingerprints(value.untracked, false);
  const conflicts = snapshotConflicts(value.conflicts);
  const ignored = snapshotIgnored(value.ignored);
  const changedPaths = snapshotPaths(value.changedPaths);
  if (typeof value.hasConflicts !== 'boolean' || value.hasConflicts !== (conflicts.length > 0)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const expectedPaths = uniqueSorted([
    ...committed.changes.map((change) => change.path), ...staged.changes.map((change) => change.path),
    ...unstaged.changes.map((change) => change.path), ...conflicts.map((entry) => entry.path),
    ...untracked.map((entry) => entry.path),
  ]);
  if (!sameStrings(changedPaths, expectedPaths) || !workingFiles.every((entry) =>
    unstaged.changes.some((change) => change.path === entry.path) ||
    conflicts.some((conflict) => conflict.path === entry.path))) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ taskId: value.taskId, repositoryRoot: value.repositoryRoot, worktreePath: value.worktreePath,
    branchName: value.branchName, baseCommit: value.baseCommit, headCommit: value.headCommit,
    committed, staged, unstaged, workingFiles, untracked, conflicts, ignored, changedPaths,
    hasConflicts: value.hasConflicts, changeSetSha256: value.changeSetSha256 });
}

export function snapshotChangeLayer(value: unknown): GitWorkspaceChangeSnapshot['committed'] {
  if (!isRecord(value) || !hasExactKeys(value, ['changes', 'patch']) || !Array.isArray(value.changes) ||
    !isSortedByPath(value.changes)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  const changes = value.changes.map((change) => snapshotTrackedChange(change));
  return deepFreeze({ changes, patch: snapshotPatch(value.patch) });
}
export function snapshotTrackedChange(value: unknown): GitWorkspaceChangeSnapshot['committed']['changes'][number] {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'status', 'oldMode', 'newMode', 'oldObjectId',
    'newObjectId', 'binary', 'addedLines', 'deletedLines']) || !safeChangePath(value.path) ||
    typeof value.status !== 'string' || !/^[AMDTU]$/u.test(value.status) ||
    typeof value.oldMode !== 'string' || !/^(?:000000|100644|100755|120000|160000)$/u.test(value.oldMode) ||
    typeof value.newMode !== 'string' || !/^(?:000000|100644|100755|120000|160000)$/u.test(value.newMode) ||
    !isOid(value.oldObjectId) || !isOid(value.newObjectId) || typeof value.binary !== 'boolean' ||
    !nullableCount(value.addedLines) || !nullableCount(value.deletedLines) ||
    (value.binary ? value.addedLines !== null || value.deletedLines !== null :
      value.addedLines === null || value.deletedLines === null)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ path: value.path, status: value.status, oldMode: value.oldMode, newMode: value.newMode,
    oldObjectId: value.oldObjectId, newObjectId: value.newObjectId, binary: value.binary,
    addedLines: value.addedLines, deletedLines: value.deletedLines });
}
export function snapshotPatch(value: unknown): GitWorkspaceChangeSnapshot['committed']['patch'] {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  if (value.status === 'captured') {
    if (!hasExactKeys(value, ['status', 'text', 'byteLength', 'sha256']) ||
      typeof value.text !== 'string' || !nonNegativeInteger(value.byteLength) ||
      value.byteLength !== Buffer.byteLength(value.text, 'utf8') || !isSha(value.sha256) ||
      shaText(value.text) !== value.sha256) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ status: 'captured', text: value.text, byteLength: value.byteLength, sha256: value.sha256 });
  }
  if (value.status === 'empty') {
    if (!hasExactKeys(value, ['status', 'byteLength', 'sha256']) || value.byteLength !== 0 ||
      value.sha256 !== shaText('')) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ status: 'empty', byteLength: 0, sha256: value.sha256 });
  }
  if ((value.status === 'omitted-limit' || value.status === 'not-requested') && hasExactKeys(value, ['status'])) {
    return deepFreeze({ status: value.status });
  }
  throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
}
export function snapshotFingerprints(value: unknown, allowMissing: boolean): GitWorkspaceChangeSnapshot['workingFiles'] {
  if (!Array.isArray(value) || !isSortedByPath(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  return deepFreeze(value.map((entry) => snapshotFingerprint(entry, allowMissing)));
}
export function snapshotFingerprint(value: unknown, allowMissing: boolean): GitWorkspaceChangeSnapshot['workingFiles'][number] {
  if (!isRecord(value) || !safeChangePath(value.path) || typeof value.kind !== 'string') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  if (value.kind === 'regular') {
    if (!hasExactKeys(value, ['path', 'kind', 'size', 'sha256']) || !nonNegativeInteger(value.size) ||
      !isSha(value.sha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ path: value.path, kind: 'regular', size: value.size, sha256: value.sha256 });
  }
  if (value.kind === 'symlink') {
    if (!hasExactKeys(value, ['path', 'kind', 'size', 'linkTargetSha256']) || !nonNegativeInteger(value.size) ||
      !isSha(value.linkTargetSha256)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    return deepFreeze({ path: value.path, kind: 'symlink', size: value.size, linkTargetSha256: value.linkTargetSha256 });
  }
  if (value.kind === 'gitlink') {
    if (!hasExactKeys(value, ['path', 'kind', 'headCommit']) || !isOid(value.headCommit)) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    }
    return deepFreeze({ path: value.path, kind: 'gitlink', headCommit: value.headCommit });
  }
  if (allowMissing && value.kind === 'missing' && hasExactKeys(value, ['path', 'kind'])) {
    return deepFreeze({ path: value.path, kind: 'missing' });
  }
  throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
}
export function snapshotConflicts(value: unknown): GitWorkspaceChangeSnapshot['conflicts'] {
  if (!Array.isArray(value) || !isSortedByPath(value)) throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  return deepFreeze(value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'kind', 'fields']) || !safeChangePath(entry.path) ||
      entry.kind !== 'u' || !Array.isArray(entry.fields) || entry.fields.length !== 10 ||
      !entry.fields.every((field) => typeof field === 'string')) {
      throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
    }
    return deepFreeze({ path: entry.path, kind: 'u' as const, fields: [...entry.fields] });
  }));
}
export function snapshotIgnored(value: unknown): GitWorkspaceChangeSnapshot['ignored'] {
  if (!isRecord(value) || !hasExactKeys(value, ['present', 'count', 'paths', 'truncated']) ||
    typeof value.present !== 'boolean' || !nonNegativeInteger(value.count) || typeof value.truncated !== 'boolean') {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  const paths = snapshotPaths(value.paths);
  if (value.present !== (value.count > 0) || value.count < paths.length ||
    (value.truncated ? value.count <= paths.length : value.count !== paths.length)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze({ present: value.present, count: value.count, paths, truncated: value.truncated });
}
export function snapshotPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(safeChangePath) || !isSortedUniqueStrings(value)) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return deepFreeze([...value]);
}
export function safeChangePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { validateChangePath(value); return true; } catch { return false; }
}
export function isSortedByPath(value: readonly unknown[]): boolean {
  let previous: string | undefined;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || (previous !== undefined && previous > entry.path)) return false;
    previous = entry.path;
  }
  return true;
}
export function isSortedUniqueStrings(value: readonly unknown[]): value is readonly string[] {
  for (let index = 0; index < value.length; index++) {
    const current = value[index];
    if (typeof current !== 'string' || (index > 0 && (value[index - 1] as string) >= current)) return false;
  }
  return true;
}
export function uniqueSorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
export function nullableCount(value: unknown): value is number | null { return value === null || nonNegativeInteger(value); }
export function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function shaText(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function snapshotWorkerResult(value: unknown): AgentHubWorkerResult {
  let result: AgentProviderTurnResult;
  try { result = snapshotAssignmentTurnResult({ protocol: 'worker-result', protocolValid: true,
    providerId: 'bundle-validation', workerResult: value }, 'worker-result', 'bundle-validation'); }
  catch { throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE'); }
  if (result.protocol !== 'worker-result' || !result.protocolValid) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE');
  }
  return result.workerResult;
}

export function sourceMatchesEvidence(source: GitWorkspaceChangeSnapshot, evidence: BuildTestEvidence): boolean {
  return source.taskId === evidence.taskId && source.branchName === evidence.branchName &&
    source.baseCommit === evidence.baseCommit && source.headCommit === evidence.headCommit &&
    source.changeSetSha256 === evidence.changeSetSha256;
}

export function lifecycleResult<T extends Record<string, unknown>>(value: T): T & LifecycleBase {
  return deepFreeze({ ...value, lifecycleSha256: digest('AgentHub.TaskLifecycleResult.v1', lifecycleIdentity(value)) });
}
export function lifecycleReceiptKey(bundle: TaskReviewBundle, review: ReviewEvidence, input: ApplyTaskReviewSnapshot): string {
  return digest('AgentHub.TaskLifecycleReceipt.v1', {
    taskId: bundle.taskId,
    assignmentId: bundle.assignmentId,
    reviewBundleSha256: bundle.reviewBundleSha256,
    reviewEvidenceSha256: review.reviewEvidenceSha256,
    targetBranch: input.targetBranch ?? null,
    mergePolicy: input.mergePolicy,
    allowNoChangeCompletion: input.allowNoChangeCompletion,
  });
}
export function lifecycleIdentity(value: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'reviewBundle' && isRecord(nested)) result.reviewBundleSha256 = nested.reviewBundleSha256;
    else if (key === 'reviewEvidence' && isRecord(nested)) result.reviewEvidenceSha256 = nested.reviewEvidenceSha256;
    else if (key === 'mergeGate' && isRecord(nested)) result.mergeGateSha256 = nested.mergeGateSha256;
    else if (key === 'mergeResult' && isRecord(nested)) result.mergeResultSha256 = nested.mergeResultSha256;
    else if (key !== 'source') result[key] = nested;
  }
  return result;
}
export function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0${canonicalChangeState(value)}`).digest('hex');
}
export function boundedString(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}
export function isOid(value: unknown): value is string { return typeof value === 'string' && oidPattern.test(value); }
export function isSha(value: unknown): value is string { return typeof value === 'string' && shaPattern.test(value); }
export function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
export function lifecycleError(code: TaskLifecycleErrorCode, merge?: TaskMergeResult): TaskLifecycleError {
  return new TaskLifecycleError(code, merge);
}
