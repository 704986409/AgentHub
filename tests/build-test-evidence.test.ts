import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BuildTestEvidenceError,
  type GitCommandRunnerLike,
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
