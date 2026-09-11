import type { SchemaIssue, SchemaResult } from './ManagerDirective.js';

export const agentHubWorkerOutcomes = [
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'NEEDS_INPUT',
] as const;

export type AgentHubWorkerOutcome = (typeof agentHubWorkerOutcomes)[number];

export const agentHubCheckStatuses = ['PASSED', 'FAILED', 'NOT_RUN'] as const;

export type AgentHubCheckStatus = (typeof agentHubCheckStatuses)[number];

export interface AgentHubWorkerCheckClaim {
  name: string;
  status: AgentHubCheckStatus;
  detail: string;
}

export interface AgentHubWorkerResult {
  protocolVersion: 1;
  outcome: AgentHubWorkerOutcome;
  summary: string;
  changedFiles: string[];
  checks: AgentHubWorkerCheckClaim[];
  blockers: string[];
  questions: string[];
  risks: string[];
  notes: string[];
}

export const agentHubWorkerResultLimits = {
  maxResponseChars: 2 * 1024 * 1024,
  maxBlockBytes: 256 * 1024,
  maxChangedFiles: 512,
  maxChecks: 128,
  maxBlockers: 64,
  maxQuestions: 64,
  maxRisks: 64,
  maxNotes: 128,
  maxSummaryChars: 8192,
  maxPathChars: 2048,
  maxCheckNameChars: 256,
  maxDetailChars: 4096,
  maxListItemChars: 4096,
  maxFailureMessageChars: 1024,
} as const;

const topLevelKeys = new Set([
  'protocolVersion',
  'outcome',
  'summary',
  'changedFiles',
  'checks',
  'blockers',
  'questions',
  'risks',
  'notes',
]);
const checkKeys = new Set(['name', 'status', 'detail']);

export const AgentHubWorkerOutcomeSchema = {
  safeParse(value: unknown): SchemaResult<AgentHubWorkerOutcome> {
    if (typeof value === 'string' && agentHubWorkerOutcomes.includes(value as AgentHubWorkerOutcome)) {
      return { success: true, data: value as AgentHubWorkerOutcome };
    }
    return { success: false, issues: [{ path: 'outcome', message: 'Unsupported worker outcome' }] };
  },
};

export const AgentHubWorkerCheckClaimSchema = {
  safeParse(value: unknown): SchemaResult<AgentHubWorkerCheckClaim> {
    return parseCheckClaim(value, 'checks[0]');
  },
};

export const AgentHubWorkerResultSchema = {
  safeParse(value: unknown): SchemaResult<AgentHubWorkerResult> {
    if (!isRecord(value)) {
      return { success: false, issues: [{ path: '$', message: 'Worker result must be a JSON object' }] };
    }

    const issues: SchemaIssue[] = [];
    rejectUnknownKeys(value, topLevelKeys, '$', issues);

    const protocolVersion = value.protocolVersion;
    if (protocolVersion !== 1) {
      issues.push({ path: 'protocolVersion', message: 'protocolVersion must be 1' });
    }

    const outcomeResult = AgentHubWorkerOutcomeSchema.safeParse(value.outcome);
    if (!outcomeResult.success) issues.push(...outcomeResult.issues);

    const summary = readString(value, 'summary', issues, agentHubWorkerResultLimits.maxSummaryChars);
    const changedFiles = readStringArray(
      value,
      'changedFiles',
      issues,
      agentHubWorkerResultLimits.maxChangedFiles,
      agentHubWorkerResultLimits.maxPathChars,
      { forbidNul: true },
    );
    const checks = readChecks(value, issues);
    const blockers = readStringArray(
      value,
      'blockers',
      issues,
      agentHubWorkerResultLimits.maxBlockers,
      agentHubWorkerResultLimits.maxListItemChars,
    );
    const questions = readStringArray(
      value,
      'questions',
      issues,
      agentHubWorkerResultLimits.maxQuestions,
      agentHubWorkerResultLimits.maxListItemChars,
    );
    const risks = readStringArray(
      value,
      'risks',
      issues,
      agentHubWorkerResultLimits.maxRisks,
      agentHubWorkerResultLimits.maxListItemChars,
    );
    const notes = readStringArray(
      value,
      'notes',
      issues,
      agentHubWorkerResultLimits.maxNotes,
      agentHubWorkerResultLimits.maxListItemChars,
    );

    if (
      issues.length > 0 ||
      !outcomeResult.success ||
      protocolVersion !== 1 ||
      summary === undefined ||
      changedFiles === undefined ||
      checks === undefined ||
      blockers === undefined ||
      questions === undefined ||
      risks === undefined ||
      notes === undefined
    ) {
      return { success: false, issues };
    }

    return {
      success: true,
      data: {
        protocolVersion: 1,
        outcome: outcomeResult.data,
        summary,
        changedFiles,
        checks,
        blockers,
        questions,
        risks,
        notes,
      },
    };
  },
};

