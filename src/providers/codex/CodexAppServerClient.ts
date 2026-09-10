import { CodexMessageParser } from './CodexMessageParser.js';
import { CodexDiagnostics, redactProtocolLine, type CodexDiagnosticSink } from './CodexDiagnostics.js';
import {
  isCodexNotification,
  isCodexResponse,
  isCodexServerRequest,
  type CodexRequestId,
  type CodexServerRequest,
} from './CodexProtocol.js';
import { CodexProcessManager, type CodexProcessManagerOptions } from './CodexProcessManager.js';
import { CodexRequestManager } from './CodexRequestManager.js';

export interface CodexAppServerClientOptions extends CodexProcessManagerOptions {
  requestTimeoutMs?: number;
  debug?: boolean;
  onDiagnostic?: CodexDiagnosticSink;
}

export const minimalInitializeParams = {
  clientInfo: { name: 'agenthub', title: 'AgentHub', version: '0.2.1' },
  capabilities: {},
} as const;

export class CodexAppServerClient {
  readonly processManager: CodexProcessManager;
  readonly requestManager: CodexRequestManager;
  readonly diagnostics: CodexDiagnostics;
  readonly #parser = new CodexMessageParser();
  readonly #requestTimeoutMs: number;
  #onNotification: ((method: string, params: unknown) => void) | undefined;
  #onServerRequest: ((request: CodexServerRequest) => void) | undefined;
  #onProtocolError: ((error: Error) => void) | undefined;
  #onStderr: ((chunk: string) => void) | undefined;
  #initializeResponseReceived = false;
  #initialized = false;

  public constructor(options: CodexAppServerClientOptions = {}) {
    this.diagnostics = new CodexDiagnostics(options.debug ?? false, options.onDiagnostic);
    this.processManager = new CodexProcessManager({ ...options, onDiagnostic: (event) => this.diagnostics.record(event.type, event.details) });
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.requestManager = new CodexRequestManager((request, timeoutMs) => {
      this.writeMessage(request, { requestId: request.id, method: request.method, timeoutMs });
    }, (request) => this.diagnostics.record('request-timeout', { ...request }));
    this.processManager.on('stdout', (chunk: Buffer) => this.handleChunk(chunk));
    this.processManager.on('stderr', (chunk: Buffer) => this.handleStderr(chunk));
    this.processManager.on('exit', (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
      this.requestManager.rejectAll(new Error(`Codex app-server exited (code=${String(exit.code)}, signal=${String(exit.signal)})`));
    });
    this.processManager.on('error', (error: Error) => this.requestManager.rejectAll(error));
  }

  public async start(): Promise<void> {
    await this.processManager.start();
  }

  public request(method: string, params?: unknown, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    return this.requestManager.request(method, params, timeoutMs);
  }

  public notify(method: string, params?: unknown): void {
    if (method === 'initialized' && !this.#initializeResponseReceived) {
      throw new Error('Cannot send initialized before receiving the initialize response');
    }
    this.writeMessage({ method, ...(params === undefined ? {} : { params }) }, { method });
  }

  public respond(id: CodexRequestId, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    this.writeMessage({ id, ...(error === undefined ? { result } : { error }) }, { requestId: id });
  }

  public async initialize(params: unknown = minimalInitializeParams): Promise<unknown> {
    if (this.#initialized) throw new Error('Codex app-server client is already initialized');
    if (!this.processManager.running) await this.start();
    this.processManager.assertRunning();
    const response = await this.request('initialize', params);
    this.#initializeResponseReceived = true;
    this.notify('initialized');
    this.#initialized = true;
    return response;
  }

  public onNotification(handler: (method: string, params: unknown) => void): void {
    this.#onNotification = handler;
  }

  public onServerRequest(handler: (request: CodexServerRequest) => void): void {
    this.#onServerRequest = handler;
  }

  public onProtocolError(handler: (error: Error) => void): void {
    this.#onProtocolError = handler;
  }

  public onStderr(handler: (chunk: string) => void): void {
    this.#onStderr = handler;
  }

  public async stop(): Promise<void> {
    this.requestManager.rejectAll(new Error('Codex provider is stopping'));
    await this.processManager.stop();
  }

  private handleChunk(chunk: Buffer): void {
    for (const parsed of this.#parser.feed(chunk)) {
      if (parsed.raw !== undefined) this.diagnostics.record('inbound-stdout', { raw: redactProtocolLine(parsed.raw) });
      if (parsed.error !== undefined) {
        this.#onProtocolError?.(parsed.error);
      } else if (parsed.message !== undefined) {
        if (isCodexResponse(parsed.message)) this.requestManager.handleResponse(parsed.message);
        else if (isCodexNotification(parsed.message)) this.#onNotification?.(parsed.message.method, parsed.message.params);
        else if (isCodexServerRequest(parsed.message)) this.#onServerRequest?.(parsed.message);
      }
    }
  }

  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) this.diagnostics.record('stderr', { raw: redactProtocolLine(line) });
    }
    this.#onStderr?.(text);
  }

  private writeMessage(message: Record<string, unknown>, details: Record<string, unknown>): void {
    const raw = JSON.stringify(message);
    this.diagnostics.record('outbound', { ...details, raw: redactProtocolLine(raw), newline: true });
    this.processManager.write(`${raw}\n`);
  }
}
