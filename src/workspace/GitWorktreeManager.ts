import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GitCommandError,
  GitCommandRunner,
  type GitCommandRunnerLike,
} from './GitCommandRunner.js';

import { captureWorkspaceChanges, snapshotCaptureOptions, canonicalChangeState,
  type CaptureWorkspaceChangesOptions, type GitWorkspaceChangeSnapshot } from './GitWorkspaceChangeCapture.js';

const excludeRule = '/.agenthub/worktrees/';
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const windowsReservedPattern = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export type GitWorktreeErrorCode =
  | 'GIT_WORKTREE_GIT_UNAVAILABLE'
  | 'GIT_WORKTREE_NOT_REPOSITORY'
  | 'GIT_WORKTREE_ROOT_MISMATCH'
  | 'GIT_WORKTREE_UNSUPPORTED_REPOSITORY'
  | 'GIT_WORKTREE_INVALID_TASK_ID'
  | 'GIT_WORKTREE_INVALID_BASE_REF'
  | 'GIT_WORKTREE_BASE_NOT_FOUND'
  | 'GIT_WORKTREE_BASE_CONFLICT'
  | 'GIT_WORKTREE_BRANCH_CONFLICT'
  | 'GIT_WORKTREE_PATH_CONFLICT'
  | 'GIT_WORKTREE_STALE_METADATA'
  | 'GIT_WORKTREE_OPERATION_BUSY'
  | 'GIT_WORKTREE_CREATE_FAILED'
  | 'GIT_WORKTREE_DIRTY'
  | 'GIT_WORKTREE_REMOVE_FAILED'
  | 'GIT_WORKTREE_CONTRACT_VIOLATION';

export class GitWorktreeError extends Error {
  public constructor(
    public readonly code: GitWorktreeErrorCode,
    message: string,
    public readonly operation?: string,
    public readonly taskId?: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'GitWorktreeError';
  }
}

export interface GitWorktreeManagerOptions {
  readonly repositoryRoot: string;
  readonly gitExecutable?: string;
  readonly runner?: GitCommandRunnerLike;
}

export interface CreateTaskWorkspaceRequest {
  readonly taskId: string;
  readonly baseRef: string;
}

export interface TaskWorkspace {
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

export interface CreatedTaskWorkspace extends TaskWorkspace {
  readonly created: boolean;
}

export interface GitWorktreeRecord {
  readonly worktreePath: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

interface PendingOperation {
  readonly token: object;
  readonly taskId: string;
  readonly kind: 'create' | 'remove' | 'capture';
  readonly captureKey?: string;
  readonly baseRef?: string;
  readonly promise: Promise<unknown>;
}

type VerifiedWorkspace = Omit<TaskWorkspace, 'baseCommit'>;

interface RepositoryCoordination {
  readonly operations: Map<string, PendingOperation>;
  excludePromise?: Promise<void>;
}

const repositoryCoordinators = new Map<string, WeakRef<RepositoryCoordination>>();
const coordinatorFinalizer = new FinalizationRegistry<{ key: string; ref: WeakRef<RepositoryCoordination> }>(
  ({ key, ref }) => { if (repositoryCoordinators.get(key) === ref) repositoryCoordinators.delete(key); },
);

export class GitWorktreeManager {
  readonly #runner: GitCommandRunnerLike;
  readonly #repositoryRoot: string;
  readonly #gitDir: string;
  readonly #worktreesRoot: string;
  readonly #coordination: RepositoryCoordination;

  private constructor(repositoryRoot: string, gitDir: string, runner: GitCommandRunnerLike) {
    this.#repositoryRoot = repositoryRoot;
    this.#gitDir = gitDir;
    this.#worktreesRoot = path.join(repositoryRoot, '.agenthub', 'worktrees');
    this.#runner = runner;
    this.#coordination = coordinationFor(repositoryRoot);
  }

