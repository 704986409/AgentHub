import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCommandRunner, GitWorktreeManager, type BuildTestEvidencePlan } from '../src/index.js';

const gitRunner = new GitCommandRunner();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('Build/Test evidence real integration', { timeout: 30_000 }, () => {
  it('collects deterministic passing evidence in a real task worktree with spaces', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence pass ');
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['build', 'build', 'process.stdout.write("build-output")'],
      ['test', 'test', 'process.stderr.write("test-output")'],
    ));
    expect(evidence).toMatchObject({
      taskId: 'TASK-A', branchName: 'agenthub/TASK-A', outcome: 'passed', build: 'passed', test: 'passed',
    });
    expect(evidence.commands).toHaveLength(2);
    expect(evidence.commands[0]?.stdout.preview).toBe('build-output');
    expect(evidence.commands[1]?.stderr.preview).toBe('test-output');
    expect(evidence.commands[0]).not.toHaveProperty('args');
    expect(evidence.commands[0]).not.toHaveProperty('env');
    expect(evidence.changeSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(workspace.worktreePath).toContain(' ');
    deepFrozen(evidence);
  });

  it('fails fast by default and continues only when explicitly requested', async () => {
    const { manager } = await workspaceFixture('agenthub evidence failure ');
    const failFast = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['first', 'build', 'process.exit(2)'], ['second', 'test', 'process.stdout.write("should-not-run")'],
    ));
    expect(failFast).toMatchObject({ outcome: 'failed', build: 'failed', test: 'not-run' });
    expect(failFast.commands).toHaveLength(1);

    const continued = await manager.collectBuildTestEvidence('TASK-A', {
      commands: [
        { ...spec('first', 'build', 'process.exit(2)'), continueOnFailure: true },
        spec('second', 'test', 'process.stdout.write("ran")'),
      ],
    });
    expect(continued).toMatchObject({ outcome: 'failed', build: 'failed', test: 'passed' });
    expect(continued.commands).toHaveLength(2);
  });

  it('tolerates ignored artifacts but invalidates tracked and untracked source mutations', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence mutation ');
    await writeFile(path.join(workspace.worktreePath, '.gitignore'), 'ignored-artifact.txt\n', 'utf8');
    await git(workspace.worktreePath, ['add', '.gitignore']);
    await git(workspace.worktreePath, ['commit', '-m', 'ignore build artifact']);
    const ignored = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['ignored', 'build', 'require("node:fs").writeFileSync("ignored-artifact.txt","generated")'],
    ));
    expect(ignored.outcome).toBe('passed');

    const tracked = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['tracked', 'test', 'require("node:fs").writeFileSync("tracked.txt","mutated")'],
    ));
    expect(tracked.outcome).toBe('workspace-mutated');
    expect(tracked.commands[0]).toMatchObject({ sourceStable: false });
    await git(workspace.worktreePath, ['restore', 'tracked.txt']);

    const untracked = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['untracked', 'test', 'require("node:fs").writeFileSync("new-source.txt","source")'],
    ));
    expect(untracked.outcome).toBe('workspace-mutated');
  });

  it('rejects a conflicted baseline before executing any command', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence conflict ');
    await writeFile(path.join(workspace.worktreePath, 'tracked.txt'), 'task change\n', 'utf8');
    await git(workspace.worktreePath, ['add', 'tracked.txt']);
    await git(workspace.worktreePath, ['commit', '-m', 'task side']);
    await git(workspace.repositoryRoot, ['checkout', '-b', 'conflict-side']);
    await writeFile(path.join(workspace.repositoryRoot, 'tracked.txt'), 'base change\n', 'utf8');
    await git(workspace.repositoryRoot, ['add', 'tracked.txt']);
    await git(workspace.repositoryRoot, ['commit', '-m', 'base side']);
    expect((await gitRunner.run(['merge', 'conflict-side'], { cwd: workspace.worktreePath, acceptedExitCodes: [0, 1] })).exitCode).toBe(1);
    await expect(manager.collectBuildTestEvidence('TASK-A', plan(
      ['must-not-run', 'test', 'require("node:fs").writeFileSync("ran.txt","bad")'],
    ))).rejects.toMatchObject({ code: 'WORKSPACE_MUTATED' });
    await expect(import('node:fs/promises').then(m => m.access(path.join(workspace.worktreePath, 'ran.txt')))).rejects.toBeDefined();
  });

  it('invalidates HEAD mutation and records missing executables as infrastructure failure', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence head ');
    const commitScript = 'require("node:child_process").execFileSync("git",["commit","--allow-empty","-m","command commit"],{stdio:"ignore"})';
    const changed = await manager.collectBuildTestEvidence('TASK-A', plan(['head', 'build', commitScript]));
    expect(changed.outcome).toBe('workspace-mutated');
    const missing = await manager.collectBuildTestEvidence('TASK-A', {
      commands: [{ ...spec('missing', 'test', ''), executable: path.join(workspace.worktreePath, 'missing-executable') }],
    });
    expect(missing).toMatchObject({ outcome: 'infrastructure-failed', test: 'failed' });
    expect(missing.commands[0]).toMatchObject({ outcome: 'spawn-failed' });
  });

  it('coordinates identical evidence across managers and blocks conflicting same-task operations', async () => {
    const { repo, manager } = await workspaceFixture('agenthub evidence coordination ');
    const peer = await GitWorktreeManager.open({ repositoryRoot: repo });
    const slowPlan = plan(['slow', 'test', 'setTimeout(()=>process.stdout.write("done"),400)']);
    const first = manager.collectBuildTestEvidence('TASK-A', slowPlan);
    const joined = peer.collectBuildTestEvidence('TASK-A', slowPlan);
    expect(joined).toBe(first);
    await expect(manager.captureWorkspaceChanges('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(peer.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(peer.collectBuildTestEvidence('TASK-A', plan(['other', 'test', 'process.exit(0)'])))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(first).resolves.toMatchObject({ outcome: 'passed' });
    await expect(manager.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
  });

  it('snapshots mutable command and option inputs before asynchronous execution', async () => {
    const { manager } = await workspaceFixture('agenthub evidence snapshot ');
    const args = ['-e', 'process.stdout.write("original")'];
    const env = { ORIGINAL: 'yes' };
    const command = { id: 'snapshot', phase: 'test' as const, executable: process.execPath,
      args, timeoutMs: 5_000, inheritEnv: [] as string[], env };
    const mutablePlan = { commands: [command] };
    const options = { maxPreviewBytes: 64 };
    const pending = manager.collectBuildTestEvidence('TASK-A', mutablePlan, options);
    args[1] = 'process.stdout.write("mutated")';
    env.ORIGINAL = 'changed';
    command.id = 'changed';
    options.maxPreviewBytes = 1;
    const result = await pending;
    expect(result.commands[0]).toMatchObject({ commandId: 'snapshot' });
    expect(result.commands[0]?.stdout.preview).toBe('original');
  });

  it('keeps evidence identity independent of duration and preview bounds while binding output bytes', async () => {
    const { manager } = await workspaceFixture('agenthub evidence digest ');
    const stablePlan = plan(['digest', 'test', 'process.stdout.write("same-output")']);
    const shortPreview = await manager.collectBuildTestEvidence('TASK-A', stablePlan, { maxPreviewBytes: 1 });
    const longPreview = await manager.collectBuildTestEvidence('TASK-A', stablePlan, { maxPreviewBytes: 100 });
    expect(shortPreview.commands[0]?.stdout.preview).toBe('s');
    expect(longPreview.commands[0]?.stdout.preview).toBe('same-output');
    expect(shortPreview.evidenceSha256).toBe(longPreview.evidenceSha256);
    const changedOutput = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['digest', 'test', 'process.stdout.write("different-output")'],
    ));
    expect(changedOutput.evidenceSha256).not.toBe(shortPreview.evidenceSha256);
  });

  it('enforces timeout and total output limits through the public manager API', async () => {
    const { manager } = await workspaceFixture('agenthub evidence limits ');
    const timedOut = await manager.collectBuildTestEvidence('TASK-A', {
      commands: [{ ...spec('timeout', 'test', 'setInterval(()=>{},1000)'), timeoutMs: 150 }],
    });
    expect(timedOut).toMatchObject({ outcome: 'failed', test: 'failed' });
    expect(timedOut.commands[0]).toMatchObject({ outcome: 'timed-out', sourceStable: true });

    const outputLimited = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['output-limit', 'test', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'],
    ), { maxOutputBytes: 32 });
    expect(outputLimited).toMatchObject({ outcome: 'failed', test: 'failed' });
    expect(outputLimited.commands[0]).toMatchObject({ outcome: 'output-limit', sourceStable: true });
    await expect(manager.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
  });

  it('permits evidence for different tasks and repositories concurrently', async () => {
    const first = await workspaceFixture('agenthub evidence parallel one ');
    await first.manager.createWorkspace({ taskId: 'TASK-B', baseRef: 'HEAD' });
    const second = await workspaceFixture('agenthub evidence parallel two ');
    const slow = plan(['parallel', 'test', 'setTimeout(()=>process.stdout.write("ok"),300)']);
    const results = await Promise.all([
      first.manager.collectBuildTestEvidence('TASK-A', slow),
      first.manager.collectBuildTestEvidence('TASK-B', slow),
      second.manager.collectBuildTestEvidence('TASK-A', slow),
    ]);
    expect(results.every((result) => result.outcome === 'passed')).toBe(true);
  });
});

type CommandTuple = readonly [string, 'build' | 'test', string];
function plan(...commands: readonly CommandTuple[]): BuildTestEvidencePlan {
  return { commands: commands.map(([id, phase, script]) => spec(id, phase, script)) };
}
function spec(id: string, phase: 'build' | 'test', script: string) {
  return { id, phase, executable: process.execPath, args: ['-e', script], timeoutMs: 5_000 } as const;
}
async function workspaceFixture(prefix: string) {
  const repo = await createRepository(prefix);
  const manager = await GitWorktreeManager.open({ repositoryRoot: repo });
  const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
  return { repo, manager, workspace };
}
async function createRepository(prefix: string): Promise<string> {
  const repo = await temporaryRoot(prefix);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'AgentHub Test']);
  await git(repo, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(path.join(repo, 'tracked.txt'), 'initial\n', 'utf8');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}
function git(cwd: string, args: readonly string[]) { return gitRunner.run(args, { cwd }); }
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) deepFrozen(nested);
  }
}
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function removeTemporaryRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a path outside the test temp directory');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
