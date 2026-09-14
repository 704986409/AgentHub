import { describe, expect, it, vi } from 'vitest';
import { performTaskCommit, type GitCommandRunnerLike, type GitWorkspaceChangeSnapshot, type TaskWorkspace } from '../src/index.js';

const oid = 'a'.repeat(40);
const workspace: TaskWorkspace = { taskId: 'TASK', repositoryRoot: 'C:/repo', worktreePath: 'C:/repo/wt',
  branchName: 'agenthub/TASK', baseCommit: oid, headCommit: oid };
function snapshot(head = oid, dirty = false): GitWorkspaceChangeSnapshot {
  const patch = { status: 'not-requested' as const };
  const change = { path: 'file.ts', status: 'A', oldMode: '000000', newMode: '100644',
    oldObjectId: '0'.repeat(40), newObjectId: 'b'.repeat(40), binary: false, addedLines: 1, deletedLines: 0 };
  return { ...workspace, headCommit: head, committed: { changes: head === oid ? [] : [change], patch },
    staged: { changes: [], patch }, unstaged: { changes: dirty ? [change] : [], patch }, workingFiles: [],
    untracked: [], conflicts: [], ignored: { present: false, count: 0, paths: [], truncated: false },
    changedPaths: dirty || head !== oid ? ['file.ts'] : [], hasConflicts: false, changeSetSha256: 'c'.repeat(64) };
}

describe('performTaskCommit', () => {
  it('returns a frozen no-change result without invoking Git', async () => {
    const run = vi.fn();
    const runner = { run } as unknown as GitCommandRunnerLike;
    const result = await performTaskCommit(runner, workspace, { capture: () => Promise.resolve(snapshot()), inspect: () => Promise.resolve(workspace) });
    expect(result.outcome).toBe('no-changes');
    expect(run.mock.calls).toHaveLength(0);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('fails closed on conflicts before invoking Git', async () => {
    const run = vi.fn();
    const runner = { run } as unknown as GitCommandRunnerLike;
    const conflicted = { ...snapshot(), hasConflicts: true, conflicts: [{ path: 'file.ts', kind: 'u' as const, fields: [] }] };
    await expect(performTaskCommit(runner, workspace, { capture: () => Promise.resolve(conflicted), inspect: () => Promise.resolve(workspace) }))
      .rejects.toMatchObject({ code: 'GIT_TASK_COMMIT_CONFLICTS' });
    expect(run.mock.calls).toHaveLength(0);
  });
  it('quarantines a failed commit when recapture cannot prove the original HEAD is unchanged', async () => {
    const changedHead = 'd'.repeat(40);
    const runner = { run: vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'add failed' }) } as unknown as GitCommandRunnerLike;
    const onAmbiguousFailure = vi.fn();
    let captureCount = 0;
    await expect(performTaskCommit(runner, workspace, {
      capture: () => Promise.resolve(captureCount++ === 0 ? snapshot(oid, true) : snapshot(changedHead, true)),
      inspect: () => Promise.resolve({ ...workspace, headCommit: changedHead }),
      onAmbiguousFailure,
    })).rejects.toMatchObject({ code: 'GIT_TASK_COMMIT_FAILED' });
    expect(onAmbiguousFailure).toHaveBeenCalledTimes(1);
  });
  it('quarantines when successful Git mutation cannot be verified afterward', async () => {
    const runner = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) } as unknown as GitCommandRunnerLike;
    const onAmbiguousFailure = vi.fn();
    let captureCount = 0;
    await expect(performTaskCommit(runner, workspace, {
      capture: () => captureCount++ === 0 ? Promise.resolve(snapshot(oid, true)) : Promise.reject(new Error('recapture failed')),
      inspect: () => Promise.resolve({ ...workspace, headCommit: 'd'.repeat(40) }),
      onAmbiguousFailure,
    })).rejects.toMatchObject({ code: 'GIT_TASK_COMMIT_POSTCONDITION_FAILED' });
    expect(onAmbiguousFailure).toHaveBeenCalledTimes(1);
  });
});
