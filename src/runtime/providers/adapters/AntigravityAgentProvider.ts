import {
  AntigravityWorkerSession,
  type AntigravityWorkerSessionOptions,
  type AntigravityWorkerTurnResult,
} from '../../../providers/antigravity/AntigravityWorkerSession.js';
import {
  validateAgentProviderTurnRequest,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../AgentProvider.js';

export const ANTIGRAVITY_AGENT_PROVIDER_ID = 'antigravity';

export const ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

export interface AntigravityWorkerSessionLike {
  readonly started: boolean;
  readonly active: boolean;
  readonly sessionId: string | undefined;
  start(): Promise<void>;
  runTurn(request: { prompt: string; timeoutMs?: number }): Promise<AntigravityWorkerTurnResult>;
  shutdown(): Promise<void>;
}

export interface AntigravityAgentProviderDependencies {
  readonly createWorkerSession?: (options: AntigravityWorkerSessionOptions) => AntigravityWorkerSessionLike;
}

export class AntigravityAgentProvider implements AgentProvider {
  public readonly id = ANTIGRAVITY_AGENT_PROVIDER_ID;
  public readonly capabilities = ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES;
  readonly #createWorkerSession: (options: AntigravityWorkerSessionOptions) => AntigravityWorkerSessionLike;

  public constructor(dependencies: AntigravityAgentProviderDependencies = {}) {
    this.#createWorkerSession = dependencies.createWorkerSession ?? ((options) => new AntigravityWorkerSession(options));
  }

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    const worker = this.#createWorkerSession({
      context: Object.freeze({ ...options.context, provider: ANTIGRAVITY_AGENT_PROVIDER_ID }),
      eventBus: options.eventBus,
      ...(options.workspacePath !== undefined ? { workspacePath: options.workspacePath } : {}),
      ...(options.config !== undefined ? { config: options.config } : {}),
    });
    return new AntigravityAgentProviderSession(worker);
  }
}

class AntigravityAgentProviderSession implements AgentProviderSession {
  public readonly providerId = ANTIGRAVITY_AGENT_PROVIDER_ID;
  public readonly capabilities = ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES;

  public constructor(private readonly worker: AntigravityWorkerSessionLike) {}

  public get started(): boolean {
    return this.worker.started;
  }

  public get active(): boolean {
    return this.worker.active;
  }

  public get sessionId(): string | undefined {
    return this.worker.sessionId;
  }

  public start(): Promise<void> {
    return this.worker.start();
  }

  public async runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    validateAgentProviderTurnRequest(request, this.capabilities);
    const result = await this.worker.runTurn({
      prompt: request.prompt,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });

    if (result.protocolValid) {
      return {
        providerId: ANTIGRAVITY_AGENT_PROVIDER_ID,
        protocol: 'worker-result',
        protocolValid: true,
        workerResult: result.workerResult,
        sessionId: result.conversationId,
        durationMs: result.durationMs,
      };
    }

    return {
      providerId: ANTIGRAVITY_AGENT_PROVIDER_ID,
      protocol: 'worker-result',
      protocolValid: false,
      failure: result.failure,
      ...(result.conversationId !== undefined ? { sessionId: result.conversationId } : {}),
      durationMs: result.durationMs,
    };
  }

  public shutdown(): Promise<void> {
    return this.worker.shutdown();
  }
}
