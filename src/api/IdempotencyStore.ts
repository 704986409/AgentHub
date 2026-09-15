import { createHash } from 'node:crypto';

import { apiError } from './ApiErrors.js';

interface Entry<T> {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly promise: Promise<Readonly<T>>;
}

export interface IdempotencyStoreOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class IdempotencyStore {
  readonly #entries = new Map<string, Entry<unknown>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  public constructor(options: IdempotencyStoreOptions = {}) {
    this.#maxEntries = positive(options.maxEntries ?? 1000);
    this.#ttlMs = positive(options.ttlMs ?? 30 * 60 * 1000);
    this.#now = options.now ?? Date.now;
  }

  public execute<T>(key: string, fingerprint: string, operation: () => Promise<T>): Promise<Readonly<T>> {
    this.#prune();
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(apiError('AGENTHUB_API_IDEMPOTENCY_CONFLICT', 409));
      }
      return existing.promise as Promise<Readonly<T>>;
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const promise = Promise.resolve().then(operation).then((value) => deepFreeze(structuredClone(value)));
    this.#entries.set(key, { fingerprint, expiresAt: this.#now() + this.#ttlMs, promise });
    void promise.catch(() => { if (this.#entries.get(key)?.promise === promise) this.#entries.delete(key); });
    return promise;
  }

  public clear(): void { this.#entries.clear(); }

  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key);
  }
}

export function requestFingerprint(method: string, route: string, body: unknown): string {
  return createHash('sha256').update(`${method}\0${route}\0${canonical(body)}`).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Idempotency store option is invalid');
  return value;
}
function deepFreeze<T>(value: T, seen = new WeakSet()): Readonly<T> {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
