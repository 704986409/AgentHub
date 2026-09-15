import { createHash } from 'node:crypto';

import { apiError, normalizeApiError } from './ApiErrors.js';

interface InFlightEntry<T> {
  readonly state: 'IN_FLIGHT';
  readonly fingerprint: string;
  readonly promise: Promise<Readonly<T>>;
}

interface CompletedEntry<T> {
  readonly state: 'COMPLETED_SUCCESS' | 'COMPLETED_FAILURE';
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly promise: Promise<Readonly<T>>;
}

type Entry<T> = InFlightEntry<T> | CompletedEntry<T>;

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
    this.#pruneCompleted();
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(apiError('AGENTHUB_API_IDEMPOTENCY_CONFLICT', 409));
      }
      return existing.promise as Promise<Readonly<T>>;
    }
    this.#makeCapacity();
    if (this.#entries.size >= this.#maxEntries) {
      return Promise.reject(apiError('AGENTHUB_API_IDEMPOTENCY_CAPACITY', 503));
    }
    const promise = Promise.resolve().then(operation).then(
      (value) => deepFreeze(structuredClone(value)),
      (error: unknown) => Promise.reject(normalizeApiError(error)),
    );
    const inFlight: InFlightEntry<T> = { state: 'IN_FLIGHT', fingerprint, promise };
    this.#entries.set(key, inFlight);
    void promise.then(
      () => this.#complete(key, inFlight, 'COMPLETED_SUCCESS'),
      () => this.#complete(key, inFlight, 'COMPLETED_FAILURE'),
    );
    return promise;
  }

  public clear(): void { this.#entries.clear(); }

  #complete<T>(key: string, expected: InFlightEntry<T>, state: CompletedEntry<T>['state']): void {
    if (this.#entries.get(key) !== expected) return;
    this.#entries.set(key, { state, fingerprint: expected.fingerprint,
      expiresAt: this.#now() + this.#ttlMs, promise: expected.promise });
  }

  #makeCapacity(): void {
    while (this.#entries.size >= this.#maxEntries) {
      const completed = [...this.#entries].find(([, entry]) => entry.state !== 'IN_FLIGHT');
      if (completed === undefined) return;
      this.#entries.delete(completed[0]);
    }
  }

  #pruneCompleted(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.state !== 'IN_FLIGHT' && entry.expiresAt <= now) this.#entries.delete(key);
    }
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
