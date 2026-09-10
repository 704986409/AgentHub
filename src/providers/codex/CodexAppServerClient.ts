import { CodexMessageParser } from './CodexMessageParser.js';
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
}

export class CodexAppServerClient {
  readonly processManager: CodexProcessManager;
  readonly requestManager: CodexRequestManager;
  readonly #parser = new CodexMessageParser();
  readonly #requestTimeoutMs: number;
  #onNotification: ((method: string, params: unknown) => void) | undefined;
  #onServerRequest: ((request: CodexServerRequest) => void) | undefined;
  #onProtocolError: ((error: Error) => void) | undefined;
  #onStderr: ((chunk: string) => void) | undefined;

  public constructor(options: CodexAppServerClientOptions = {}) {
    this.processManager = new CodexProcessManager(options);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.requestManager = new CodexRequestManager((request) => {
      this.processManager.write(`${JSON.stringify(request)}\n`);
    });
    this.processManager.on('stdout', (chunk: Buffer) => this.handleChunk(chunk));
    this.processManager.on('stderr', (chunk: Buffer) => this.#onStderr?.(chunk.toString('utf8')));
    this.processManager.on('exit', (exit: { code: number | null; signal: NodeJS.Signals | null }) => {
      this.requestManager.rejectAll(new Error(`Codex app-server exited (code=${String(exit.code)}, signal=${String(exit.signal)})`));
    });
    this.processManager.on('error', (error: Error) => this.requestManager.rejectAll(error));
  }

  public start(): void {
    this.processManager.start();
  }

  public request(method: string, params?: unknown, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    return this.requestManager.request(method, params, timeoutMs);
  }

  public notify(method: string, params?: unknown): void {
    this.processManager.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  public respond(id: CodexRequestId, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    this.processManager.write(`${JSON.stringify({ id, ...(error === undefined ? { result } : { error }) })}\n`);
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
      if (parsed.error !== undefined) {
        this.#onProtocolError?.(parsed.error);
      } else if (parsed.message !== undefined) {
        if (isCodexResponse(parsed.message)) this.requestManager.handleResponse(parsed.message);
        else if (isCodexNotification(parsed.message)) this.#onNotification?.(parsed.message.method, parsed.message.params);
        else if (isCodexServerRequest(parsed.message)) this.#onServerRequest?.(parsed.message);
      }
    }
  }
}