  public static async open(options: GitWorktreeManagerOptions): Promise<GitWorktreeManager> {
    if (!isRecord(options)) {
      throw new GitWorktreeError('GIT_WORKTREE_NOT_REPOSITORY', 'Repository root is invalid', 'open');
    }
    const repositoryRootValue = options.repositoryRoot;
    const runnerValue = options.runner;
    const gitExecutableValue = options.gitExecutable;
    if (typeof repositoryRootValue !== 'string' || repositoryRootValue.length === 0) {
      throw new GitWorktreeError('GIT_WORKTREE_NOT_REPOSITORY', 'Repository root is invalid', 'open');
    }
    const runner = runnerValue ?? new GitCommandRunner({
      ...(gitExecutableValue === undefined ? {} : { gitExecutable: gitExecutableValue }),
    });
    let requestedRoot: string;
    try {
      requestedRoot = await realpath(path.resolve(repositoryRootValue));
    } catch {
      throw new GitWorktreeError('GIT_WORKTREE_NOT_REPOSITORY', 'Repository root does not exist', 'open');
    }
    try {
      const bare = await runner.run(['rev-parse', '--is-bare-repository'], { cwd: requestedRoot });
      if (bare.stdout.trim() === 'true') {
        throw new GitWorktreeError(
          'GIT_WORKTREE_UNSUPPORTED_REPOSITORY', 'Bare repositories are unsupported', 'open',
        );
      }
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error;
      throw preflightError(error);
    }
    let reportedRoot: string;
    try {
      const result = await runner.run(['rev-parse', '--show-toplevel'], { cwd: requestedRoot });
      reportedRoot = await realpath(path.resolve(requestedRoot, result.stdout.trim()));
    } catch (error) {
      throw preflightError(error);
    }
    if (!samePath(requestedRoot, reportedRoot)) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_ROOT_MISMATCH', 'Repository root must be the exact Git top-level', 'open',
      );
    }
    const dotGit = await safeLstat(path.join(requestedRoot, '.git'));
    if (dotGit === undefined || !dotGit.isDirectory() || dotGit.isSymbolicLink()) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_UNSUPPORTED_REPOSITORY', 'Project root must be the primary Git worktree', 'open',
      );
    }
    let gitDir: string;
    try {
      const result = await runner.run(['rev-parse', '--absolute-git-dir'], { cwd: requestedRoot });
      gitDir = await realpath(path.resolve(requestedRoot, result.stdout.trim()));
    } catch (error) {
      throw preflightError(error);
    }
    if (!samePath(gitDir, await realpath(path.join(requestedRoot, '.git')))) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_UNSUPPORTED_REPOSITORY', 'Primary Git metadata identity is inconsistent', 'open',
      );
    }
    const manager = new GitWorktreeManager(requestedRoot, gitDir, runner);
    await manager.#assertNoTrackedWorkspaceContent();
    return manager;
  }

  public get repositoryRoot(): string { return this.#repositoryRoot; }

  public createWorkspace(request: CreateTaskWorkspaceRequest): Promise<CreatedTaskWorkspace> {
    let taskId: string;
    let baseRef: string;
    try {
      if (!isRecord(request)) throw invalidTaskId();
      taskId = validateTaskId(request.taskId);
      baseRef = validateBaseRef(request.baseRef);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const key = operationKey(taskId);
    const pending = this.#coordination.operations.get(key);
    if (pending !== undefined) {
      if (pending.taskId === taskId && pending.kind === 'create' && pending.baseRef === baseRef) {
        return pending.promise as Promise<CreatedTaskWorkspace>;
      }
      return Promise.reject(operationBusy(taskId));
    }
    const token = {};
    const operation = this.#performCreate(taskId, baseRef);
    const current = operation.finally(() => {
      if (this.#coordination.operations.get(key)?.token === token) this.#coordination.operations.delete(key);
    });
    this.#coordination.operations.set(key, { token, taskId, kind: 'create', baseRef, promise: current });
    return current;
  }

  public captureWorkspaceChanges(
    taskIdValue: string, options?: CaptureWorkspaceChangesOptions,
  ): Promise<GitWorkspaceChangeSnapshot> {
    let taskId: string;
    let snapshot: Required<CaptureWorkspaceChangesOptions>;
    try {
      taskId = validateTaskId(taskIdValue);
      snapshot = snapshotCaptureOptions(options);
    } catch (error) { return Promise.reject(asError(error)); }
    const key = operationKey(taskId);
    const captureKey = canonicalChangeState(snapshot);
    const pending = this.#coordination.operations.get(key);
    if (pending !== undefined) {
      if (pending.taskId === taskId && pending.kind === 'capture' && pending.captureKey === captureKey) {
        return pending.promise as Promise<GitWorkspaceChangeSnapshot>;
      }
      return Promise.reject(operationBusy(taskId));
    }
    const token = {};
    const operation = captureWorkspaceChanges(this.#runner, () => this.#inspect(taskId), snapshot);
    const current = operation.finally(() => {
      if (this.#coordination.operations.get(key)?.token === token) this.#coordination.operations.delete(key);
    });
    this.#coordination.operations.set(key, { token, taskId, kind: 'capture', captureKey, promise: current });
    return current;
  }

  public inspectWorkspace(taskIdValue: string): Promise<TaskWorkspace | undefined> {
    try {
      const taskId = validateTaskId(taskIdValue);
      return this.#inspect(taskId);
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  public removeWorkspace(taskIdValue: string): Promise<void> {
    let taskId: string;
    try {
      taskId = validateTaskId(taskIdValue);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const key = operationKey(taskId);
    const pending = this.#coordination.operations.get(key);
    if (pending !== undefined) {
      if (pending.taskId === taskId && pending.kind === 'remove') return pending.promise as Promise<void>;
      return Promise.reject(operationBusy(taskId));
    }
    const token = {};
    const operation = this.#performRemove(taskId);
    const current = operation.finally(() => {
      if (this.#coordination.operations.get(key)?.token === token) this.#coordination.operations.delete(key);
    });
    this.#coordination.operations.set(key, { token, taskId, kind: 'remove', promise: current });
    return current;
  }

  async #performCreate(taskId: string, baseRef: string): Promise<CreatedTaskWorkspace> {
    const branchName = branchFor(taskId);
    const worktreePath = this.#pathFor(taskId);
    try {
      await this.#runnerCall(['check-ref-format', '--branch', branchName], 'validate-branch', taskId);
    } catch (error) {
      if (error instanceof GitWorktreeError && error.code === 'GIT_WORKTREE_GIT_UNAVAILABLE') throw error;
      throw invalidTaskId();
    }
    await this.#assertNoTrackedWorkspaceContent(taskId);
    await this.#ensureExclude();
    await this.#validateManagedRoot(taskId, true);
    const before = await this.#discover();
    const existing = await this.#classifyExisting(taskId, branchName, worktreePath, before);
    const storedBase = await this.#readBaseMarker(taskId);
    if (existing !== undefined) {
      if (storedBase !== undefined) {
        await this.#assertBaseAncestry(taskId, storedBase, existing.headCommit);
        return Object.freeze({ ...existing, baseCommit: storedBase, created: false });
      }
      const recoveryBase = await this.#resolveCommit(baseRef, taskId);
      const durableBase = await this.#recoverBaseMarker(taskId, existing, recoveryBase);
      return Object.freeze({ ...existing, baseCommit: durableBase, created: false });
    }
    if (storedBase !== undefined) throw baseConflict(taskId);
    const baseCommit = await this.#resolveCommit(baseRef, taskId);

    try {
      await this.#validateManagedRoot(taskId, false);
      await this.#runnerCall(
        ['worktree', 'add', '-b', branchName, worktreePath, baseCommit], 'create', taskId,
      );
    } catch (error) {
      const afterFailure = await this.#discover();
      const adopted = await this.#exactWorkspace(taskId, branchName, worktreePath, afterFailure);
      if (adopted !== undefined && adopted.headCommit === baseCommit) {
        const durableBase = await this.#ensureBaseMarker(taskId, baseCommit);
        return Object.freeze({ ...adopted, baseCommit: durableBase, created: true });
      }
      throw workspaceErrorFrom(error, 'GIT_WORKTREE_CREATE_FAILED', 'Task worktree creation failed', 'create', taskId);
    }

    const after = await this.#discover();
    const created = await this.#exactWorkspace(taskId, branchName, worktreePath, after);
    if (created === undefined || created.headCommit !== baseCommit) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Created task worktree failed postcondition checks', 'create', taskId,
      );
    }
    const durableBase = await this.#ensureBaseMarker(taskId, baseCommit);
    return Object.freeze({ ...created, baseCommit: durableBase, created: true });
  }

  async #performRemove(taskId: string): Promise<void> {
    const branchName = branchFor(taskId);
    const worktreePath = this.#pathFor(taskId);
    await this.#validateManagedRoot(taskId, false);
    const records = await this.#discover();
    const exact = await this.#exactWorkspace(taskId, branchName, worktreePath, records);
    if (exact === undefined) {
      const pathRecord = findByPath(records, worktreePath);
      if (pathRecord !== undefined) throw pathConflict(taskId);
      if (await pathExists(worktreePath)) throw pathConflict(taskId);
      return;
    }
    const baseCommit = await this.#requireBaseMarker(taskId);
    await this.#assertBaseAncestry(taskId, baseCommit, exact.headCommit);
    await this.#validateManagedRoot(taskId, false);
    const status = await this.#runnerCall(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], 'status', taskId, worktreePath,
    );
    if (status.stdout.length > 0) {
      throw new GitWorktreeError('GIT_WORKTREE_DIRTY', 'Task worktree has uncommitted changes', 'remove', taskId);
    }
    try {
      await this.#validateManagedRoot(taskId, false);
      await this.#runnerCall(['worktree', 'remove', worktreePath], 'remove', taskId);
    } catch (error) {
      if (await this.#removalPostconditions(taskId, branchName, worktreePath, baseCommit)) return;
      throw workspaceErrorFrom(error, 'GIT_WORKTREE_REMOVE_FAILED', 'Task worktree removal failed', 'remove', taskId);
    }
    if (!await this.#removalPostconditions(taskId, branchName, worktreePath, baseCommit)) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Removed task worktree failed postcondition checks', 'remove', taskId,
      );
    }
  }

  async #inspect(taskId: string): Promise<TaskWorkspace | undefined> {
    const branchName = branchFor(taskId);
    const worktreePath = this.#pathFor(taskId);
    await this.#validateManagedRoot(taskId, false);
    const records = await this.#discover();
    const exact = await this.#exactWorkspace(taskId, branchName, worktreePath, records);
    if (exact !== undefined) {
      const baseCommit = await this.#requireBaseMarker(taskId);
      await this.#assertBaseAncestry(taskId, baseCommit, exact.headCommit);
      return Object.freeze({ ...exact, baseCommit });
    }
    if (findByPath(records, worktreePath) !== undefined || await pathExists(worktreePath)) throw pathConflict(taskId);
    if (await this.#branchExists(branchName, taskId) || findByBranch(records, branchName) !== undefined) {
      throw new GitWorktreeError('GIT_WORKTREE_BRANCH_CONFLICT', 'Task branch exists without its managed worktree', 'inspect', taskId);
    }
    return undefined;
  }

  async #classifyExisting(
    taskId: string,
    branchName: string,
    worktreePath: string,
    records: readonly GitWorktreeRecord[],
  ): Promise<VerifiedWorkspace | undefined> {
    const pathRecord = findByPath(records, worktreePath);
    if (pathRecord !== undefined) {
      if (pathRecord.prunable) throw staleMetadata(taskId);
      if (pathRecord.branch !== `refs/heads/${branchName}` || pathRecord.detached || pathRecord.bare || pathRecord.locked) {
        throw pathConflict(taskId);
      }
      return this.#workspaceFromRecord(taskId, branchName, worktreePath, pathRecord);
    }
    const branchRecord = findByBranch(records, branchName);
    if (branchRecord !== undefined) {
      if (branchRecord.prunable) throw staleMetadata(taskId);
      throw new GitWorktreeError(
        'GIT_WORKTREE_BRANCH_CONFLICT', 'Task branch is attached to another worktree', 'create', taskId,
      );
    }
    if (await this.#branchExists(branchName, taskId)) {
      throw new GitWorktreeError('GIT_WORKTREE_BRANCH_CONFLICT', 'Task branch already exists', 'create', taskId);
    }
    if (await pathExists(worktreePath)) throw pathConflict(taskId);
    return undefined;
  }

  async #exactWorkspace(
    taskId: string,
    branchName: string,
    worktreePath: string,
    records: readonly GitWorktreeRecord[],
  ): Promise<VerifiedWorkspace | undefined> {
    const record = findByPath(records, worktreePath);
    if (record === undefined || record.branch !== `refs/heads/${branchName}`) return undefined;
    if (record.prunable) throw staleMetadata(taskId);
    if (record.detached || record.bare || record.locked) throw pathConflict(taskId);
    return this.#workspaceFromRecord(taskId, branchName, worktreePath, record);
  }

  async #workspaceFromRecord(
    taskId: string,
    branchName: string,
    worktreePath: string,
    record: GitWorktreeRecord,
  ): Promise<VerifiedWorkspace> {
    if (record.head === undefined || !shaPattern.test(record.head)) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Task worktree has an invalid HEAD', 'inspect', taskId,
      );
    }
    await this.#validateManagedRoot(taskId, false);
    const stat = await safeLstat(worktreePath);
    const dotGit = await safeLstat(path.join(worktreePath, '.git'));
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() || dotGit === undefined ||
      !dotGit.isFile() || dotGit.isSymbolicLink()) {
      throw pathConflict(taskId);
    }
    try {
      const [topResult, gitDirResult, commonResult, branchResult, headResult, refResult] = await Promise.all([
        this.#runnerCall(['rev-parse', '--show-toplevel'], 'verify-worktree', taskId, worktreePath),
        this.#runnerCall(['rev-parse', '--absolute-git-dir'], 'verify-worktree', taskId, worktreePath),
        this.#runnerCall(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'verify-worktree', taskId, worktreePath),
        this.#runnerCall(['symbolic-ref', '-q', 'HEAD'], 'verify-worktree', taskId, worktreePath),
        this.#runnerCall(['rev-parse', '--verify', 'HEAD'], 'verify-worktree', taskId, worktreePath),
        this.#runnerCall(['rev-parse', '--verify', `refs/heads/${branchName}`], 'verify-worktree', taskId, worktreePath),
      ]);
      const top = await realpath(path.resolve(worktreePath, topResult.stdout.trim()));
      const linkedGitDir = await realpath(path.resolve(worktreePath, gitDirResult.stdout.trim()));
      const commonDir = await realpath(path.resolve(worktreePath, commonResult.stdout.trim()));
      if (!samePath(top, worktreePath) || !isContainedPath(path.join(this.#gitDir, 'worktrees'), linkedGitDir) ||
        !samePath(commonDir, this.#gitDir) || branchResult.stdout.trim() !== `refs/heads/${branchName}` ||
        headResult.stdout.trim() !== record.head || refResult.stdout.trim() !== record.head) {
        throw new Error('identity mismatch');
      }
    } catch (error) {
      if (error instanceof GitWorktreeError && error.code === 'GIT_WORKTREE_GIT_UNAVAILABLE') throw error;
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Task worktree Git identity is inconsistent', 'inspect', taskId,
      );
    }
    return Object.freeze({
      taskId, repositoryRoot: this.#repositoryRoot, worktreePath,
      branchName, headCommit: record.head,
    });
  }

  async #discover(): Promise<readonly GitWorktreeRecord[]> {
    const result = await this.#runnerCall(['worktree', 'list', '--porcelain', '-z'], 'discover');
    return parseWorktreePorcelain(result.stdout);
  }

  async #resolveCommit(baseRef: string, taskId: string): Promise<string> {
    try {
      const result = await this.#runnerCall(
        ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], 'resolve-base', taskId,
      );
      const commit = result.stdout.trim();
      if (!shaPattern.test(commit)) throw new Error('invalid commit');
      return commit;
    } catch (error) {
      if (error instanceof GitWorktreeError && error.code === 'GIT_WORKTREE_GIT_UNAVAILABLE') throw error;
      throw new GitWorktreeError('GIT_WORKTREE_BASE_NOT_FOUND', 'Base ref does not resolve to a local commit', 'resolve-base', taskId);
    }
  }

  async #branchExists(branchName: string, taskId?: string): Promise<boolean> {
    const result = await this.#runnerCall(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], 'inspect-branch', taskId, undefined, [0, 1],
    );
    return result.exitCode === 0;
  }

  async #removalPostconditions(
    taskId: string, branchName: string, worktreePath: string, baseCommit: string,
  ): Promise<boolean> {
    await this.#validateManagedRoot(taskId, false);
    const records = await this.#discover();
    return findByPath(records, worktreePath) === undefined &&
      !await pathExists(worktreePath) && await this.#branchExists(branchName) &&
      await this.#readBaseMarker(taskId) === baseCommit;
  }

  async #ensureExclude(): Promise<void> {
    if (this.#coordination.excludePromise !== undefined) return this.#coordination.excludePromise;
    const current = this.#writeExclude();
    this.#coordination.excludePromise = current;
    void current.finally(() => {
      if (this.#coordination.excludePromise === current) delete this.#coordination.excludePromise;
    }).catch(() => undefined);
    return current;
  }

  async #writeExclude(): Promise<void> {
    const result = await this.#runnerCall(['rev-parse', '--git-path', 'info/exclude'], 'exclude');
    const excludePath = path.resolve(this.#repositoryRoot, result.stdout.trim());
    const expectedInfo = path.join(this.#gitDir, 'info');
    if (!samePath(excludePath, path.join(expectedInfo, 'exclude')) || !isContainedPath(this.#gitDir, excludePath)) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Git exclude path escapes primary metadata', 'exclude',
      );
    }
    await this.#ensureRealDirectory(expectedInfo, 'exclude');
    const existing = await safeLstat(excludePath);
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Git exclude path is not a regular file', 'exclude',
      );
    }
    let content = '';
    try { content = await readFile(excludePath, 'utf8'); } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    if (content.split(/\r?\n/).includes(excludeRule)) return;
    await this.#ensureRealDirectory(expectedInfo, 'exclude');
    const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    await writeFile(excludePath, `${content}${prefix}${excludeRule}\n`, { encoding: 'utf8' });
  }

  async #validateManagedRoot(taskId: string, create: boolean): Promise<void> {
    const agentHubRoot = path.join(this.#repositoryRoot, '.agenthub');
    const validate = async (target: string): Promise<boolean> => {
      const stat = await safeLstat(target);
      if (stat === undefined) return false;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw pathConflict(taskId);
      return true;
    };
    if (!await validate(agentHubRoot)) {
      if (!create) return;
      try { await mkdir(agentHubRoot); } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      await validate(agentHubRoot);
    }
    if (!await validate(this.#worktreesRoot)) {
      if (!create) return;
      try { await mkdir(this.#worktreesRoot); } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      await validate(agentHubRoot);
      await validate(this.#worktreesRoot);
    }
    const canonical = await realpath(this.#worktreesRoot);
    if (!samePath(canonical, this.#worktreesRoot) || !isContainedPath(this.#repositoryRoot, canonical)) {
      throw pathConflict(taskId);
    }
  }

  async #ensureRealDirectory(target: string, operation: string): Promise<void> {
    let stat = await safeLstat(target);
    if (stat === undefined) {
      try { await mkdir(target); } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      stat = await safeLstat(target);
    }
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() ||
      !samePath(await realpath(target), target)) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_CONTRACT_VIOLATION', 'Git metadata parent is unsafe', operation,
      );
    }
  }

  async #readBaseMarker(taskId: string): Promise<string | undefined> {
    const marker = baseMarkerFor(taskId);
    const exists = await this.#runnerCall(
      ['show-ref', '--verify', '--quiet', marker], 'inspect-base', taskId, undefined, [0, 1],
    );
    if (exists.exitCode === 1) return undefined;
    const symbolic = await this.#runnerCall(
      ['symbolic-ref', '-q', marker], 'inspect-base', taskId, undefined, [0, 1],
    );
    if (symbolic.exitCode === 0) throw baseConflict(taskId);
    const resolved = await this.#runnerCall(
      ['rev-parse', '--verify', '--end-of-options', `${marker}^{commit}`], 'inspect-base', taskId,
    );
    const commit = resolved.stdout.trim();
    if (!shaPattern.test(commit)) throw baseConflict(taskId);
    return commit;
  }

  async #requireBaseMarker(taskId: string): Promise<string> {
    const marker = await this.#readBaseMarker(taskId);
    if (marker === undefined) throw baseConflict(taskId);
    return marker;
  }

  async #assertBaseAncestry(taskId: string, baseCommit: string, headCommit: string): Promise<void> {
    const result = await this.#runnerCall(
      ['merge-base', '--is-ancestor', baseCommit, headCommit], 'verify-base', taskId, undefined, [0, 1],
    );
    if (result.exitCode !== 0) throw baseConflict(taskId);
  }

  async #recoverBaseMarker(
    taskId: string, workspace: VerifiedWorkspace, requestedBase: string,
  ): Promise<string> {
    if (workspace.headCommit !== requestedBase) throw baseConflict(taskId);
    return this.#ensureBaseMarker(taskId, requestedBase);
  }

  async #ensureBaseMarker(taskId: string, baseCommit: string): Promise<string> {
    const existing = await this.#readBaseMarker(taskId);
    if (existing !== undefined) {
      if (existing !== baseCommit) throw baseConflict(taskId);
      return existing;
    }
    try {
      await this.#runnerCall(['update-ref', baseMarkerFor(taskId), baseCommit, ''], 'create-base', taskId);
    } catch {
      const reconciled = await this.#readBaseMarker(taskId);
      if (reconciled === baseCommit) return reconciled;
      throw baseConflict(taskId);
    }
    const verified = await this.#readBaseMarker(taskId);
    if (verified !== baseCommit) throw baseConflict(taskId);
    return verified;
  }

  async #assertNoTrackedWorkspaceContent(taskId?: string): Promise<void> {
    const result = await this.#runnerCall(
      ['ls-files', '-z', '--', '.agenthub/worktrees'], 'tracked-content', taskId,
    );
    if (result.stdout.length > 0) {
      throw new GitWorktreeError(
        'GIT_WORKTREE_PATH_CONFLICT', 'Tracked .agenthub/worktrees content prevents workspace management',
        'tracked-content', taskId,
      );
    }
  }

  #pathFor(taskId: string): string {
    const worktreePath = path.resolve(this.#worktreesRoot, taskId);
    const relative = path.relative(this.#worktreesRoot, worktreePath);
    if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw invalidTaskId();
    }
    return worktreePath;
  }

  #runnerCall(
    args: readonly string[],
    operation: string,
    taskId?: string,
    cwd = this.#repositoryRoot,
    acceptedExitCodes?: readonly number[],
  ) {
    return this.#runner.run(args, {
      cwd,
      ...(acceptedExitCodes === undefined ? {} : { acceptedExitCodes }),
    }).catch((error: unknown) => {
      throw workspaceErrorFrom(
        error, 'GIT_WORKTREE_CONTRACT_VIOLATION', `Git ${operation} operation failed`, operation, taskId,
      );
    });
  }
}

