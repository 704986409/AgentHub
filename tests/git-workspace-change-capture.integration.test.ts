import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitCommandRunner, GitCommandError, GitWorktreeManager, type GitCommandOptions } from '../src/index.js';

const runner = new GitCommandRunner();
const roots: string[] = [];
const git = (cwd: string, args: string[]) => runner.run(args, { cwd });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
async function setup(hook?: (args: readonly string[], cwd: string) => Promise<void>) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'agenthub-capture-'));
  roots.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, 'file'), 'initial\n');
  await writeFile(path.join(repo, '.gitignore'), '*.log\ndist/\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const delegate = { async run(args: readonly string[], options: GitCommandOptions) {
    calls.push({ args: [...args], cwd: options.cwd });
    await hook?.(args, options.cwd);
    return runner.run(args, options);
  } };
  const manager = await GitWorktreeManager.open({ repositoryRoot: repo, runner: delegate });
  const workspace = await manager.createWorkspace({ taskId: 'TASK', baseRef: 'main' });
  const wt = workspace.worktreePath;
  const capture = (options = {}) => manager.captureWorkspaceChanges('TASK', options);
  return { repo, wt, manager, workspace, capture, calls, delegate };
}
describe('change capture real Git', { timeout: 30_000 }, () => {
  it('captures clean state and stable digest after restart', async () => {
    const { repo, capture } = await setup();
    const first = await capture();
    expect(first.changedPaths).toEqual([]);
    expect(first.hasConflicts).toBe(false);
    const restart = await GitWorktreeManager.open({ repositoryRoot: repo });
    expect(await restart.captureWorkspaceChanges('TASK')).toEqual(first);
  });
  it('separates all tracked layers and changes digest on edit, stage, commit', async () => {
    const { wt, capture } = await setup();
    const clean = await capture();
    await writeFile(path.join(wt, 'file'), 'first\n');
    const working = await capture();
    expect(working.unstaged.changes).toHaveLength(1);
    expect(working.workingFiles[0]?.sha256).toBe(hash('first\n'));
    await git(wt, ['add', 'file']);
    const staged = await capture();
    expect(staged.staged.changes).toHaveLength(1);
    expect(staged.unstaged.changes).toEqual([]);
    await writeFile(path.join(wt, 'file'), 'second\n');
    const mixed = await capture({ includePatchText: true });
    expect(mixed.staged.changes).toHaveLength(1);
    expect(mixed.unstaged.changes).toHaveLength(1);
    expect(mixed.changedPaths).toEqual(['file']);
    expect(mixed.unstaged.patch.status).toBe('captured');
    await git(wt, ['commit', '-m', 'staged change']);
    const committed = await capture();
    expect(committed.committed.changes).toHaveLength(1);
    expect(committed.staged.changes).toEqual([]);
    expect(new Set([clean, working, staged, mixed, committed].map(s => s.changeSetSha256)).size).toBe(5);
  });
  it('uses durable base after main moves and leaves primary HEAD/branch/index/status untouched', async () => {
    const { repo, wt, capture, workspace } = await setup();
    await writeFile(path.join(wt, 'task'), 'task');
    await git(wt, ['add', 'task']); await git(wt, ['commit', '-m', 'task']);
    await writeFile(path.join(repo, 'primary'), 'primary');
    await git(repo, ['add', 'primary']); await git(repo, ['commit', '-m', 'main moves']);
    await writeFile(path.join(repo, 'file'), 'dirty primary');
    const state = async () => Promise.all([
      git(repo, ['rev-parse', 'HEAD']), git(repo, ['symbolic-ref', 'HEAD']),
      git(repo, ['--no-optional-locks', 'status', '--porcelain=v2', '-z']), readFile(path.join(repo, '.git', 'index')),
    ]);
    const before = await state();
    const snapshot = await capture();
    expect(snapshot.baseCommit).toBe(workspace.baseCommit);
    expect(snapshot.committed.changes.map(c => c.path)).toEqual(['task']);
    expect(await state()).toEqual(before);
  });
  it('hashes untracked bytes, excludes ignored artifacts from digest and bounds ignored samples', async () => {
    const { wt, capture } = await setup();
    await writeFile(path.join(wt, 'new'), 'one');
    const first = await capture();
    expect(first.untracked[0]).toMatchObject({ path: 'new', size: 3, sha256: hash('one') });
    await writeFile(path.join(wt, 'out.log'), 'ignored');
    await mkdir(path.join(wt, 'dist')); await writeFile(path.join(wt, 'dist', 'out'), 'ignored');
    const ignored = await capture({ maxIgnoredPaths: 0 });
    expect(ignored.ignored).toEqual({ present: true, count: 2, paths: [], truncated: true });
    expect(ignored.changeSetSha256).toBe(first.changeSetSha256);
    await writeFile(path.join(wt, 'new'), 'two');
    expect((await capture()).changeSetSha256).not.toBe(first.changeSetSha256);
    await rm(path.join(wt, 'new'));
    expect((await capture()).changedPaths).toEqual([]);
  });
  it('captures deletion, binary metadata and rename as add/delete independently of config', async () => {
    const { wt, capture } = await setup();
    await rm(path.join(wt, 'file'));
    expect((await capture()).workingFiles).toEqual([{ path: 'file', kind: 'missing' }]);
    await writeFile(path.join(wt, 'renamed'), 'initial\n');
    await writeFile(path.join(wt, 'binary'), Buffer.from([0, 1, 2]));
    await git(wt, ['config', 'diff.renames', 'true']);
    await git(wt, ['add', '-A']);
    const result = await capture({ includePatchText: true });
    expect(result.staged.changes.find(c => c.path === 'binary')).toMatchObject({ binary: true, addedLines: null, deletedLines: null });
    expect(result.staged.changes.find(c => c.path === 'renamed')?.status).toBe('A');
    expect(result.staged.changes.find(c => c.path === 'file')?.status).toBe('D');
    expect(JSON.stringify(result.staged.patch)).not.toContain('GIT binary patch');
  });
  it.each(process.platform === 'win32' ? ['space name', '中文'] : ['space name', '中文', 'tab\tname', 'line\nname'])('captures real path %j', async name => {
    const { wt, capture } = await setup();
    await writeFile(path.join(wt, name), 'test\n');
    expect((await capture()).untracked[0]?.path).toBe(name);
    await git(wt, ['add', '--', name]);
    expect((await capture()).staged.changes[0]?.path).toBe(name);
  });
  it.each(['--assume-unchanged', '--skip-worktree'])('rejects incomplete index %s and permits retry', async flag => {
    const { wt, capture } = await setup();
    await git(wt, ['update-index', flag, 'file']);
    await writeFile(path.join(wt, 'file'), 'hidden');
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_INCOMPLETE_INDEX' });
    await git(wt, ['update-index', flag.replace('--', '--no-'), 'file']);
    expect((await capture()).changedPaths).toEqual(['file']);
  });
  it('preserves structured inventory when patch bound or runner output limit is hit', async () => {
    let outputLimit = false;
    const { wt, capture } = await setup(args => {
      if (outputLimit && args.includes('--patch')) throw new GitCommandError('GIT_COMMAND_OUTPUT_LIMIT', 'diff');
      return Promise.resolve();
    });
    await writeFile(path.join(wt, 'file'), 'changed\n');
    const plain = await capture();
    const bounded = await capture({ includePatchText: true, maxPatchBytes: 1 });
    expect(bounded.unstaged.patch.status).toBe('omitted-limit');
    expect(bounded.changeSetSha256).toBe(plain.changeSetSha256);
    outputLimit = true;
    const limited = await capture({ includePatchText: true });
    expect(limited.unstaged.patch.status).toBe('omitted-limit');
    expect(limited.changeSetSha256).toBe(plain.changeSetSha256);
  });
  it('keeps source identity stable when local diff algorithm changes', async () => {
    const { wt, capture } = await setup();
    await writeFile(path.join(wt, 'file'), 'D\nC\nC\nA\nA\n');
    const first = await capture({ includePatchText: true });
    await git(wt, ['config', 'diff.algorithm', 'patience']);
    const second = await capture({ includePatchText: true });
    expect(second.changeSetSha256).toBe(first.changeSetSha256);
    expect(second.unstaged.changes).toEqual(first.unstaged.changes);
    expect(second.unstaged.patch).toEqual(first.unstaged.patch);
  });
  it('keeps source identity stable when info attributes change binary presentation', async () => {
    const { wt, capture } = await setup();
    await writeFile(path.join(wt, 'file'), 'changed\n');
    const first = await capture();
    const attributes = path.resolve(wt, (await git(wt, ['rev-parse', '--git-path', 'info/attributes'])).stdout.trim());
    await mkdir(path.dirname(attributes), { recursive: true });
    await writeFile(attributes, 'file binary\n');
    const second = await capture();
    expect(second.changeSetSha256).toBe(first.changeSetSha256);
    expect(second.unstaged.changes[0]).toMatchObject({ path: 'file', binary: true, addedLines: null, deletedLines: null });
  });
  it('fails hard completeness limits and releases ownership after each failure', async () => {
    const { wt, capture } = await setup();
    await writeFile(path.join(wt, 'new'), '123');
    for (const options of [{ maxChangedPaths: 0 }, { maxFingerprintBytes: 2 }]) {
      await expect(capture(options)).rejects.toMatchObject({ code: 'GIT_CHANGE_CAPTURE_LIMIT_EXCEEDED' });
      expect((await capture()).changedPaths).toEqual(['new']);
    }
  });
  it.each(['file', 'untracked'])('detects same-status mid-capture content mutation in %s', async name => {
    let count = 0;
    let armed = false;
    const { wt, capture } = await setup(async (args, cwd) => {
      if (armed && args.includes('--porcelain=v2') && ++count === 2) await writeFile(path.join(cwd, name), 'BBBB\n');
    });
    await writeFile(path.join(wt, name), 'AAAA\n');
    armed = true;
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_SNAPSHOT_UNSTABLE' });
    expect((await capture()).changedPaths).toContain(name);
  });
  it.each(['head', 'base', 'index'])('rejects mid-capture %s movement', async kind => {
    let count = 0;
    let armed = false;
    const { wt, capture } = await setup(async (args, cwd) => {
      if (armed && args.includes('--porcelain=v2') && ++count === 2) {
        if (kind === 'index') await git(cwd, ['add', 'file']);
        else if (kind === 'head') await git(cwd, ['commit', '--allow-empty', '-m', 'move']);
        else await git(cwd, ['update-ref', 'refs/agenthub/bases/TASK', 'HEAD']);
      }
    });
    await writeFile(path.join(wt, 'file'), 'edit');
    if (kind === 'base') await git(wt, ['commit', '--allow-empty', '-m', 'advance']);
    armed = true;
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_SNAPSHOT_UNSTABLE' });
  });
  it('fences same-task operations across managers, joins only identical options and permits other tasks', async () => {
    const { repo, manager, delegate, capture } = await setup();
    await manager.createWorkspace({ taskId: 'OTHER', baseRef: 'main' });
    const second = await GitWorktreeManager.open({ repositoryRoot: repo, runner: delegate });
    const options = { includePatchText: false };
    const first = capture(options);
    options.includePatchText = true;
    expect(second.captureWorkspaceChanges('TASK', { includePatchText: false })).toBe(first);
    await expect(second.captureWorkspaceChanges('TASK', options)).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(second.createWorkspace({ taskId: 'TASK', baseRef: 'main' })).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await expect(second.removeWorkspace('TASK')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await Promise.all([first, second.captureWorkspaceChanges('OTHER')]);
    const create = second.createWorkspace({ taskId: 'NEW', baseRef: 'main' });
    await expect(manager.captureWorkspaceChanges('NEW')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await create;
    const remove = second.removeWorkspace('NEW');
    await expect(manager.captureWorkspaceChanges('NEW')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await remove;
    expect((await capture()).committed.patch.status).toBe('not-requested');
  });
  it('uses safe commands exclusively in the task cwd and does not refresh its index', async () => {
    const { wt, calls, capture } = await setup();
    await writeFile(path.join(wt, 'file'), 'edit');
    const indexPath = (await git(wt, ['rev-parse', '--git-path', 'index'])).stdout.trim();
    const before = await readFile(path.resolve(wt, indexPath));
    calls.length = 0;
    const result = await capture({ includePatchText: true });
    for (const call of calls) {
      expect(call.args).toContain('--no-lazy-fetch');
      expect(call.args).toContain('--no-replace-objects');
    }
    for (const call of calls.filter(c => c.args.includes('diff') || c.args.includes('--porcelain=v2'))) {
      expect(call.cwd).toBe(wt);
      expect(call.args).toContain('--no-optional-locks');
      expect(call.args).toContain('core.fsmonitor=false');
      if (call.args.includes('diff')) {
        for (const flag of ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
          '--diff-algorithm=myers', '--no-indent-heuristic']) expect(call.args).toContain(flag);
        if (call.args.includes('--patch')) {
          for (const flag of ['--unified=3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/']) {
            expect(call.args).toContain(flag);
          }
        }
      }
    }
    expect(await readFile(path.resolve(wt, indexPath))).toEqual(before);
    expect(Object.isFrozen(result.unstaged.changes[0])).toBe(true);
    expect(Object.isFrozen(result.workingFiles)).toBe(true);
    const patch = result.unstaged.patch;
    if (patch.status !== 'captured') throw new Error('missing patch');
    expect(patch.sha256).toBe(hash(patch.text));
    expect(patch.byteLength).toBe(Buffer.byteLength(patch.text));
    expect((await capture()).changeSetSha256).toBe(result.changeSetSha256);
  });
  it('captures real unresolved conflict stages', async () => {
    const { repo, wt, capture } = await setup();
    await writeFile(path.join(repo, 'file'), 'main\n'); await git(repo, ['add', 'file']); await git(repo, ['commit', '-m', 'main']);
    await writeFile(path.join(wt, 'file'), 'task\n'); await git(wt, ['add', 'file']); await git(wt, ['commit', '-m', 'task']);
    await runner.run(['merge', 'main'], { cwd: wt, acceptedExitCodes: [0, 1] });
    const result = await capture({ includePatchText: true });
    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts[0]?.path).toBe('file');
    expect(result.unstaged.changes.find(c => c.status === 'U')?.addedLines).toBe(0);
    expect(result.unstaged.changes.find(c => c.status === 'M')?.addedLines).toBeGreaterThan(0);
    expect(result.workingFiles[0]?.sha256).toBeDefined();
  });
  it.skipIf(process.platform === 'win32')('hashes symlink target bytes without reading external contents', async () => {
    const { repo, wt, capture } = await setup();
    await symlink(path.join(repo, 'file'), path.join(wt, 'link'));
    const first = await capture();
    expect(first.untracked[0]).toMatchObject({ kind: 'symlink', linkTargetSha256: hash(path.join(repo, 'file')) });
    await writeFile(path.join(repo, 'file'), 'external changed');
    expect((await capture()).changeSetSha256).toBe(first.changeSetSha256);
  });
  it('rejects nested untracked repositories rather than omitting their files', async () => {
    const { wt, capture } = await setup();
    await mkdir(path.join(wt, 'nested')); await git(path.join(wt, 'nested'), ['init']);
    await writeFile(path.join(wt, 'nested', 'source'), 'data');
    await expect(capture()).rejects.toBeDefined();
  });
  it('captures deletion of an entire tracked directory', async () => {
    const { wt, capture } = await setup();
    await mkdir(path.join(wt, 'dir')); await writeFile(path.join(wt, 'dir', 'file'), 'data');
    await git(wt, ['add', 'dir']); await git(wt, ['commit', '-m', 'directory']);
    await rm(path.join(wt, 'dir'), { recursive: true });
    expect((await capture()).workingFiles).toContainEqual({ path: 'dir/file', kind: 'missing' });
  });
  it('captures clean gitlink movement and rejects real nested dirtiness', async () => {
    const source = await setup();
    const { wt, capture } = await setup();
    await git(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source.repo, 'module']);
    await git(wt, ['commit', '-m', 'submodule']);
    const nested = path.join(wt, 'module');
    const clean = await capture();
    await git(nested, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'pointer']);
    const moved = await capture();
    expect(moved.changeSetSha256).not.toBe(clean.changeSetSha256);
    await git(nested, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'second pointer']);
    expect((await capture()).changeSetSha256).not.toBe(moved.changeSetSha256);
    await writeFile(path.join(nested, 'file'), 'dirty');
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_DIRTY_SUBMODULE' });
    await git(nested, ['restore', 'file']);
    expect((await capture()).changedPaths).toContain('module');
  });
  it.skipIf(process.platform === 'win32')('rejects a reported FIFO without opening or hanging', async () => {
    const { wt, capture } = await setup(async (args, cwd) => {
      if (args.includes('--stage')) {
        // Git ignores untracked FIFOs. Replace an already reported regular path before hashing.
        await rm(path.join(cwd, 'special'), { force: true });
        await promisify(execFile)('mkfifo', [path.join(cwd, 'special')]);
      }
    });
    await writeFile(path.join(wt, 'special'), 'regular before capture');
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_UNSUPPORTED_FILE_TYPE' });
  });
  it('does not read through a parent junction or symlink', async () => {
    let armed = false;
    const { wt, repo, capture } = await setup(async (args, cwd) => {
      if (armed && args.includes('--stage')) {
        armed = false;
        await rm(path.join(cwd, 'dir'), { recursive: true });
        await symlink(repo, path.join(cwd, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
      }
    });
    await mkdir(path.join(wt, 'dir')); await writeFile(path.join(wt, 'dir', 'file'), 'inside');
    armed = true;
    await expect(capture()).rejects.toMatchObject({ code: 'GIT_CHANGE_CONTRACT_VIOLATION' });
  });
  it('keeps distinct repositories parallel during a held capture', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let hold = true;
    const first = await setup(async args => {
      if (hold && args.includes('--porcelain=v2')) { hold = false; started(); await gate; }
    });
    const second = await setup();
    const pending = first.capture();
    await entered;
    try { expect((await second.capture()).changedPaths).toEqual([]); }
    finally { release(); await pending; }
  });
  it('late consumers of failed generation A cannot clear an active generation B', async () => {
    let failures = 1;
    const { capture, manager } = await setup(args => {
      if (args.includes('--porcelain=v2') && failures-- > 0) throw new Error('injected');
      return Promise.resolve();
    });
    const first = capture();
    const duplicate = capture();
    await expect(first).rejects.toMatchObject({ code: 'GIT_CHANGE_CONTRACT_VIOLATION' });
    const second = capture();
    await expect(duplicate).rejects.toMatchObject({ code: 'GIT_CHANGE_CONTRACT_VIOLATION' });
    await expect(manager.removeWorkspace('TASK')).rejects.toMatchObject({ code: 'GIT_WORKTREE_OPERATION_BUSY' });
    await second;
  });

  it('streams multi-buffer files and captures intent-to-add without writing the index', async () => {
    const { wt, capture } = await setup();
    const content = 'a'.repeat(200_000);
    await writeFile(path.join(wt, 'large'), content);
    await git(wt, ['add', '--intent-to-add', 'large']);
    const result = await capture();
    expect(result.unstaged.changes.some(c => c.path === 'large')).toBe(true);
    expect(result.workingFiles.find(c => c.path === 'large')).toMatchObject({ size: 200_000, sha256: hash(content) });
  });

});
