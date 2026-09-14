import { createHash } from 'node:crypto';

import type { GitCommandRunnerLike } from './GitCommandRunner.js';
import { canonicalChangeState, type GitWorkspaceChangeSnapshot } from './GitWorkspaceChangeCapture.js';
import type { TaskWorkspace } from './GitWorktreeManager.js';

export type TaskCommitOutcome = 'committed' | 'already-committed' | 'no-changes';

export interface TaskCommitResult {
  readonly version: 1;
  readonly taskId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headBefore: string;
  readonly headAfter: string;
  readonly outcome: TaskCommitOutcome;
  readonly taskCommitSha256: string;
}

export type GitTaskCommitErrorCode =
  | 'GIT_TASK_COMMIT_INVALID_REQUEST'
  | 'GIT_TASK_COMMIT_CONFLICTS'
  | 'GIT_TASK_COMMIT_FILTER_BLOCKED'
  | 'GIT_TASK_COMMIT_FAILED'
  | 'GIT_TASK_COMMIT_POSTCONDITION_FAILED';

export class GitTaskCommitError extends Error {
  public constructor(public readonly code: GitTaskCommitErrorCode) {
    super(code);
    this.name = 'GitTaskCommitError';
  }
}

export interface TaskCommitOptions {
  readonly capture: () => Promise<GitWorkspaceChangeSnapshot>;
  readonly inspect: () => Promise<TaskWorkspace | undefined>;
  readonly commitMessage?: string;
  readonly onAmbiguousFailure?: () => void;
}

const gitPrefix = Object.freeze([
  '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false',
  '-c', 'protocol.version=2', '-c', 'fetch.auto=0', '-c', 'remote.origin.promisor=false',
  '-c', 'extensions.partialClone=', '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false',
  '-c', 'rerere.enabled=false', '-c', 'rerere.autoupdate=false',
]);

const disabledHooks = (repositoryRoot: string): readonly string[] => Object.freeze([
  '-c', `core.hooksPath=${repositoryRoot}/.git/agenthub-disabled-hooks`,
]);

/** Performs a source-authoritative, hook-free commit in one task worktree. */
export async function performTaskCommit(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
  options: TaskCommitOptions,
): Promise<TaskCommitResult> {
  if (!isRecord(workspace) || !isRecord(options) || typeof options.capture !== 'function' ||
    typeof options.inspect !== 'function') throw new GitTaskCommitError('GIT_TASK_COMMIT_INVALID_REQUEST');
  const before = await options.capture();
  if (before.taskId !== workspace.taskId || before.branchName !== workspace.branchName ||
    before.baseCommit !== workspace.baseCommit || before.headCommit !== workspace.headCommit) {
    throw new GitTaskCommitError('GIT_TASK_COMMIT_POSTCONDITION_FAILED');
  }
  if (before.hasConflicts || before.conflicts.length > 0) throw new GitTaskCommitError('GIT_TASK_COMMIT_CONFLICTS');
  const dirty = before.staged.changes.length > 0 || before.unstaged.changes.length > 0 || before.untracked.length > 0;
  if (!dirty) {
    const outcome: TaskCommitOutcome = before.headCommit === before.baseCommit ? 'no-changes' : 'already-committed';
    return makeResult(workspace, before.headCommit, before.headCommit, outcome);
  }
  await rejectExecutableFilters(runner, workspace, before);
  try {
    await run(runner, [...gitPrefix, ...disabledHooks(workspace.repositoryRoot), 'add', '--all', '--', '.'], workspace.worktreePath);
    await run(runner, [...gitPrefix, ...disabledHooks(workspace.repositoryRoot),
      '-c', 'core.editor=true', 'commit', '--no-verify', '--no-gpg-sign', '--no-edit',
      '-m', options.commitMessage ?? `AgentHub task ${workspace.taskId}`], workspace.worktreePath);
  } catch {
    try {
      const currentWorkspace = await options.inspect();
      const current = await options.capture();
      if (currentWorkspace === undefined || currentWorkspace.taskId !== workspace.taskId ||
        currentWorkspace.branchName !== workspace.branchName || currentWorkspace.baseCommit !== workspace.baseCommit ||
        currentWorkspace.headCommit !== workspace.headCommit || current.taskId !== workspace.taskId ||
        current.branchName !== workspace.branchName || current.baseCommit !== workspace.baseCommit ||
        current.headCommit !== currentWorkspace.headCommit ||
        current.hasConflicts || current.conflicts.length > 0) notifyAmbiguous(options.onAmbiguousFailure);
    } catch { notifyAmbiguous(options.onAmbiguousFailure); }
    throw new GitTaskCommitError('GIT_TASK_COMMIT_FAILED');
  }
  try {
    const afterWorkspace = await options.inspect();
    if (afterWorkspace === undefined || afterWorkspace.taskId !== workspace.taskId ||
      afterWorkspace.branchName !== `agenthub/${workspace.taskId}` ||
      afterWorkspace.baseCommit !== workspace.baseCommit || afterWorkspace.headCommit === before.headCommit) {
      throw new GitTaskCommitError('GIT_TASK_COMMIT_POSTCONDITION_FAILED');
    }
    const after = await options.capture();
    if (after.taskId !== workspace.taskId || after.branchName !== workspace.branchName ||
      after.baseCommit !== workspace.baseCommit || after.headCommit !== afterWorkspace.headCommit ||
      after.hasConflicts || after.conflicts.length > 0 || after.staged.changes.length > 0 ||
      after.unstaged.changes.length > 0 || after.untracked.length > 0) {
      throw new GitTaskCommitError('GIT_TASK_COMMIT_POSTCONDITION_FAILED');
    }
    return makeResult(workspace, before.headCommit, after.headCommit, 'committed');
  } catch {
    notifyAmbiguous(options.onAmbiguousFailure);
    throw new GitTaskCommitError('GIT_TASK_COMMIT_POSTCONDITION_FAILED');
  }
}

