import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { BuildTestEvidenceCollectorOptions } from '../BuildTestEvidenceCollector.js';
import { gitWorktreeManagerInternal,
  type GitWorktreeManager, type GitWorktreeManagerOptions } from '../GitWorktreeManager.js';

type TaskRunner = NonNullable<BuildTestEvidenceCollectorOptions['taskRunner']>;

export function openGitWorktreeManagerWithTaskRunner(
  options: GitWorktreeManagerOptions,
  taskRunner: TaskRunner,
): Promise<GitWorktreeManager> {
  return gitWorktreeManagerInternal.openWithTaskRunner(options, taskRunner);
}

export function releaseTransientRepositoryCoordination(repositoryRoot: string): void {
  gitWorktreeManagerInternal.releaseTransientCoordination(repositoryRoot);
}

export function quarantineTask(repositoryRoot: string, taskId: string): void {
  gitWorktreeManagerInternal.quarantine(repositoryRoot, taskId);
}

export function isTaskQuarantined(repositoryRoot: string, taskId: string): boolean {
  return gitWorktreeManagerInternal.isQuarantined(repositoryRoot, taskId);
}

export function setMergeHooks(
  manager: GitWorktreeManager,
  hooks: Parameters<typeof gitWorktreeManagerInternal.setMergeHooks>[1],
): void {
  gitWorktreeManagerInternal.setMergeHooks(manager, hooks);
}

export function isMergeRepositoryQuarantined(repositoryRoot: string): boolean {
  return gitWorktreeManagerInternal.isMergeQuarantined(realpathSync(path.resolve(repositoryRoot)));
}
