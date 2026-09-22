import { createHash } from 'node:crypto';

import { AgentAuthority, AgentStatus, TaskComplexity, TaskRisk, type Agent, type Task } from '../core/types.js';
import { agentOutputProtocols, type AgentOutputProtocol } from '../runtime/providers/AgentProvider.js';

const maxAgents = 10_000;
const maxProviders = 256;
const maxTaskTokens = 256;
const maxAgentTokens = 512;
const maxProviderProtocols = 32;
const maxExcludedAgents = 64;
const maxTokenBytes = 256;
const encoder = new TextEncoder();
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export interface ProviderRoutingCapabilities {
  readonly providerId: string;
  readonly outputProtocols: readonly AgentOutputProtocol[];
}

export interface TaskRoutingRequirements {
  readonly minimumAuthority?: AgentAuthority;
  readonly requiredOutputProtocols?: readonly AgentOutputProtocol[];
  readonly excludedAgentIds?: readonly string[];
}

export interface TaskRoutingRequest {
  readonly task: Task;
  readonly agents: readonly Agent[];
  readonly providerCapabilities: readonly ProviderRoutingCapabilities[];
  readonly requirements?: TaskRoutingRequirements;
}

export type TaskRouteRejectReason =
  | 'AGENT_DISABLED'
  | 'PROJECT_MISMATCH'
  | 'COMPLEXITY_UNSUPPORTED'
  | 'RISK_UNSUPPORTED'
  | 'MISSING_CAPABILITY'
  | 'MISSING_SPECIALTY'
  | 'AUTHORITY_INSUFFICIENT'
  | 'PROVIDER_UNAVAILABLE'
  | 'OUTPUT_PROTOCOL_UNSUPPORTED'
  | 'AGENT_EXCLUDED';

export interface TaskRouteCandidate {
  readonly rank: number;
  readonly agentId: string;
  readonly providerId: string;
  readonly routingPriority: number;
  readonly scope: 'project' | 'global';
}

export interface TaskRouteRejection {
  readonly agentId: string;
  readonly providerId: string;
  readonly reasons: readonly TaskRouteRejectReason[];
}

export interface TaskRoutePlan {
  readonly version: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
  readonly candidates: readonly TaskRouteCandidate[];
  readonly rejected: readonly TaskRouteRejection[];
  readonly routePlanSha256: string;
}

export type TaskRouterErrorCode =
  | 'TASK_ROUTER_INVALID_REQUEST'
  | 'TASK_ROUTER_DUPLICATE_AGENT'
  | 'TASK_ROUTER_DUPLICATE_PROVIDER'
  | 'TASK_ROUTER_LIMIT_EXCEEDED';

export class TaskRouterError extends Error {
  public constructor(public readonly code: TaskRouterErrorCode) {
    super(routerErrorMessage(code));
    this.name = 'TaskRouterError';
  }
}

interface TaskRoutingSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly requiredCapabilities: readonly string[];
  readonly requiredSpecialties: readonly string[];
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
}

interface AgentRoutingSnapshot {
  readonly id: string;
  readonly projectId: string | null;
  readonly provider: string;
  readonly status: AgentStatus;
  readonly allowedComplexities: readonly TaskComplexity[];
  readonly allowedRiskLevels: readonly TaskRisk[];
  readonly capabilities: readonly string[];
  readonly specialties: readonly string[];
  readonly authority: AgentAuthority;
  readonly routingPriority: number;
  readonly enabled: boolean;
}

interface ProviderRoutingSnapshot {
  readonly providerId: string;
  readonly outputProtocols: readonly AgentOutputProtocol[];
}

interface RequirementsSnapshot {
  readonly minimumAuthority: AgentAuthority | null;
  readonly requiredOutputProtocols: readonly AgentOutputProtocol[];
  readonly excludedAgentIds: readonly string[];
}

interface RequestSnapshot {
  readonly task: TaskRoutingSnapshot;
  readonly agents: readonly AgentRoutingSnapshot[];
  readonly providers: readonly ProviderRoutingSnapshot[];
  readonly requirements: RequirementsSnapshot;
}

interface CanonicalTaskRouteIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
  readonly requiredCapabilities: readonly string[];
  readonly requiredSpecialties: readonly string[];
}

interface CanonicalStaticAgentRouteIdentity {
  readonly id: string;
  readonly projectId: string | null;
  readonly provider: string;
  readonly staticallyEnabled: boolean;
  readonly allowedComplexities: readonly TaskComplexity[];
  readonly allowedRiskLevels: readonly TaskRisk[];
  readonly capabilities: readonly string[];
  readonly specialties: readonly string[];
  readonly authority: AgentAuthority;
  readonly routingPriority: number;
}

