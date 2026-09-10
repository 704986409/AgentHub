import type { CodexRequestId, CodexResponse } from './CodexProtocol.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRequestManager {
  readonly #pending = new Map<CodexRequestId, PendingRequest>();
  #nextId = 1;

  public constructor(private readonly write: (request: { id: CodexRequestId; method: string; params?: unknown }) => void) {}

  public get pendingCount(): number {
    return this.#pending.size;
  }

  public request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
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
    clearTimeout(pending.timer);
    if (response.error !== undefined) pending.reject(new Error(`${String(response.error.code)}: ${response.error.message}`));
    else pending.resolve(response.result);
    return true;
  }

  public rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }
}
