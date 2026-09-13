import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCommandRunner, GitWorktreeManager, TaskCommandRunnerError,
  type BuildTestEvidencePlan, type TaskCommandRunResult } from '../src/index.js';
import { openGitWorktreeManagerWithTaskRunner,
  releaseTransientRepositoryCoordination } from '../src/workspace/internal/GitWorktreeManagerTestHarness.js';

const gitRunner = new GitCommandRunner();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('Build/Test evidence real integration', { timeout: 60_000 }, () => {
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
    expect(ignored.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: true } });

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

  it.each([
    ['root', '.gitignore', 'generated-source.ts'],
    ['nested', 'src/.gitignore', 'src/generated.ts'],
  ] as const)('detects a self-ignored %s .gitignore and hidden generated source', async (_label, policy, generated) => {
    const { manager } = await workspaceFixture('agenthub evidence self ignore ');
    const script = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(path.dirname(policy))},{recursive:true});fs.writeFileSync(${JSON.stringify(policy)},${JSON.stringify(`${path.basename(policy)}\n${path.basename(generated)}\n`)});fs.writeFileSync(${JSON.stringify(generated)},'hidden source')`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['self-ignore', 'build', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', build: 'failed', test: 'not-run' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: false } });
    await expect(manager.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
  });

  it('allows normal generated output under a stable tracked ignore policy', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence stable ignore ');
    await writeFile(path.join(workspace.worktreePath, '.gitignore'), 'dist/\n', 'utf8');
    await git(workspace.worktreePath, ['add', '.gitignore']);
    await git(workspace.worktreePath, ['commit', '-m', 'stable ignore policy']);
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(
      ['ignored-output', 'build', 'require("node:fs").mkdirSync("dist",{recursive:true});require("node:fs").writeFileSync("dist/output.js","generated")'],
    ));
    expect(evidence).toMatchObject({ outcome: 'passed', build: 'passed' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: true } });
  });

  it('detects an info/exclude mutation even when the new source becomes ignored', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence info exclude ');
    const excludePath = await gitPath(workspace.worktreePath, 'info/exclude');
    const sourcePath = path.join(workspace.worktreePath, 'generated-source.ts');
    const script = `require('node:fs').appendFileSync(${JSON.stringify(excludePath)},'\\ngenerated-source.ts\\n');require('node:fs').writeFileSync(${JSON.stringify(sourcePath)},'hidden source')`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['exclude', 'build', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', build: 'failed' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: false } });
    await expect(manager.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
  });

  it('detects effective core.excludesFile content changes without exposing the policy', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence excludes file ');
    const excludesPath = path.join(workspace.repositoryRoot, 'effective-excludes.txt');
    await writeFile(excludesPath, 'ignored-by-effective-file.txt\\n', 'utf8');
    await git(workspace.worktreePath, ['config', 'core.excludesFile', excludesPath]);
    const script = `require('node:fs').appendFileSync(${JSON.stringify(excludesPath)},'new-policy-entry\\n')`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['effective-excludes', 'test', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', test: 'failed' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: false } });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(excludesPath);
    expect(serialized).not.toContain('new-policy-entry');
  });

  it('detects effective core.excludesFile setting changes', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence excludes setting ');
    const excludesPath = path.join(workspace.repositoryRoot, 'effective-excludes.txt');
    const replacementPath = path.join(workspace.repositoryRoot, 'replacement-excludes.txt');
    await writeFile(excludesPath, '', 'utf8');
    await writeFile(replacementPath, '', 'utf8');
    await git(workspace.worktreePath, ['config', 'core.excludesFile', excludesPath]);
    const script = `require('node:child_process').execFileSync('git',['config','core.excludesFile',${JSON.stringify(replacementPath)}],{stdio:'ignore'})`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['setting', 'test', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', test: 'failed' });
    expect(evidence.commands[0]?.sourceVisibilityAfter).toMatchObject({ status: 'captured', stable: false });
  });

  it('treats tracked .gitignore changes as source mutations', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence gitignore ');
    await writeFile(path.join(workspace.worktreePath, '.gitignore'), 'initial-ignored.txt\\n', 'utf8');
    await git(workspace.worktreePath, ['add', '.gitignore']);
    await git(workspace.worktreePath, ['commit', '-m', 'add tracked ignore policy']);
    const script = `require('node:fs').appendFileSync(${JSON.stringify(path.join(workspace.worktreePath, '.gitignore'))},'tracked-hidden.txt\\n');require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace.worktreePath, 'tracked-hidden.txt'))},'source')`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['gitignore', 'test', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', test: 'failed' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: false });
  });

  it('detects local .git/info/attributes changes and keeps raw metadata private', async () => {
    const { manager, workspace } = await workspaceFixture('agenthub evidence attributes ');
    const attributesPath = await gitPath(workspace.worktreePath, 'info/attributes');
    const rawMarker = 'private-attributes-marker';
    const script = `require('node:fs').appendFileSync(${JSON.stringify(attributesPath)},'\\n*.private ${rawMarker}\\n')`;
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['attributes', 'test', script]));
    expect(evidence).toMatchObject({ outcome: 'workspace-mutated', test: 'failed' });
    expect(evidence.commands[0]).toMatchObject({ sourceStable: true,
      sourceVisibilityAfter: { status: 'captured', stable: false } });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(attributesPath);
    expect(serialized).not.toContain(rawMarker);
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

  it('blocks every concurrent same-task operation across managers', async () => {
    const { repo, manager } = await workspaceFixture('agenthub evidence coordination ');
    const peer = await GitWorktreeManager.open({ repositoryRoot: repo });
    const slowPlan = plan(['slow', 'test', 'setTimeout(()=>process.stdout.write("done"),400)']);
    const first = manager.collectBuildTestEvidence('TASK-A', slowPlan);
    await expect(peer.collectBuildTestEvidence('TASK-A', slowPlan))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(manager.captureWorkspaceChanges('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(peer.removeWorkspace('TASK-A')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(peer.collectBuildTestEvidence('TASK-A', plan(['other', 'test', 'process.exit(0)'])))
      .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(first).resolves.toMatchObject({ outcome: 'passed' });
    await expect(manager.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
  });

  it('blocks concurrent evidence and snapshots each sequential execution environment internally', async () => {
    const { repo, manager } = await workspaceFixture('agenthub evidence environment join ');
    const peer = await GitWorktreeManager.open({ repositoryRoot: repo });
    const previous = process.env.AGENTHUB_TEST_SAFE;
    const valueA = 'private-environment-value-A';
    const valueB = 'private-environment-value-B';
    process.env.AGENTHUB_TEST_SAFE = valueA;
    try {
      const envPlan: BuildTestEvidencePlan = { commands: [{
        ...spec('environment', 'test', 'setTimeout(()=>process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.AGENTHUB_TEST_SAFE ?? "missing").digest("hex")),400)'),
        inheritEnv: ['AGENTHUB_TEST_SAFE'],
      }] };
      const first = manager.collectBuildTestEvidence('TASK-A', envPlan);
      await expect(peer.collectBuildTestEvidence('TASK-A', envPlan))
        .rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
      const evidenceA = await first;
      expect(evidenceA.commands[0]?.stdout.preview).toBe(hash(valueA));
      process.env.AGENTHUB_TEST_SAFE = valueB;
      const evidenceB = await peer.collectBuildTestEvidence('TASK-A', envPlan);
      expect(evidenceB.commands[0]?.stdout.preview).toBe(hash(valueB));
      expect(evidenceB.commands[0]?.executionEnvironmentSha256)
        .not.toBe(evidenceA.commands[0]?.executionEnvironmentSha256);
      expect(evidenceB.evidenceSha256).not.toBe(evidenceA.evidenceSha256);
      expect(JSON.stringify(evidenceB)).not.toContain('AGENTHUB_TEST_SAFE');
      expect(JSON.stringify(evidenceB)).not.toContain(valueB);
    } finally {
      if (previous === undefined) delete process.env.AGENTHUB_TEST_SAFE;
      else process.env.AGENTHUB_TEST_SAFE = previous;
    }
  });

  it('keeps cleanup quarantine durable across transient coordinator replacement and repository reopen', async () => {
    const repo = await createRepository('agenthub evidence durable quarantine ');
    const factual = factualCleanupFailure();
    const manager = await openGitWorktreeManagerWithTaskRunner(
      { repositoryRoot: repo },
      { run: () => Promise.reject(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED', factual)) },
    );
    await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    await manager.createWorkspace({ taskId: 'TASK-B', baseRef: 'HEAD' });
    const evidence = await manager.collectBuildTestEvidence('TASK-A', plan(['cleanup', 'test', 'process.exit(0)']));
    expect(evidence).toMatchObject({ outcome: 'infrastructure-failed', test: 'infrastructure-failed' });
    expect(evidence.commands[0]).toMatchObject({ cleanupFailed: true, outcome: 'timed-out' });
    for (const operation of [
      manager.captureWorkspaceChanges('TASK-A'),
      manager.removeWorkspace('TASK-A'),
      manager.collectBuildTestEvidence('TASK-A', plan(['again', 'test', 'process.exit(0)'])),
      manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }),
    ]) await expect(operation).rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });

    releaseTransientRepositoryCoordination(repo);
    const reopened = await GitWorktreeManager.open({ repositoryRoot: repo });
    for (const operation of [
      reopened.captureWorkspaceChanges('TASK-A'),
      reopened.removeWorkspace('TASK-A'),
      reopened.collectBuildTestEvidence('TASK-A', plan(['reopened', 'test', 'process.exit(0)'])),
      reopened.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' }),
    ]) await expect(operation).rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
    await expect(reopened.captureWorkspaceChanges('TASK-B')).resolves.toMatchObject({ taskId: 'TASK-B' });

    const otherRepo = await createRepository('agenthub evidence quarantine other repo ');
    const other = await GitWorktreeManager.open({ repositoryRoot: otherRepo });
    await other.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
    await expect(other.captureWorkspaceChanges('TASK-A')).resolves.toMatchObject({ taskId: 'TASK-A' });
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
function factualCleanupFailure(): TaskCommandRunResult {
  return Object.freeze({
    outcome: 'timed-out', durationMs: 10, cleanupFailed: true,
    executionEnvironmentSha256: '2'.repeat(64),
    stdout: Object.freeze({ byteLength: 3, sha256: '3'.repeat(64), preview: 'ran', previewTruncated: false }),
    stderr: Object.freeze({ byteLength: 0, sha256: '4'.repeat(64), preview: '', previewTruncated: false }),
  });
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
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
async function gitPath(cwd: string, name: string): Promise<string> {
  const result = await gitRunner.run(['rev-parse', '--path-format=absolute', '--git-path', name], { cwd });
  if (result.exitCode !== 0) throw new Error(`Unable to resolve Git path ${name}`);
  return result.stdout.trim();
}
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
