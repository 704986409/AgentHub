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
  it('snapshots every run field once and owns the snapshot before asynchronous validation', async () => {
    const root = await temporaryRoot('agenthub runner snapshot ');
    const values = {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: '.',
      timeoutMs: 5_000,
      inheritEnv: [] as string[],
      env: {} as Record<string, string>,
    };
    const reads = { executable: 0, args: 0, cwd: 0, timeoutMs: 0, inheritEnv: 0, env: 0 };
    const spec = {
      get executable() { reads.executable++; return values.executable; },
      get args() { reads.args++; return values.args; },
      get cwd() { reads.cwd++; return values.cwd; },
      get timeoutMs() { reads.timeoutMs++; return values.timeoutMs; },
      get inheritEnv() { reads.inheritEnv++; return values.inheritEnv; },
      get env() { reads.env++; return values.env; },
    };
    const pending = new TaskCommandRunner({ worktreePath: root }).run(spec);
    values.args = ['-e', 'process.stdout.write("mutated")'];
    values.cwd = 'missing';
    values.timeoutMs = 1;
    values.inheritEnv = ['PATH'];
    values.env = { MUTATED: 'yes' };
    const result = await pending;
    expect(result.outcome).toBe('passed');
    expect(result.stdout.preview).toBe(await import('node:fs/promises').then(async (m) => m.realpath(root)));
    expect(reads).toEqual({ executable: 1, args: 1, cwd: 1, timeoutMs: 1, inheritEnv: 1, env: 1 });
  });

  it('rejects direct runner limits above the public bounds', async () => {
    const root = await temporaryRoot('agenthub runner bounds ');
    expect(() => new TaskCommandRunner({ worktreePath: root, maxOutputBytes: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
    expect(() => new TaskCommandRunner({ worktreePath: root, maxPreviewBytes: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
    await expect(new TaskCommandRunner({ worktreePath: root }).run({ ...command(''), timeoutMs: Number.MAX_SAFE_INTEGER }))
      .rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

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

  it('cleans a descendant process tree on output limit', async () => {
    const root = await temporaryRoot('agenthub output cleanup ');
    const marker = path.join(root, 'orphan-marker.txt');
    const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700)`;
    const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)`;
    const result = await new TaskCommandRunner({ worktreePath: root, maxOutputBytes: 32 }).run(command(parentScript));
    expect(result.outcome).toBe('output-limit');
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