export function validateAgentHubWorkerResultSemantics(result: AgentHubWorkerResult): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  if (result.summary.trim().length === 0) {
    issues.push({ path: 'summary', message: 'summary must not be blank' });
  }

  if (result.outcome === 'COMPLETED') {
    if (result.blockers.length > 0) {
      issues.push({ path: 'blockers', message: 'COMPLETED must not include blockers' });
    }
    if (result.questions.length > 0) {
      issues.push({ path: 'questions', message: 'COMPLETED must not include questions' });
    }
  } else if (result.outcome === 'BLOCKED' && result.blockers.length === 0) {
    issues.push({ path: 'blockers', message: 'BLOCKED requires at least one blocker' });
  } else if (result.outcome === 'NEEDS_INPUT' && result.questions.length === 0) {
    issues.push({ path: 'questions', message: 'NEEDS_INPUT requires at least one question' });
  }

  addDuplicateIssues(result.changedFiles, 'changedFiles', 'changed file', issues);
  addDuplicateIssues(
    result.checks.map((check) => check.name),
    'checks',
    'check name',
    issues,
  );

  return issues;
}

function parseCheckClaim(value: unknown, path: string): SchemaResult<AgentHubWorkerCheckClaim> {
  if (!isRecord(value)) {
    return { success: false, issues: [{ path, message: 'Check claim must be a JSON object' }] };
  }

  const issues: SchemaIssue[] = [];
  rejectUnknownKeys(value, checkKeys, path, issues);
  const name = readNestedString(value, 'name', path, issues, agentHubWorkerResultLimits.maxCheckNameChars, true);
  const detail = readNestedString(value, 'detail', path, issues, agentHubWorkerResultLimits.maxDetailChars, false);
  const status = value.status;
  if (typeof status !== 'string' || !agentHubCheckStatuses.includes(status as AgentHubCheckStatus)) {
    issues.push({ path: `${path}.status`, message: 'Unsupported check status' });
  }

  if (issues.length > 0 || name === undefined || detail === undefined || typeof status !== 'string') {
    return { success: false, issues };
  }

  return { success: true, data: { name, status: status as AgentHubCheckStatus, detail } };
}

function readChecks(record: Record<string, unknown>, issues: SchemaIssue[]): AgentHubWorkerCheckClaim[] | undefined {
  const value = record.checks;
  if (!Array.isArray(value)) {
    issues.push({ path: 'checks', message: 'checks must be an array' });
    return undefined;
  }
  if (value.length > agentHubWorkerResultLimits.maxChecks) {
    issues.push({ path: 'checks', message: `checks must contain at most ${String(agentHubWorkerResultLimits.maxChecks)} items` });
  }

  const checks: AgentHubWorkerCheckClaim[] = [];
  value.forEach((item, index) => {
    const result = parseCheckClaim(item, `checks[${String(index)}]`);
    if (result.success) checks.push(result.data);
    else issues.push(...result.issues);
  });
  return checks;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  issues: SchemaIssue[],
  maxChars: number,
): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    issues.push({ path: key, message: `${key} must be a string` });
    return undefined;
  }
  if (value.length > maxChars) issues.push({ path: key, message: `${key} must be at most ${String(maxChars)} characters` });
  return value;
}

function readNestedString(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
  issues: SchemaIssue[],
  maxChars: number,
  requireNonblank: boolean,
): string | undefined {
  const value = record[key];
  const path = `${parentPath}.${key}`;
  if (typeof value !== 'string') {
    issues.push({ path, message: `${key} must be a string` });
    return undefined;
  }
  if (requireNonblank && value.trim().length === 0) issues.push({ path, message: `${key} must not be blank` });
  if (value.length > maxChars) issues.push({ path, message: `${key} must be at most ${String(maxChars)} characters` });
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  issues: SchemaIssue[],
  maxItems: number,
  maxItemChars: number,
  options: { forbidNul?: boolean } = {},
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push({ path: key, message: `${key} must be an array` });
    return undefined;
  }
  if (value.length > maxItems) issues.push({ path: key, message: `${key} must contain at most ${String(maxItems)} items` });

  const result: string[] = [];
  value.forEach((item, index) => {
    const path = `${key}[${String(index)}]`;
    if (typeof item !== 'string') {
      issues.push({ path, message: `${key} items must be strings` });
      return;
    }
    result.push(item);
    if (item.trim().length === 0) issues.push({ path, message: `${key} items must not be blank` });
    if (item.length > maxItemChars) issues.push({ path, message: `${key} items must be at most ${String(maxItemChars)} characters` });
    if (options.forbidNul === true && item.includes('\0')) issues.push({ path, message: `${key} items must not contain NUL` });
  });
  return result;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  parentPath: string,
  issues: SchemaIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: parentPath === '$' ? '$.*' : `${parentPath}.*`, message: 'Unknown field' });
    }
  }
}

function addDuplicateIssues(values: readonly string[], path: string, label: string, issues: SchemaIssue[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push({ path: `${path}[${String(index)}]`, message: `Duplicate ${label}` });
    seen.add(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
