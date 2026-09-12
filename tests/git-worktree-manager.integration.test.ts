import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCommandRunner, GitWorktreeManager } from '../src/index.js';

const runner = new GitCommandRunner();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Refusing to remove a path outside the test temp directory');
    }
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('GitWorktreeManager real Git integration', { timeout: 15_000 }, () => {
  it('reports a real Git executable and rejects non-repo, bare, nested, and linked roots', async () => {
    const version = await runner.run(['--version'], { cwd: process.cwd() });
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^git version /);
    const nonRepo = await temporaryDirectory('agenthub nonrepo ');
    await expect(GitWorktreeManager.open({ repositoryRoot: nonRepo })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_NOT_REPOSITORY',
    });

    const bare = await temporaryDirectory('agenthub bare ');
    await git(bare, ['init', '--bare']);
    await expect(GitWorktreeManager.open({ repositoryRoot: bare })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_UNSUPPORTED_REPOSITORY',
    });

    const repo = await createRepository('agenthub root validation ');
    const nested = path.join(repo, 'nested');
    await mkdir(nested);
    await expect(GitWorktreeManager.open({ repositoryRoot: nested })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_ROOT_MISMATCH',
    });
    const linked = path.join(path.dirname(repo), `${path.basename(repo)} linked`);
    await git(repo, ['worktree', 'add', '-b', 'linked-test', linked, 'HEAD']);
    roots.push(linked);
    await expect(GitWorktreeManager.open({ repositoryRoot: linked })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_UNSUPPORTED_REPOSITORY',
    });
  });

  it('creates and adopts worktrees in a spaced path while preserving primary state and local exclude', async () => {
    const repo = await createRepository('agenthub repository with spaces ');
    const excludePath = (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim();
    await writeFile(path.resolve(repo, excludePath), 'custom-rule\n', 'utf8');
    await writeFile(path.join(repo, 'tracked.txt'), 'dirty primary\n', 'utf8');
    await writeFile(path.join(repo, 'untracked.txt'), 'untracked\n', 'utf8');
    const beforeStatus = (await git(repo, ['status', '--porcelain=v1', '-z'])).stdout;
    const beforeHead = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const beforeBranch = (await git(repo, ['branch', '--show-current'])).stdout.trim();

    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const first = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const second = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    expect(first).toMatchObject({
      taskId: 'TASK-A', branchName: 'agenthub/TASK-A', headCommit: beforeHead,
      baseCommit: beforeHead, created: true,
    });
    expect(second).toMatchObject({ ...first, created: false });
    expect(Object.isFrozen(first)).toBe(true);
    expect(await manager.inspectWorkspace('TASK-A')).toEqual({
      taskId: second.taskId,
      repositoryRoot: second.repositoryRoot,
      worktreePath: second.worktreePath,
      branchName: second.branchName,
      baseCommit: second.baseCommit,
      headCommit: second.headCommit,
    });
    expect((await git(repo, ['show-ref', '--verify', 'refs/heads/agenthub/TASK-A'])).exitCode).toBe(0);
    expect((await git(repo, ['status', '--porcelain=v1', '-z'])).stdout).toBe(beforeStatus);
    expect((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeHead);
    expect((await git(repo, ['branch', '--show-current'])).stdout.trim()).toBe(beforeBranch);
    const exclude = await readFile(path.resolve(repo, excludePath), 'utf8');
    expect(exclude).toContain('custom-rule\n');
    expect(exclude.split(/\r?\n/).filter((line) => line === '/.agenthub/worktrees/')).toHaveLength(1);
  });

  it('deduplicates same-task creation, rejects conflicting overlap, and permits different tasks', async () => {
    const repo = await createRepository('agenthub concurrency ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const first = manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const duplicate = manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const conflict = manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'main' });
    const removalConflict = manager.removeWorkspace('TASK-A');
    const independent = manager.createWorkspace({ taskId: 'TASK-B', baseRef: 'HEAD' });
    expect(duplicate).toBe(first);
    await expect(conflict).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(removalConflict).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    const [taskA, taskB] = await Promise.all([first, independent]);
    expect(taskA.worktreePath).not.toBe(taskB.worktreePath);
    expect(taskA.branchName).toBe('agenthub/TASK-A');
    expect(taskB.branchName).toBe('agenthub/TASK-B');
    expect(taskA.baseCommit).toBe(taskB.baseCommit);
    const records = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout;
    expect(records.match(/^worktree /gm)).toHaveLength(3);
  });

  it('rejects existing branches and paths without changing user data', async () => {
    const repo = await createRepository('agenthub collision ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(repo, ['branch', 'agenthub/BRANCH-CONFLICT', head]);
    await expect(manager.createWorkspace({ taskId: 'BRANCH-CONFLICT', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_BRANCH_CONFLICT' });
    expect((await git(repo, ['rev-parse', 'refs/heads/agenthub/BRANCH-CONFLICT'])).stdout.trim()).toBe(head);

    const conflictPath = path.join(repo, '.agenthub', 'worktrees', 'PATH-CONFLICT');
    await mkdir(conflictPath, { recursive: true });
    const sentinel = path.join(conflictPath, 'sentinel.txt');
    await writeFile(sentinel, 'preserve me', 'utf8');
    await expect(manager.createWorkspace({ taskId: 'PATH-CONFLICT', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me');

    await expect(manager.createWorkspace({ taskId: 'MISSING-BASE', baseRef: 'refs/heads/missing' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_BASE_NOT_FOUND' });
    await expect(manager.createWorkspace({ taskId: 'INVALID-REF', baseRef: '-unsafe' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_INVALID_BASE_REF' });
    await expect(manager.createWorkspace({ taskId: 'invalid.lock', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_INVALID_TASK_ID' });
  });

  it('rejects symlink, detached, and prunable collisions without repair or deletion', async () => {
    const repo = await createRepository('agenthub metadata collision ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const worktreesRoot = path.join(repo, '.agenthub', 'worktrees');
    await mkdir(worktreesRoot, { recursive: true });

    const target = await temporaryDirectory('agenthub symlink target ');
    const sentinel = path.join(target, 'sentinel.txt');
    await writeFile(sentinel, 'preserve me', 'utf8');
    await symlink(target, path.join(worktreesRoot, 'SYMLINK'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.createWorkspace({ taskId: 'SYMLINK', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me');

    const detachedPath = path.join(worktreesRoot, 'DETACHED');
    await git(repo, ['worktree', 'add', '--detach', detachedPath, 'HEAD']);
    await expect(manager.createWorkspace({ taskId: 'DETACHED', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });

    const stalePath = path.join(worktreesRoot, 'STALE');
    await git(repo, ['worktree', 'add', '-b', 'agenthub/STALE', stalePath, 'HEAD']);
    await rm(stalePath, { recursive: true, force: true });
    await expect(manager.createWorkspace({ taskId: 'STALE', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_STALE_METADATA' });
  });

  it('blocks every dirty form and removes only a clean worktree while preserving its committed branch', async () => {
    const repo = await createRepository('agenthub removal ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const tracked = path.join(workspace.worktreePath, 'tracked.txt');
    const untracked = path.join(workspace.worktreePath, 'untracked.txt');
    const ignored = path.join(workspace.worktreePath, 'ignored.log');
    await writeFile(tracked, 'modified\n', 'utf8');
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
    expect(await manager.inspectWorkspace('TASK-A')).toBeDefined();
    await git(workspace.worktreePath, ['add', 'tracked.txt']);
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
    await git(workspace.worktreePath, ['commit', '-m', 'task change']);
    await writeFile(untracked, 'untracked\n', 'utf8');
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
    await rm(untracked);
    await writeFile(path.join(workspace.worktreePath, '.gitignore'), '*.log\n', 'utf8');
    await git(workspace.worktreePath, ['add', '.gitignore']);
    await git(workspace.worktreePath, ['commit', '-m', 'ignore task output']);
    await writeFile(ignored, 'must not be discarded\n', 'utf8');
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_DIRTY' });
    await expect(readFile(ignored, 'utf8')).resolves.toBe('must not be discarded\n');
    await rm(ignored);
    const taskCommit = (await git(workspace.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    const primaryHead = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await manager.removeWorkspace('TASK-A');
    await expect(manager.removeWorkspace('TASK-A')).resolves.toBeUndefined();
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_BRANCH_CONFLICT' });
    expect((await git(repo, ['rev-parse', 'refs/heads/agenthub/TASK-A'])).stdout.trim()).toBe(taskCommit);
    expect((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(primaryHead);
    expect(taskCommit).not.toBe(primaryHead);
  });

  it('rejects tracked canonical workspace content before creating any worktree', async () => {
    const repo = await createRepository('agenthub tracked conflict ');
    const trackedPath = path.join(repo, '.agenthub', 'worktrees', 'tracked.txt');
    await mkdir(path.dirname(trackedPath), { recursive: true });
    await writeFile(trackedPath, 'tracked\n', 'utf8');
    await git(repo, ['add', '.agenthub/worktrees/tracked.txt']);
    await git(repo, ['commit', '-m', 'track conflict']);
    await expect(GitWorktreeManager.open({ repositoryRoot: repo })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_PATH_CONFLICT',
    });
    expect((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it('blocks managed-root and Git-info junction escapes without touching external data', async () => {
    const repo = await createRepository('agenthub containment ');
    const external = await temporaryDirectory('agenthub external ');
    const sentinel = path.join(external, 'sentinel.txt');
    await writeFile(sentinel, 'preserve me', 'utf8');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });

    await writeFile(path.join(repo, '.agenthub'), 'conflict');
    await expect(manager.createWorkspace({ taskId: 'PARENT-FILE', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await rm(path.join(repo, '.agenthub'));
    await symlink(external, path.join(repo, '.agenthub'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.createWorkspace({ taskId: 'PARENT-LINK', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me');
    await expect(readFile(path.join(external, 'worktrees', 'PARENT-LINK'))).rejects.toBeDefined();
    await rm(path.join(repo, '.agenthub'), { force: true });

    await mkdir(path.join(repo, '.agenthub'));
    await writeFile(path.join(repo, '.agenthub', 'worktrees'), 'conflict');
    await expect(manager.createWorkspace({ taskId: 'WORKTREES-FILE', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await rm(path.join(repo, '.agenthub', 'worktrees'));
    await symlink(external, path.join(repo, '.agenthub', 'worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.createWorkspace({ taskId: 'WORKTREES-LINK', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await rm(path.join(repo, '.agenthub', 'worktrees'), { force: true });

    const info = path.join(repo, '.git', 'info');
    const infoBackup = path.join(repo, '.git', 'info-backup');
    await rename(info, infoBackup);
    await symlink(external, info, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.createWorkspace({ taskId: 'INFO-LINK', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_CONTRACT_VIOLATION', operation: 'exclude' });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me');
    await rm(info, { force: true });
    await rename(infoBackup, info);
    expect((await git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/agenthub/INFO-LINK'], [0, 1])).exitCode).toBe(1);
  });

  it('rejects a replaced managed root before inspect or remove', async () => {
    const repo = await createRepository('agenthub replacement ');
    const external = await temporaryDirectory('agenthub replacement external ');
    const sentinel = path.join(external, 'sentinel.txt');
    await writeFile(sentinel, 'preserve me', 'utf8');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const managed = path.join(repo, '.agenthub');
    const backup = path.join(repo, '.agenthub-safe');
    await rename(managed, backup);
    await symlink(external, managed, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve me');
    await rm(managed, { force: true });
    await rename(backup, managed);
  });

  it('persists original base identity across main movement, task commits, restart, and removal', async () => {
    const repo = await createRepository('agenthub durable base ');
    let manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'main' });
    const original = workspace.baseCommit;
    expect((await git(repo, ['rev-parse', 'refs/agenthub/bases/TASK-A'])).stdout.trim()).toBe(original);
    await writeFile(path.join(workspace.worktreePath, 'task.txt'), 'task\n');
    await git(workspace.worktreePath, ['add', 'task.txt']);
    await git(workspace.worktreePath, ['commit', '-m', 'task commit']);
    const taskCommit = (await git(workspace.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(repo, 'main.txt'), 'main\n');
    await git(repo, ['add', 'main.txt']);
    await git(repo, ['commit', '-m', 'advance main']);
    manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const adopted = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'main' });
    expect(adopted).toMatchObject({ created: false, baseCommit: original, headCommit: taskCommit });
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'refs/heads/no-longer-present' }))
      .resolves.toMatchObject({ created: false, baseCommit: original, headCommit: taskCommit });
    expect(await manager.inspectWorkspace('TASK-A')).toMatchObject({ baseCommit: original, headCommit: taskCommit });
    await manager.removeWorkspace('TASK-A');
    expect((await git(repo, ['rev-parse', 'refs/agenthub/bases/TASK-A'])).stdout.trim()).toBe(original);
    expect((await git(repo, ['rev-parse', 'refs/heads/agenthub/TASK-A'])).stdout.trim()).toBe(taskCommit);
  });

  it('coordinates same-repository managers and keeps repositories independent', async () => {
    const repoA = await createRepository('agenthub shared manager A ');
    const repoB = await createRepository('agenthub shared manager B ');
    const counting = new CountingRunner(runner);
    const [managerA1, managerA2, managerB] = await Promise.all([
      GitWorktreeManager.open({ repositoryRoot: repoA, runner: counting }),
      GitWorktreeManager.open({ repositoryRoot: repoA, runner: counting }),
      GitWorktreeManager.open({ repositoryRoot: repoB, runner: counting }),
    ]);
    const first = managerA1.createWorkspace({ taskId: 'TASK-X', baseRef: 'HEAD' });
    const duplicate = managerA2.createWorkspace({ taskId: 'TASK-X', baseRef: 'HEAD' });
    expect(duplicate).toBe(first);
    await expect(managerA2.createWorkspace({ taskId: 'TASK-X', baseRef: 'main' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(managerA2.removeWorkspace('TASK-X')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    const otherRepo = managerB.createWorkspace({ taskId: 'TASK-X', baseRef: 'HEAD' });
    await Promise.all([first, otherRepo]);
    expect([...counting.addCallsByRoot.values()]).toEqual([1, 1]);
    expect([...counting.excludeCallsByRoot.values()]).toEqual([1, 1]);
    counting.blockRemove = true;
    const removal = managerA1.removeWorkspace('TASK-X');
    await counting.removeStarted;
    await expect(managerA2.createWorkspace({ taskId: 'TASK-X', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    counting.releaseRemove();
    await removal;
  });

  it('ignores inherited Git repository-routing environment', async () => {
    const repoA = await createRepository('agenthub routed A ');
    const repoB = await createRepository('agenthub routed B ');
    const isolated = new GitCommandRunner({
      env: { ...process.env, GIT_DIR: path.join(repoB, '.git'), GIT_WORK_TREE: repoB },
    });
    const manager = await GitWorktreeManager.open({ repositoryRoot: repoA, runner: isolated });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    expect(workspace.repositoryRoot).toBe(await realpath(repoA));
    expect((await git(repoB, ['show-ref', '--verify', '--quiet', 'refs/heads/agenthub/TASK-A'], [0, 1])).exitCode)
      .toBe(1);
  });

  it('recovers only an exact clean missing base marker and rejects ambiguous migration', async () => {
    const repo = await createRepository('agenthub marker recovery ');
    let manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const workspace = await manager.createWorkspace({ taskId: 'SAFE', baseRef: 'HEAD' });
    await git(repo, ['update-ref', '-d', 'refs/agenthub/bases/SAFE']);
    manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    await expect(manager.createWorkspace({ taskId: 'SAFE', baseRef: 'HEAD' }))
      .resolves.toMatchObject({ created: false, baseCommit: workspace.baseCommit });

    const ambiguous = await manager.createWorkspace({ taskId: 'AMBIGUOUS', baseRef: 'HEAD' });
    await writeFile(path.join(ambiguous.worktreePath, 'change.txt'), 'change\n');
    await git(ambiguous.worktreePath, ['add', 'change.txt']);
    await git(ambiguous.worktreePath, ['commit', '-m', 'advance task']);
    await git(repo, ['update-ref', '-d', 'refs/agenthub/bases/AMBIGUOUS']);
    manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    await expect(manager.createWorkspace({ taskId: 'AMBIGUOUS', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_BASE_CONFLICT' });

    await git(repo, ['update-ref', 'refs/agenthub/bases/COLLISION', 'HEAD']);
    await expect(manager.createWorkspace({ taskId: 'COLLISION', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_BASE_CONFLICT' });
  });

  it('rejects tampered linked-worktree metadata and branch identity', async () => {
    const repo = await createRepository('agenthub metadata identity ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const dotGit = path.join(workspace.worktreePath, '.git');
    const backup = path.join(workspace.worktreePath, '.git-safe');
    await rename(dotGit, backup);
    await writeFile(dotGit, 'gitdir: C:/definitely/not/the/right/repository\n');
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_CONTRACT_VIOLATION' });
    await rm(dotGit);
    await mkdir(dotGit);
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_CONFLICT' });
    await rm(dotGit, { recursive: true });
    await rename(backup, dotGit);

    await git(repo, ['update-ref', '-d', 'refs/heads/agenthub/TASK-A']);
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_CONTRACT_VIOLATION' });
  });

  it('snapshots manager open options exactly once', async () => {
    const repo = await createRepository('agenthub open snapshot ');
    let rootReads = 0;
    let runnerReads = 0;
    let executableReads = 0;
    const options = Object.defineProperties({}, {
      repositoryRoot: { get: () => { rootReads += 1; return rootReads === 1 ? repo : 'wrong'; } },
      runner: { get: () => { runnerReads += 1; return runner; } },
      gitExecutable: { get: () => { executableReads += 1; return 'unused'; } },
    }) as { repositoryRoot: string; runner: GitCommandRunner; gitExecutable: string };
    const manager = await GitWorktreeManager.open(options);
    expect(manager.repositoryRoot).toBe(await realCanonical(repo));
    expect({ rootReads, runnerReads, executableReads }).toEqual({ rootReads: 1, runnerReads: 1, executableReads: 1 });
  });
});

async function createRepository(prefix: string): Promise<string> {
  const repo = await temporaryDirectory(prefix);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'AgentHub Test']);
  await git(repo, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(repo, 'tracked.txt'), 'initial\n', 'utf8');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[], acceptedExitCodes?: readonly number[]) {
  return runner.run(args, { cwd, ...(acceptedExitCodes === undefined ? {} : { acceptedExitCodes }) });
}

class CountingRunner {
  public readonly addCallsByRoot = new Map<string, number>();
  public readonly excludeCallsByRoot = new Map<string, number>();
  public blockRemove = false;
  public readonly removeStarted: Promise<void>;
  private signalRemove!: () => void;
  private continueRemove: (() => void) | undefined;
  public constructor(private readonly delegate: GitCommandRunner) {
    this.removeStarted = new Promise((resolve) => { this.signalRemove = resolve; });
  }
  public async run(args: readonly string[], options: { cwd: string; acceptedExitCodes?: readonly number[] }) {
    if (args[0] === 'worktree' && args[1] === 'add') increment(this.addCallsByRoot, options.cwd);
    if (args.join(' ') === 'rev-parse --git-path info/exclude') increment(this.excludeCallsByRoot, options.cwd);
    if (this.blockRemove && args[0] === 'worktree' && args[1] === 'remove') {
      this.signalRemove();
      await new Promise<void>((resolve) => { this.continueRemove = resolve; });
    }
    return this.delegate.run(args, options);
  }
  public releaseRemove(): void { this.continueRemove?.(); }
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

async function realCanonical(value: string): Promise<string> {
  return realpath(value);
}