async function rejectExecutableFilters(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
  snapshot: GitWorkspaceChangeSnapshot,
): Promise<void> {
  const paths = [...new Set([
    ...snapshot.staged.changes.map((change) => change.path),
    ...snapshot.unstaged.changes.map((change) => change.path),
    ...snapshot.untracked.map((file) => file.path),
  ])].sort();
  if (paths.length === 0) return;
  try {
    const attr = await runner.run([...gitPrefix, 'check-attr', '-z', '--all', '--', ...paths], {
      cwd: workspace.worktreePath,
    });
    const fields = attr.stdout.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0) throw new GitTaskCommitError('GIT_TASK_COMMIT_FILTER_BLOCKED');
    for (let index = 0; index < fields.length; index += 3) {
      const attribute = fields[index + 1];
      const value = fields[index + 2];
      if ((attribute === 'filter' || attribute === 'working-tree-encoding') &&
        value !== undefined && value !== 'unspecified' && value !== 'unset') {
        throw new GitTaskCommitError('GIT_TASK_COMMIT_FILTER_BLOCKED');
      }
    }
  } catch (error) {
    if (error instanceof GitTaskCommitError) throw error;
    throw new GitTaskCommitError('GIT_TASK_COMMIT_FILTER_BLOCKED');
  }
}

async function run(runner: GitCommandRunnerLike, args: readonly string[], cwd: string): Promise<void> {
  const result = await runner.run(args, { cwd });
  if (result.exitCode !== 0) throw new GitTaskCommitError('GIT_TASK_COMMIT_FAILED');
}

function notifyAmbiguous(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* quarantine notification must not replace the bounded commit error */ }
}

function makeResult(workspace: TaskWorkspace, headBefore: string, headAfter: string, outcome: TaskCommitOutcome): TaskCommitResult {
  const base = { version: 1 as const, taskId: workspace.taskId, branchName: workspace.branchName,
    baseCommit: workspace.baseCommit, headBefore, headAfter, outcome };
  return deepFreeze({ ...base, taskCommitSha256: createHash('sha256')
    .update(`AgentHub.TaskCommitResult.v1\0${canonicalChangeState(base)}`).digest('hex') });
}

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}