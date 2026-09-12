import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import type { AgentHubWorkerResultFailure } from '../../protocol/AgentHubWorkerResultParser.js';
import type { ManagerDirective } from '../../protocol/ManagerDirective.js';
import type { ManagerDirectiveFailure } from '../../protocol/ManagerDirectiveParser.js';

export type AgentProviderId = string;

export const agentOutputProtocols = Object.freeze(['manager-directive', 'worker-result'] as const);

/** A structured output contract, independent of provider identity and organizational role. */
export type AgentOutputProtocol = (typeof agentOutputProtocols)[number];

export interface AgentProviderCapabilities {
  readonly outputProtocols: readonly AgentOutputProtocol[];
  readonly sessionContinuation: boolean;
}

export type AgentProviderRuntimeContext = Omit<AgentRuntimeContext, 'provider'>;

export interface AgentProviderSessionCreateOptions {
  readonly eventBus: EventBus;
  readonly context: AgentRuntimeContext;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface CreateAgentProviderSessionRequest {
  readonly eventBus: EventBus;
  readonly context: AgentProviderRuntimeContext;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface AgentProviderTurnRequest {
  readonly prompt: string;
  readonly protocol: AgentOutputProtocol;
  readonly timeoutMs?: number;
}

export interface AgentProviderTurnMetadata {
  readonly providerId: AgentProviderId;
  readonly sessionId?: string;
  readonly durationMs?: number;
}

export interface AgentManagerDirectiveTurnSuccess extends AgentProviderTurnMetadata {
  readonly protocol: 'manager-directive';
  readonly directiveStatus: 'valid' | 'repaired';
  readonly directive: ManagerDirective;
  readonly failure?: never;
}

export interface AgentManagerDirectiveTurnFailure extends AgentProviderTurnMetadata {
  readonly protocol: 'manager-directive';
  readonly directiveStatus: 'invalid';
  readonly directive: null;
  readonly failure: ManagerDirectiveFailure;
}

export type AgentManagerDirectiveTurnResult =
  | AgentManagerDirectiveTurnSuccess
  | AgentManagerDirectiveTurnFailure;

export interface AgentWorkerResultTurnSuccess extends AgentProviderTurnMetadata {
  readonly protocol: 'worker-result';
  readonly protocolValid: true;
  readonly workerResult: AgentHubWorkerResult;
  readonly failure?: never;
}

export interface AgentWorkerResultTurnFailure extends AgentProviderTurnMetadata {
  readonly protocol: 'worker-result';
  readonly protocolValid: false;
  readonly workerResult?: never;
  readonly failure: AgentHubWorkerResultFailure;
}

export type AgentProviderTurnResult =
  | AgentManagerDirectiveTurnResult
  | AgentWorkerResultTurnSuccess
  | AgentWorkerResultTurnFailure;

/**
 * One provider-neutral execution session. Provider identity is independent of
 * organizational role. Startup and shutdown are explicit; runTurn never auto-starts.
 * `started` means the session accepts turns, and `active` means one logical turn is in flight.
 */
export interface AgentProviderSession {
  readonly providerId: AgentProviderId;
  readonly capabilities: AgentProviderCapabilities;
  readonly started: boolean;
  readonly active: boolean;
  readonly sessionId: string | undefined;

  start(): Promise<void>;
  runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult>;
  /** Explicit cleanup operation; adapters define retry behavior for failed cleanup. */
  shutdown(): Promise<void>;
}

/**
 * Constructs provider-neutral sessions without starting execution. Provider identity
 * is independent of organizational role and capabilities may support either protocol.
 */
export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly capabilities: AgentProviderCapabilities;
  createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession;
}

export interface AgentProviderDescriptor {
  readonly id: AgentProviderId;
  readonly capabilities: AgentProviderCapabilities;
}

export type AgentProviderErrorCode =
  | 'AGENT_PROVIDER_INVALID_ID'
  | 'AGENT_PROVIDER_INVALID_CAPABILITIES'
  | 'AGENT_PROVIDER_DUPLICATE'
  | 'AGENT_PROVIDER_NOT_FOUND'
  | 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL'
  | 'AGENT_PROVIDER_CONTRACT_VIOLATION';

export class AgentProviderError extends Error {
  public constructor(
    public readonly code: AgentProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}

export function providerSupportsProtocol(
  capabilities: AgentProviderCapabilities,
  protocol: AgentOutputProtocol,
): boolean {
  return capabilities.outputProtocols.includes(protocol);
}

export function validateAgentProviderTurnRequest(
  request: AgentProviderTurnRequest,
  capabilities: AgentProviderCapabilities,
): void {
  if (!isRecord(request) || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
      'Agent provider turn prompt must be a non-blank string',
    );
  }
  if (request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
      'Agent provider turn timeout must be a positive safe integer',
    );
  }
  if (!agentOutputProtocols.includes(request.protocol)) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
      'Agent provider turn protocol is invalid',
    );
  }
  if (!providerSupportsProtocol(capabilities, request.protocol)) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL',
      `Agent provider does not support protocol ${request.protocol}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
