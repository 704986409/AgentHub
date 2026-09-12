import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskCommandRunner } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe('TaskCommandRunner', { timeout: 20_000 }, () => {
  it('executes explicit argv without a shell and records bounded stream evidence', async () => {
    const root = await temporaryRoot('agenthub runner ');
    const runner = new TaskCommandRunner({ worktreePath: root, maxPreviewBytes: 5 });
    const result = await runner.run(command(
      'process.stdout.write(Buffer.from([0x68,0x65,0x6c,0x6c,0x6f,0xff])); process.stderr.write("problem");',
    ));
    expect(result).toMatchObject({ outcome: 'passed', exitCode: 0 });
    expect(result.stdout).toEqual({
      byteLength: 6,
      sha256: digest(Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff])),
      preview: 'hello',
      previewTruncated: true,
    });
    expect(result.stderr).toEqual({
      byteLength: 7, sha256: digest('problem'), preview: 'probl', previewTruncated: true,
    });
    expect(Object.isFrozen(result.stdout)).toBe(true);
  });

  it('separates nonzero exit, timeout, output limit, and spawn failure', async () => {
    const root = await temporaryRoot('agenthub outcomes ');
    await expect(new TaskCommandRunner({ worktreePath: root }).run(command('process.exit(7)')))
      .resolves.toMatchObject({ outcome: 'failed', exitCode: 7 });
    await expect(new TaskCommandRunner({ worktreePath: root }).run(command('setInterval(() => {}, 1000)', 150)))
      .resolves.toMatchObject({ outcome: 'timed-out' });
    await expect(new TaskCommandRunner({ worktreePath: root, maxOutputBytes: 32 }).run(
      command('process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)'),
    )).resolves.toMatchObject({ outcome: 'output-limit' });
    await expect(new TaskCommandRunner({ worktreePath: root }).run({
      ...command(''), executable: path.join(root, 'missing-executable'),
    })).resolves.toMatchObject({ outcome: 'spawn-failed' });
  });

  it('uses an allowlisted environment and blocks secrets, Git variables, and duplicate keys', async () => {
    const root = await temporaryRoot('agenthub environment ');
    process.env.AGENTHUB_SAFE_VALUE = 'visible';
    process.env.AGENTHUB_TEST_TOKEN = 'must-not-leak';
    try {
      const runner = new TaskCommandRunner({ worktreePath: root });
      const result = await runner.run({
        ...command('process.stdout.write(JSON.stringify({safe:process.env.AGENTHUB_SAFE_VALUE,token:process.env.AGENTHUB_TEST_TOKEN,explicit:process.env.EXPLICIT}))'),
        inheritEnv: ['agenthub_safe_value'], env: { EXPLICIT: 'provided' },
      });
      expect(result.stdout.preview).toBe(JSON.stringify({ safe: 'visible', explicit: 'provided' }));
      await expect(runner.run({ ...command(''), inheritEnv: ['AGENTHUB_TEST_TOKEN'] }))
        .rejects.toMatchObject({ code: 'INVALID_ENV' });
      await expect(runner.run({ ...command(''), env: { GIT_CONFIG_COUNT: '1' } }))
        .rejects.toMatchObject({ code: 'INVALID_ENV' });
      await expect(runner.run({ ...command(''), inheritEnv: ['PATH'], env: { Path: 'duplicate' } }))
        .rejects.toMatchObject({ code: 'INVALID_ENV' });
    } finally {
      delete process.env.AGENTHUB_SAFE_VALUE;
      delete process.env.AGENTHUB_TEST_TOKEN;
    }
  });

  it('contains cwd and rejects missing, file-like, linked, absolute, parent, and shell-script cwd/executable inputs', async () => {
    const root = await temporaryRoot('agenthub cwd ');
    await mkdir(path.join(root, 'child'));
    const external = await temporaryRoot('agenthub external ');
    await symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const runner = new TaskCommandRunner({ worktreePath: root });
    const nested = await runner.run({ ...command('process.stdout.write(process.cwd())'), cwd: 'child' });
    expect(path.normalize(nested.stdout.preview)).toBe(path.normalize(path.join(await import('node:fs/promises').then(m => m.realpath(root)), 'child')));
    for (const cwd of ['..', path.resolve(root), 'missing', 'linked']) {
      await expect(runner.run({ ...command(''), cwd })).rejects.toMatchObject({ code: 'UNSAFE_CWD' });
    }
    for (const executable of ['build.cmd', 'test.BAT']) {
      await expect(runner.run({ ...command(''), executable })).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    }
  });

  it('accepts a canonical Windows path when mkdtemp returned its 8.3 alias', async () => {
    const root = await temporaryRoot('agenthub short path ');
    await expect(new TaskCommandRunner({ worktreePath: root }).run(command('process.stdout.write("ok")')))
      .resolves.toMatchObject({ outcome: 'passed' });
  });

  it('cleans a descendant process tree on timeout', async () => {
    const root = await temporaryRoot('agenthub cleanup ');
    const marker = path.join(root, 'orphan-marker.txt');
    const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700)`;
    const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const result = await new TaskCommandRunner({ worktreePath: root }).run(command(parentScript, 150));
    expect(result.outcome).toBe('timed-out');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(access(marker)).rejects.toBeDefined();
  });
});

function command(script: string, timeoutMs = 5_000) {
  return { executable: process.execPath, args: ['-e', script], cwd: '.', timeoutMs, inheritEnv: [], env: {} } as const;
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
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
