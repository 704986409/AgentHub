import { describe, expect, it } from 'vitest';

import { parseWorktreePorcelain, validateTaskId } from '../src/index.js';

describe('GitWorktreeManager validation', () => {
  it.each(['TASK-123', 'task_abc', 'abc.def', 'A', 'a'.repeat(64)])('accepts safe task ID %s', (taskId) => {
    expect(validateTaskId(taskId)).toBe(taskId);
  });

  it.each([
    '', '.hidden', '../escape', 'a/b', 'a\\b', 'a..b', 'trailing.', 'line\nbreak', 'nul\0byte',
    'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con.txt', 'NUL.anything', 'a'.repeat(65),
  ])('rejects unsafe task ID %s without normalization', (taskId) => {
    expectErrorCode(() => validateTaskId(taskId), 'GIT_WORKTREE_INVALID_TASK_ID');
  });
});

describe('Git worktree porcelain parser', () => {
  it('parses primary, spaces, Windows paths, and optional flags', () => {
    const output = [
      'worktree /repo root', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
      'worktree C:\\Repo Path\\task', 'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/agenthub/TASK-A', 'locked maintenance', 'future-field ignored', '',
      'worktree /repo/detached', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable stale', '',
    ].join('\0');
    const records = parseWorktreePorcelain(output);
    expect(records).toEqual([
      {
        worktreePath: '/repo root', head: '1111111111111111111111111111111111111111',
        branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false,
      },
      {
        worktreePath: 'C:\\Repo Path\\task', head: '2222222222222222222222222222222222222222',
        branch: 'refs/heads/agenthub/TASK-A', detached: false, bare: false, locked: true, prunable: false,
      },
      {
        worktreePath: '/repo/detached', head: '3333333333333333333333333333333333333333',
        detached: true, bare: false, locked: false, prunable: true,
      },
    ]);
    expect(Object.isFrozen(records)).toBe(true);
    expect(records.every(Object.isFrozen)).toBe(true);
  });

  it.each(['HEAD abc\0', 'branch refs/heads/main\0', 'worktree \0HEAD abc\0'])(
    'rejects malformed essential record %s',
    (output) => expectErrorCode(() => parseWorktreePorcelain(output), 'GIT_WORKTREE_CONTRACT_VIOLATION'),
  );
});

function expectErrorCode(callback: () => unknown, code: string): void {
  let caught: unknown;
  try { callback(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code });
}
