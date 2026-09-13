import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createReviewEvidence, GitCommandRunner, GitWorktreeManager, snapshotMergeGateDecision,
  type BuildTestEvidencePlan, type GitCommandRunnerLike } from '../src/index.js';
import { setMergeHooks } from '../src/workspace/internal/GitWorktreeManagerTestHarness.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeRoot(root); });

describe('Git merge integration value contracts', { timeout: 180_000 }, () => {
  it('validates supplied gate values and rejects tampering under the exact policy', async () => {
    const fixture = await readyFixture('agenthub merge values ');
    const policy = { requiredPhases: ['test'] as const, requiredCommandIds: ['verify'] };
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review, policy);
    expect(snapshotMergeGateDecision(JSON.parse(JSON.stringify(gate)), policy)).toEqual(gate);
    expect(() => snapshotMergeGateDecision({ ...gate, eligible: false }, policy)).toThrow();
    expect(() => snapshotMergeGateDecision(gate, {})).toThrow();
    await expect(fixture.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: fixture.evidence, reviewEvidence: fixture.review,
      gateDecision: { ...gate, mergeGateSha256: '0'.repeat(64) }, gatePolicy: policy })).rejects
      .toMatchObject({ code: 'GIT_MERGE_INVALID_REQUEST' });
  });

  it('snapshots request values before asynchronous merge work', async () => {
    const fixture = await readyFixture('agenthub merge snapshot ');
    const policy = { requiredPhases: ['test'] as const };
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review, policy);
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate, gatePolicy: policy };
    const pending = fixture.manager.mergeTaskWorkspace(request);
    (request as { targetBranch: string }).targetBranch = 'other';
    (policy as { requiredPhases: readonly string[] }).requiredPhases = ['build'];
    await expect(pending).resolves.toMatchObject({ outcome: 'merged', targetBranch: 'main' });
  });

  it('blocks invalid target, wrong primary, dirty primary, stale gate, and unsafe executable config privately', async () => {
    const invalid = await readyFixture('agenthub merge invalid ');
    const gate = await invalid.manager.evaluateMergeGate('TASK-A', invalid.evidence, invalid.review);
    const base = { taskId: 'TASK-A', buildEvidence: invalid.evidence, reviewEvidence: invalid.review, gateDecision: gate };
    await expect(invalid.manager.mergeTaskWorkspace({ ...base, targetBranch: '-bad' })).rejects
      .toMatchObject({ code: 'GIT_MERGE_TARGET_INVALID' });
    await git(invalid.repo, ['branch', 'other']); await git(invalid.repo, ['switch', 'other']);
    await expect(invalid.manager.mergeTaskWorkspace({ ...base, targetBranch: 'main' })).rejects
      .toMatchObject({ code: 'GIT_MERGE_WRONG_PRIMARY_BRANCH' });
    await git(invalid.repo, ['switch', '--detach', 'main']);
    await expect(invalid.manager.mergeTaskWorkspace({ ...base, targetBranch: 'main' })).rejects
      .toMatchObject({ code: 'GIT_MERGE_WRONG_PRIMARY_BRANCH' });

    const dirty = await readyFixture('agenthub merge dirty ');
    const dirtyGate = await dirty.manager.evaluateMergeGate('TASK-A', dirty.evidence, dirty.review);
    await writeFile(path.join(dirty.repo, 'dirty.txt'), 'dirty\n');
    await expect(dirty.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: dirty.evidence, reviewEvidence: dirty.review, gateDecision: dirtyGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_PRIMARY_DIRTY' });

    const stale = await readyFixture('agenthub merge stale ');
    const staleGate = await stale.manager.evaluateMergeGate('TASK-A', stale.evidence, stale.review);
    await writeFile(path.join(stale.workspace.worktreePath, 'later.txt'), 'later\n');
    await git(stale.workspace.worktreePath, ['add', 'later.txt']); await git(stale.workspace.worktreePath, ['commit', '-m', 'later']);
    await expect(stale.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: stale.evidence, reviewEvidence: stale.review, gateDecision: staleGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_STALE_GATE' });

    const unsafe = await readyFixture('agenthub merge unsafe ');
    await git(unsafe.repo, ['config', 'merge.evil.driver', 'secret-command --token top-secret']);
    const unsafeEvidence = await unsafe.manager.collectBuildTestEvidence('TASK-A', plan());
    const unsafeReview = createReviewEvidence(unsafeEvidence, { reviewId: 'unsafe-review', reviewerId: 'reviewer',
      verdict: 'ACCEPT', summary: 'accepted' });
    const unsafeGate = await unsafe.manager.evaluateMergeGate('TASK-A', unsafeEvidence, unsafeReview);
    await expect(unsafe.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: unsafeEvidence, reviewEvidence: unsafeReview, gateDecision: unsafeGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_UNSAFE_GIT_EXTENSION', message: 'Repository Git extensions are unsafe for trusted merge' });

    await git(unsafe.repo, ['config', '--unset', 'merge.evil.driver']);
    await git(unsafe.repo, ['config', 'filter.evil.clean', 'secret-filter --token top-secret']);
    await writeFile(path.join(unsafe.workspace.worktreePath, '.gitattributes'), 'task.txt filter=evil\n');
    await git(unsafe.workspace.worktreePath, ['add', '.gitattributes']);
    await git(unsafe.workspace.worktreePath, ['commit', '-m', 'select external filter']);
    const filterEvidence = await unsafe.manager.collectBuildTestEvidence('TASK-A', plan());
    const filterReview = createReviewEvidence(filterEvidence, { reviewId: 'filter-review', reviewerId: 'reviewer',
      verdict: 'ACCEPT', summary: 'accepted' });
    const filterGate = await unsafe.manager.evaluateMergeGate('TASK-A', filterEvidence, filterReview);
    await expect(unsafe.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: filterEvidence, reviewEvidence: filterReview, gateDecision: filterGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_UNSAFE_GIT_EXTENSION' });
  });

  it('blocks source or visibility changes between coherent task views', async () => {
    const source = await readyFixture('agenthub merge source unstable ');
    const sourceGate = await source.manager.evaluateMergeGate('TASK-A', source.evidence, source.review);
    setMergeHooks(source.manager, {
      betweenTaskViews: async () => { await writeFile(path.join(source.workspace.worktreePath, 'unstable.txt'), 'changed\n'); },
    });
    await expect(source.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: source.evidence, reviewEvidence: source.review, gateDecision: sourceGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_SOURCE_UNSTABLE' });

    const visibility = await readyFixture('agenthub merge visibility unstable ');
    const visibilityGate = await visibility.manager.evaluateMergeGate('TASK-A', visibility.evidence, visibility.review);
    setMergeHooks(visibility.manager, {
      betweenTaskViews: async () => {
        await writeFile(path.join(visibility.repo, '.git', 'info', 'exclude'), 'visibility-secret.txt\n');
      },
    });
    await expect(visibility.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: visibility.evidence, reviewEvidence: visibility.review, gateDecision: visibilityGate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_SOURCE_UNSTABLE' });
  });

  it('blocks task changes after preflight and before primary mutation', async () => {
    const fixture = await readyFixture('agenthub merge pre-mutation stale ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    const targetBefore = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();
    setMergeHooks(fixture.manager, {
      afterPreflight: async () => {
        await writeFile(path.join(fixture.workspace.worktreePath, 'after-preflight.txt'), 'changed\n');
        await git(fixture.workspace.worktreePath, ['add', 'after-preflight.txt']);
        await git(fixture.workspace.worktreePath, ['commit', '-m', 'after preflight']);
      },
    });
    await expect(fixture.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: fixture.evidence, reviewEvidence: fixture.review, gateDecision: gate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_STALE_GATE' });
    expect((await git(fixture.repo, ['rev-parse', 'HEAD'])).trim()).toBe(targetBefore);
    expect(await git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  });

  it('blocks mergeOptions introduced after preflight and before the final semantics check', async () => {
    const fixture = await readyFixture('agenthub merge options race ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    const targetBefore = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();
    setMergeHooks(fixture.manager, {
      afterPreflight: async () => { await git(fixture.repo, ['config', 'branch.main.mergeOptions', '-s ours']); },
    });
    await expect(fixture.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: fixture.evidence, reviewEvidence: fixture.review, gateDecision: gate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_UNSAFE_GIT_EXTENSION' });
    expect((await git(fixture.repo, ['rev-parse', 'HEAD'])).trim()).toBe(targetBefore);
    expect(await git(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  });

  it('rejects a malformed merge-tree result without mutating primary', async () => {
    const realRunner = new GitCommandRunner();
    const malformedRunner: GitCommandRunnerLike = {
      run: async (args, options) => {
        const result = await realRunner.run(args, options);
        return args.includes('merge-tree') ? { ...result, stdout: 'not-an-object-id\n' } : result;
      },
    };
    const fixture = await readyFixture('agenthub merge malformed tree ', malformedRunner);
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    const targetBefore = (await git(fixture.repo, ['rev-parse', 'HEAD'])).trim();
    await expect(fixture.manager.mergeTaskWorkspace({ taskId: 'TASK-A', targetBranch: 'main',
      buildEvidence: fixture.evidence, reviewEvidence: fixture.review, gateDecision: gate })).rejects
      .toMatchObject({ code: 'GIT_MERGE_UNSUPPORTED' });
    expect((await git(fixture.repo, ['rev-parse', 'HEAD'])).trim()).toBe(targetBefore);
  });

  it('aborts an actual failed merge and releases merge authority after verified cleanup', async () => {
    const fixture = await readyFixture('agenthub merge cleanup ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    setMergeHooks(fixture.manager, {
      beforeMerge: async () => { await git(fixture.repo, ['config', 'user.name', '']); },
      afterMergeFailure: async () => { await git(fixture.repo, ['config', 'user.name', 'AgentHub Test']); },
    });
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate };
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects.toMatchObject({ code: 'GIT_MERGE_FAILED' });
    expect(await git(fixture.repo, ['status', '--porcelain=v1'])).toBe('');
    await expect(git(fixture.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toBeDefined();
    setMergeHooks(fixture.manager, undefined);
    await expect(fixture.manager.mergeTaskWorkspace(request)).resolves.toMatchObject({ outcome: 'merged' });
  });

  it('quarantines the repository when failed-merge cleanup cannot be verified', async () => {
    const fixture = await readyFixture('agenthub merge quarantine ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    setMergeHooks(fixture.manager, {
      beforeMerge: async () => { await git(fixture.repo, ['config', 'user.name', '']); },
      afterMergeFailure: async () => {
        await git(fixture.repo, ['config', 'user.name', 'AgentHub Test']);
        await writeFile(path.join(fixture.repo, 'cleanup-ambiguous.txt'), 'ambiguous\n');
      },
    });
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate };
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects.toMatchObject({ code: 'GIT_MERGE_CLEANUP_FAILED' });
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects
      .toMatchObject({ code: 'GIT_MERGE_REPOSITORY_QUARANTINED' });
  });

  it('quarantines the repository when post-merge state cannot be verified', async () => {
    const fixture = await readyFixture('agenthub merge postcondition ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    setMergeHooks(fixture.manager, {
      afterMerge: async () => { await writeFile(path.join(fixture.repo, 'postcondition-ambiguous.txt'), 'ambiguous\n'); },
    });
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate };
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects.toMatchObject({ code: 'GIT_MERGE_CLEANUP_FAILED' });
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects
      .toMatchObject({ code: 'GIT_MERGE_REPOSITORY_QUARANTINED' });
  });

  it('quarantines a clean merge commit whose tree differs from the trusted preflight tree', async () => {
    const fixture = await readyFixture('agenthub merge semantic mismatch ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    setMergeHooks(fixture.manager, {
      afterMerge: async () => {
        await git(fixture.repo, ['rm', 'task.txt']);
        await git(fixture.repo, ['commit', '--amend', '--no-edit']);
      },
    });
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate };
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects
      .toMatchObject({ code: 'GIT_MERGE_CLEANUP_FAILED' });
    expect(await git(fixture.repo, ['status', '--porcelain=v1'])).toBe('');
    await expect(fixture.manager.mergeTaskWorkspace(request)).rejects
      .toMatchObject({ code: 'GIT_MERGE_REPOSITORY_QUARANTINED' });
  });

  it('returns a deterministic immutable result and an idempotent retry', async () => {
    const fixture = await readyFixture('agenthub merge result ');
    const gate = await fixture.manager.evaluateMergeGate('TASK-A', fixture.evidence, fixture.review);
    const request = { taskId: 'TASK-A', targetBranch: 'main', buildEvidence: fixture.evidence,
      reviewEvidence: fixture.review, gateDecision: gate };
    const merged = await fixture.manager.mergeTaskWorkspace(request);
    expect(merged.outcome).toBe('merged'); deepFrozen(merged);
    const retry = await fixture.manager.mergeTaskWorkspace(request);
    expect(retry).toMatchObject({ outcome: 'already-merged', targetHeadBefore: merged.targetHeadAfter,
      targetHeadAfter: merged.targetHeadAfter, mergeGateSha256: gate.mergeGateSha256 });
    expect(retry.mergeResultSha256).not.toBe(merged.mergeResultSha256);
  });
});

async function readyFixture(prefix: string, runner?: GitCommandRunnerLike) {
  const repo = await createRepo(prefix); const manager = await GitWorktreeManager.open({
    repositoryRoot: repo, ...(runner === undefined ? {} : { runner }),
  });
  const workspace = await manager.createWorkspace({ taskId: 'TASK-A', baseRef: 'HEAD' });
  await writeFile(path.join(workspace.worktreePath, 'task.txt'), 'task\n');
  await git(workspace.worktreePath, ['add', 'task.txt']); await git(workspace.worktreePath, ['commit', '-m', 'task']);
  const evidence = await manager.collectBuildTestEvidence('TASK-A', plan());
  const review = createReviewEvidence(evidence, { reviewId: 'review', reviewerId: 'reviewer', verdict: 'ACCEPT', summary: 'accepted' });
  return { repo, manager, workspace, evidence, review };
}
function plan(): BuildTestEvidencePlan { return { commands: [{ id: 'verify', phase: 'test', executable: process.execPath, args: ['-e', ''], timeoutMs: 5_000 }] }; }
async function createRepo(prefix: string) { const repo = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(repo); await git(repo, ['init', '-b', 'main']); await git(repo, ['config', 'user.name', 'AgentHub Test']); await git(repo, ['config', 'user.email', 'agenthub@example.invalid']); await writeFile(path.join(repo, 'initial.txt'), 'initial\n'); await git(repo, ['add', 'initial.txt']); await git(repo, ['commit', '-m', 'initial']); return repo; }
async function git(cwd: string, args: readonly string[]) { return (await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true })).stdout; }
async function removeRoot(root: string) { const resolved=path.resolve(root); const rel=path.relative(path.resolve(os.tmpdir()),resolved); if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel)) throw new Error('unsafe cleanup'); await rm(resolved,{recursive:true,force:true,maxRetries:3}); }
function deepFrozen(value: unknown): void { if(value!==null&&typeof value==='object'){ expect(Object.isFrozen(value)).toBe(true); for(const nested of Object.values(value)) deepFrozen(nested); } }
