import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BuildTestEvidenceError,
  TaskCommandRunnerError,
  type GitCommandRunnerLike,
  type GitWorkspaceChangeSnapshot,
  type TaskWorkspace,
} from '../src/index.js';
import { collectBuildTestEvidence, evidencePlanKey, snapshotBuildTestEvidenceOptions,
  snapshotBuildTestEvidencePlan } from '../src/workspace/BuildTestEvidenceCollector.js';

const roots: string[] = [];
const oid = 'a'.repeat(40);

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('Build/Test evidence plan and unit behavior', () => {
  it('rejects empty, duplicate, malformed, secret, Git, and unsafe option inputs', () => {
    for (const value of [undefined, {}, { commands: [] }, { commands: [{ ...spec('x'), id: 'bad id' }] },
      { commands: [spec('x'), spec('x')] }, { commands: [{ ...spec('x'), inheritEnv: ['API_TOKEN'] }] },
      { commands: [{ ...spec('x'), env: { GIT_DIR: 'secret' } }] }]) {
      expect(() => snapshotBuildTestEvidencePlan(value)).toThrow(BuildTestEvidenceError);
    }
    expect(() => snapshotBuildTestEvidenceOptions({ maxOutputBytes: 0 })).toThrow(BuildTestEvidenceError);
    expect(() => snapshotBuildTestEvidenceOptions({ maxOutputBytes: Number.MAX_SAFE_INTEGER })).toThrow(BuildTestEvidenceError);
    expect(() => snapshotBuildTestEvidenceOptions({ maxPreviewBytes: Number.MAX_SAFE_INTEGER })).toThrow(BuildTestEvidenceError);
  });

  it('snapshots getters exactly once and recursively freezes command input', () => {
    let commandsReads = 0;
    let idReads = 0;
    const rawCommand = Object.defineProperty({ ...spec('ignored') }, 'id', {
      get: () => { idReads++; return idReads === 1 ? 'snapshot' : 'changed'; }, enumerable: true,
    });
    const rawPlan = Object.defineProperty({}, 'commands', {
      get: () => { commandsReads++; return [rawCommand]; }, enumerable: true,
    });
    const result = snapshotBuildTestEvidencePlan(rawPlan);
    expect({ commandsReads, idReads }).toEqual({ commandsReads: 1, idReads: 1 });
    expect(result.commands[0]?.id).toBe('snapshot');
    deepFrozen(result);
  });

  it('keys identical plans/options together and distinguishes material command changes', () => {
    const first = snapshotBuildTestEvidencePlan({ commands: [spec('one')] });
    const same = snapshotBuildTestEvidencePlan({ commands: [spec('one')] });
    const changed = snapshotBuildTestEvidencePlan({ commands: [{ ...spec('one'), args: ['-e', 'changed'] }] });
    expect(evidencePlanKey(first, { maxPreviewBytes: 10 })).toBe(evidencePlanKey(same, { maxPreviewBytes: 10 }));
    expect(evidencePlanKey(first, { maxPreviewBytes: 10 })).not.toBe(evidencePlanKey(changed, { maxPreviewBytes: 10 }));
  });

  it('sanitizes initial capture errors as infrastructure failure', async () => {
    const root = await temporaryRoot('agenthub evidence unit ');
    const workspace = taskWorkspace(root);
    await expect(collectBuildTestEvidence({ commands: [spec('one')] }, {
      runner: throwingRunner(), inspect: () => Promise.resolve(workspace), worktree: workspace,
    })).rejects.toMatchObject({ code: 'INFRASTRUCTURE_FAILED' });

  });

  it('retains a passed command when post-source capture fails and stops later commands', async () => {
    const root = await temporaryRoot('agenthub evidence post-capture ');
    const workspace = taskWorkspace(root);
    const source = fakeSource(workspace, 'b'.repeat(64));
    let captures = 0;
    let executed = 0;
    const evidence = await collectBuildTestEvidence({ commands: [spec('first'), spec('later')] }, {
      runner: throwingRunner(), inspect: () => Promise.resolve(workspace), worktree: workspace,
      taskRunner: { run: () => { executed++; return Promise.resolve(passedResult()); } },
      captureSource: () => { captures++; if (captures === 3) return Promise.reject(new Error('post source unavailable')); return Promise.resolve(source); },
      captureContext: () => Promise.resolve({ sourceVisibilitySha256: 'v'.repeat(64) }),
    });
    expect(executed).toBe(1);
    expect(evidence).toMatchObject({ outcome: 'infrastructure-failed', test: 'infrastructure-failed' });
    expect(evidence.commands).toHaveLength(1);
    expect(evidence.commands[0]).toMatchObject({ outcome: 'passed', stdout: { sha256: passedResult().stdout.sha256 },
      sourceAfter: { status: 'capture-failed' } });
  });

  it('retains a failed command facts when post-source capture fails', async () => {
    const root = await temporaryRoot('agenthub evidence failed post-capture ');
    const workspace = taskWorkspace(root);
    const source = fakeSource(workspace, 'c'.repeat(64));
    let captures = 0;
    const run = { ...passedResult(), outcome: 'failed' as const, exitCode: 7,
      stdout: { ...passedResult().stdout, byteLength: 3, sha256: '7'.repeat(64), preview: 'out' },
      stderr: { ...passedResult().stderr, byteLength: 3, sha256: '8'.repeat(64), preview: 'err' } };
    const evidence = await collectBuildTestEvidence({ commands: [spec('failed')] }, {
      runner: throwingRunner(), inspect: () => Promise.resolve(workspace), worktree: workspace,
      taskRunner: { run: () => Promise.resolve(run) },
      captureSource: () => { captures++; if (captures === 3) return Promise.reject(new Error('post source unavailable')); return Promise.resolve(source); },
      captureContext: () => Promise.resolve({ sourceVisibilitySha256: 'w'.repeat(64) }),
    });
    expect(evidence).toMatchObject({ outcome: 'infrastructure-failed', test: 'infrastructure-failed' });
    expect(evidence.commands[0]).toMatchObject({ outcome: 'failed', exitCode: 7,
      stdout: { sha256: '7'.repeat(64) }, stderr: { sha256: '8'.repeat(64) }, sourceAfter: { status: 'capture-failed' } });
  });

  it('retains factual execution evidence when cleanup ownership fails', async () => {
    const root = await temporaryRoot('agenthub evidence cleanup ');
    const workspace = taskWorkspace(root);
    const source = fakeSource(workspace, 'd'.repeat(64));
    const factual = passedResult();
    const evidence = await collectBuildTestEvidence({ commands: [spec('cleanup')] }, {
      runner: throwingRunner(), inspect: () => Promise.resolve(workspace), worktree: workspace,
      taskRunner: { run: () => Promise.reject(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED', factual)) },
      captureSource: () => Promise.resolve(source),
      captureContext: () => Promise.resolve({ sourceVisibilitySha256: 'x'.repeat(64) }),
    });
    expect(evidence).toMatchObject({ outcome: 'infrastructure-failed', test: 'infrastructure-failed' });
    expect(evidence.commands[0]).toMatchObject({ outcome: 'passed', cleanupFailed: true });
  });
});

function spec(id: string) {
  return { id, phase: 'test' as const, executable: process.execPath, args: ['-e', ''], timeoutMs: 5_000 };
}
function taskWorkspace(root: string): TaskWorkspace {
  return Object.freeze({ taskId: 'TASK', repositoryRoot: root, worktreePath: root,
    branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid });
}
function throwingRunner(): GitCommandRunnerLike {
  return { run: () => Promise.reject(new Error('private runner failure')) };
}
function fakeSource(workspace: TaskWorkspace, changeSetSha256: string): GitWorkspaceChangeSnapshot {
  const layer = { changes: [], patch: { status: 'not-requested' as const } };
  return { ...workspace, committed: layer, staged: layer, unstaged: layer, workingFiles: [], untracked: [],
    conflicts: [], ignored: { present: false, count: 0, paths: [], truncated: false }, changedPaths: [], hasConflicts: false,
    changeSetSha256 };
}
function passedResult() {
  return { outcome: 'passed' as const, exitCode: 0, durationMs: 1,
    stdout: { byteLength: 0, sha256: '0'.repeat(64), preview: '', previewTruncated: false },
    stderr: { byteLength: 0, sha256: '1'.repeat(64), preview: '', previewTruncated: false } };
}
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) deepFrozen(nested);
  }
}
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root;
}
async function removeTemporaryRoot(root: string): Promise<void> {
  const resolved = path.resolve(root); const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('unsafe cleanup');
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
