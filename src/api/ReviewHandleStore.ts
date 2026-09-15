import type { TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import { apiError } from './ApiErrors.js';

export class ReviewHandleStore {
  readonly #active = new Map<string, Readonly<TaskReviewBundle>>();
  readonly #expired = new Set<string>();
  readonly #claimed = new Set<string>();

  public register(bundle: Readonly<TaskReviewBundle>): string {
    const handle = bundle.reviewBundleSha256;
    const existing = this.#active.get(handle);
    if (existing !== undefined && existing !== bundle &&
      JSON.stringify(existing) !== JSON.stringify(bundle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    this.#expired.delete(handle);
    this.#active.set(handle, bundle);
    return handle;
  }

  public resolve(handle: string): Readonly<TaskReviewBundle> {
    const bundle = this.#active.get(handle);
    if (bundle === undefined) throw apiError('AGENTHUB_API_REVIEW_HANDLE_EXPIRED', 410);
    return bundle;
  }

  public expire(handle: string): void {
    if (this.#active.delete(handle)) this.#expired.add(handle);
  }

  public claim(handle: string): void {
    if (this.#claimed.has(handle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    this.#claimed.add(handle);
  }

  public release(handle: string): void { this.#claimed.delete(handle); }

  public clear(): void { this.#active.clear(); this.#expired.clear(); this.#claimed.clear(); }
}
