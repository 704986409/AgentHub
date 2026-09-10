import type { EventBus } from '../../events/event-bus.js';
import type { CodexAppServerClientOptions } from './CodexAppServerClient.js';
import { CodexAppServerClient } from './CodexAppServerClient.js';
import type { CodexServerRequest } from './CodexProtocol.js';

export type CodexProviderOptions = CodexAppServerClientOptions;

export type CodexNotificationHandler = (method: string, params: unknown) => void;
export type CodexServerRequestHandler = (request: CodexServerRequest) => void;
export type CodexProtocolErrorHandler = (error: Error) => void;
export type CodexProcessExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
export type CodexProcessErrorHandler = (error: Error) => void;

export enum CodexProviderStatus {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  READY = 'READY',
  ERROR = 'ERROR',
  STOPPING = 'STOPPING',
}

export class CodexProvider {
  readonly client: CodexAppServerClient;
  readonly #notificationHandlers = new Set<CodexNotificationHandler>();
  readonly #serverRequestHandlers = new Set<CodexServerRequestHandler>();
  readonly #protocolErrorHandlers = new Set<CodexProtocolErrorHandler>();
  readonly #processExitHandlers = new Set<CodexProcessExitHandler>();
  readonly #processErrorHandlers = new Set<CodexProcessErrorHandler>();
  #status = CodexProviderStatus.STOPPED;

  public constructor(
    options: CodexProviderOptions = {},
    private readonly eventBus?: EventBus,
  ) {
    this.client = new CodexAppServerClient(options);
    this.client.onNotification((method, params) => {
      for (const handler of this.#notificationHandlers) handler(method, params);
    });
    this.client.onServerRequest((request) => {
      for (const handler of this.#serverRequestHandlers) handler(request);
    });
    this.client.onProtocolError((error) => {
      for (const handler of this.#protocolErrorHandlers) handler(error);
      this.#status = CodexProviderStatus.ERROR;
    });
    this.client.processManager.on('exit', (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
      for (const handler of this.#processExitHandlers) handler(exit.code, exit.signal);
      if (this.#status !== CodexProviderStatus.STOPPING) {
        this.#status = CodexProviderStatus.ERROR;
      }
    });
    this.client.processManager.on('error', (error: Error) => {
      for (const handler of this.#processErrorHandlers) handler(error);
      this.#status = CodexProviderStatus.ERROR;
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
    await this.client.stop();
    this.#status = CodexProviderStatus.STOPPED;
    this.client.diagnostics.record('provider-state', { status: this.#status });
    this.eventBus?.publish({ eventType: 'CodexProviderStopped' });
  }

  public getStatus(): CodexProviderStatus {
    return this.#status;
  }

  public onNotification(handler: CodexNotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  public onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.#serverRequestHandlers.add(handler);
    return () => this.#serverRequestHandlers.delete(handler);
  }

  public onProtocolError(handler: CodexProtocolErrorHandler): () => void {
    this.#protocolErrorHandlers.add(handler);
    return () => this.#protocolErrorHandlers.delete(handler);
  }

  public onProcessExit(handler: CodexProcessExitHandler): () => void {
    this.#processExitHandlers.add(handler);
    return () => this.#processExitHandlers.delete(handler);
  }

  public onProcessError(handler: CodexProcessErrorHandler): () => void {
    this.#processErrorHandlers.add(handler);
    return () => this.#processErrorHandlers.delete(handler);
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

  public assertReady(): void {
    if (this.#status !== CodexProviderStatus.READY) {
      throw new Error(`Codex provider must be READY (current status: ${this.#status})`);
    }
  }
}

export const codexProviderEventTypes = [
  'CodexProviderStarting',
  'CodexProviderReady',
  'CodexProviderStopped',
  'CodexRequestSent',
  'CodexResponseReceived',
] as const;
