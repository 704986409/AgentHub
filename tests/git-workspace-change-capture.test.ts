import { describe, expect, it } from 'vitest';
import {
  canonicalChangeState, parseChangeNumstat, parseChangeStatus, parseIndexFlags,
  parseRawChanges, snapshotCaptureOptions, validateChangePath,
} from '../src/workspace/GitWorkspaceChangeCapture.js';
const id = 'a'.repeat(40);
const ordinary = (name: string, sub = 'N...') => `1 .M ${sub} 100644 100644 100644 ${id} ${id} ${name}\0`;
describe('change capture deterministic contracts', () => {
  it.each(['a b', '中文', 'a\tb', 'a\nb', '-option'])('preserves machine path %j', name => {
    expect(parseChangeStatus(ordinary(name))[0]?.path).toBe(name);
    expect(parseRawChanges(`:100644 100644 ${id} ${id} M\0${name}\0`)[0]?.path).toBe(name);
    expect(parseChangeNumstat(`1\t2\t${name}\0`)[0]?.path).toBe(name);
  });
  it('retains conflict stages, ignored entries and untracked paths', () => {
    const result = parseChangeStatus(`u UU N... 100644 100644 100644 100644 ${id} ${id} ${id} conflict\0? new\0! dist/\0`);
    expect(result.map(e => [e.kind, e.path])).toEqual([['u', 'conflict'], ['!', 'dist'], ['?', 'new']]);
    expect(result[0]?.fields.slice(7)).toEqual([id, id, id]);
    expect(Object.isFrozen(result[0]?.fields)).toBe(true);
  });
  it.each(['S.M.', 'S..U', 'SCMU'])('rejects dirty submodule %s', sub => {
    expect(() => parseChangeStatus(ordinary('module', sub))).toThrow('GIT_CHANGE_DIRTY_SUBMODULE');
  });
  it('allows a clean submodule pointer change', () => {
    expect(parseChangeStatus(ordinary('module', 'SC..'))).toHaveLength(1);
  });
  it.each(['h file\0', 'S file\0', 's file\0'])('rejects hidden index state %s', value => {
    expect(() => parseIndexFlags(value)).toThrow('GIT_CHANGE_INCOMPLETE_INDEX');
  });
  it('keeps binary stats distinct from zero lines', () => {
    expect(parseChangeNumstat('-\t-\tfile\0')[0]).toMatchObject({ binary: true, addedLines: null, deletedLines: null });
    expect(parseChangeNumstat('0\t0\tfile\0')[0]).toMatchObject({ binary: false, addedLines: 0, deletedLines: 0 });
  });
  it.each(['bad', '? a', 'x unknown\0', '? \0', ordinary('a') + ordinary('a'), ordinary('a').replace('.M', 'ZZ')])('rejects malformed status %j', value => {
    expect(() => parseChangeStatus(value)).toThrow();
  });
  it.each(['bad\0', `:100644 100644 ${id} ${id} R100\0a\0`, `:100644 100644 ${id} ${id} M\0`])('rejects malformed raw %j', value => {
    expect(() => parseRawChanges(value)).toThrow('GIT_CHANGE_PARSE_FAILED');
  });
  it.each(['1\t2\ta', '-\t1\ta\0', '1\t2\t\0', '999999999999999999999\t0\ta\0'])('rejects malformed numstat %j', value => {
    expect(() => parseChangeNumstat(value)).toThrow('GIT_CHANGE_PARSE_FAILED');
  });
  it.each(['../escape', '/absolute', 'C:/escape', 'a/../b', '.git/config', 'a//b', 'a/./b', 'bad\ufffd'])('rejects unsafe path %j', value => {
    expect(() => validateChangePath(value)).toThrow('GIT_CHANGE_CONTRACT_VIOLATION');
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limit %s', maxPatchBytes => {
    expect(() => snapshotCaptureOptions({ maxPatchBytes })).toThrow('GIT_CHANGE_CONTRACT_VIOLATION');
  });
  it('snapshots every option getter once and normalizes defaults', () => {
    let reads = 0;
    const value = snapshotCaptureOptions({ get maxPatchBytes() { reads++; return 1; } });
    expect(reads).toBe(1);
    expect(value.maxPatchBytes).toBe(1);
    expect(Object.isFrozen(value)).toBe(true);
    expect(snapshotCaptureOptions()).toEqual(snapshotCaptureOptions({ includePatchText: false }));
  });
  it('canonicalizes nested keys without locale or property construction order', () => {
    expect(canonicalChangeState({ z: [{ b: 2, a: 1 }], a: '中' })).toBe('{"a":"中","z":[{"a":1,"b":2}]}');
    expect(canonicalChangeState({ a: 1, b: 2 })).toBe(canonicalChangeState({ b: 2, a: 1 }));
  });
});

