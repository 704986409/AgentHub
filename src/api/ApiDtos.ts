import { AgentAuthority, TaskComplexity, TaskRisk, type Agent, type AgentHubEvent,
  type Assignment, type Project, type Task } from '../core/types.js';
import type { TaskLifecycleReviewResult, TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import type { CreateTaskInput } from '../repositories/interfaces.js';
import type { DomainEvent } from '../events/event-bus.js';
import { redactEventValue } from '../events/event-redaction.js';
import type { ReviewDecisionInput, ReviewFindingInput, ReviewFindingSeverity, ReviewVerdict } from '../workspace/index.js';
import type { CreateManagedAgentInput, UpdateManagedAgentInput, AgentDeleteResult } from '../services/agent-management-service.js';
import type { ProviderDto } from '../services/provider-catalog-service.js';
import { apiError } from './ApiErrors.js';
import type { CreateIntakeInput, CreatePlanInput, CreatePlanRevisionInput, PlanDecisionInput, PlanStartInput } from '../lifecycle/plan-lifecycle.js';

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
    modelId: value.model, position: value.position, status: value.status, allowedComplexities: [...value.allowedComplexities],
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

export function agentDeleteDto(value: AgentDeleteResult) {
  return frozen({ agentId: value.agentId, deleted: true as const });
}

export function snapshotCreateAgent(value: unknown): Readonly<CreateManagedAgentInput> {
  const record = exactRecord(value, ['projectId', 'name', 'providerId', 'modelId', 'position',
    'allowedComplexities', 'allowedRiskLevels', 'capabilities', 'specialties', 'authority',
    'routingPriority', 'enabled']);
  if (typeof record.enabled !== 'boolean') invalid();
  return frozen({
    projectId: nullableProjectId(record.projectId),
    name: exactBoundedText(record.name, 256),
    providerId: exactBoundedText(record.providerId, 128),
    modelId: exactBoundedText(record.modelId, 512),
    position: exactBoundedText(record.position, 256),
    allowedComplexities: enumArray(record.allowedComplexities, Object.values(TaskComplexity)),
    allowedRiskLevels: enumArray(record.allowedRiskLevels, Object.values(TaskRisk)),
    capabilities: uniqueStringArray(record.capabilities, 256, 512),
    specialties: uniqueStringArray(record.specialties, 256, 512),
    authority: exactEnum(record.authority, Object.values(AgentAuthority)),
    routingPriority: exactPriority(record.routingPriority),
    enabled: record.enabled,
  });
}

export function snapshotUpdateAgent(value: unknown): Readonly<UpdateManagedAgentInput> {
  const record = exactRecord(value, ['name', 'providerId', 'modelId', 'position',
    'allowedComplexities', 'allowedRiskLevels', 'capabilities', 'specialties', 'authority',
    'routingPriority']);
  return frozen({
    name: exactBoundedText(record.name, 256),
    providerId: exactBoundedText(record.providerId, 128),
    modelId: exactBoundedText(record.modelId, 512),
    position: exactBoundedText(record.position, 256),
    allowedComplexities: enumArray(record.allowedComplexities, Object.values(TaskComplexity)),
    allowedRiskLevels: enumArray(record.allowedRiskLevels, Object.values(TaskRisk)),
    capabilities: uniqueStringArray(record.capabilities, 256, 512),
    specialties: uniqueStringArray(record.specialties, 256, 512),
    authority: exactEnum(record.authority, Object.values(AgentAuthority)),
    routingPriority: exactPriority(record.routingPriority),
  });
}

export function snapshotEmptyObject(value: unknown): Readonly<Record<string, never>> {
  exactRecord(value, []);
  return frozen({});
}

export function snapshotCreateIntake(value: unknown): Readonly<CreateIntakeInput> {
  const r=exactRecord(value,['projectId','createdBy','goal','leadAgentId']);
  return frozen({projectId:exactBoundedText(r.projectId,256),createdBy:exactBoundedText(r.createdBy,256),goal:boundedText(r.goal,128*1024,true),leadAgentId:exactBoundedText(r.leadAgentId,256)});
}
export function snapshotCreatePlan(value: unknown): Readonly<CreatePlanInput> {
  const r=exactRecord(value,['intakeId','leadAgentId','summary','tasks','dependencies']);
  return frozen({intakeId:exactBoundedText(r.intakeId,256),leadAgentId:exactBoundedText(r.leadAgentId,256),summary:boundedText(r.summary,16*1024,true),tasks:snapshotPlanTasks(r.tasks),dependencies:snapshotPlanDependencies(r.dependencies)});
}
export function snapshotCreatePlanRevision(value: unknown): Readonly<CreatePlanRevisionInput> {
  const r=exactRecord(value,['basedOnVersion','leadAgentId','summary','tasks','dependencies']);
  return frozen({basedOnVersion:positiveVersion(r.basedOnVersion),leadAgentId:exactBoundedText(r.leadAgentId,256),summary:boundedText(r.summary,16*1024,true),tasks:snapshotPlanTasks(r.tasks),dependencies:snapshotPlanDependencies(r.dependencies)});
}
export function snapshotPlanDecision(value: unknown): Readonly<PlanDecisionInput> {
  const r=exactRecord(value,['planVersion','proposalHash','actorId','summary']);
  const proposalHash=exactBoundedText(r.proposalHash,64); if(!/^[a-f0-9]{64}$/u.test(proposalHash))invalid();
  return frozen({planVersion:positiveVersion(r.planVersion),proposalHash,actorId:exactBoundedText(r.actorId,256),summary:boundedText(r.summary,16*1024,false)});
}
export function snapshotPlanStart(value: unknown): Readonly<PlanStartInput> {
  const r=exactRecord(value,['planVersion','proposalHash']); const proposalHash=exactBoundedText(r.proposalHash,64); if(!/^[a-f0-9]{64}$/u.test(proposalHash))invalid(); return frozen({planVersion:positiveVersion(r.planVersion),proposalHash});
}
function snapshotPlanTasks(value:unknown):CreatePlanInput['tasks'] { if(!Array.isArray(value)||value.length<1||value.length>1000)invalid(); return Object.freeze(value.map((item)=>{const r=exactRecord(item,['clientId','parentClientId','title','description','acceptanceCriteria','requiredCapabilities','requiredSpecialties','complexity','risk']);if(r.parentClientId!==null&&typeof r.parentClientId!=='string')invalid();if(r.description!==null&&typeof r.description!=='string')invalid();if(!Object.values(TaskComplexity).includes(r.complexity as TaskComplexity)||!Object.values(TaskRisk).includes(r.risk as TaskRisk))invalid();return frozen({clientId:exactBoundedText(r.clientId,256),parentClientId:r.parentClientId===null?null:exactBoundedText(r.parentClientId,256),title:boundedText(r.title,16*1024,true),description:r.description===null?null:boundedText(r.description,128*1024,false),acceptanceCriteria:stringArray(r.acceptanceCriteria,256,8192),requiredCapabilities:stringArray(r.requiredCapabilities,256,512),requiredSpecialties:stringArray(r.requiredSpecialties,256,512),complexity:r.complexity as TaskComplexity,risk:r.risk as TaskRisk});})); }
function snapshotPlanDependencies(value:unknown):CreatePlanInput['dependencies'] { if(!Array.isArray(value)||value.length>4000)invalid(); return Object.freeze(value.map((item)=>{const r=exactRecord(item,['prerequisiteClientId','dependentClientId']);return frozen({prerequisiteClientId:exactBoundedText(r.prerequisiteClientId,256),dependentClientId:exactBoundedText(r.dependentClientId,256)});})); }
function positiveVersion(value:unknown):number { if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)invalid();return value; }

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
function exactBoundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.includes('\0') || encoder.encode(value).byteLength > maxBytes ||
    value.trim().length === 0 || value !== value.trim()) invalid();
  return value;
}
function nullableProjectId(value: unknown): string | null {
  if (value === null) return null;
  return exactBoundedText(value, 256);
}
function exactEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid();
  return value as T;
}
function exactPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length > 256) invalid();
  const items = value.map((item) => exactEnum(item, allowed));
  if (new Set(items).size !== items.length) invalid();
  return items;
}
function uniqueStringArray(value: unknown, maxItems: number, maxItemBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  const items = value.map((item) => exactBoundedText(item, maxItemBytes));
  if (new Set(items).size !== items.length) invalid();
  return items;
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

export function providerDto(value: ProviderDto): Readonly<ProviderDto> {
  return frozen({
    providerId: value.providerId,
    supported: true,
    usable: value.usable,
    installed: value.installed,
    authenticated: value.authenticated,
    version: value.version,
    status: value.status,
    capabilities: frozen({
      outputProtocols: frozen([...value.capabilities.outputProtocols]),
      sessionContinuation: value.capabilities.sessionContinuation,
    }),
    modelDiscovery: value.modelDiscovery,
    models: frozen(value.models.map((m) => frozen({ modelId: m.modelId, label: m.label }))),
    checkedAt: value.checkedAt,
  });
}
