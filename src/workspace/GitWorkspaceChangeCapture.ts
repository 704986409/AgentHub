import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GitCommandError, type GitCommandRunnerLike } from './GitCommandRunner.js';
import { GitWorktreeError, type TaskWorkspace } from './GitWorktreeManager.js';

export type GitChangeCaptureErrorCode =
  | 'GIT_CHANGE_WORKSPACE_NOT_FOUND' | 'GIT_CHANGE_PARSE_FAILED'
  | 'GIT_CHANGE_SNAPSHOT_UNSTABLE' | 'GIT_CHANGE_CAPTURE_LIMIT_EXCEEDED'
  | 'GIT_CHANGE_UNSUPPORTED_FILE_TYPE' | 'GIT_CHANGE_DIRTY_SUBMODULE'
  | 'GIT_CHANGE_INCOMPLETE_INDEX' | 'GIT_CHANGE_CONTRACT_VIOLATION';
export class GitChangeCaptureError extends Error {
  public constructor(public readonly code: GitChangeCaptureErrorCode) {
    super(code);
    this.name = 'GitChangeCaptureError';
  }
}
export interface CaptureWorkspaceChangesOptions {
  readonly includePatchText?: boolean;
  readonly maxPatchBytes?: number;
  readonly maxChangedPaths?: number;
  readonly maxFingerprintBytes?: number;
  readonly maxIgnoredPaths?: number;
}
export interface GitWorkingFileFingerprint {
  readonly path: string;
  readonly kind: 'regular' | 'symlink' | 'missing' | 'gitlink';
  readonly size?: number;
  readonly sha256?: string;
  readonly linkTargetSha256?: string;
  readonly headCommit?: string;
}
export interface GitTrackedChange {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObjectId: string;
  readonly newObjectId: string;
  readonly binary: boolean;
  readonly addedLines: number | null;
  readonly deletedLines: number | null;
}
export type GitPatchCapture =
  | { readonly status: 'captured'; readonly text: string; readonly byteLength: number; readonly sha256: string }
  | { readonly status: 'empty'; readonly byteLength: 0; readonly sha256: string }
  | { readonly status: 'omitted-limit' | 'not-requested' };
export interface GitChangeLayer {
  readonly changes: readonly GitTrackedChange[];
  readonly patch: GitPatchCapture;
}
export interface GitStatusEntry {
  readonly path: string;
  readonly kind: '1' | 'u' | '?' | '!';
  readonly fields: readonly string[];
}
export interface GitWorkspaceChangeSnapshot extends TaskWorkspace {
  readonly committed: GitChangeLayer;
  readonly staged: GitChangeLayer;
  readonly unstaged: GitChangeLayer;
  readonly workingFiles: readonly GitWorkingFileFingerprint[];
  readonly untracked: readonly GitWorkingFileFingerprint[];
  readonly conflicts: readonly GitStatusEntry[];
  readonly ignored: { readonly present: boolean; readonly count: number; readonly paths: readonly string[]; readonly truncated: boolean };
  readonly changedPaths: readonly string[];
  readonly hasConflicts: boolean;
  readonly changeSetSha256: string;
}
const fail = (code: GitChangeCaptureErrorCode): never => { throw new GitChangeCaptureError(code); };
const parseFailure = (): never => fail('GIT_CHANGE_PARSE_FAILED');
const unstable = (): never => fail('GIT_CHANGE_SNAPSHOT_UNSTABLE');
const limit = (): never => fail('GIT_CHANGE_CAPTURE_LIMIT_EXCEEDED');
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const mode = /^(?:000000|100644|100755|120000|160000)$/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const gitCapturePrefix: readonly string[] = Object.freeze([
  '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false',
]);

