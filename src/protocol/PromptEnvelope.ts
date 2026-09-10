import path from 'node:path';

export interface ManagerProjectContext {
  workspacePath: string;
  targetBranch: string;
  repositoryRules: string[];
}

export interface ManagerTaskContext {
  taskId?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  revision?: number;
}

export interface ManagerPromptEnvelope {
  rolePrompt: string;
  project: ManagerProjectContext;
  userRequirement: string;
  task?: ManagerTaskContext;
}

export type ManagerPromptValidationCode =
  | 'MANAGER_ROLE_EMPTY'
  | 'WORKSPACE_PATH_EMPTY'
  | 'WORKSPACE_PATH_NOT_ABSOLUTE'
  | 'WORKSPACE_PATH_NOT_NORMALIZED'
  | 'TARGET_BRANCH_EMPTY'
  | 'USER_REQUIREMENT_EMPTY'
  | 'REPOSITORY_RULES_INVALID'
  | 'TASK_CONTEXT_INVALID'
  | 'ACCEPTANCE_CRITERIA_INVALID'
  | 'REVISION_INVALID';

export class ManagerPromptValidationError extends Error {
  public constructor(
    public readonly code: ManagerPromptValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagerPromptValidationError';
  }
}

export function validateManagerPromptEnvelope(value: unknown): asserts value is ManagerPromptEnvelope {
  if (!isRecord(value) || !isNonBlankString(value.rolePrompt)) {
    throw new ManagerPromptValidationError('MANAGER_ROLE_EMPTY', 'Manager role prompt must not be blank');
  }
  if (!isRecord(value.project)) {
    throw new ManagerPromptValidationError('WORKSPACE_PATH_EMPTY', 'Manager project context is required');
  }
  const workspacePath = value.project.workspacePath;
  if (!isNonBlankString(workspacePath)) {
    throw new ManagerPromptValidationError('WORKSPACE_PATH_EMPTY', 'Workspace path must not be blank');
  }
  const pathApi = path.win32.isAbsolute(workspacePath) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(workspacePath)) {
    throw new ManagerPromptValidationError('WORKSPACE_PATH_NOT_ABSOLUTE', 'Workspace path must be absolute');
  }
  if (pathApi.normalize(workspacePath) !== workspacePath) {
    throw new ManagerPromptValidationError('WORKSPACE_PATH_NOT_NORMALIZED', 'Workspace path must be normalized');
  }
  if (!isNonBlankString(value.project.targetBranch)) {
    throw new ManagerPromptValidationError('TARGET_BRANCH_EMPTY', 'Target branch must not be blank');
  }
  if (!isStringArray(value.project.repositoryRules, true)) {
    throw new ManagerPromptValidationError('REPOSITORY_RULES_INVALID', 'Repository rules must be an array of non-blank strings');
  }
  if (!isNonBlankString(value.userRequirement)) {
    throw new ManagerPromptValidationError('USER_REQUIREMENT_EMPTY', 'User requirement must not be blank');
  }
  if (value.task === undefined) return;
  if (!isRecord(value.task)) {
    throw new ManagerPromptValidationError('TASK_CONTEXT_INVALID', 'Task context must be an object');
  }
  for (const field of ['taskId', 'title', 'description'] as const) {
    const fieldValue = value.task[field];
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      throw new ManagerPromptValidationError('TASK_CONTEXT_INVALID', `Task ${field} must be a string`);
    }
  }
  if (value.task.acceptanceCriteria !== undefined && !isStringArray(value.task.acceptanceCriteria, true)) {
    throw new ManagerPromptValidationError('ACCEPTANCE_CRITERIA_INVALID', 'Acceptance criteria must be an array of non-blank strings');
  }
  const revision = value.task.revision;
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)) {
    throw new ManagerPromptValidationError('REVISION_INVALID', 'Task revision must be a non-negative integer');
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown, requireNonBlank: boolean): value is string[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === 'string' && (!requireNonBlank || item.trim().length > 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
