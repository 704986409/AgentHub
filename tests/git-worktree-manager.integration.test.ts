import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('GitWorktreeManager real Git integration', () => {
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

function git(cwd: string, args: readonly string[]) {
  return runner.run(args, { cwd });
}
