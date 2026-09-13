import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { BuildTestEvidence } from './BuildTestEvidenceCollector.js';
import type { GitCommandResult, GitCommandRunnerLike } from './GitCommandRunner.js';
import { canonicalChangeState, gitCapturePrefix, type GitWorkspaceChangeSnapshot } from './GitWorkspaceChangeCapture.js';
import type { TaskWorkspace } from './GitWorktreeManager.js';
import { evaluateMergeGateSnapshot, snapshotMergeGateDecision, snapshotMergeGateInputs,
  type MergeGateDecision, type MergeGateInputSnapshot, type MergeGatePolicy } from './MergeGate.js';
import type { ReviewEvidence } from './ReviewEvidence.js';
import type { GitEvidenceContextSnapshot } from './GitEvidenceContext.js';

export type GitMergeErrorCode =
  | 'GIT_MERGE_INVALID_REQUEST'
  | 'GIT_MERGE_REPOSITORY_BUSY'
  | 'GIT_MERGE_REPOSITORY_QUARANTINED'
  | 'GIT_MERGE_STALE_GATE'
  | 'GIT_MERGE_SOURCE_UNSTABLE'
  | 'GIT_MERGE_TARGET_INVALID'
  | 'GIT_MERGE_WRONG_PRIMARY_BRANCH'
  | 'GIT_MERGE_PRIMARY_DIRTY'
  | 'GIT_MERGE_PRIMARY_COLLISION'
  | 'GIT_MERGE_UNSUPPORTED'
  | 'GIT_MERGE_UNSAFE_GIT_EXTENSION'
  | 'GIT_MERGE_CONFLICT'
  | 'GIT_MERGE_FAILED'
  | 'GIT_MERGE_CLEANUP_FAILED'
  | 'GIT_MERGE_CONTRACT_VIOLATION';

export class GitMergeError extends Error {
  public constructor(public readonly code: GitMergeErrorCode, public readonly taskId?: string) {
    super(mergeErrorMessage(code));
    this.name = 'GitMergeError';
  }
}

export interface MergeTaskRequest {
  readonly taskId: string;
  readonly targetBranch: string;
  readonly buildEvidence: BuildTestEvidence;
  readonly reviewEvidence: ReviewEvidence;
  readonly gateDecision: MergeGateDecision;
  readonly gatePolicy?: MergeGatePolicy;
}
export type TaskMergeOutcome = 'merged' | 'already-merged';
export interface TaskMergeResult {
  readonly version: 1;
  readonly taskId: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly taskHeadCommit: string;
  readonly targetHeadBefore: string;
  readonly targetHeadAfter: string;
  readonly changeSetSha256: string;
  readonly sourceVisibilitySha256: string;
  readonly buildTestEvidenceSha256: string;
  readonly reviewEvidenceSha256: string;
  readonly mergeGateSha256: string;
  readonly outcome: TaskMergeOutcome;
  readonly mergeResultSha256: string;
}
export interface MergeRequestSnapshot {
  readonly taskId: string;
  readonly targetBranch: string;
  readonly input: MergeGateInputSnapshot;
  readonly suppliedGate: MergeGateDecision;
}
export interface GitMergeCallbacks {
  readonly inspectTask: () => Promise<TaskWorkspace | undefined>;
  readonly captureSource: (workspace: TaskWorkspace) => Promise<GitWorkspaceChangeSnapshot>;
  readonly captureContext: (workspace: TaskWorkspace) => Promise<GitEvidenceContextSnapshot>;
  readonly readBaseMarker: () => Promise<string>;
  readonly quarantineRepository: () => void;
}
export interface GitMergeHooks {
  readonly betweenTaskViews?: () => Promise<void> | void;
  readonly afterPreflight?: () => Promise<void> | void;
  readonly beforeMerge?: () => Promise<void> | void;
  readonly afterMerge?: () => Promise<void> | void;
  readonly afterMergeFailure?: () => Promise<void> | void;
}
interface MergePreflightResult {
  readonly expectedTree: string;
}