interface CanonicalProviderRouteIdentity {
  readonly providerId: string;
  readonly outputProtocols: readonly AgentOutputProtocol[];
}

interface CanonicalRoutingRequirements {
  readonly minimumAuthority: AgentAuthority | null;
  readonly requiredOutputProtocols: readonly AgentOutputProtocol[];
  readonly excludedAgentIds: readonly string[];
}

const authorityRank: Readonly<Record<AgentAuthority, number>> = Object.freeze({
  [AgentAuthority.READ_ONLY]: 0,
  [AgentAuthority.STANDARD]: 1,
  [AgentAuthority.PRIVILEGED]: 2,
  [AgentAuthority.ADMIN]: 3,
});

export class TaskRouter {
  public route(request: TaskRoutingRequest): TaskRoutePlan {
    let snapshot: RequestSnapshot;
    try { snapshot = snapshotRequest(request); }
    catch (error) {
      if (error instanceof TaskRouterError) throw error;
      throw new TaskRouterError('TASK_ROUTER_INVALID_REQUEST');
    }
    const providers = new Map(snapshot.providers.map((provider) => [provider.providerId, provider]));
    const eligible: Omit<TaskRouteCandidate, 'rank'>[] = [];
    const rejected: TaskRouteRejection[] = [];

    for (const agent of snapshot.agents) {
      const descriptor = providers.get(agent.provider);
      const reasons = rejectReasons(snapshot.task, agent, descriptor, snapshot.requirements);
      if (reasons.length === 0) {
        eligible.push({
          agentId: agent.id,
          providerId: agent.provider,
          routingPriority: agent.routingPriority,
          scope: agent.projectId === null ? 'global' : 'project',
        });
      } else {
        rejected.push({ agentId: agent.id, providerId: agent.provider, reasons });
      }
    }

    eligible.sort((left, right) =>
      right.routingPriority - left.routingPriority ||
      scopeRank(right.scope) - scopeRank(left.scope) ||
      compare(left.agentId, right.agentId));
    rejected.sort((left, right) => compare(left.agentId, right.agentId));
    const candidates = eligible.map((candidate, index) => ({ rank: index + 1, ...candidate }));
    const digestInput = {
      version: 1,
      task: canonicalTaskRouteIdentity(snapshot.task),
      requirements: canonicalRoutingRequirements(snapshot.requirements),
      providers: snapshot.providers
        .map(canonicalProviderRouteIdentity)
        .sort((left, right) => compare(left.providerId, right.providerId)),
      agents: snapshot.agents
        .map(canonicalAgentRouteIdentity)
        .sort((left, right) => compare(left.id, right.id)),
      candidates,
      rejected,
    };
    const routePlanSha256 = createHash('sha256')
      .update(`AgentHub.TaskRoutePlan.v1\0${canonicalJson(digestInput)}`)
      .digest('hex');
    return deepFreeze({
      version: 1,
      taskId: snapshot.task.id,
      projectId: snapshot.task.projectId,
      complexity: snapshot.task.complexity,
      risk: snapshot.task.risk,
      candidates,
      rejected,
      routePlanSha256,
    });
  }
}

