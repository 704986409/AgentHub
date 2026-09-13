import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReviewEvidence, GitWorktreeManager, type BuildTestEvidencePlan } from '../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('MergeGate real Git integration', { timeout: 60_000 }, () => {
  it('allows exact committed task evidence without mutating primary or task Git state, then denies a new commit', async () => {
    const fixture = await committedFixture('agenthub merge gate exact ');
    const primaryHead = await revParse(fixture.repo, 'HEAD');
    const taskHead = await revParse(fixture.workspace.worktreePath, 'HEAD');
    const evidence = await fixture.manager.collectBuildTestEvidence('TASK-A', plan());
    const review = accept(evidence);
    const decision = await fixture.manager.evaluateMergeGate('TASK-A', evidence, review,
      { requiredPhases: ['test'], requiredCommandIds: ['verify'] });
    expect(decision).toMatchObject({ eligible: true, reasons: [] });
    expect(await revParse(fixture.repo, 'HEAD')).toBe(primaryHead);
    expect(await revParse(fixture.workspace.worktreePath, 'HEAD')).toBe(taskHead);
    expect(await git(fixture.repo, ['status', '--porcelain=v1'])).toBe('');
    expect(await git(fixture.workspace.worktreePath, ['status', '--porcelain=v1'])).toBe('');

    await writeFile(path.join(fixture.workspace.worktreePath, 'later.txt'), 'later\n', 'utf8');
    await git(fixture.workspace.worktreePath, ['add', 'later.txt']);
    await git(fixture.workspace.worktreePath, ['commit', '-m', 'later source']);
    const staleDecision = await fixture.manager.evaluateMergeGate('TASK-A', evidence, review);
    expect(staleDecision.eligible).toBe(false);
    expect(staleDecision.reasons).toContain('STALE_SOURCE');
    expect(await revParse(fixture.repo, 'HEAD')).toBe(primaryHead);
  });

  it('denies evidence collected on uncommitted source after that source is committed', async () => {
    const fixture = await workspaceFixture('agenthub merge gate commit after evidence ');
    await writeFile(path.join(fixture.workspace.worktreePath, 'pending.txt'), 'pending\n', 'utf8');
    const evidence = await fixture.manager.collectBuildTestEvidence('TASK-A', plan());
    const review = accept(evidence);
    await git(fixture.workspace.worktreePath, ['add', 'pending.txt']);
    await git(fixture.workspace.worktreePath, ['commit', '-m', 'commit pending source']);
    const decision = await fixture.manager.evaluateMergeGate('TASK-A', evidence, review);
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('STALE_SOURCE');
  });

  it('allows an ignored artifact created after accepted evidence', async () => {
    const fixture = await workspaceFixture('agenthub merge gate ignored ');
    await writeFile(path.join(fixture.workspace.worktreePath, '.gitignore'), 'artifact.tmp\n', 'utf8');
    await writeFile(path.join(fixture.workspace.worktreePath, 'task.txt'), 'task\n', 'utf8');
    await git(fixture.workspace.worktreePath, ['add', '.gitignore', 'task.txt']);
    await git(fixture.workspace.worktreePath, ['commit', '-m', 'task and ignore policy']);
    const evidence = await fixture.manager.collectBuildTestEvidence('TASK-A', plan());
    const review = accept(evidence);
    await writeFile(path.join(fixture.workspace.worktreePath, 'artifact.tmp'), 'generated\n', 'utf8');
    const decision = await fixture.manager.evaluateMergeGate('TASK-A', evidence, review);
    expect(decision).toMatchObject({ eligible: true, reasons: [] });
  });

  it('denies a .git/info/exclude visibility mutation without exposing its contents', async () => {
    const fixture = await committedFixture('agenthub merge gate visibility ');
    const evidence = await fixture.manager.collectBuildTestEvidence('TASK-A', plan());
    const review = accept(evidence);
    const gitFile: string = await readFile(path.join(fixture.workspace.worktreePath, '.git'), 'utf8');
    const gitDirValue = gitFile.trim().replace(/^gitdir:\s*/u, '');
    const gitDir = path.resolve(fixture.workspace.worktreePath, gitDirValue);
    const commonDir = path.resolve(gitDir, (await git(fixture.workspace.worktreePath,
      ['rev-parse', '--git-common-dir'])).trim());
    const exclude = path.join(commonDir, 'info', 'exclude');
    await writeFile(exclude, `${await readFile(exclude, 'utf8')}private-visibility-rule\n`, 'utf8');
    const decision = await fixture.manager.evaluateMergeGate('TASK-A', evidence, review);
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('STALE_VISIBILITY');
    expect(JSON.stringify(decision)).not.toContain('private-visibility-rule');
  });
});

async function committedFixture(prefix: string) {
  const fixture = await workspaceFixture(prefix);
  await writeFile(path.join(fixture.workspace.worktreePath, 'task.txt'), 'task\n', 'utf8');
  await git(fixture.workspace.worktreePath, ['add', 'task.txt']);
  await git(fixture.workspace.worktreePath, ['commit', '-m', 'task source']);
  return fixture;
}
async function workspaceFixture(prefix: string) {
  const repo = await createRepository(prefix);
  const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
  const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
  return { repo, manager, workspace };
}
async function createRepository(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'AgentHub Test']);
  await git(repo, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(repo, 'tracked.txt'), 'initial\n', 'utf8');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}
function plan(): BuildTestEvidencePlan {
  return { commands: [{ id: 'verify', phase: 'test', executable: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 5_000 }] };
}
function accept(evidence: Awaited<ReturnType<GitWorktreeManager['collectBuildTestEvidence']>>) {
  return createReviewEvidence(evidence, { reviewId: 'review', reviewerId: 'reviewer', verdict: 'ACCEPT',
    summary: 'accepted exact evidence' });
}
async function revParse(cwd: string, value: string): Promise<string> {
  return (await git(cwd, ['rev-parse', value])).trim();
}
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return result.stdout;
}
async function removeTemporaryRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('unsafe cleanup');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