export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || !taskIdPattern.test(value) || value.includes('..') ||
    value.endsWith('.') || windowsReservedPattern.test(value)) throw invalidTaskId();
  return value;
}

export function parseWorktreePorcelain(output: string): readonly GitWorktreeRecord[] {
  if (typeof output !== 'string') throw parseError();
  const records: GitWorktreeRecord[] = [];
  let current: {
    worktreePath?: string;
    head?: string;
    branch?: string;
    detached?: boolean;
    bare?: boolean;
    locked?: boolean;
    prunable?: boolean;
  } | undefined;
  const finish = (): void => {
    if (current === undefined) return;
    if (typeof current.worktreePath !== 'string' || current.worktreePath.length === 0) throw parseError();
    records.push(Object.freeze({
      worktreePath: current.worktreePath,
      ...(current.head === undefined ? {} : { head: current.head }),
      ...(current.branch === undefined ? {} : { branch: current.branch }),
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    }));
    current = undefined;
  };
  for (const token of output.split('\0')) {
    if (token.length === 0) { finish(); continue; }
    const separator = token.indexOf(' ');
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? '' : token.slice(separator + 1);
    if (key === 'worktree') {
      finish();
      current = { worktreePath: value };
      continue;
    }
    if (current === undefined) throw parseError();
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  finish();
  return Object.freeze(records);
}

function branchFor(taskId: string): string { return `agenthub/${taskId}`; }

function baseMarkerFor(taskId: string): string { return `refs/agenthub/bases/${taskId}`; }

function validateBaseRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim().length === 0 ||
    value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new GitWorktreeError('GIT_WORKTREE_INVALID_BASE_REF', 'Base ref is invalid', 'create');
  }
  return value;
}