function snapshotRequest(value: unknown): RequestSnapshot {
  if (!isRecord(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  const taskValue = value.task;
  const task = snapshotTask(taskValue);
  const agentsValue = value.agents;
  const agents = snapshotArray(agentsValue, maxAgents).map(snapshotAgent);
  rejectDuplicateIdentities(agents.map((agent) => agent.id), 'TASK_ROUTER_DUPLICATE_AGENT');
  const providerCapabilitiesValue = value.providerCapabilities;
  const providers = snapshotArray(providerCapabilitiesValue, maxProviders).map(snapshotProvider);
  rejectDuplicateIdentities(providers.map((provider) => provider.providerId), 'TASK_ROUTER_DUPLICATE_PROVIDER');
  const requirementsValue = value.requirements;
  const requirements = snapshotRequirements(requirementsValue);
  return deepFreeze({ task, agents, providers, requirements });
}

function snapshotTask(value: unknown): TaskRoutingSnapshot {
  if (!isRecord(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  const id = token(value.id);
  const projectId = token(value.projectId);
  const requiredCapabilities = stringSet(value.requiredCapabilities, maxTaskTokens);
  const requiredSpecialties = stringSet(value.requiredSpecialties, maxTaskTokens);
  const complexity = enumValue(value.complexity, Object.values(TaskComplexity));
  const risk = enumValue(value.risk, Object.values(TaskRisk));
  return deepFreeze({
    id,
    projectId,
    requiredCapabilities,
    requiredSpecialties,
    complexity,
    risk,
  });
}

function snapshotAgent(value: unknown): AgentRoutingSnapshot {
  if (!isRecord(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  const id = token(value.id);
  const projectIdValue = value.projectId;
  if (projectIdValue !== null && typeof projectIdValue !== 'string') fail('TASK_ROUTER_INVALID_REQUEST');
  const projectId = projectIdValue === null ? null : token(projectIdValue);
  const provider = token(value.provider);
  const status = enumValue(value.status, Object.values(AgentStatus));
  const allowedComplexities = enumSet(value.allowedComplexities, Object.values(TaskComplexity), 32);
  const allowedRiskLevels = enumSet(value.allowedRiskLevels, Object.values(TaskRisk), 32);
  const capabilities = stringSet(value.capabilities, maxAgentTokens);
  const specialties = stringSet(value.specialties, maxAgentTokens);
  const authority = enumValue(value.authority, Object.values(AgentAuthority));
  const routingPriorityValue = value.routingPriority;
  const enabledValue = value.enabled;
  if (typeof routingPriorityValue !== 'number' || !Number.isSafeInteger(routingPriorityValue) ||
    typeof enabledValue !== 'boolean') {
    fail('TASK_ROUTER_INVALID_REQUEST');
  }
  return deepFreeze({
    id,
    projectId,
    provider,
    status,
    allowedComplexities,
    allowedRiskLevels,
    capabilities,
    specialties,
    authority,
    routingPriority: routingPriorityValue,
    enabled: enabledValue,
  });
}

function snapshotProvider(value: unknown): ProviderRoutingSnapshot {
  if (!isRecord(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  const providerId = token(value.providerId);
  const outputProtocols = enumSet(value.outputProtocols, agentOutputProtocols, maxProviderProtocols);
  return deepFreeze({
    providerId,
    outputProtocols,
  });
}

function snapshotRequirements(value: unknown): RequirementsSnapshot {
  if (value === undefined) {
    return deepFreeze({ minimumAuthority: null, requiredOutputProtocols: [], excludedAgentIds: [] });
  }
  if (!isRecord(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  const minimumAuthorityValue = value.minimumAuthority;
  const minimumAuthority = minimumAuthorityValue === undefined
    ? null
    : enumValue(minimumAuthorityValue, Object.values(AgentAuthority));
  const requiredOutputProtocolsValue = value.requiredOutputProtocols;
  const requiredOutputProtocols = requiredOutputProtocolsValue === undefined
    ? []
    : enumSet(requiredOutputProtocolsValue, agentOutputProtocols, maxProviderProtocols);
  const excludedAgentIds = snapshotExcludedAgentIds(value.excludedAgentIds);
  return deepFreeze({
    minimumAuthority,
    requiredOutputProtocols,
    excludedAgentIds,
  });
}

function snapshotExcludedAgentIds(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  if (value.length > maxExcludedAgents) fail('TASK_ROUTER_LIMIT_EXCEEDED');
  const ids = value.map((entry) => {
    const id = token(entry);
    if (id !== id.trim()) fail('TASK_ROUTER_INVALID_REQUEST');
    return id;
  });
  if (new Set(ids).size !== ids.length) fail('TASK_ROUTER_INVALID_REQUEST');
  return Object.freeze([...ids].sort(compare));
}

function canonicalTaskRouteIdentity(task: TaskRoutingSnapshot): CanonicalTaskRouteIdentity {
  return {
    id: task.id,
    projectId: task.projectId,
    complexity: task.complexity,
    risk: task.risk,
    requiredCapabilities: task.requiredCapabilities,
    requiredSpecialties: task.requiredSpecialties,
  };
}

function canonicalAgentRouteIdentity(agent: AgentRoutingSnapshot): CanonicalStaticAgentRouteIdentity {
  return {
    id: agent.id,
    projectId: agent.projectId,
    provider: agent.provider,
    staticallyEnabled: agent.enabled && agent.status !== AgentStatus.DISABLED,
    allowedComplexities: agent.allowedComplexities,
    allowedRiskLevels: agent.allowedRiskLevels,
    capabilities: agent.capabilities,
    specialties: agent.specialties,
    authority: agent.authority,
    routingPriority: agent.routingPriority,
  };
}

function canonicalProviderRouteIdentity(provider: ProviderRoutingSnapshot): CanonicalProviderRouteIdentity {
  return {
    providerId: provider.providerId,
    outputProtocols: provider.outputProtocols,
  };
}

function canonicalRoutingRequirements(requirements: RequirementsSnapshot): CanonicalRoutingRequirements {
  return {
    minimumAuthority: requirements.minimumAuthority,
    requiredOutputProtocols: requirements.requiredOutputProtocols,
    excludedAgentIds: requirements.excludedAgentIds,
  };
}

function rejectReasons(
  task: TaskRoutingSnapshot,
  agent: AgentRoutingSnapshot,
  provider: ProviderRoutingSnapshot | undefined,
  requirements: RequirementsSnapshot,
): readonly TaskRouteRejectReason[] {
  const reasons: TaskRouteRejectReason[] = [];
  if (!agent.enabled || agent.status === AgentStatus.DISABLED) reasons.push('AGENT_DISABLED');
  if (agent.projectId !== null && agent.projectId !== task.projectId) reasons.push('PROJECT_MISMATCH');
  if (!agent.allowedComplexities.includes(task.complexity)) reasons.push('COMPLEXITY_UNSUPPORTED');
  if (!agent.allowedRiskLevels.includes(task.risk)) reasons.push('RISK_UNSUPPORTED');
  if (!containsAll(agent.capabilities, task.requiredCapabilities)) reasons.push('MISSING_CAPABILITY');
  if (!containsAll(agent.specialties, task.requiredSpecialties)) reasons.push('MISSING_SPECIALTY');
  if (requirements.minimumAuthority !== null &&
    authorityRank[agent.authority] < authorityRank[requirements.minimumAuthority]) {
    reasons.push('AUTHORITY_INSUFFICIENT');
  }
  if (provider === undefined) reasons.push('PROVIDER_UNAVAILABLE');
  if (requirements.requiredOutputProtocols.length > 0 &&
    (provider === undefined || !containsAll(provider.outputProtocols, requirements.requiredOutputProtocols))) {
    reasons.push('OUTPUT_PROTOCOL_UNSUPPORTED');
  }
  if (requirements.excludedAgentIds.includes(agent.id)) reasons.push('AGENT_EXCLUDED');
  return Object.freeze(reasons);
}

function containsAll<T>(available: readonly T[], required: readonly T[]): boolean {
  const values = new Set(available);
  return required.every((value) => values.has(value));
}

function scopeRank(scope: TaskRouteCandidate['scope']): number { return scope === 'project' ? 1 : 0; }

function snapshotArray(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value)) fail('TASK_ROUTER_INVALID_REQUEST');
  if (value.length > limit) fail('TASK_ROUTER_LIMIT_EXCEEDED');
  return Array.from(value);
}

function stringSet(value: unknown, limit: number): readonly string[] {
  return Object.freeze([...new Set(snapshotArray(value, limit).map(token))].sort(compare));
}

function enumSet<T extends string>(value: unknown, allowed: readonly T[], limit: number): readonly T[] {
  return Object.freeze([...new Set(snapshotArray(value, limit).map((entry) => enumValue(entry, allowed)))].sort(compare));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail('TASK_ROUTER_INVALID_REQUEST');
  return value as T;
}

function token(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('TASK_ROUTER_INVALID_REQUEST');
  if (encoder.encode(value).byteLength > maxTokenBytes) fail('TASK_ROUTER_LIMIT_EXCEEDED');
  return value;
}

function rejectDuplicateIdentities(values: readonly string[], code: TaskRouterErrorCode): void {
  if (new Set(values).size !== values.length) fail(code);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  fail('TASK_ROUTER_INVALID_REQUEST');
}

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: TaskRouterErrorCode): never { throw new TaskRouterError(code); }

function routerErrorMessage(code: TaskRouterErrorCode): string {
  const messages: Record<TaskRouterErrorCode, string> = {
    TASK_ROUTER_INVALID_REQUEST: 'Task routing request is invalid',
    TASK_ROUTER_DUPLICATE_AGENT: 'Task routing request contains a duplicate agent identity',
    TASK_ROUTER_DUPLICATE_PROVIDER: 'Task routing request contains a duplicate provider identity',
    TASK_ROUTER_LIMIT_EXCEEDED: 'Task routing request exceeds a resource limit',
  };
  return messages[code];
}
