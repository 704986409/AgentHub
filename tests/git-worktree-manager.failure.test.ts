import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GitCommandError,
  GitCommandRunner,
  GitWorktreeManager,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunnerLike,
  type GitExecFile,
} from '../src/index.js';

const actual = new GitCommandRunner();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('Unsafe test cleanup target');
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('GitWorktreeManager failure reconciliation', () => {
  it('reports an unavailable Git executable as a typed preflight failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agenthub unavailable git '));
    roots.push(root);
    const unavailable: GitExecFile = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', 'private diagnostic');
    };
    const runner = new GitCommandRunner({ execFile: unavailable });
    const error = await GitWorktreeManager.open({ repositoryRoot: root, runner }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'GIT_WORKTREE_GIT_UNAVAILABLE', operation: 'open' });
    expect(String(error)).not.toContain('private diagnostic');
  });

  it('clears a clean create failure and permits an explicit retry', async () => {
    const repo = await createRepository('agenthub clean failure ');
    const injected = new InterceptRunner(actual);
    injected.addMode = 'clean-failure';
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_CREATE_FAILED', taskId: 'TASK-A',
    });
    expect(injected.addCalls).toBe(1);
    injected.addMode = 'pass';
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' })).resolves.toMatchObject({
      created: true, branchName: 'agenthub/TASK-A',
    });
    expect(injected.addCalls).toBe(2);
  });

  it('preserves a partially created branch and reports failure without destructive cleanup', async () => {
    const repo = await createRepository('agenthub partial failure ');
    const injected = new InterceptRunner(actual);
    injected.addMode = 'branch-then-fail';
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    const base = (await actual.run(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_CREATE_FAILED',
    });
    expect((await actual.run(['rev-parse', 'refs/heads/agenthub/TASK-A'], { cwd: repo })).stdout.trim()).toBe(base);
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_BRANCH_CONFLICT',
    });
  });

  it('accepts authoritative clean removal when Git reports failure after completing it', async () => {
    const repo = await createRepository('agenthub remove reconciliation ');
    const injected = new InterceptRunner(actual);
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    injected.removeAfterSuccessFailure = true;
    await expect(manager.removeWorkspace('TASK-A')).resolves.toBeUndefined();
    await expect(manager.inspectWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_BRANCH_CONFLICT' });
    expect((await actual.run(['show-ref', '--verify', 'refs/heads/agenthub/TASK-A'], { cwd: repo })).exitCode).toBe(0);
    await expect(writeFile(path.join(workspace.worktreePath, 'unexpected'), 'x')).rejects.toBeDefined();
  });

  it('blocks creation when local exclude initialization fails', async () => {
    const repo = await createRepository('agenthub exclude failure ');
    const injected = new InterceptRunner(actual);
    injected.excludeFailure = true;
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' })).rejects.toMatchObject({
      code: 'GIT_WORKTREE_CONTRACT_VIOLATION', operation: 'exclude',
    });
    expect(injected.addCalls).toBe(0);
    await expect(actual.run(['show-ref', '--verify', '--quiet', 'refs/heads/agenthub/TASK-A'], {
      cwd: repo, acceptedExitCodes: [0, 1],
    })).resolves.toMatchObject({ exitCode: 1 });
  });

  it('creates from the immutable commit resolved before a moving base ref advances', async () => {
    const repo = await createRepository('agenthub moving base ');
    const original = (await actual.run(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const injected = new InterceptRunner(actual);
    injected.addMode = 'move-base';
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'main' });
    const advanced = (await actual.run(['rev-parse', 'main'], { cwd: repo })).stdout.trim();
    expect(advanced).not.toBe(original);
    expect(workspace).toMatchObject({ baseCommit: original, headCommit: original });
    expect(injected.lastAddArgs?.at(-1)).toBe(original);
  });

  it('preserves ambiguous branch and path state created by a failed add', async () => {
    const repo = await createRepository('agenthub ambiguous add ');
    const injected = new InterceptRunner(actual);
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });

    injected.addMode = 'different-branch-then-fail';
    await expect(manager.createWorkspace({ taskId: 'AMBIGUOUS', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_CREATE_FAILED' });
    const requestedBase = required(injected.lastAddArgs ?? [], 5);
    const branchTip = (await actual.run(['rev-parse', 'refs/heads/agenthub/AMBIGUOUS'], { cwd: repo })).stdout.trim();
    expect(branchTip).not.toBe(requestedBase);

    injected.addMode = 'path-then-fail';
    await expect(manager.createWorkspace({ taskId: 'PATH-APPEARED', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_CREATE_FAILED' });
    await expect(readFile(path.join(repo, '.agenthub', 'worktrees', 'PATH-APPEARED', 'sentinel.txt'), 'utf8'))
      .resolves.toBe('preserve me');
  });

  it('retains a registered worktree when remove fails and permits a later retry', async () => {
    const repo = await createRepository('agenthub retained remove ');
    const injected = new InterceptRunner(actual);
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    injected.removeFailure = true;
    await expect(manager.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_REMOVE_FAILED' });
    await expect(manager.inspectWorkspace('TASK-A')).resolves.toMatchObject({ worktreePath: workspace.worktreePath });
    injected.removeFailure = false;
    await expect(manager.removeWorkspace('TASK-A')).resolves.toBeUndefined();
  });

  it('rejects success when create postconditions cannot be verified', async () => {
    const repo = await createRepository('agenthub create postcondition ');
    const injected = new InterceptRunner(actual);
    injected.addMode = 'hide-postcondition';
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_CONTRACT_VIOLATION' });
    expect((await actual.run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout)
      .toContain('branch refs/heads/agenthub/TASK-A');
  });

  it('preserves a created worktree when base-marker creation fails and recovers on retry', async () => {
    const repo = await createRepository('agenthub marker failure ');
    const injected = new InterceptRunner(actual);
    injected.markerFailure = true;
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: injected });
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_BASE_CONFLICT' });
    expect((await actual.run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout)
      .toContain('branch refs/heads/agenthub/TASK-A');
    await expect(actual.run(['show-ref', '--verify', '--quiet', 'refs/agenthub/bases/TASK-A'], {
      cwd: repo, acceptedExitCodes: [0, 1],
    })).resolves.toMatchObject({ exitCode: 1 });
    injected.markerFailure = false;
    await expect(manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }))
      .resolves.toMatchObject({ created: false });
  });
});

class InterceptRunner implements GitCommandRunnerLike {
  public addMode: 'pass' | 'clean-failure' | 'branch-then-fail' | 'different-branch-then-fail' |
    'path-then-fail' | 'move-base' | 'hide-postcondition' = 'pass';
  public addCalls = 0;
  public lastAddArgs: readonly string[] | undefined;
  public removeAfterSuccessFailure = false;
  public removeFailure = false;
  public excludeFailure = false;
  public markerFailure = false;
  private hideNextList = false;

  public constructor(private readonly delegate: GitCommandRunnerLike) {}

  public async run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    if (this.excludeFailure && args.join(' ') === 'rev-parse --git-path info/exclude') {
      throw new GitCommandError('GIT_COMMAND_FAILED', 'rev-parse', 1);
    }
    if (this.markerFailure && args[0] === 'update-ref' && args[1]?.startsWith('refs/agenthub/bases/')) {
      throw new GitCommandError('GIT_COMMAND_FAILED', 'update-ref', 1);
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      this.addCalls += 1;
      this.lastAddArgs = [...args];
      if (this.addMode === 'clean-failure') throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
      if (this.addMode === 'branch-then-fail') {
        const branch = required(args, 3);
        const baseCommit = required(args, 5);
        await this.delegate.run(['branch', branch, baseCommit], { cwd: options.cwd });
        throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
      }
      if (this.addMode === 'different-branch-then-fail') {
        const branch = required(args, 3);
        const baseCommit = required(args, 5);
        const tree = (await this.delegate.run(['write-tree'], { cwd: options.cwd })).stdout.trim();
        const different = (await this.delegate.run(
          ['commit-tree', tree, '-p', baseCommit, '-m', 'ambiguous branch'], { cwd: options.cwd },
        )).stdout.trim();
        await this.delegate.run(['branch', branch, different], { cwd: options.cwd });
        throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
      }
      if (this.addMode === 'path-then-fail') {
        const worktreePath = required(args, 4);
        await mkdir(worktreePath, { recursive: true });
        await writeFile(path.join(worktreePath, 'sentinel.txt'), 'preserve me', 'utf8');
        throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
      }
      if (this.addMode === 'move-base') {
        this.addMode = 'pass';
        const oldCommit = required(args, 5);
        const tree = (await this.delegate.run(['write-tree'], { cwd: options.cwd })).stdout.trim();
        const next = (await this.delegate.run(
          ['commit-tree', tree, '-p', oldCommit, '-m', 'advance moving base'], { cwd: options.cwd },
        )).stdout.trim();
        await this.delegate.run(['update-ref', 'refs/heads/main', next, oldCommit], { cwd: options.cwd });
      }
      if (this.addMode === 'hide-postcondition') {
        this.addMode = 'pass';
        const result = await this.delegate.run(args, options);
        this.hideNextList = true;
        return result;
      }
    }
    if (this.hideNextList && args.join(' ') === 'worktree list --porcelain -z') {
      this.hideNextList = false;
      const head = (await this.delegate.run(['rev-parse', 'HEAD'], { cwd: options.cwd })).stdout.trim();
      return { exitCode: 0, stdout: `worktree ${options.cwd}\0HEAD ${head}\0branch refs/heads/main\0`, stderr: '' };
    }
    if (this.removeFailure && args[0] === 'worktree' && args[1] === 'remove') {
      throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
    }
    if (this.removeAfterSuccessFailure && args[0] === 'worktree' && args[1] === 'remove') {
      this.removeAfterSuccessFailure = false;
      await this.delegate.run(args, options);
      throw new GitCommandError('GIT_COMMAND_FAILED', 'worktree', 1);
    }
    return this.delegate.run(args, options);
  }
}

async function createRepository(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(repo);
  await actual.run(['init', '-b', 'main'], { cwd: repo });
  await actual.run(['config', 'user.name', 'AgentHub Test'], { cwd: repo });
  await actual.run(['config', 'user.email', 'agenthub@example.invalid'], { cwd: repo });
  await mkdir(path.join(repo, 'nested'));
  await writeFile(path.join(repo, 'tracked.txt'), 'initial\n', 'utf8');
  await actual.run(['add', 'tracked.txt'], { cwd: repo });
  await actual.run(['commit', '-m', 'initial'], { cwd: repo });
  return repo;
}

function required(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing Git argument ${String(index)}`);
  return value;
}
