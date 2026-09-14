import type { CreatedTaskWorkspace } from '../../workspace/GitWorktreeManager.js';
import {
  AssignmentDispatcher,
  type AssignmentDispatcherOptions,
} from '../AssignmentDispatcher.js';
import { assignmentDispatcherTestAuthority } from './AssignmentDispatcherTestAuthority.js';

export interface AssignmentDispatcherWorkspaceTestDouble {
  readonly repositoryRoot: string;
  createWorkspace(request: { readonly taskId: string; readonly baseRef: string }): Promise<CreatedTaskWorkspace>;
}

export function createAssignmentDispatcherForTest(
  options: Omit<AssignmentDispatcherOptions, 'worktreeManager'> & {
    readonly worktreeManager: AssignmentDispatcherWorkspaceTestDouble;
  },
): AssignmentDispatcher {
  return new AssignmentDispatcher(
    options as unknown as AssignmentDispatcherOptions,
    assignmentDispatcherTestAuthority,
  );
}
