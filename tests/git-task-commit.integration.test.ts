import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitCommandRunner, GitWorktreeManager } from '../src/index.js';

const roots: string[] = [];
const runner = new GitCommandRunner();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

async function git(cwd: string, args: readonly string[]) {
  return runner.run(args, { cwd });
}
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenthub-task-commit-'));
  roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'AgentHub Test']);
  await git(root, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  await git(root, ['add', 'base.txt']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

describe('Git task commit integration', { timeout: 20_000 }, () => {
  it('commits all actual source once and reconciles an already committed head', async () => {
    const root = await repo();
    const manager = await GitWorktreeManager.open({ repositoryRoot: root });
    const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    await writeFile(path.join(workspace.worktreePath, 'actual.txt'), 'actual\n');
    const first = await manager.commitTaskWorkspace('TASK-A');
    expect(first.outcome).toBe('committed');
    expect(first.headAfter).not.toBe(first.headBefore);
    expect(await manager.commitTaskWorkspace('TASK-A')).toMatchObject({ outcome: 'already-committed', headAfter: first.headAfter });
    const source = await manager.captureWorkspaceChanges('TASK-A');
    expect(source.untracked).toHaveLength(0);
    expect(source.staged.changes).toHaveLength(0);
    expect(source.unstaged.changes).toHaveLength(0);
  });

  it('does not create an empty commit and isolates every repository or configured hook authority', async () => {
    const root = await repo();
    const manager = await GitWorktreeManager.open({ repositoryRoot: root });
    const clean = await manager.createWorkspace({ taskId: 'CLEAN', baseRef: 'HEAD' });
    expect(await manager.commitTaskWorkspace('CLEAN')).toMatchObject({ outcome: 'no-changes', headBefore: clean.baseCommit });

    const workspace = await manager.createWorkspace({ taskId: 'HOOK', baseRef: 'HEAD' });
    const sentinels = ['repository-hook.txt', 'predictable-hook.txt', 'configured-hook.txt'].map((name) => path.join(root, name));
    const hookRoots = [path.join(root, '.git', 'hooks'), path.join(root, '.git', 'agenthub-disabled-hooks'),
      path.join(root, 'attacker-hooks')];
    for (let index = 0; index < hookRoots.length; index += 1) {
      const hookRoot = hookRoots[index];
      const sentinel = sentinels[index];
      if (hookRoot === undefined || sentinel === undefined) throw new Error('invalid hook fixture');
      await mkdir(hookRoot, { recursive: true });
      await writeFile(path.join(hookRoot, 'prepare-commit-msg'),
        `#!/bin/sh\necho ran > "${sentinel.replaceAll('\\', '/')}"\n`);
    }
    await git(root, ['config', 'core.hooksPath', hookRoots[2] ?? '']);
    await writeFile(path.join(workspace.worktreePath, 'change.txt'), 'change\n');
    await expect(manager.commitTaskWorkspace('HOOK')).resolves.toMatchObject({ outcome: 'committed' });
    for (const sentinel of sentinels) await expect(access(sentinel)).rejects.toBeDefined();
  });

  it('blocks an executable clean filter affecting changed source', async () => {
    const root = await repo();
    const manager = await GitWorktreeManager.open({ repositoryRoot: root });
    const workspace = await manager.createWorkspace({ taskId: 'FILTER', baseRef: 'HEAD' });
    await writeFile(path.join(workspace.worktreePath, '.gitattributes'), '*.secret filter=unsafe\n');
    await writeFile(path.join(workspace.worktreePath, 'value.secret'), 'secret\n');
    await expect(manager.commitTaskWorkspace('FILTER')).rejects.toMatchObject({ code: 'GIT_TASK_COMMIT_FILTER_BLOCKED' });
  });
});