// Controlled complete passes exercise bounds/privacy without shell or repository mutations.
import { captureWorkspaceChanges } from '../src/workspace/GitWorkspaceChangeCapture.js';
import { GitCommandError, type TaskWorkspace } from '../src/index.js';
const workspace: TaskWorkspace = Object.freeze({ taskId: 'TASK', repositoryRoot: '/unused', worktreePath: '/unused/task',
  branchName: 'agenthub/TASK', baseCommit: id, headCommit: id });
function fakeCapture(overrides: (args: readonly string[], pass: number) => string | undefined,
  options = {}, inspect: () => Promise<TaskWorkspace | undefined> = () => Promise.resolve(workspace)) {
  let pass = 0;
  const fake = { run(args: readonly string[]) {
    if (args.includes('--porcelain=v2')) pass++;
    return Promise.resolve({ stdout: overrides(args, pass) ?? '', stderr: '', exitCode: 0 });
  } };
  return captureWorkspaceChanges(fake, inspect, snapshotCaptureOptions(options));
}
describe('change capture complete-pass failure injection', () => {
  it('rejects missing workspace', async () => {
    await expect(fakeCapture(() => '', {}, () => Promise.resolve(undefined))).rejects.toMatchObject({ code: 'GIT_CHANGE_WORKSPACE_NOT_FOUND' });
  });
  it('detects ignored-report changes beyond the returned sample', async () => {
    await expect(fakeCapture((args, pass) => args.includes('--porcelain=v2') ? `! ${String(pass)}\0` : '', { maxIgnoredPaths: 0 }))
      .rejects.toMatchObject({ code: 'GIT_CHANGE_SNAPSHOT_UNSTABLE' });
  });
  it('detects changing patch text even with unchanged source inventory', async () => {
    await expect(fakeCapture((args, pass) => args.includes('--patch') ? String(pass) : '', { includePatchText: true }))
      .rejects.toMatchObject({ code: 'GIT_CHANGE_SNAPSHOT_UNSTABLE' });
  });
  it('rejects structured output overflow without exposing output', async () => {
    await expect(fakeCapture(() => { throw new GitCommandError('GIT_COMMAND_OUTPUT_LIMIT', 'status'); }))
      .rejects.toMatchObject({ code: 'GIT_CHANGE_CAPTURE_LIMIT_EXCEEDED' });
  });
  it.each(['status', '--stage', '--raw', '--numstat'])('rejects malformed %s output', async command => {
    await expect(fakeCapture(args => args.includes(command) ? 'secret malformed output' : ''))
      .rejects.toMatchObject({ message: 'GIT_CHANGE_PARSE_FAILED' });
  });
  it('sanitizes arbitrary runner exceptions including patch failures', async () => {
    await expect(fakeCapture(args => { if (args.includes('--patch')) throw new Error('secret patch content'); return ''; }, { includePatchText: true }))
      .rejects.toMatchObject({ message: 'GIT_CHANGE_CONTRACT_VIOLATION' });
  });
  it('rejects dirty submodule through the complete capture API', async () => {
    await expect(fakeCapture(args => args.includes('status') ? ordinary('module', 'S.M.') : ''))
      .rejects.toMatchObject({ code: 'GIT_CHANGE_DIRTY_SUBMODULE' });
  });
  it('rejects metadata/stat inventory disagreement', async () => {
    await expect(fakeCapture(args => args.includes('--numstat') ? '1\t1\tfile\0' : ''))
      .rejects.toMatchObject({ code: 'GIT_CHANGE_PARSE_FAILED' });
  });
  it('freezes the complete result recursively', async () => {
    const result = await fakeCapture(() => '');
    const check = (v: unknown): void => {
      if (v !== null && typeof v === 'object') { expect(Object.isFrozen(v)).toBe(true); Object.values(v).forEach(check); }
    };
    check(result);
  });
});