function mergeGitPrefix(repositoryRoot: string): readonly string[] {
  // A unique absolute nonexistent path inside Git's private directory cannot become tracked
  // during checkout. Capture hardening also forbids lazy fetch and replacement-object lookup.
  const disabledHooksPath = path.join(repositoryRoot, '.git', `agenthub-disabled-hooks-${randomUUID()}`);
  return Object.freeze([
    ...gitCapturePrefix,
    '-c', 'protocol.version=2', '-c', 'fetch.auto=0', '-c', 'remote.origin.promisor=false',
    '-c', 'extensions.partialClone=', '-c', `core.hooksPath=${disabledHooksPath}`,
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', '-c', 'rerere.enabled=false',
    '-c', 'rerere.autoupdate=false', '-c', 'merge.autostash=false',
  ]);
}

export function snapshotMergeTaskRequest(value: unknown, validateTaskId: (value: unknown) => string): MergeRequestSnapshot {
  if (!isRecord(value)) throw new GitMergeError('GIT_MERGE_INVALID_REQUEST');
  let taskId: string;
  let targetBranch: string;
  let input: MergeGateInputSnapshot;
  let suppliedGate: MergeGateDecision;
  try {
    taskId = validateTaskId(value.taskId);
    targetBranch = snapshotTargetBranch(value.targetBranch);
    input = snapshotMergeGateInputs(value.buildEvidence, value.reviewEvidence, value.gatePolicy ?? {});
    if (!input.build.valid || !input.review.valid) throw new Error('invalid evidence');
    suppliedGate = snapshotMergeGateDecision(value.gateDecision, input.policy);
  } catch (error) {
    if (error instanceof GitMergeError) throw error;
    throw new GitMergeError('GIT_MERGE_INVALID_REQUEST');
  }
  if (suppliedGate.taskId !== taskId) throw new GitMergeError('GIT_MERGE_INVALID_REQUEST', taskId);
  return deepFreeze({ taskId, targetBranch, input, suppliedGate });
}

export async function performEvidenceGatedMerge(
  runner: GitCommandRunnerLike,
  repositoryRoot: string,
  request: MergeRequestSnapshot,
  callbacks: GitMergeCallbacks,
  hooks: GitMergeHooks = {},
): Promise<TaskMergeResult> {
  const taskId = request.taskId;
  await requireValidTarget(runner, repositoryRoot, request.targetBranch, taskId);
  await requireNoTargetMergeOptions(runner, repositoryRoot, request.targetBranch, taskId);
  const initial = await requireStableTaskView(request, callbacks, hooks);
  const freshGate = evaluateMergeGateSnapshot(taskId, initial.source, initial.context, request.input);
  requireMatchingGate(request.suppliedGate, freshGate, taskId);
  await requirePrimaryBranch(runner, repositoryRoot, request.targetBranch, taskId);
  await requirePrimaryClean(runner, repositoryRoot, taskId);
  await requireSafeGitExtensions(runner, repositoryRoot, request.targetBranch, taskId);
  const targetHeadBefore = await revParse(runner, repositoryRoot, 'HEAD', taskId);
  const taskHead = initial.workspace.headCommit;
  if (await isAncestor(runner, repositoryRoot, taskHead, targetHeadBefore, taskId)) {
    await requireTaskIdentity(callbacks, initial.workspace, initial.source, initial.context, taskId);
    return mergeResult(request, targetHeadBefore, targetHeadBefore, 'already-merged');
  }
  await requireNoIgnoredCollision(runner, repositoryRoot, targetHeadBefore, taskHead, taskId);
  const preflight = await requireConflictFree(runner, repositoryRoot, targetHeadBefore, taskHead, taskId);
  await hooks.afterPreflight?.();
  await requireImmediatePreMutationState(
    runner, repositoryRoot, request, callbacks, initial, targetHeadBefore, taskHead,
  );
  let mergeStarted = false;
  try {
    await hooks.beforeMerge?.();
    mergeStarted = true;
    await run(runner, [...mergeGitPrefix(repositoryRoot), 'merge', '--no-ff', '--commit', '--no-edit', '--no-gpg-sign',
      '-m', `AgentHub merge ${taskId}`, '--', taskHead], repositoryRoot);
  } catch {
    if (!mergeStarted) throw new GitMergeError('GIT_MERGE_FAILED', taskId);
    try {
      await hooks.afterMergeFailure?.();
      await cleanupFailedMerge(runner, repositoryRoot, request.targetBranch, targetHeadBefore, taskId);
    } catch {
      callbacks.quarantineRepository();
      throw new GitMergeError('GIT_MERGE_CLEANUP_FAILED', taskId);
    }
    throw new GitMergeError('GIT_MERGE_FAILED', taskId);
  }
  try {
    await hooks.afterMerge?.();
    const targetHeadAfter = await verifyPostconditions(
      runner, repositoryRoot, request, callbacks, initial, targetHeadBefore, taskHead, preflight.expectedTree,
    );
    return mergeResult(request, targetHeadBefore, targetHeadAfter, 'merged');
  } catch {
    callbacks.quarantineRepository();
    throw new GitMergeError('GIT_MERGE_CLEANUP_FAILED', taskId);
  }
}

