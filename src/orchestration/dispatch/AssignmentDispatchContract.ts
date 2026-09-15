import { createHash } from 'node:crypto';

import { AgentHubWorkerResultSchema, validateAgentHubWorkerResultSemantics } from '../../protocol/AgentHubWorkerResult.js';
import { ManagerDirectiveSchema, validateManagerDirectiveSemantics } from '../../protocol/ManagerDirective.js';
import {
  agentOutputProtocols,
  type AgentOutputProtocol,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../../runtime/providers/AgentProvider.js';
import {
  snapshotAgentScheduleReservation,
  type AgentScheduleReservation,
} from '../AgentScheduler.js';

const encoder = new TextEncoder();
export const maxBaseRefBytes = 1024;
export const maxPromptBytes = 1024 * 1024;
export const maxTimeoutMs = 60 * 60 * 1000;
export const gitObjectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface AssignmentDispatchRequest {
  readonly reservation: AgentScheduleReservation;
  readonly baseRef: string;
  readonly turn: AgentProviderTurnRequest;
}

export interface AssignmentDispatchRequestSnapshot {
  readonly reservation: Readonly<AgentScheduleReservation>;
  readonly baseRef: string;
  readonly turn: Readonly<AgentProviderTurnRequest>;
}

export interface AssignmentDispatchWorkspace {
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly created: boolean;
}

export interface AssignmentDispatchResult {
  readonly version: 1;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly providerId: string;
  readonly assignmentId: string;
  readonly reservationSha256: string;
  readonly executionProfileSha256: string;
  readonly workspace: AssignmentDispatchWorkspace;
  readonly assignmentStatus: 'ACTIVE';
  readonly taskStatus: 'IMPLEMENTING';
  readonly turnResult: AgentProviderTurnResult;
  readonly dispatchSha256: string;
}
/**
 * Value-validates the dispatcher hand-off.  This is deliberately separate from
 * dispatch(): lifecycle code may receive the value from a queue, RPC boundary,
 * or a persisted test fixture rather than from the dispatcher itself.
 */
export function snapshotAssignmentDispatchResult(value: unknown): Readonly<AssignmentDispatchResult> {
  try {
    if (!isRecord(value)) throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    const keys = ['version', 'taskId', 'projectId', 'agentId', 'providerId', 'assignmentId',
      'reservationSha256', 'executionProfileSha256', 'workspace', 'assignmentStatus', 'taskStatus',
      'turnResult', 'dispatchSha256'];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    const strings = ['taskId', 'projectId', 'agentId', 'providerId', 'assignmentId',
      'reservationSha256', 'executionProfileSha256'] as const;
    if (value.version !== 1 || value.assignmentStatus !== 'ACTIVE' || value.taskStatus !== 'IMPLEMENTING' ||
      strings.some((key) => !isNonBlankString(value[key]) || (key.endsWith('Sha256') && !/^[0-9a-f]{64}$/u.test(value[key])))) {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    if (!isRecord(value.workspace)) throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    const workspace = value.workspace;
    const workspaceKeys = ['branchName', 'baseCommit', 'headCommit', 'created'];
    if (Object.keys(workspace).length !== workspaceKeys.length ||
      workspaceKeys.some((key) => !Object.prototype.hasOwnProperty.call(workspace, key)) ||
      !isNonBlankString(workspace.branchName) || !gitObjectIdPattern.test(workspace.baseCommit as string) ||
      !gitObjectIdPattern.test(workspace.headCommit as string) || typeof workspace.created !== 'boolean') {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    if (!isRecord(value.turnResult) || !agentOutputProtocols.includes(value.turnResult.protocol as AgentOutputProtocol)) {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    const turnResult = snapshotTurnResult(value.turnResult as unknown as AgentProviderTurnResult,
      value.turnResult.protocol as AgentOutputProtocol, value.providerId as string);
    const identity = {
      version: 1 as const,
      taskId: value.taskId as string,
      projectId: value.projectId as string,
      agentId: value.agentId as string,
      providerId: value.providerId as string,
      assignmentId: value.assignmentId as string,
      reservationSha256: value.reservationSha256 as string,
      executionProfileSha256: value.executionProfileSha256 as string,
      workspace: deepFreeze({ branchName: workspace.branchName, baseCommit: workspace.baseCommit as string,
        headCommit: workspace.headCommit as string, created: workspace.created }),
      assignmentStatus: 'ACTIVE' as const,
      taskStatus: 'IMPLEMENTING' as const,
      turnResult,
    };
    const digestInput = { ...identity, turnProtocol: turnResult.protocol, turnResult: turnResultForDigest(turnResult) };
    if (dispatchDigest(digestInput) !== value.dispatchSha256) {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    return deepFreeze({ ...identity, dispatchSha256: value.dispatchSha256 });
  } catch (error) {
    if (error instanceof AssignmentDispatcherError) throw error;
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
}

export type AssignmentDispatcherErrorCode =
  | 'AGENT_DISPATCH_INVALID_REQUEST'
  | 'AGENT_DISPATCH_TASK_BUSY'
  | 'AGENT_DISPATCH_INVALID_RESERVATION'
  | 'AGENT_DISPATCH_STALE_RESERVATION'
  | 'AGENT_DISPATCH_STALE_PROFILE'
  | 'AGENT_DISPATCH_RESERVATION_MISMATCH'
  | 'AGENT_DISPATCH_WORKSPACE_FAILED'
  | 'AGENT_DISPATCH_WORKSPACE_STALE'
  | 'AGENT_DISPATCH_ACCEPT_FAILED'
  | 'AGENT_DISPATCH_RUNTIME_START_FAILED'
  | 'AGENT_DISPATCH_ACTIVATION_FAILED'
  | 'AGENT_DISPATCH_TURN_FAILED'
  | 'AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION'
  | 'AGENT_DISPATCH_RECONCILIATION_REQUIRED'
  | 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED';

export class AssignmentDispatcherError extends Error {
  public constructor(public readonly code: AssignmentDispatcherErrorCode) {
    super(dispatchErrorMessage(code));
    this.name = 'AssignmentDispatcherError';
  }
}
export function snapshotDispatchRequest(request: AssignmentDispatchRequest): Readonly<AssignmentDispatchRequestSnapshot> {
  let reservationValue: unknown;
  let baseRef: unknown;
  let turnValue: unknown;
  try {
    if (!isRecord(request)) throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
    reservationValue = request.reservation;
    baseRef = request.baseRef;
    turnValue = request.turn;
  } catch {
    throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
  }
  const reservation = snapshotAgentScheduleReservation(reservationValue);
  if (reservation === null) throw dispatchError('AGENT_DISPATCH_INVALID_RESERVATION');
  try {
    if (typeof baseRef !== 'string' || baseRef.length === 0 || /[\0\r\n]/u.test(baseRef) ||
      encoder.encode(baseRef).byteLength > maxBaseRefBytes || !isRecord(turnValue)) {
      throw new TypeError('invalid dispatch request');
    }
    const prompt: unknown = turnValue.prompt;
    const protocol: unknown = turnValue.protocol;
    const timeoutMs: unknown = turnValue.timeoutMs;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 ||
      encoder.encode(prompt).byteLength > maxPromptBytes || typeof protocol !== 'string' ||
      !agentOutputProtocols.includes(protocol as AgentOutputProtocol) ||
      (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) ||
        typeof timeoutMs !== 'number' || timeoutMs <= 0 || timeoutMs > maxTimeoutMs))) {
      throw new TypeError('invalid dispatch turn');
    }
    return deepFreeze({
      reservation,
      baseRef,
      turn: {
        prompt,
        protocol: protocol as AgentOutputProtocol,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    });
  } catch {
    throw dispatchError('AGENT_DISPATCH_INVALID_REQUEST');
  }
}
export function snapshotAssignmentTurnResult(
  value: unknown,
  protocol: AgentOutputProtocol,
  providerId: string,
): AgentProviderTurnResult {
  if (!agentOutputProtocols.includes(protocol) || !isNonBlankString(providerId)) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  return snapshotTurnResult(value as AgentProviderTurnResult, protocol, providerId);
}

export function snapshotTurnResult(
  value: AgentProviderTurnResult,
  protocol: AgentOutputProtocol,
  providerId: string,
): AgentProviderTurnResult {
  if (!isRecord(value) || value.protocol !== protocol || value.providerId !== providerId ||
    (value.sessionId !== undefined && !isNonBlankString(value.sessionId)) ||
    (value.durationMs !== undefined && (typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0))) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  const metadataKeys = ['providerId', 'sessionId', 'durationMs'];
  const variantKeys = protocol === 'worker-result'
    ? (value.protocolValid === true ? ['protocol', 'protocolValid', 'workerResult'] : ['protocol', 'protocolValid', 'failure'])
    : (value.directiveStatus === 'invalid'
      ? ['protocol', 'directiveStatus', 'directive', 'failure']
      : ['protocol', 'directiveStatus', 'directive']);
  const allowedKeys = new Set([...metadataKeys, ...variantKeys]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  const metadata = {
    providerId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
  };
  if (protocol === 'worker-result') {
    if (value.protocol !== 'worker-result' || typeof value.protocolValid !== 'boolean') {
      throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
    }
    if (value.protocolValid) {
      const parsed = AgentHubWorkerResultSchema.safeParse(value.workerResult);
      if (!parsed.success || validateAgentHubWorkerResultSemantics(parsed.data).length > 0) {
        throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
      }
      return deepFreeze({ ...metadata, protocol, protocolValid: true as const, workerResult: parsed.data });
    }
    const failure = snapshotFailure(value.failure, workerFailureKinds);
    return deepFreeze({ ...metadata, protocol, protocolValid: false as const, failure });
  }
  if (value.protocol !== 'manager-directive' ||
    !['valid', 'repaired', 'invalid'].includes(value.directiveStatus)) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  if (value.directiveStatus === 'invalid') {
    const failure = snapshotFailure(value.failure, managerFailureKinds);
    return deepFreeze({ ...metadata, protocol, directiveStatus: 'invalid', directive: null, failure });
  }
  const parsed = ManagerDirectiveSchema.safeParse(value.directive);
  if (!parsed.success || validateManagerDirectiveSemantics(parsed.data).length > 0) {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  return deepFreeze({ ...metadata, protocol, directiveStatus: value.directiveStatus, directive: parsed.data });
}

const workerFailureKinds = new Set([
  'missing_result', 'multiple_results', 'result_too_large', 'malformed_json', 'schema_invalid', 'semantic_invalid',
]);
const managerFailureKinds = new Set([
  'missing_directive', 'multiple_directives', 'malformed_json', 'schema_invalid', 'semantic_invalid',
  'initial_turn_failed', 'repair_turn_failed',
]);

function snapshotFailure(value: unknown, kinds: ReadonlySet<string>): { readonly kind: never; readonly message: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'kind') || !Object.prototype.hasOwnProperty.call(value, 'message') ||
    typeof value.kind !== 'string' || !kinds.has(value.kind) || typeof value.message !== 'string') {
    throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
  }
  return deepFreeze({ kind: value.kind as never, message: value.message });
}
export function turnResultForDigest(result: AgentProviderTurnResult): unknown {
  const stable: Record<string, unknown> = { ...result };
  delete stable.durationMs;
  return stable;
}

export function dispatchDigest(value: unknown): string {
  return createHash('sha256')
    .update('AgentHub.AssignmentDispatch.v1\0' + canonicalJson(value))
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort(compare).map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw dispatchError('AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION');
}

export function deepFreeze<T>(value: T, seen = new WeakSet()): Readonly<T> {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function dispatchError(code: AssignmentDispatcherErrorCode): AssignmentDispatcherError {
  return new AssignmentDispatcherError(code);
}

function dispatchErrorMessage(code: AssignmentDispatcherErrorCode): string {
  const messages: Record<AssignmentDispatcherErrorCode, string> = {
    AGENT_DISPATCH_INVALID_REQUEST: 'Assignment dispatch request is invalid',
    AGENT_DISPATCH_TASK_BUSY: 'Task is already being dispatched',
    AGENT_DISPATCH_INVALID_RESERVATION: 'Assignment reservation is invalid',
    AGENT_DISPATCH_STALE_RESERVATION: 'Assignment reservation is stale',
    AGENT_DISPATCH_STALE_PROFILE: 'Agent profile no longer matches the reservation',
    AGENT_DISPATCH_RESERVATION_MISMATCH: 'Agent pool reservation does not match',
    AGENT_DISPATCH_WORKSPACE_FAILED: 'Task workspace could not be prepared',
    AGENT_DISPATCH_WORKSPACE_STALE: 'Task workspace identity changed before runtime start',
    AGENT_DISPATCH_ACCEPT_FAILED: 'Assignment acceptance failed before commit',
    AGENT_DISPATCH_RUNTIME_START_FAILED: 'Reserved runtime failed to start cleanly',
    AGENT_DISPATCH_ACTIVATION_FAILED: 'Assignment activation failed before commit',
    AGENT_DISPATCH_TURN_FAILED: 'Initial provider turn failed',
    AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION: 'Provider returned an invalid turn result',
    AGENT_DISPATCH_RECONCILIATION_REQUIRED: 'Assignment dispatch state requires reconciliation',
    AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED: 'Runtime ownership requires reconciliation',
  };
  return messages[code];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
