import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReviewEvidence, GitCommandRunner, GitWorktreeManager,
  type BuildTestEvidencePlan, type GitCommandRunnerLike } from '../src/index.js';
import { isTaskQuarantined, quarantineTask } from '../src/workspace/internal/GitWorktreeManagerTestHarness.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('MergeGate coordination', { timeout: 90_000 }, () => {
  it('owns a task globally and blocks all same-task operations while allowing another task', async () => {
    const repo = await createRepository('agenthub merge gate coordination ');
    const runner = new GateBarrierRunner();
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner });
    const taskA = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    const taskB = await manager.createWorkspace({ taskId: 'TASK-B', baseRef: 'HEAD' });
    await commitTaskChange(taskA.worktreePath, 'a.txt');
    await commitTaskChange(taskB.worktreePath, 'b.txt');
    const peer = await GitWorktreeManager.open({ repositoryRoot: repo });
    const evidence = await manager.collectBuildTestEvidence('TASK-A', evidencePlan());
    const review = accept(evidence);

    runner.arm(taskA.worktreePath);
    const gate = manager.evaluateMergeGate('TASK-A', evidence, review);
    await runner.entered;
    for (const operation of [
      peer.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }),
      peer.removeWorkspace('TASK-A'),
      peer.captureWorkspaceChanges('TASK-A'),
      peer.collectBuildTestEvidence('TASK-A', evidencePlan()),
      peer.evaluateMergeGate('TASK-A', evidence, review),
    ]) await expect(operation).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(peer.captureWorkspaceChanges('TASK-B')).resolves.toMatchObject({ taskId: 'TASK-B' });
    runner.release();
    await expect(gate).resolves.toMatchObject({ eligible: true, reasons: [] });
  });

  it('blocks the gate for quarantined tasks', async () => {
    const repo = await createRepository('agenthub merge gate quarantine ');
    const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
    const task = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    await commitTaskChange(task.worktreePath, 'task.txt');
    const evidence = await manager.collectBuildTestEvidence('TASK-A', evidencePlan());
    const review = accept(evidence);
    quarantineTask(manager.repositoryRoot, 'TASK-A');
    expect(isTaskQuarantined(manager.repositoryRoot, 'TASK-A')).toBe(true);
    await expect(manager.evaluateMergeGate('TASK-A', evidence, review)).rejects
      .toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
  });
});

class GateBarrierRunner implements GitCommandRunnerLike {
  readonly #delegate = new GitCommandRunner();
  #target: string | undefined;
  #blocked = false;
  #release = deferred<undefined>();
  #entered = deferred<undefined>();
  public get entered(): Promise<void> { return this.#entered.promise; }
  public arm(worktreePath: string): void { this.#target = path.resolve(worktreePath); }
  public release(): void { this.#release.resolve(undefined); }
  public async run(args: readonly string[], options: Parameters<GitCommandRunnerLike['run']>[1]) {
    if (!this.#blocked && this.#target !== undefined && path.resolve(options.cwd) === this.#target) {
      this.#blocked = true;
      this.#entered.resolve(undefined);
      await this.#release.promise;
    }
    return this.#delegate.run(args, options);
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}
function evidencePlan(): BuildTestEvidencePlan {
  return { commands: [{ id: 'verify', phase: 'test', executable: process.execPath,
    args: ['-e', ''], timeoutMs: 5_000 }] };
}
function accept(evidence: Awaited<ReturnType<GitWorktreeManager['collectBuildTestEvidence']>>) {
  return createReviewEvidence(evidence, { reviewId: 'review', reviewerId: 'reviewer', verdict: 'ACCEPT',
    summary: 'accepted exact evidence' });
}
async function commitTaskChange(worktreePath: string, name: string): Promise<void> {
  await writeFile(path.join(worktreePath, name), `${name}\n`, 'utf8');
  await git(worktreePath, ['add', name]);
  await git(worktreePath, ['commit', '-m', `add ${name}`]);
}
async function createRepository(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'AgentHub Test']);
  await git(repo, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(repo, 'initial.txt'), 'initial\n', 'utf8');
  await git(repo, ['add', 'initial.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true })).stdout;
}
async function removeTemporaryRoot(root: string): Promise<void> {
  const resolved = path.resolve(root); const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('unsafe cleanup');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
