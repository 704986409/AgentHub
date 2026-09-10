export const managerDirectiveActions = [
  'DELEGATE',
  'REQUEST_REVISION',
  'ACCEPT',
  'BLOCK',
  'INFORM',
] as const;

export type ManagerDirectiveAction = (typeof managerDirectiveActions)[number];

export interface ManagerDirective {
  action: ManagerDirectiveAction;
  taskId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  issues: string[];
  requestedChecks: string[];
  summary: string;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

export type SchemaResult<T> =
  | { success: true; data: T }
  | { success: false; issues: readonly SchemaIssue[] };

export const ManagerDirectiveActionSchema = {
  safeParse(value: unknown): SchemaResult<ManagerDirectiveAction> {
    if (typeof value === 'string' && managerDirectiveActions.includes(value as ManagerDirectiveAction)) {
      return { success: true, data: value as ManagerDirectiveAction };
    }
    return { success: false, issues: [{ path: 'action', message: 'Unsupported directive action' }] };
  },
};

export const ManagerDirectiveSchema = {
  safeParse(value: unknown): SchemaResult<ManagerDirective> {
    if (!isRecord(value)) {
      return { success: false, issues: [{ path: '$', message: 'Directive must be a JSON object' }] };
    }

    const issues: SchemaIssue[] = [];
    const actionResult = ManagerDirectiveActionSchema.safeParse(value.action);
    if (!actionResult.success) issues.push(...actionResult.issues);
    const taskId = readString(value, 'taskId', issues);
    const title = readString(value, 'title', issues);
    const instructions = readString(value, 'instructions', issues);
    const acceptanceCriteria = readStringArray(value, 'acceptanceCriteria', issues);
    const directiveIssues = readStringArray(value, 'issues', issues);
    const requestedChecks = readStringArray(value, 'requestedChecks', issues);
    const summary = readString(value, 'summary', issues);
    if (taskId !== undefined && taskId.trim().length === 0) {
      issues.push({ path: 'taskId', message: 'taskId must not be blank' });
    }
    if (issues.length > 0 || !actionResult.success) return { success: false, issues };

    return {
      success: true,
      data: {
        action: actionResult.data,
        taskId: taskId ?? '',
        title: title ?? '',
        instructions: instructions ?? '',
        acceptanceCriteria: acceptanceCriteria ?? [],
        issues: directiveIssues ?? [],
        requestedChecks: requestedChecks ?? [],
        summary: summary ?? '',
      },
    };
  },
};

export function validateManagerDirectiveSemantics(directive: ManagerDirective): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  switch (directive.action) {
    case 'DELEGATE':
      if (directive.instructions.trim().length === 0) {
        issues.push({ path: 'instructions', message: 'DELEGATE requires non-blank instructions' });
      }
      if (directive.acceptanceCriteria.length === 0) {
        issues.push({ path: 'acceptanceCriteria', message: 'DELEGATE requires at least one acceptance criterion' });
      }
      break;
    case 'REQUEST_REVISION':
      if (directive.issues.length === 0) {
        issues.push({ path: 'issues', message: 'REQUEST_REVISION requires at least one issue' });
      }
      break;
    case 'ACCEPT':
      if (directive.summary.trim().length === 0) {
        issues.push({ path: 'summary', message: 'ACCEPT requires a non-blank summary' });
      }
      break;
    case 'BLOCK':
      if (directive.summary.trim().length === 0) {
        issues.push({ path: 'summary', message: 'BLOCK requires a non-blank summary' });
      }
      if (directive.summary.trim().length === 0 && directive.issues.length === 0) {
        issues.push({ path: 'issues', message: 'BLOCK requires a blocking reason' });
      }
      break;
    case 'INFORM':
      if (directive.summary.trim().length === 0) {
        issues.push({ path: 'summary', message: 'INFORM requires a non-blank summary' });
      }
      break;
  }
  return issues;
}

function readString(record: Record<string, unknown>, key: string, issues: SchemaIssue[]): string | undefined {
  const value = record[key];
  if (typeof value === 'string') return value;
  issues.push({ path: key, message: `${key} must be a string` });
  return undefined;
}

function readStringArray(record: Record<string, unknown>, key: string, issues: SchemaIssue[]): string[] | undefined {
  const value = record[key];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value] as string[];
  issues.push({ path: key, message: `${key} must be an array of strings` });
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