async function requireStableTaskView(
  request: MergeRequestSnapshot, callbacks: GitMergeCallbacks, hooks: GitMergeHooks = {},
) {
  try {
    const workspaceA = await callbacks.inspectTask();
    if (workspaceA === undefined) throw new Error('missing task');
    const sourceA = await callbacks.captureSource(workspaceA);
    const contextA = await callbacks.captureContext(workspaceA);
    await hooks.betweenTaskViews?.();
    const workspaceB = await callbacks.inspectTask();
    if (workspaceB === undefined) throw new Error('missing task');
    const sourceB = await callbacks.captureSource(workspaceB);
    const contextB = await callbacks.captureContext(workspaceB);
    if (canonicalChangeState(workspaceA) !== canonicalChangeState(workspaceB) ||
      canonicalChangeState(sourceA) !== canonicalChangeState(sourceB) ||
      canonicalChangeState(contextA) !== canonicalChangeState(contextB)) throw new Error('unstable');
    if (workspaceB.taskId !== request.taskId) throw new Error('wrong task');
    return { workspace: workspaceB, source: sourceB, context: contextB };
  } catch (error) {
    if (error instanceof GitMergeError) throw error;
    throw new GitMergeError('GIT_MERGE_SOURCE_UNSTABLE', request.taskId);
  }
}
function requireMatchingGate(supplied: MergeGateDecision, fresh: MergeGateDecision, taskId: string): void {
  if (!supplied.eligible || !fresh.eligible || supplied.mergeGateSha256 !== fresh.mergeGateSha256) {
    throw new GitMergeError('GIT_MERGE_STALE_GATE', taskId);
  }
}
async function requireImmediatePreMutationState(
  runner: GitCommandRunnerLike, repositoryRoot: string, request: MergeRequestSnapshot,
  callbacks: GitMergeCallbacks, initial: Awaited<ReturnType<typeof requireStableTaskView>>,
  targetHeadBefore: string, taskHead: string,
): Promise<void> {
  await requirePrimaryBranch(runner, repositoryRoot, request.targetBranch, request.taskId);
  await requirePrimaryClean(runner, repositoryRoot, request.taskId);
  if (await revParse(runner, repositoryRoot, 'HEAD', request.taskId) !== targetHeadBefore) {
    throw new GitMergeError('GIT_MERGE_STALE_GATE', request.taskId);
  }
  await requireSafeGitExtensions(runner, repositoryRoot, request.targetBranch, request.taskId);
  await requireSafeSelectedAttributes(runner, repositoryRoot, targetHeadBefore, taskHead, request.taskId);
  await requireTaskIdentity(callbacks, initial.workspace, initial.source, initial.context, request.taskId);
}
async function requireTaskIdentity(
  callbacks: GitMergeCallbacks, expectedWorkspace: TaskWorkspace, expectedSource: GitWorkspaceChangeSnapshot,
  expectedContext: GitEvidenceContextSnapshot, taskId: string,
): Promise<void> {
  try {
    const current = await callbacks.inspectTask();
    if (current === undefined || canonicalChangeState(current) !== canonicalChangeState(expectedWorkspace)) throw new Error('changed');
    const source = await callbacks.captureSource(current);
    const context = await callbacks.captureContext(current);
    if (canonicalChangeState(source) !== canonicalChangeState(expectedSource) ||
      canonicalChangeState(context) !== canonicalChangeState(expectedContext)) throw new Error('changed');
  } catch { throw new GitMergeError('GIT_MERGE_STALE_GATE', taskId); }
}
async function requireValidTarget(runner: GitCommandRunnerLike, root: string, target: string, taskId: string): Promise<void> {
  const checked = await run(runner, [...gitCapturePrefix, 'check-ref-format', '--branch', target], root, [0, 1]);
  if (checked.exitCode !== 0) throw new GitMergeError('GIT_MERGE_TARGET_INVALID', taskId);
  const local = await run(runner, [...gitCapturePrefix, 'show-ref', '--verify', '--quiet', `refs/heads/${target}`], root, [0, 1]);
  if (local.exitCode !== 0) throw new GitMergeError('GIT_MERGE_TARGET_INVALID', taskId);
}
async function requirePrimaryBranch(runner: GitCommandRunnerLike, root: string, target: string, taskId: string): Promise<void> {
  const current = await run(runner, [...gitCapturePrefix, 'symbolic-ref', '-q', 'HEAD'], root, [0, 1]);
  if (current.exitCode !== 0 || current.stdout.trim() !== `refs/heads/${target}`) {
    throw new GitMergeError('GIT_MERGE_WRONG_PRIMARY_BRANCH', taskId);
  }
}
async function requirePrimaryClean(runner: GitCommandRunnerLike, root: string, taskId: string): Promise<void> {
  const result = await run(runner, [...gitCapturePrefix, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (result.stdout.length > 0) throw new GitMergeError('GIT_MERGE_PRIMARY_DIRTY', taskId);
}
async function requireSafeGitExtensions(
  runner: GitCommandRunnerLike, root: string, targetBranch: string, taskId: string,
): Promise<void> {
  await requireNoTargetMergeOptions(runner, root, targetBranch, taskId);
  const mergeDrivers = await configuredExtensions(runner, root, '^merge\\..*\\.driver$', taskId);
  if (mergeDrivers.length > 0) throw new GitMergeError('GIT_MERGE_UNSAFE_GIT_EXTENSION', taskId);

  // Repository/worktree-defined filters are rejected outright. Inherited filters are
  // rejected only when an affected path selects one; requireConflictFree performs that audit.
  const filters = await configuredExtensions(runner, root, '^filter\\..*\\.(clean|smudge|process)$', taskId);
  if (filters.some(({ scope }) => scope === 'local' || scope === 'worktree')) {
    throw new GitMergeError('GIT_MERGE_UNSAFE_GIT_EXTENSION', taskId);
  }
}
async function requireNoTargetMergeOptions(
  runner: GitCommandRunnerLike, root: string, targetBranch: string, taskId: string,
): Promise<void> {
  const mergeOptions = await run(runner,
    [...gitCapturePrefix, 'config', '--null', '--show-scope', '--get-all', `branch.${targetBranch}.mergeOptions`],
    root, [0, 1]);
  if (mergeOptions.exitCode === 0) throw new GitMergeError('GIT_MERGE_UNSAFE_GIT_EXTENSION', taskId);
}
async function configuredExtensions(
  runner: GitCommandRunnerLike, root: string, pattern: string, taskId: string,
): Promise<readonly Readonly<{ scope: string; entry: string }>[]> {
  const result = await run(runner,
    [...gitCapturePrefix, 'config', '--null', '--show-scope', '--get-regexp', pattern], root, [0, 1]);
  if (result.exitCode === 1) return Object.freeze([]);
  const fields = nulList(result.stdout);
  // With --null --show-scope, Git emits scope\0 followed by key\nvalue\0.
  if (fields.length % 2 !== 0) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
  const entries: Readonly<{ scope: string; entry: string }>[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const scope = fields[index];
    const entry = fields[index + 1];
    if (scope === undefined || entry === undefined || !entry.includes('\n')) {
      throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
    }
    entries.push(Object.freeze({ scope, entry }));
  }
  return Object.freeze(entries);
}
async function requireNoIgnoredCollision(
  runner: GitCommandRunnerLike, root: string, targetHead: string, taskHead: string, taskId: string,
): Promise<void> {
  const changed = await run(runner, [...gitCapturePrefix, 'diff', '--name-only', '-z', targetHead, taskHead, '--'], root);
  const paths = nulList(changed.stdout);
  if (paths.length === 0) return;
  const ignored = await run(runner, [...gitCapturePrefix, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...paths], root);
  if (ignored.stdout.length > 0) throw new GitMergeError('GIT_MERGE_PRIMARY_COLLISION', taskId);
}
async function requireConflictFree(
  runner: GitCommandRunnerLike, root: string, targetHead: string, taskHead: string, taskId: string,
): Promise<MergePreflightResult> {
  await requireSafeSelectedAttributes(runner, root, targetHead, taskHead, taskId);
  const result = await run(runner, [...mergeGitPrefix(root), 'merge-tree', '--write-tree', targetHead, taskHead], root, [0, 1]);
  if (result.exitCode === 1) throw new GitMergeError('GIT_MERGE_CONFLICT', taskId);
  if (result.exitCode !== 0) throw new GitMergeError('GIT_MERGE_UNSUPPORTED', taskId);
  const expectedTree = result.stdout.trim();
  if (!isObjectId(expectedTree)) throw new GitMergeError('GIT_MERGE_UNSUPPORTED', taskId);
  return Object.freeze({ expectedTree });
}
async function requireSafeSelectedAttributes(
  runner: GitCommandRunnerLike, root: string, targetHead: string, taskHead: string, taskId: string,
): Promise<void> {
  const changed = await run(runner, [...gitCapturePrefix, 'diff', '--name-only', '-z', targetHead, taskHead, '--'], root);
  const paths = nulList(changed.stdout);
  if (paths.length > 0) {
    // Audit the live worktree plus both immutable input trees. Named merge attributes
    // could become executable after a late merge.<name>.driver configuration change.
    await requireSafeAttributesInView(runner, root, paths, taskId);
    await requireSafeAttributesInView(runner, root, paths, taskId, targetHead);
    await requireSafeAttributesInView(runner, root, paths, taskId, taskHead);
  }
}
async function requireSafeAttributesInView(
  runner: GitCommandRunnerLike, root: string, paths: readonly string[], taskId: string, source?: string,
): Promise<void> {
  const attributes = await run(runner,
    [...gitCapturePrefix, 'check-attr', '-z', ...(source === undefined ? [] : ['--source', source]),
      'filter', 'merge', '--', ...paths], root);
  const fields = nulList(attributes.stdout);
  if (fields.length % 3 !== 0) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
  for (let index = 0; index < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    const safe = attribute === 'merge'
      ? value === 'unspecified' || value === 'set' || value === 'unset'
      : attribute === 'filter' && (value === 'unspecified' || value === 'unset');
    if (!safe) {
      throw new GitMergeError('GIT_MERGE_UNSAFE_GIT_EXTENSION', taskId);
    }
  }
}
async function cleanupFailedMerge(
  runner: GitCommandRunnerLike, root: string, targetBranch: string, targetHead: string, taskId: string,
): Promise<void> {
  const mergeHead = await run(runner, [...gitCapturePrefix, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], root, [0, 1]);
  if (mergeHead.exitCode === 0) await run(runner, [...mergeGitPrefix(root), 'merge', '--abort'], root);
  await requirePrimaryBranch(runner, root, targetBranch, taskId);
  if (await revParse(runner, root, 'HEAD', taskId) !== targetHead) throw new Error('HEAD changed');
  await requirePrimaryClean(runner, root, taskId);
  const remaining = await run(runner, [...gitCapturePrefix, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], root, [0, 1]);
  if (remaining.exitCode === 0) throw new Error('merge state remains');
}
async function verifyPostconditions(
  runner: GitCommandRunnerLike, root: string, request: MergeRequestSnapshot, callbacks: GitMergeCallbacks,
  initial: Awaited<ReturnType<typeof requireStableTaskView>>, targetBefore: string, taskHead: string,
  expectedTree: string,
): Promise<string> {
  await requirePrimaryBranch(runner, root, request.targetBranch, request.taskId);
  await requirePrimaryClean(runner, root, request.taskId);
  const targetAfter = await revParse(runner, root, 'HEAD', request.taskId);
  if (!await isAncestor(runner, root, targetBefore, targetAfter, request.taskId) ||
    !await isAncestor(runner, root, taskHead, targetAfter, request.taskId)) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId);
  const parents = (await run(runner, [...gitCapturePrefix, 'rev-list', '--parents', '-n', '1', targetAfter], root)).stdout.trim().split(/\s+/u);
  if (parents.length !== 3 || parents[1] !== targetBefore || parents[2] !== taskHead) {
    throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId);
  }
  if (await revParseTree(runner, root, targetAfter, request.taskId) !== expectedTree) {
    throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId);
  }
  const taskBranch = await revParse(runner, root, `refs/heads/${initial.workspace.branchName}`, request.taskId);
  if (taskBranch !== taskHead || await callbacks.readBaseMarker() !== initial.workspace.baseCommit) {
    throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId);
  }
  try { await requireTaskIdentity(callbacks, initial.workspace, initial.source, initial.context, request.taskId); }
  catch { throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId); }
  return targetAfter;
}
function mergeResult(request: MergeRequestSnapshot, targetBefore: string, targetAfter: string, outcome: TaskMergeOutcome): TaskMergeResult {
  if (!request.input.build.valid || !request.input.review.valid) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', request.taskId);
  const build = request.input.build.value;
  const review = request.input.review.value;
  const base: Omit<TaskMergeResult, 'mergeResultSha256'> = {
    version: 1, taskId: request.taskId, targetBranch: request.targetBranch, baseCommit: build.baseCommit,
    taskHeadCommit: build.headCommit, targetHeadBefore: targetBefore, targetHeadAfter: targetAfter,
    changeSetSha256: build.changeSetSha256, sourceVisibilitySha256: build.sourceVisibilitySha256,
    buildTestEvidenceSha256: build.evidenceSha256, reviewEvidenceSha256: review.reviewEvidenceSha256,
    mergeGateSha256: request.suppliedGate.mergeGateSha256, outcome,
  };
  const mergeResultSha256 = createHash('sha256').update(`AgentHub.TaskMergeResult.v1\0${canonicalChangeState(base)}`).digest('hex');
  return deepFreeze({ ...base, mergeResultSha256 });
}
async function revParse(runner: GitCommandRunnerLike, root: string, ref: string, taskId: string): Promise<string> {
  const result = await run(runner, [...gitCapturePrefix, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], root);
  const value = result.stdout.trim();
  if (!isObjectId(value)) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
  return value;
}
async function revParseTree(runner: GitCommandRunnerLike, root: string, ref: string, taskId: string): Promise<string> {
  const result = await run(runner, [...gitCapturePrefix, 'rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`], root);
  const value = result.stdout.trim();
  if (!isObjectId(value)) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
  return value;
}
function isObjectId(value: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value); }
async function isAncestor(runner: GitCommandRunnerLike, root: string, ancestor: string, descendant: string, taskId: string): Promise<boolean> {
  const result = await run(runner, [...gitCapturePrefix, 'merge-base', '--is-ancestor', ancestor, descendant], root, [0, 1]);
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION', taskId);
  return result.exitCode === 0;
}
async function run(
  runner: GitCommandRunnerLike, args: readonly string[], cwd: string, acceptedExitCodes?: readonly number[],
): Promise<GitCommandResult> {
  try { return await runner.run(args, { cwd, ...(acceptedExitCodes === undefined ? {} : { acceptedExitCodes }) }); }
  catch { throw new GitMergeError('GIT_MERGE_CONTRACT_VIOLATION'); }
}
function nulList(value: string): string[] { return value.split('\0').filter(Boolean); }
function snapshotTargetBranch(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim().length === 0 ||
    value.startsWith('-') || /[\0\r\n]/u.test(value) || value.startsWith('refs/') || value.includes('@{')) {
    throw new GitMergeError('GIT_MERGE_TARGET_INVALID');
  }
  return value;
}
function mergeErrorMessage(code: GitMergeErrorCode): string {
  const messages: Record<GitMergeErrorCode, string> = {
    GIT_MERGE_INVALID_REQUEST: 'Merge request is invalid', GIT_MERGE_REPOSITORY_BUSY: 'Repository merge is busy',
    GIT_MERGE_REPOSITORY_QUARANTINED: 'Repository merge state is quarantined', GIT_MERGE_STALE_GATE: 'Merge gate is stale',
    GIT_MERGE_SOURCE_UNSTABLE: 'Task source changed while validating merge', GIT_MERGE_TARGET_INVALID: 'Merge target is invalid',
    GIT_MERGE_WRONG_PRIMARY_BRANCH: 'Primary workspace is not on the requested target branch',
    GIT_MERGE_PRIMARY_DIRTY: 'Primary workspace is dirty', GIT_MERGE_PRIMARY_COLLISION: 'Primary workspace has a merge path collision',
    GIT_MERGE_UNSUPPORTED: 'Required Git merge capability is unavailable',
    GIT_MERGE_UNSAFE_GIT_EXTENSION: 'Repository Git extensions are unsafe for trusted merge',
    GIT_MERGE_CONFLICT: 'Task changes conflict with the target branch', GIT_MERGE_FAILED: 'Git merge failed',
    GIT_MERGE_CLEANUP_FAILED: 'Failed merge cleanup is ambiguous', GIT_MERGE_CONTRACT_VIOLATION: 'Git merge contract was violated',
  };
  return messages[code];
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}
