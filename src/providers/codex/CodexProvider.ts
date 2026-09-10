import type { EventBus } from '../../events/event-bus.js';
import type { CodexAppServerClientOptions } from './CodexAppServerClient.js';
import { CodexAppServerClient } from './CodexAppServerClient.js';
import {
  CodexManagerTurnController,
  type CodexManagerSession,
  type CodexTurnRequest,
  type CodexTurnResult,
} from './CodexManagerTurn.js';
import { CodexManagerDirectiveRunner, type ManagerDirectiveTurnResult } from './CodexManagerDirective.js';

export interface CodexProviderOptions extends CodexAppServerClientOptions {
  managerThreadTimeoutMs?: number;
  managerTurnTimeoutMs?: number;
}

export enum CodexProviderStatus {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  READY = 'READY',
  ERROR = 'ERROR',
  STOPPING = 'STOPPING',
}

export class NotImplementedInVersionError extends Error {
  public constructor(operation: string) {
    super(`${operation} is not implemented in V0.2.1.3`);
    this.name = 'NotImplementedInVersionError';
  }
}

export class CodexProvider {
  readonly client: CodexAppServerClient;
  readonly managerTurns: CodexManagerTurnController;
  readonly managerDirectives: CodexManagerDirectiveRunner;
  #status = CodexProviderStatus.STOPPED;

  public constructor(
    options: CodexProviderOptions = {},
    private readonly eventBus?: EventBus,
  ) {
    const { managerThreadTimeoutMs, managerTurnTimeoutMs, ...clientOptions } = options;
    this.client = new CodexAppServerClient(clientOptions);
    this.managerTurns = new CodexManagerTurnController(
      this.client,
      () => this.assertReady(),
      {
        ...(managerThreadTimeoutMs === undefined ? {} : { threadRequestTimeoutMs: managerThreadTimeoutMs }),
        ...(managerTurnTimeoutMs === undefined ? {} : { turnTimeoutMs: managerTurnTimeoutMs }),
        diagnostics: this.client.diagnostics,
      },
    );
    this.managerDirectives = new CodexManagerDirectiveRunner(this.managerTurns, this.client.diagnostics);
    this.client.onNotification((method, params) => {
      this.managerTurns.handleNotification(method, params);
      this.eventBus?.publish({ eventType: 'CodexNotificationReceived', payload: summarizeNotification(method, params) });
    });
    this.client.onServerRequest((request) => {
      this.eventBus?.publish({ eventType: 'CodexServerRequestReceived', payload: request, actor: 'codex' });
    });
    this.client.onProtocolError((error) => {
      this.managerTurns.handleProtocolError(error);
      this.#status = CodexProviderStatus.ERROR;
      this.eventBus?.publishSystemError(error, { source: 'codex-protocol' });
      this.eventBus?.publish({ eventType: 'CodexProviderError', payload: { message: error.message } });
    });
    this.client.processManager.on('exit', (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
      this.managerTurns.handleProcessExit(exit.code, exit.signal);
      if (this.#status !== CodexProviderStatus.STOPPING && exit.code !== 0) {
        this.#status = CodexProviderStatus.ERROR;
        this.eventBus?.publish({ eventType: 'CodexProviderError', payload: exit });
      }
    });
    this.client.processManager.on('error', (error: Error) => {
      this.#status = CodexProviderStatus.ERROR;
      this.eventBus?.publishSystemError(error, { source: 'codex-process' });
      this.eventBus?.publish({ eventType: 'CodexProviderError', payload: { message: error.message } });
    });
    this.client.processManager.on('stderr', (chunk: Buffer) => {
      this.eventBus?.publish({ eventType: 'CodexProviderError', payload: { stderr: chunk.toString('utf8').slice(-2_000) } });
    });
  }

  public async initialize(): Promise<unknown> {
    if (this.#status !== CodexProviderStatus.STOPPED) throw new Error(`Cannot initialize from ${this.#status}`);
    this.#status = CodexProviderStatus.STARTING;
    this.client.diagnostics.record('provider-state', { status: this.#status });
    this.eventBus?.publish({ eventType: 'CodexProviderStarting' });
    try {
      const response = await this.client.initialize();
      this.#status = CodexProviderStatus.READY;
      this.client.diagnostics.record('provider-state', { status: this.#status });
      this.eventBus?.publish({ eventType: 'CodexProviderReady' });
      return response;
    } catch (error) {
      this.#status = CodexProviderStatus.ERROR;
      this.client.diagnostics.record('provider-state', { status: this.#status });
      this.eventBus?.publishSystemError(error, { source: 'codex-start' });
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.#status === CodexProviderStatus.STOPPED) return;
    this.#status = CodexProviderStatus.STOPPING;
    this.client.diagnostics.record('provider-state', { status: this.#status });
    this.managerTurns.stop();
    await this.client.stop();
    this.#status = CodexProviderStatus.STOPPED;
    this.client.diagnostics.record('provider-state', { status: this.#status });
    this.eventBus?.publish({ eventType: 'CodexProviderStopped' });
  }

  public getStatus(): CodexProviderStatus {
    return this.#status;
  }

  public createManagerThread(): Promise<CodexManagerSession> {
    return this.managerTurns.createManagerThread();
  }

  public runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    return this.managerTurns.runTurn(request);
  }

  public runDirectiveTurn(request: CodexTurnRequest): Promise<ManagerDirectiveTurnResult> {
    return this.managerDirectives.run(request);
  }

  public getManagerThreadId(): string | undefined {
    return this.managerTurns.managerThreadId;
  }

  public get pendingTurnCount(): number {
    return this.managerTurns.pendingTurnCount;
  }

  public async initializeProtocol(): Promise<unknown> {
    if (this.#status !== CodexProviderStatus.STOPPED) throw new Error(`Cannot initialize from ${this.#status}`);
    return this.initialize();
  }

  public sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.eventBus?.publish({ eventType: 'CodexRequestSent', payload: { method } });
    return this.client.request(method, params, timeoutMs).then((result) => {
      this.eventBus?.publish({ eventType: 'CodexResponseReceived', payload: { method } });
      return result;
    });
  }

  public respondToServerRequest(id: string | number, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    this.client.respond(id, result, error);
  }

  public startTask(): never { throw new NotImplementedInVersionError('startTask'); }
  public sendMessage(): never { throw new NotImplementedInVersionError('sendMessage'); }
  public cancelTask(): never { throw new NotImplementedInVersionError('cancelTask'); }

  private assertReady(): void {
    if (this.#status !== CodexProviderStatus.READY) {
      throw new Error(`Codex provider must be READY (current status: ${this.#status})`);
    }
  }
}

export const codexProviderEventTypes = [
  'CodexProviderStarting',
  'CodexProviderReady',
  'CodexProviderStopped',
  'CodexProviderError',
  'CodexRequestSent',
  'CodexResponseReceived',
  'CodexNotificationReceived',
  'CodexServerRequestReceived',
] as const;

function summarizeNotification(method: string, params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) return { method };
  const record = params as Record<string, unknown>;
  const turn = typeof record.turn === 'object' && record.turn !== null ? record.turn as Record<string, unknown> : undefined;
  return {
    method,
    ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
    ...(typeof record.turnId === 'string' ? { turnId: record.turnId } : {}),
    ...(typeof turn?.id === 'string' ? { turnId: turn.id } : {}),
  };
}
