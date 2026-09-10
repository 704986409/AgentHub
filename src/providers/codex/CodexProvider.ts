import type { EventBus } from '../../events/event-bus.js';
import type { CodexAppServerClientOptions } from './CodexAppServerClient.js';
import { CodexAppServerClient } from './CodexAppServerClient.js';

export enum CodexProviderStatus {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  READY = 'READY',
  ERROR = 'ERROR',
  STOPPING = 'STOPPING',
}

export class NotImplementedInVersionError extends Error {
  public constructor(operation: string) {
    super(`${operation} is not implemented in V0.2.1`);
    this.name = 'NotImplementedInVersionError';
  }
}

export class CodexProvider {
  readonly client: CodexAppServerClient;
  #status = CodexProviderStatus.STOPPED;

  public constructor(
    options: CodexAppServerClientOptions = {},
    private readonly eventBus?: EventBus,
  ) {
    this.client = new CodexAppServerClient(options);
    this.client.onNotification((method, params) => {
      this.eventBus?.publish({ eventType: 'CodexNotificationReceived', payload: { method, params } });
    });
    this.client.onServerRequest((request) => {
      this.eventBus?.publish({ eventType: 'CodexServerRequestReceived', payload: request, actor: 'codex' });
    });
    this.client.onProtocolError((error) => {
      this.#status = CodexProviderStatus.ERROR;
      this.eventBus?.publishSystemError(error, { source: 'codex-protocol' });
      this.eventBus?.publish({ eventType: 'CodexProviderError', payload: { message: error.message } });
    });
    this.client.processManager.on('exit', (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
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
    this.eventBus?.publish({ eventType: 'CodexProviderStarting' });
    try {
      const response = await this.client.initialize();
      this.#status = CodexProviderStatus.READY;
      this.eventBus?.publish({ eventType: 'CodexProviderReady' });
      return response;
    } catch (error) {
      this.#status = CodexProviderStatus.ERROR;
      this.eventBus?.publishSystemError(error, { source: 'codex-start' });
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.#status === CodexProviderStatus.STOPPED) return;
    this.#status = CodexProviderStatus.STOPPING;
    await this.client.stop();
    this.#status = CodexProviderStatus.STOPPED;
    this.eventBus?.publish({ eventType: 'CodexProviderStopped' });
  }

  public getStatus(): CodexProviderStatus {
    return this.#status;
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