/** Explicit recursive key ordering; independent of object construction and locale. */
export function canonicalChangeState(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalChangeState).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalChangeState(record[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return fail('GIT_CHANGE_CONTRACT_VIOLATION');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function snapshotCaptureOptions(options: CaptureWorkspaceChangesOptions = {}): Required<CaptureWorkspaceChangesOptions> {
  if ((options as unknown) === null || typeof options !== 'object' || Array.isArray(options)) return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  const result = {
    includePatchText: options.includePatchText ?? false,
    maxPatchBytes: options.maxPatchBytes ?? 512 * 1024,
    maxChangedPaths: options.maxChangedPaths ?? 20_000,
    maxFingerprintBytes: options.maxFingerprintBytes ?? 1024 * 1024 * 1024,
    maxIgnoredPaths: options.maxIgnoredPaths ?? 1000,
  };
  if (typeof result.includePatchText !== 'boolean' || Object.entries(result).some(([key, value]) =>
    key !== 'includePatchText' && (!Number.isSafeInteger(value) || (value as number) < 0))) {
    return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  }
  return Object.freeze(result);
}
/** Reject paths that cannot be represented safely by this UTF-8 runner. */
export function validateChangePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\ufffd') || path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
    value.split('/').some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
    (process.platform === 'win32' && (/[\\:]/.test(value) || value.split('/').some(part =>
      /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  }
  return value;
}
function tokens(output: string): string[] {
  if (typeof output !== 'string' || (output !== '' && !output.endsWith('\0'))) return parseFailure();
  return output === '' ? [] : output.slice(0, -1).split('\0');
}
export function parseChangeStatus(output: string): readonly GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const seen = new Set<string>();
  for (const record of tokens(output)) {
    const kind = record[0];
    let fields: string[] = [];
    let filename: string;
    if ((kind === '?' || kind === '!') && record[1] === ' ') filename = record.slice(2);
    else if (kind === '1' || kind === 'u') {
      const count = kind === '1' ? 8 : 10;
      let offset = 0;
      for (let i = 0; i < count; i++) {
        const end = record.indexOf(' ', offset);
        if (end < 0) return parseFailure();
        fields.push(record.slice(offset, end));
        offset = end + 1;
      }
      filename = record.slice(offset);
      const xy = fields[1] ?? '';
      const sub = fields[2] ?? '';
      if (!/^[.MADRCUT?!]{2}$/.test(xy) || !/^(N\.\.\.|S[.C][.M][.U])$/.test(sub)) return parseFailure();
      if (kind === 'u' && !['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)) return parseFailure();
      const modeEnd = kind === '1' ? 6 : 7;
      if (!fields.slice(3, modeEnd).every(v => mode.test(v)) || !fields.slice(modeEnd).every(v => oid.test(v))) return parseFailure();
      if (sub[0] === 'S' && (sub[2] !== '.' || sub[3] !== '.')) return fail('GIT_CHANGE_DIRTY_SUBMODULE');
    } else return parseFailure();
    if (kind === '?' && filename.endsWith('/')) return fail('GIT_CHANGE_UNSUPPORTED_FILE_TYPE');
    if (kind === '!' && filename.endsWith('/')) filename = filename.slice(0, -1);
    validateChangePath(filename);
    if (seen.has(filename)) return parseFailure();
    seen.add(filename);
    fields = [...fields];
    entries.push({ kind, path: filename, fields });
  }
  return freeze(entries.sort((a, b) => compare(a.path, b.path)));
}
export function parseIndexFlags(output: string): readonly string[] {
  const records = tokens(output);
  for (const record of records) {
    if (!/^[HSMRCK?] /.test(record)) {
      if (/^[a-z] /.test(record)) return fail('GIT_CHANGE_INCOMPLETE_INDEX');
      return parseFailure();
    }
    validateChangePath(record.slice(2));
    if (record[0] === 'S') return fail('GIT_CHANGE_INCOMPLETE_INDEX');
  }
  return Object.freeze(records.sort(compare));
}
export function parseRawChanges(output: string): readonly Omit<GitTrackedChange, 'binary' | 'addedLines' | 'deletedLines'>[] {
  const records = tokens(output);
  const result: Omit<GitTrackedChange, 'binary' | 'addedLines' | 'deletedLines'>[] = [];
  for (let i = 0; i < records.length; i += 2) {
    const header = records[i] ?? '';
    const filename = records[i + 1];
    const fields = header.slice(1).split(' ');
    const [oldMode, newMode, oldObjectId, newObjectId, status] = fields;
    if (!header.startsWith(':') || fields.length !== 5 || !oldMode || !newMode || !oldObjectId || !newObjectId ||
      !status || !/^[AMDTU]$/.test(status) || !mode.test(oldMode) || !mode.test(newMode) ||
      !oid.test(oldObjectId) || !oid.test(newObjectId) || filename === undefined) return parseFailure();
    result.push({ path: validateChangePath(filename), status, oldMode, newMode, oldObjectId, newObjectId });
  }
  // An unmerged path can have both U and M raw records; retain both.
  return freeze(result.sort((a, b) => compare(a.path, b.path)));
}
export function parseChangeNumstat(output: string): readonly { path: string; binary: boolean; addedLines: number | null; deletedLines: number | null }[] {
  const result = tokens(output).map(record => {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) return parseFailure();
    const [, added, deleted, filename] = match;
    if (!filename || (added === '-') !== (deleted === '-')) return parseFailure();
    const binary = added === '-';
    const addedLines = binary ? null : Number(added);
    const deletedLines = binary ? null : Number(deleted);
    if (!binary && (!Number.isSafeInteger(addedLines) || !Number.isSafeInteger(deletedLines))) return parseFailure();
    return { path: validateChangePath(filename), binary, addedLines, deletedLines };
  });
  return freeze(result.sort((a, b) => compare(a.path, b.path)));
}

/** Only the manager supplies this runner and trusted inspection callback. */
export async function captureWorkspaceChanges(
  runner: GitCommandRunnerLike,
  inspect: () => Promise<TaskWorkspace | undefined>,
  options: Required<CaptureWorkspaceChangesOptions>,
): Promise<GitWorkspaceChangeSnapshot> {
  const requireWorkspace = async (): Promise<TaskWorkspace> =>
    await inspect() ?? fail('GIT_CHANGE_WORKSPACE_NOT_FOUND');
  const pass = async () => {
    const workspace = await requireWorkspace();
    const run = async (args: readonly string[], patch = false): Promise<string | undefined> => {
      try {
        // Disable optional index refresh, fsmonitor helpers, lazy fetch, and replacement objects.
        const result = await runner.run([...gitCapturePrefix, ...args], { cwd: workspace.worktreePath });
        if (result.exitCode !== 0 || typeof result.stdout !== 'string') return fail('GIT_CHANGE_CONTRACT_VIOLATION');
        return result.stdout;
      } catch (error) {
        if (error instanceof GitCommandError && error.code === 'GIT_COMMAND_OUTPUT_LIMIT') {
          if (patch) return undefined;
          return limit();
        }
        if (error instanceof GitChangeCaptureError) throw error;
        return fail('GIT_CHANGE_CONTRACT_VIOLATION');
      }
    };
    // Capability preflight: older Git must fail safely before collecting source evidence.
    await run(['--version']);
    const status = parseChangeStatus(await run(['status', '--porcelain=v2', '-z', '--untracked-files=all',
      '--ignored=matching', '--no-renames', '--ignore-submodules=none']) ?? parseFailure());
    const flags = parseIndexFlags(await run(['ls-files', '-v', '-z']) ?? parseFailure());
    // Stage entries make index movement visible even when raw diff/status remain identical.
    const index = await run(['ls-files', '--stage', '-z']) ?? parseFailure();
    for (const record of tokens(index)) {
      const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || !mode.test(match[1] ?? '') || !oid.test(match[2] ?? '')) return parseFailure();
      validateChangePath(match[4] ?? '');
    }
    let patchRemaining = options.maxPatchBytes;
    const layer = async (endpoints: readonly string[]): Promise<GitChangeLayer> => {
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
        '--ignore-submodules=none', '--full-index', '--abbrev=64'];
      const raw = parseRawChanges(await run([...args, '--raw', '-z', ...endpoints, '--']) ?? parseFailure());
      const stats = [...parseChangeNumstat(await run([...args, '--numstat', '-z', ...endpoints, '--']) ?? parseFailure())];
      const byPath = new Map<string, typeof stats>();
      for (const stat of stats) {
        const group = byPath.get(stat.path) ?? [];
        group.push(stat);
        byPath.set(stat.path, group);
      }
      const changes = raw.map(change => {
        const stat = byPath.get(change.path)?.shift();
        if (!stat) return parseFailure();
        return { ...change, ...stat };
      });
      if ([...byPath.values()].some(group => group.length > 0)) return parseFailure();
      let patch: GitPatchCapture = { status: 'not-requested' };
      if (options.includePatchText) {
        const text = await run([...args, '--patch', ...endpoints, '--'], true);
        if (text === undefined || Buffer.byteLength(text) > patchRemaining) patch = { status: 'omitted-limit' };
        else {
          const byteLength = Buffer.byteLength(text);
          patchRemaining -= byteLength;
          patch = byteLength === 0 ? { status: 'empty', byteLength: 0, sha256: sha('') }
            : { status: 'captured', text, byteLength, sha256: sha(text) };
        }
      }
      return { changes, patch };
    };
    const committed = await layer([workspace.baseCommit, workspace.headCommit]);
    const staged = await layer(['--cached', workspace.headCommit]);
    const unstaged = await layer([]);
    const conflicts = status.filter(entry => entry.kind === 'u');
    const untrackedPaths = status.filter(entry => entry.kind === '?').map(entry => entry.path);
    const changedPaths = sorted([...committed.changes, ...staged.changes, ...unstaged.changes, ...conflicts].map(c => c.path).concat(untrackedPaths));
    if (changedPaths.length > options.maxChangedPaths) return limit();
    const budget = { remaining: options.maxFingerprintBytes };
    const workingFiles: GitWorkingFileFingerprint[] = [];
    const workingPaths = sorted([...unstaged.changes, ...conflicts,
      ...status.filter(entry => entry.kind === '1' && entry.fields[1]?.[1] !== '.')].map(c => c.path));
    for (const filename of workingPaths) {
      const gitlink = unstaged.changes.some(c => c.path === filename && c.newMode === '160000');
      if (gitlink) {
        // Raw worktree diffs use a zero OID for gitlinks. Read the clean nested HEAD explicitly;
        // this is pointer identity only, never recursive source capture or submodule update.
        const nested = path.resolve(workspace.worktreePath, filename);
        let parent = workspace.worktreePath;
        for (const part of filename.split('/')) {
          parent = path.join(parent, part);
          const stat = await lstat(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('GIT_CHANGE_CONTRACT_VIOLATION');
        }
        const top = (await run(['-C', nested, 'rev-parse', '--show-toplevel']) ?? '').trim();
        const gitdir = (await run(['-C', nested, 'rev-parse', '--absolute-git-dir']) ?? '').trim();
        const metadataRelative = path.relative(path.join(workspace.repositoryRoot, '.git'), await realpath(gitdir));
        if (path.relative(await realpath(nested), await realpath(top)) !== '' || !metadataRelative ||
          metadataRelative === '..' || metadataRelative.startsWith(`..${path.sep}`) || path.isAbsolute(metadataRelative)) {
          return fail('GIT_CHANGE_CONTRACT_VIOLATION');
        }
        const headCommit = (await run(['-C', nested, 'rev-parse', '--verify', 'HEAD']) ?? '').trim();
        if (!oid.test(headCommit)) return parseFailure();
        workingFiles.push({ path: filename, kind: 'gitlink', headCommit });
      } else workingFiles.push(await fingerprint(workspace.worktreePath, filename, budget));
    }
    const untracked: GitWorkingFileFingerprint[] = [];
    for (const filename of untrackedPaths) {
      const entry = await fingerprint(workspace.worktreePath, filename, budget);
      if (entry.kind === 'missing') return unstable();
      untracked.push(entry);
    }
    const ignoredPaths = status.filter(entry => entry.kind === '!').map(entry => entry.path);
    const ignored = { present: ignoredPaths.length > 0, count: ignoredPaths.length,
      paths: ignoredPaths.slice(0, options.maxIgnoredPaths), truncated: ignoredPaths.length > options.maxIgnoredPaths };
    const after = await requireWorkspace();
    if (canonicalChangeState(workspace) !== canonicalChangeState(after)) return unstable();
    const source = { taskId: workspace.taskId, branchName: workspace.branchName, baseCommit: workspace.baseCommit,
      headCommit: workspace.headCommit, committed: committed.changes, staged: staged.changes,
      unstaged: unstaged.changes, workingFiles, untracked, conflicts,
      status: status.filter(entry => entry.kind !== '!') };
    const snapshot = { ...workspace, committed, staged, unstaged, workingFiles, untracked, conflicts, ignored,
      changedPaths, hasConflicts: conflicts.length > 0, changeSetSha256: sha(canonicalChangeState(source)) };
    return { snapshot, equality: canonicalChangeState({ snapshot, status, flags, index }) };
  };
  try {
    const first = await pass();
    const second = await pass();
    if (first.equality !== second.equality) return unstable();
    return freeze(second.snapshot);
  } catch (error) {
    if (error instanceof GitChangeCaptureError || error instanceof GitWorktreeError) throw error;
    return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  }
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function fingerprint(root: string, filename: string, budget: { remaining: number }): Promise<GitWorkingFileFingerprint> {
  validateChangePath(filename);
  const target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  }
  const parents = async () => {
    let parent = root;
    for (const part of ['.', ...filename.split('/').slice(0, -1)]) {
      parent = path.resolve(parent, part);
      let stat;
      try { stat = await lstat(parent); } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(parent, await realpath(parent)) !== '') {
        return fail('GIT_CHANGE_CONTRACT_VIOLATION');
      }
    }
    return true;
  };
  try {
    if (!await parents()) return { path: filename, kind: 'missing' };
    let before: BigIntStats;
    try { before = await lstat(target, { bigint: true }); } catch (error) {
      if (isMissing(error)) return { path: filename, kind: 'missing' };
      throw error;
    }
    if (before.isSymbolicLink()) {
      const link = await readlink(target, { encoding: 'buffer' });
      if (link.length > budget.remaining) return limit();
      budget.remaining -= link.length;
      if (!sameStat(before, await lstat(target, { bigint: true }))) return unstable();
      if (!await parents()) return unstable();
      return { path: filename, kind: 'symlink', size: link.length, linkTargetSha256: sha(link) };
    }
    if (!before.isFile()) return fail('GIT_CHANGE_UNSUPPORTED_FILE_TYPE');
    if (before.size > BigInt(budget.remaining)) return limit();
    // NONBLOCK prevents a replaced FIFO from hanging; NOFOLLOW prevents leaf symlink traversal on POSIX.
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameStat(before, await handle.stat({ bigint: true }))) return unstable();
      if (!await parents()) return unstable();
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        if (bytesRead > budget.remaining) return limit();
        budget.remaining -= bytesRead;
        size += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (BigInt(size) !== before.size || !sameStat(before, await handle.stat({ bigint: true })) ||
        !sameStat(before, await lstat(target, { bigint: true }))) return unstable();
      if (!await parents()) return unstable();
      return { path: filename, kind: 'regular', size, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof GitChangeCaptureError) throw error;
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') return unstable();
    return fail('GIT_CHANGE_CONTRACT_VIOLATION');
  }
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'; }
