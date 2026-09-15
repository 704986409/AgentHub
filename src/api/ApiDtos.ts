import { TaskComplexity, TaskRisk, type Agent, type AgentHubEvent,
  type Assignment, type Project, type Task } from '../core/types.js';
import type { TaskLifecycleReviewResult, TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import type { CreateTaskInput } from '../repositories/interfaces.js';
import type { DomainEvent } from '../events/event-bus.js';
import { redactEventValue } from '../events/event-redaction.js';
import type { ReviewDecisionInput, ReviewFindingInput, ReviewFindingSeverity, ReviewVerdict } from '../workspace/index.js';
import { apiError } from './ApiErrors.js';

const encoder = new TextEncoder();
const forbiddenPublicKeys = new Set(['repositoryroot', 'worktreepath', 'gitdir', 'cwd', 'env',
  'environment', 'executable', 'sessionid', 'profilehash', 'executionprofilesha256']);

export interface ExecuteCommandSnapshot {
  readonly baseRef: string;
  readonly prompt: string;
}
export interface ReviewDecisionSnapshot {
  readonly decision: ReviewDecisionInput;
  readonly allowNoChangeCompletion: boolean;
}

export function projectDto(value: Project) {
  return frozen({ projectId: value.id, name: value.name, description: value.description,
    createdAt: value.createdAt, updatedAt: value.updatedAt });
}
export function agentDto(value: Agent) {
  return frozen({ agentId: value.id, projectId: value.projectId, name: value.name, providerId: value.provider,
    position: value.position, status: value.status, allowedComplexities: [...value.allowedComplexities],
    allowedRiskLevels: [...value.allowedRiskLevels], capabilities: [...value.capabilities],
    specialties: [...value.specialties], authority: value.authority, routingPriority: value.routingPriority,
    enabled: value.enabled, createdAt: value.createdAt, updatedAt: value.updatedAt });
}
export function taskDto(value: Task) {
  return frozen({ taskId: value.id, projectId: value.projectId, title: value.title, description: value.description,
    requiredCapabilities: [...value.requiredCapabilities], requiredSpecialties: [...value.requiredSpecialties],
    acceptanceCriteria: [...value.acceptanceCriteria], complexity: value.complexity, risk: value.risk,
    status: value.status, assignedAgentId: value.assignedAgentId, assignmentId: value.assignmentId,
    createdAt: value.createdAt, updatedAt: value.updatedAt });
}
export function assignmentDto(value: Assignment) {
  return frozen({ assignmentId: value.id, taskId: value.taskId, agentId: value.agentId,
    specVersion: value.specVersion, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt });
}
export function eventDto(value: AgentHubEvent | DomainEvent) {
  return frozen({ eventId: value.eventId, eventType: value.eventType, timestamp: value.timestamp,
    projectId: value.projectId ?? null, agentId: value.agentId ?? null, taskId: value.taskId ?? null,
    assignmentId: value.assignmentId ?? null, actor: value.actor ?? null,
    oldStatus: value.oldStatus ?? null, newStatus: value.newStatus ?? null,
    payload: publicValue(redactEventValue(value.payload ?? {})) });
}

export function reviewReadyDto(bundle: Readonly<TaskReviewBundle>) {
  const patch = bundle.source.committed.patch;
  return frozen({ outcome: 'review-ready' as const, reviewHandle: bundle.reviewBundleSha256,
    reviewBundleSha256: bundle.reviewBundleSha256, taskId: bundle.taskId, assignmentId: bundle.assignmentId,
    agentId: bundle.agentId, providerId: bundle.providerId,
    workerResult: { summary: bundle.workerResult.summary, blockers: [...bundle.workerResult.blockers],
      questions: [...bundle.workerResult.questions], risks: [...bundle.workerResult.risks], notes: [...bundle.workerResult.notes] },
    source: { branchName: bundle.source.branchName, baseCommit: bundle.source.baseCommit,
      headCommit: bundle.source.headCommit, changedPaths: [...bundle.source.changedPaths],
      changeSetSha256: bundle.source.changeSetSha256,
      committedPatch: patch.status === 'captured' ? patch.text : undefined },
    buildTest: { build: bundle.buildTestEvidence.build, test: bundle.buildTestEvidence.test,
      outcome: bundle.buildTestEvidence.outcome,
      commands: bundle.buildTestEvidence.commands.map((command) => ({ id: command.commandId, phase: command.phase,
        outcome: command.outcome, exitCode: command.exitCode,
        stdoutPreview: command.stdout.preview, stderrPreview: command.stderr.preview })) },
    evidenceSha256: bundle.buildTestEvidence.evidenceSha256 });
}

export function lifecycleDto(result: Readonly<TaskLifecycleReviewResult>): unknown {
  if (result.outcome === 'review-ready') return reviewReadyDto(result.reviewBundle);
  const record = result as unknown as Record<string, unknown>;
  return frozen({ outcome: result.outcome, taskId: record.taskId, assignmentId: record.assignmentId,
    lifecycleSha256: result.lifecycleSha256,
    reviewEvidenceSha256: isRecord(record.reviewEvidence)
      ? record.reviewEvidence.reviewEvidenceSha256 : undefined,
    merge: isRecord(record.mergeResult) ? publicValue(record.mergeResult) : undefined,
    mergeGate: isRecord(record.mergeGate) ? publicValue(record.mergeGate) : undefined });
}

export function snapshotCreateTask(value: unknown): Readonly<CreateTaskInput> {
  const record = exactRecord(value, ['projectId', 'title', 'description', 'requiredCapabilities',
    'requiredSpecialties', 'acceptanceCriteria', 'complexity', 'risk']);
  const projectId = boundedText(record.projectId, 256, true);
  const title = boundedText(record.title, 16 * 1024, true);
  const description = record.description === undefined || record.description === null
    ? null : boundedText(record.description, 128 * 1024, false);
  const requiredCapabilities = stringArray(record.requiredCapabilities, 256, 512);
  const requiredSpecialties = stringArray(record.requiredSpecialties, 256, 512);
  const acceptanceCriteria = stringArray(record.acceptanceCriteria, 256, 8192);
  if (!Object.values(TaskComplexity).includes(record.complexity as TaskComplexity) ||
    !Object.values(TaskRisk).includes(record.risk as TaskRisk)) invalid();
  return frozen({ projectId, title, description, requiredCapabilities, requiredSpecialties,
    acceptanceCriteria, complexity: record.complexity as TaskComplexity, risk: record.risk as TaskRisk });
}

export function snapshotExecuteCommand(value: unknown): Readonly<ExecuteCommandSnapshot> {
  const record = exactRecord(value, ['baseRef', 'prompt']);
  const baseRef = boundedText(record.baseRef, 1024, true);
  const prompt = boundedText(record.prompt, 1024 * 1024, true);
  if (/[\0\r\n]/u.test(baseRef)) invalid();
  return frozen({ baseRef, prompt });
}

export function snapshotReviewDecision(value: unknown): Readonly<ReviewDecisionSnapshot> {
  const record = exactRecord(value, ['reviewId', 'reviewerId', 'verdict', 'summary', 'findings',
    'allowNoChangeCompletion']);
  const reviewId = boundedText(record.reviewId, 128, true);
  const reviewerId = boundedText(record.reviewerId, 128, true);
  const summary = boundedText(record.summary, 16 * 1024, false);
  const verdicts: readonly ReviewVerdict[] = ['ACCEPT', 'REQUEST_REVISION', 'BLOCK'];
  if (!verdicts.includes(record.verdict as ReviewVerdict)) invalid();
  const findingsRaw = record.findings ?? [];
  if (!Array.isArray(findingsRaw) || findingsRaw.length > 256) invalid();
  const findings = findingsRaw.map(snapshotFinding);
  if (record.allowNoChangeCompletion !== undefined && typeof record.allowNoChangeCompletion !== 'boolean') invalid();
  return frozen({ decision: { reviewId, reviewerId, verdict: record.verdict as ReviewVerdict, summary, findings },
    allowNoChangeCompletion: record.allowNoChangeCompletion === true });
}

function snapshotFinding(value: unknown): ReviewFindingInput {
  const record = exactRecord(value, ['code', 'severity', 'message', 'path']);
  const severities: readonly ReviewFindingSeverity[] = ['info', 'warning', 'error', 'blocker'];
  if (!severities.includes(record.severity as ReviewFindingSeverity)) invalid();
  const findingPath = record.path === undefined ? undefined : boundedText(record.path, 4096, true);
  if (findingPath !== undefined && (/^(?:[A-Za-z]:|[/\\])/u.test(findingPath) ||
    findingPath.replaceAll('\\', '/').split('/').some((part) => part === '..'))) invalid();
  return frozen({ code: boundedText(record.code, 128, true), severity: record.severity as ReviewFindingSeverity,
    message: boundedText(record.message, 8192, false), ...(findingPath === undefined ? {} : { path: findingPath }) });
}

function publicValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => publicValue(item, depth + 1));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!forbiddenPublicKeys.has(key.toLowerCase())) output[key] = publicValue(child, depth + 1);
  }
  return output;
}
function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
  return value;
}
function boundedText(value: unknown, maxBytes: number, nonBlank: boolean): string {
  if (typeof value !== 'string' || value.includes('\0') || encoder.encode(value).byteLength > maxBytes ||
    (nonBlank && value.trim().length === 0)) invalid();
  return value;
}
function stringArray(value: unknown, maxItems: number, maxItemBytes: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  return value.map((item) => boundedText(item, maxItemBytes, true));
}
function invalid(): never { throw apiError('AGENTHUB_API_INVALID_REQUEST', 400); }
function frozen<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
