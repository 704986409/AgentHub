import { collectBuildTestEvidence, type BuildTestEvidence } from '../src/workspace/BuildTestEvidenceCollector.js';
import type { GitCommandRunnerLike, GitWorkspaceChangeSnapshot, TaskWorkspace } from '../src/index.js';

export const baseCommit = 'a'.repeat(40);
export const headCommit = 'b'.repeat(40);
export const changeSetSha256 = 'c'.repeat(64);
export const visibilitySha256 = 'd'.repeat(64);

export interface EvidenceFixtureOptions {
  readonly commandId?: string;
  readonly phase?: 'build' | 'test';
  readonly outcome?: 'passed' | 'failed';
  readonly changeSetSha256?: string;
  readonly visibilitySha256?: string;
  readonly taskId?: string;
  readonly headCommit?: string;
}

export async function evidenceFixture(options: EvidenceFixtureOptions = {}): Promise<{
  readonly evidence: BuildTestEvidence;
  readonly current: GitWorkspaceChangeSnapshot;
}> {
  const taskId = options.taskId ?? 'TASK-A';
  const workspace = taskWorkspace(taskId, options.headCommit ?? headCommit);
  const current = sourceFixture(workspace, options.changeSetSha256 ?? changeSetSha256);
  const visibility = options.visibilitySha256 ?? visibilitySha256;
  const runOutcome = options.outcome ?? 'passed';
  const evidence = await collectBuildTestEvidence({ commands: [{
    id: options.commandId ?? 'test', phase: options.phase ?? 'test', executable: process.execPath,
    args: ['-e', ''], timeoutMs: 5_000,
  }] }, {
    runner: unusedRunner(), inspect: () => Promise.resolve(workspace), worktree: workspace,
    taskRunner: { run: () => Promise.resolve({
      outcome: runOutcome,
      exitCode: runOutcome === 'passed' ? 0 : 7,
      durationMs: 1,
      executionEnvironmentSha256: 'e'.repeat(64),
      stdout: stream('0'), stderr: stream('1'),
    }) },
    captureSource: () => Promise.resolve(current),
    captureContext: () => Promise.resolve({ sourceVisibilitySha256: visibility }),
  });
  return { evidence, current };
}

export function sourceFixture(workspace: TaskWorkspace, digest = changeSetSha256): GitWorkspaceChangeSnapshot {
  const emptyLayer = Object.freeze({ changes: Object.freeze([]), patch: Object.freeze({ status: 'not-requested' as const }) });
  const committed = Object.freeze({
    changes: Object.freeze([Object.freeze({
      path: 'task.txt', status: 'A', oldMode: '000000', newMode: '100644', oldObjectId: '0'.repeat(40),
      newObjectId: 'f'.repeat(40), binary: false, addedLines: 1, deletedLines: 0,
    })]),
    patch: Object.freeze({ status: 'not-requested' as const }),
  });
  return Object.freeze({
    ...workspace, committed, staged: emptyLayer, unstaged: emptyLayer,
    workingFiles: Object.freeze([]), untracked: Object.freeze([]), conflicts: Object.freeze([]),
    ignored: Object.freeze({ present: false, count: 0, paths: Object.freeze([]), truncated: false }),
    changedPaths: Object.freeze(['task.txt']), hasConflicts: false, changeSetSha256: digest,
  });
}

export function taskWorkspace(taskId = 'TASK-A', head = headCommit): TaskWorkspace {
  return Object.freeze({ taskId, repositoryRoot: '/repo', worktreePath: `/repo/.agenthub/worktrees/${taskId}`,
    branchName: `agenthub/${taskId}`, baseCommit, headCommit: head });
}

function stream(seed: string) {
  return Object.freeze({ byteLength: 0, sha256: seed.repeat(64), preview: '', previewTruncated: false });
}
function unusedRunner(): GitCommandRunnerLike {
  return { run: () => Promise.reject(new Error('unused runner')) };
}
