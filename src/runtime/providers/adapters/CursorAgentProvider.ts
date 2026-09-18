import {
  CursorWorkerSession,
  type CursorWorkerSessionOptions,
  type CursorWorkerTurnResult,
} from '../../../providers/cursor/CursorWorkerSession.js';
import {
  validateAgentProviderTurnRequest,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../AgentProvider.js';

export const CURSOR_AGENT_PROVIDER_ID = 'cursor';

export const CURSOR_AGENT_PROVIDER_CAPABILITIES: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

export interface CursorWorkerSessionLike {
  readonly started: boolean;
  readonly active: boolean;
  readonly sessionId: string | undefined;
  start(): Promise<void>;
  runTurn(request: { prompt: string; timeoutMs?: number }): Promise<CursorWorkerTurnResult>;
  shutdown(): Promise<void>;
}

export interface CursorAgentProviderDependencies {
  readonly createWorkerSession?: (options: CursorWorkerSessionOptions) => CursorWorkerSessionLike;
}

export class CursorAgentProvider implements AgentProvider {
  public readonly id = CURSOR_AGENT_PROVIDER_ID;
  public readonly capabilities = CURSOR_AGENT_PROVIDER_CAPABILITIES;
  readonly #createWorkerSession: (options: CursorWorkerSessionOptions) => CursorWorkerSessionLike;

  public constructor(dependencies: CursorAgentProviderDependencies = {}) {
    this.#createWorkerSession = dependencies.createWorkerSession ?? ((options) => new CursorWorkerSession(options));
  }

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    const worker = this.#createWorkerSession({
      context: Object.freeze({ ...options.context, provider: CURSOR_AGENT_PROVIDER_ID }),
      eventBus: options.eventBus,
      ...(options.workspacePath !== undefined ? { workspacePath: options.workspacePath } : {}),
      ...(options.config !== undefined ? { config: options.config } : {}),
    });
    return new CursorAgentProviderSession(worker);
  }
}

class CursorAgentProviderSession implements AgentProviderSession {
  public readonly providerId = CURSOR_AGENT_PROVIDER_ID;
  public readonly capabilities = CURSOR_AGENT_PROVIDER_CAPABILITIES;

  public constructor(private readonly worker: CursorWorkerSessionLike) {}

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
        providerId: CURSOR_AGENT_PROVIDER_ID,
        protocol: 'worker-result',
        protocolValid: true,
        workerResult: result.workerResult,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        durationMs: result.durationMs,
      };
    }

    return {
      providerId: CURSOR_AGENT_PROVIDER_ID,
      protocol: 'worker-result',
      protocolValid: false,
      failure: result.failure,
      ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
      durationMs: result.durationMs,
    };
  }

  public shutdown(): Promise<void> {
    return this.worker.shutdown();
  }
}
