import type { CodexRequestId, CodexResponse } from './CodexProtocol.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexRequestTimeout {
  id: CodexRequestId;
  method: string;
  timeoutMs: number;
}

export class CodexRequestManager {
  readonly #pending = new Map<CodexRequestId, PendingRequest>();
  readonly #settledIds = new Set<CodexRequestId>();
  readonly #settledOrder: CodexRequestId[] = [];
  #nextId = 1;

  public constructor(
    private readonly write: (request: { id: CodexRequestId; method: string; params?: unknown }, timeoutMs: number) => void,
    private readonly onTimeout?: (request: CodexRequestTimeout) => void,
  ) {}

  public get pendingCount(): number {
    return this.#pending.size;
  }

  public request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.rememberSettled(id);
        this.onTimeout?.({ id, method, timeoutMs });
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) }, timeoutMs);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public handleResponse(response: CodexResponse): boolean {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return false;
    this.#pending.delete(response.id);
    this.rememberSettled(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) pending.reject(new Error(`${String(response.error.code)}: ${response.error.message}`));
    else pending.resolve(response.result);
    return true;
  }

  public rejectAll(reason: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.rememberSettled(id);
    }
    this.#pending.clear();
  }

  public wasSettled(id: CodexRequestId): boolean {
    return this.#settledIds.has(id);
  }

  private rememberSettled(id: CodexRequestId): void {
    if (this.#settledIds.has(id)) return;
    this.#settledIds.add(id);
    this.#settledOrder.push(id);
    if (this.#settledOrder.length > 256) {
      const oldest = this.#settledOrder.shift();
      if (oldest !== undefined) this.#settledIds.delete(oldest);
    }
  }
}
