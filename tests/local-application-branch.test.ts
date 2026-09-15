import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalAgentHubApplication, resolvePrimaryBranch } from '../src/application/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

describe('local application branch authority', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('binds production composition to the checked-out local branch', async () => {
    const root = await createRepository(); const dataDirectory = join(root, 'runtime-data');
    expect(await resolvePrimaryBranch(root)).toBe('main');
    const owned = await createLocalAgentHubApplication({ repositoryRoot: root, dataDirectory });
    try { expect(owned.application.targetBranch).toBe('main'); }
    finally { await owned.close(); }
  });

  it('rejects detached HEAD before creating application data', async () => {
    const root = await createRepository(); const dataDirectory = join(root, 'detached-data');
    await git(root, ['switch', '--detach']);
    await expect(createLocalAgentHubApplication({ repositoryRoot: root, dataDirectory })).rejects
      .toThrow('Repository must have a checked-out local branch');
    await expect(access(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agenthub-local-app-')); roots.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'AgentHub Test']);
  await git(root, ['config', 'user.email', 'agenthub@example.invalid']);
  await writeFile(join(root, 'initial.txt'), 'initial\n');
  await git(root, ['add', 'initial.txt']); await git(root, ['commit', '-m', 'initial']);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}
