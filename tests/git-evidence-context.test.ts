import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCommandRunner, type GitCommandRunnerLike, type TaskWorkspace } from '../src/index.js';
import { captureGitEvidenceContext } from '../src/workspace/GitEvidenceContext.js';

const roots: string[] = [];
const gitRunner = new GitCommandRunner();

afterEach(async () => {
  for (const root of roots.splice(0)) await safeRemove(root);
});

describe('GitEvidenceContext ignore policy', { timeout: 30_000 }, () => {
  it('fails closed at file-count, per-file byte, and total-byte bounds', async () => {
    const { repo, workspace } = await fixture('agenthub context bounds ');
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, '.gitignore'), 'aaaa');
    await writeFile(path.join(repo, 'src', '.gitignore'), 'bbbb');
    await git(repo, ['add', '.gitignore', 'src/.gitignore']);

    await expect(captureGitEvidenceContext(gitRunner, workspace, { maxIgnoreFiles: 1 }))
      .rejects.toThrow(/too many/iu);
    await expect(captureGitEvidenceContext(gitRunner, workspace, { maxIgnoreFileBytes: 3 }))
      .rejects.toThrow(/too large/iu);
    await expect(captureGitEvidenceContext(gitRunner, workspace, { maxIgnoreTotalBytes: 7 }))
      .rejects.toThrow(/too large/iu);
    const accepted = await captureGitEvidenceContext(gitRunner, workspace, {
      maxIgnoreFiles: 2, maxIgnoreFileBytes: 4, maxIgnoreTotalBytes: 8,
    });
    expect(accepted.sourceVisibilitySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.runIf(process.platform !== 'win32')('rejects a .gitignore symlink without reading its target', async () => {
    const { repo, workspace } = await fixture('agenthub context symlink ');
    const external = await temporaryRoot('agenthub context external ');
    const target = path.join(external, 'policy');
    await writeFile(target, 'private external policy');
    await symlink(target, path.join(repo, '.gitignore'), 'file');
    await git(repo, ['add', '.gitignore']);
    await expect(captureGitEvidenceContext(gitRunner, workspace)).rejects.toThrow(/unsafe/iu);
  });

  it.runIf(process.platform !== 'win32')('rejects a nested .gitignore symlink without reading its target', async () => {
    const { repo, workspace } = await fixture('agenthub context nested symlink ');
    const external = await temporaryRoot('agenthub context nested external ');
    const target = path.join(external, 'policy');
    await writeFile(target, 'private nested policy');
    await mkdir(path.join(repo, 'src'));
    await symlink(target, path.join(repo, 'src', '.gitignore'), 'file');
    await git(repo, ['add', 'src/.gitignore']);
    await expect(captureGitEvidenceContext(gitRunner, workspace)).rejects.toThrow(/unsafe/iu);
  });

  it('rejects an enumerated ignore file behind a parent junction or symlink', async () => {
    const { repo, workspace } = await fixture('agenthub context parent link ');
    const external = await temporaryRoot('agenthub context linked external ');
    await writeFile(path.join(external, '.gitignore'), 'external policy');
    await symlink(external, path.join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const runner: GitCommandRunnerLike = {
      run: (args, options) => args.includes('ls-files') && args.includes('--ignored')
        ? Promise.resolve({ stdout: 'linked/.gitignore\0', stderr: '', exitCode: 0 })
        : gitRunner.run(args, options),
    };
    await expect(captureGitEvidenceContext(runner, workspace)).rejects.toThrow(/parent (?:is unsafe|escapes)/iu);
  });
});

async function fixture(prefix: string): Promise<{ repo: string; workspace: TaskWorkspace }> {
  const repo = await temporaryRoot(prefix);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'AgentHub Test']);
  await git(repo, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const head = (await gitRunner.run(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  return { repo, workspace: Object.freeze({
    taskId: 'TASK-A', repositoryRoot: repo, worktreePath: repo,
    branchName: 'main', baseCommit: head, headCommit: head,
  }) };
}
function git(cwd: string, args: readonly string[]) { return gitRunner.run(args, { cwd }); }
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root;
}
async function safeRemove(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('unsafe cleanup');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
