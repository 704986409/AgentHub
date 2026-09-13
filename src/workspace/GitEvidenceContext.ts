import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { gitCapturePrefix } from './GitWorkspaceChangeCapture.js';
import type { GitCommandRunnerLike } from './GitCommandRunner.js';
import type { TaskWorkspace } from './GitWorktreeManager.js';

export interface GitEvidenceContextSnapshot {
  readonly sourceVisibilitySha256: string;
}

const maxFileBytes = 16 * 1024 * 1024;
const maxIgnoreFiles = 4096;
const maxIgnoreFileBytes = 4 * 1024 * 1024;
const maxIgnoreTotalBytes = 64 * 1024 * 1024;
const configKeys = ['core.excludesFile', 'core.attributesFile'] as const;

/**
 * Captures only private identities of Git's source-visibility inputs.  The
 * returned object intentionally contains no paths, config values, or file
 * contents.
 */
export async function captureGitEvidenceContext(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
  limits: GitEvidenceContextLimits = {},
): Promise<GitEvidenceContextSnapshot> {
  const resolvedLimits = {
    maxIgnoreFiles: limits.maxIgnoreFiles ?? maxIgnoreFiles,
    maxIgnoreFileBytes: limits.maxIgnoreFileBytes ?? maxIgnoreFileBytes,
    maxIgnoreTotalBytes: limits.maxIgnoreTotalBytes ?? maxIgnoreTotalBytes,
  };
  if (Object.values(resolvedLimits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Git evidence limits are invalid');
  }
  const first = await captureOnce(runner, workspace, resolvedLimits);
  const second = await captureOnce(runner, workspace, resolvedLimits);
  if (first.sourceVisibilitySha256 !== second.sourceVisibilitySha256) {
    throw new Error('Git evidence visibility changed while capturing');
  }
  return first;
}

export interface GitEvidenceContextLimits {
  readonly maxIgnoreFiles?: number;
  readonly maxIgnoreFileBytes?: number;
  readonly maxIgnoreTotalBytes?: number;
}

async function captureOnce(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
  limits: Required<GitEvidenceContextLimits>,
): Promise<GitEvidenceContextSnapshot> {
  const cwd = workspace.worktreePath;
  const metadataNames = ['info/exclude', 'info/attributes', 'config', 'config.worktree'];
  const metadata = await Promise.all(metadataNames.map(async (name) => {
    const result = await runGit(runner, ['rev-parse', '--path-format=absolute', '--git-path', name], cwd);
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || value.length === 0 || value.includes('\0')) {
      throw new Error('Git evidence path resolution failed');
    }
    return fingerprint(path.resolve(value));
  }));

  const configured = await Promise.all(configKeys.map(async (key) => {
    const result = await runGit(runner,
      ['config', '--null', '--show-origin', '--show-scope', '--get-all', key], cwd, [0, 1]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error('Git evidence config resolution failed');
    }
    return {
      key,
      valueSha256: digest(result.stdout),
      files: await configuredFiles(result.stdout),
    };
  }));
  const ignorePolicies = await captureIgnorePolicies(runner, cwd, limits);

  return Object.freeze({
    sourceVisibilitySha256: digest(JSON.stringify({ metadata, configured, ignorePolicies })),
  });

  async function configuredFiles(output: string): Promise<readonly unknown[]> {
    const records = output.length === 0 ? [] : output.split('\0');
    if (records.length > 0 && records[records.length - 1] === '') records.pop();
    if (records.length % 3 !== 0) throw new Error('Git evidence config output malformed');
    const result: unknown[] = [];
    for (let index = 0; index < records.length; index += 3) {
      const origin = records[index + 1];
      const value = records[index + 2];
      if (origin === undefined || value === undefined || value.length === 0) {
        throw new Error('Git evidence config output malformed');
      }
      const originPath = parseOriginPath(origin, cwd);
      const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
      const expanded = value === '~'
        ? home
        : value.startsWith('~/')
          ? path.join(home, value.slice(2))
        : value;
      const resolved = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(path.dirname(originPath), expanded);
      result.push(await fingerprint(resolved));
    }
    return result;
  }
}

