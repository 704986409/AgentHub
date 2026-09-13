import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { gitCapturePrefix } from './GitWorkspaceChangeCapture.js';
import type { GitCommandRunnerLike } from './GitCommandRunner.js';
import type { TaskWorkspace } from './GitWorktreeManager.js';

export interface GitEvidenceContextSnapshot {
  readonly sourceVisibilitySha256: string;
}

const maxFileBytes = 16 * 1024 * 1024;
const configKeys = ['core.excludesFile', 'core.attributesFile'] as const;

/**
 * Captures only private identities of Git's source-visibility inputs.  The
 * returned object intentionally contains no paths, config values, or file
 * contents.
 */
export async function captureGitEvidenceContext(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
): Promise<GitEvidenceContextSnapshot> {
  const first = await captureOnce(runner, workspace);
  const second = await captureOnce(runner, workspace);
  if (first.sourceVisibilitySha256 !== second.sourceVisibilitySha256) {
    throw new Error('Git evidence visibility changed while capturing');
  }
  return first;
}

async function captureOnce(
  runner: GitCommandRunnerLike,
  workspace: TaskWorkspace,
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

  return Object.freeze({
    sourceVisibilitySha256: digest(JSON.stringify({ metadata, configured })),
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

async function fingerprint(target: string): Promise<unknown> {
  const privatePath = digest(path.normalize(target));
  try {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxFileBytes) {
      throw new Error('Git evidence file is unsafe');
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
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
        if (size > maxFileBytes) throw new Error('Git evidence file is too large');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await lstat(target);
      const final = await handle.stat();
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

function sameStats(a: { size: number; mtimeMs: number; ctimeMs: number }, b: { size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