function operationKey(taskId: string): string {
  return process.platform === 'win32' ? taskId.toLocaleLowerCase('en-US') : taskId;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function isContainedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function coordinationFor(repositoryRoot: string): RepositoryCoordination {
  const key = process.platform === 'win32'
    ? path.normalize(repositoryRoot).toLocaleLowerCase('en-US')
    : path.normalize(repositoryRoot);
  const current = repositoryCoordinators.get(key)?.deref();
  if (current !== undefined) return current;
  const coordination: RepositoryCoordination = { operations: new Map() };
  const ref = new WeakRef(coordination);
  repositoryCoordinators.set(key, ref);
  coordinatorFinalizer.register(coordination, { key, ref });
  return coordination;
}

function findByPath(records: readonly GitWorktreeRecord[], expectedPath: string): GitWorktreeRecord | undefined {
  return records.find((record) => samePath(path.resolve(record.worktreePath), expectedPath));
}

function findByBranch(records: readonly GitWorktreeRecord[], branchName: string): GitWorktreeRecord | undefined {
  return records.find((record) => record.branch === `refs/heads/${branchName}`);
}

function preflightError(error: unknown): GitWorktreeError {
  if (error instanceof GitCommandError && error.code === 'GIT_COMMAND_UNAVAILABLE') {
    return new GitWorktreeError('GIT_WORKTREE_GIT_UNAVAILABLE', 'Git executable is unavailable', 'open');
  }
  return new GitWorktreeError('GIT_WORKTREE_NOT_REPOSITORY', 'Repository root is not a Git repository', 'open');
}

function workspaceErrorFrom(
  error: unknown,
  fallbackCode: GitWorktreeErrorCode,
  message: string,
  operation: string,
  taskId?: string,
): GitWorktreeError {
  if (error instanceof GitWorktreeError) {
    if (error.code === 'GIT_WORKTREE_GIT_UNAVAILABLE' || fallbackCode === 'GIT_WORKTREE_CONTRACT_VIOLATION') {
      return error;
    }
    return new GitWorktreeError(fallbackCode, message, operation, taskId, error.exitCode);
  }
  if (error instanceof GitCommandError && error.code === 'GIT_COMMAND_UNAVAILABLE') {
    return new GitWorktreeError('GIT_WORKTREE_GIT_UNAVAILABLE', 'Git executable is unavailable', operation, taskId);
  }
  return new GitWorktreeError(fallbackCode, message, operation, taskId,
    error instanceof GitCommandError ? error.exitCode : undefined);
}

function invalidTaskId(): GitWorktreeError {
  return new GitWorktreeError('GIT_WORKTREE_INVALID_TASK_ID', 'Task ID is not workspace-safe', 'validate-task');
}

function operationBusy(taskId: string): GitWorktreeError {
  return new GitWorktreeError(
    'GIT_WORKTREE_OPERATION_BUSY', 'Another workspace operation owns this task', 'operation', taskId,
  );
}

function pathConflict(taskId: string): GitWorktreeError {
  return new GitWorktreeError('GIT_WORKTREE_PATH_CONFLICT', 'Task worktree path conflicts with existing state', 'inspect', taskId);
}

function staleMetadata(taskId: string): GitWorktreeError {
  return new GitWorktreeError('GIT_WORKTREE_STALE_METADATA', 'Task worktree has stale Git metadata', 'inspect', taskId);
}

function baseConflict(taskId: string): GitWorktreeError {
  return new GitWorktreeError(
    'GIT_WORKTREE_BASE_CONFLICT', 'Task base metadata is missing or conflicts with workspace identity',
    'base-identity', taskId,
  );
}

function parseError(): GitWorktreeError {
  return new GitWorktreeError(
    'GIT_WORKTREE_CONTRACT_VIOLATION', 'Git worktree porcelain output is malformed', 'discover',
  );
}

async function safeLstat(targetPath: string) {
  try { return await lstat(targetPath); } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> { return await safeLstat(targetPath) !== undefined; }

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Workspace operation failed', { cause: error });
}