async function captureIgnorePolicies(
  runner: GitCommandRunnerLike, cwd: string, limits: Required<GitEvidenceContextLimits>,
): Promise<readonly unknown[]> {
  const pathspec = ['--', '*.gitignore', '**/.gitignore'] as const;
  const [tracked, selfIgnored] = await Promise.all([
    runGit(runner, ['ls-files', '--cached', '-z', ...pathspec], cwd, [0]),
    runGit(runner, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...pathspec], cwd, [0]),
  ]);
  const paths = `${tracked.stdout}${selfIgnored.stdout}`.split('\0').filter(Boolean);
  const unique = [...new Set(paths)].sort();
  if (unique.length > limits.maxIgnoreFiles) throw new Error('Too many Git ignore policy files');
  const canonicalRoot = await realpath(cwd);
  let total = 0;
  const records: unknown[] = [];
  for (const relative of unique) {
    if (!relative || relative.includes('\0') || path.posix.isAbsolute(relative) ||
      relative.split('/').some((part) => part === '..' || part === '' || part === '.')) {
      throw new Error('Git ignore policy path is unsafe');
    }
    const target = path.resolve(canonicalRoot, ...relative.split('/'));
    if (!isContained(canonicalRoot, target)) throw new Error('Git ignore policy path escapes worktree');
    await validateParentChain(canonicalRoot, target);
    const stat = await lstat(target).catch(() => undefined);
    if (stat === undefined) { records.push({ path: digest(relative), state: 'missing' }); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Git ignore policy is unsafe');
    if (stat.size > limits.maxIgnoreFileBytes || total + stat.size > limits.maxIgnoreTotalBytes) {
      throw new Error('Git ignore policy is too large');
    }
    total += stat.size;
    records.push({
      path: digest(relative),
      file: await fingerprint(target, limits.maxIgnoreFileBytes, () => validateParentChain(canonicalRoot, target)),
    });
  }
  return records;
}

async function validateParentChain(root: string, target: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  const parent = path.dirname(target);
  const relative = path.relative(canonicalRoot, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Git ignore policy parent escapes worktree');
  }
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(cursor), cursor)) {
      throw new Error('Git ignore policy parent is unsafe');
    }
  }
}

async function runGit(
  runner: GitCommandRunnerLike,
  args: readonly string[],
  cwd: string,
  acceptedExitCodes?: readonly number[],
) {
  return runner.run([...gitCapturePrefix, ...args], {
    cwd,
    ...(acceptedExitCodes === undefined ? {} : { acceptedExitCodes }),
  });
}

function parseOriginPath(origin: string, cwd: string): string {
  if (!origin.startsWith('file:')) throw new Error('Git evidence config origin is not a file');
  const value = origin.slice('file:'.length);
  if (value.length === 0 || value.includes('\0')) throw new Error('Git evidence config origin is invalid');
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function fingerprint(target: string, limit = maxFileBytes, parentGuard?: () => Promise<void>): Promise<unknown> {
  const privatePath = digest(path.normalize(target));
  try {
    const before = await lstat(target);
    await parentGuard?.();
    if (before.isSymbolicLink() || !before.isFile() || before.size > limit) {
      throw new Error('Git evidence file is unsafe');
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      await parentGuard?.();
      if (opened.isSymbolicLink() || !opened.isFile() || before.size !== opened.size ||
        before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) {
        throw new Error('Git evidence file changed');
      }
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > limit) throw new Error('Git evidence file is too large');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await lstat(target);
      const final = await handle.stat();
      await parentGuard?.();
      if (after.isSymbolicLink() || !after.isFile() || size !== before.size ||
        !sameStats(before, final) || !sameStats(before, after)) {
        throw new Error('Git evidence file changed');
      }
      return { privatePath, state: 'file', size, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { privatePath, state: 'missing' };
    }
    throw error;
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => path.normalize(value).replace(/[\\/]$/u, '');
  if (process.platform !== 'win32') return normalize(a) === normalize(b);
  return normalize(a).toLocaleLowerCase('en-US') === normalize(b).toLocaleLowerCase('en-US');
}

function sameStats(a: { size: number; mtimeMs: number; ctimeMs: number }, b: { size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
