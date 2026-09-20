import type { Database } from '../database/index.js';
import type { PlanDto } from '../lifecycle/plan-lifecycle.js';
import { snapshotTaskReviewBundle, type TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import { apiError } from './ApiErrors.js';
import { lifecycleReviewDto } from './ApiDtos.js';

const SETTINGS_KEY = 'public_review_handle_snapshot';

export class ReviewHandleStore {
  readonly #active = new Map<string, Readonly<TaskReviewBundle>>();
  readonly #expired = new Set<string>();
  readonly #claimed = new Set<string>();
  readonly #database: Database | undefined;

  public constructor(database?: Database) {
    this.#database = database;
    this.#load();
  }

  public register(bundle: Readonly<TaskReviewBundle>): string {
    const handle = bundle.reviewBundleSha256;
    const existing = this.#active.get(handle);
    if (existing !== undefined && existing !== bundle &&
      JSON.stringify(existing) !== JSON.stringify(bundle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    const previous = existing;
    const wasExpired = this.#expired.delete(handle);
    this.#active.set(handle, bundle);
    try {
      this.#persist();
    } catch (error) {
      if (previous === undefined) this.#active.delete(handle);
      else this.#active.set(handle, previous);
      if (wasExpired) this.#expired.add(handle);
      throw error;
    }
    return handle;
  }

  public resolve(handle: string): Readonly<TaskReviewBundle> {
    const bundle = this.#active.get(handle);
    if (bundle === undefined) throw apiError('AGENTHUB_API_REVIEW_HANDLE_EXPIRED', 410);
    return bundle;
  }

  public expire(handle: string): void {
    if (!this.#active.has(handle)) return;
    const previous = this.#active.get(handle);
    this.#active.delete(handle);
    this.#expired.add(handle);
    try {
      this.#persist();
    } catch (error) {
      if (previous !== undefined) {
        this.#active.set(handle, previous);
        this.#expired.delete(handle);
      }
      throw error;
    }
  }

  public claim(handle: string): void {
    if (this.#claimed.has(handle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    this.#claimed.add(handle);
  }

  public release(handle: string): void { this.#claimed.delete(handle); }

  public listPublic(plans: readonly PlanDto[] = []): readonly ReturnType<typeof lifecycleReviewDto>[] {
    const byRuntime = new Map<string, Array<{ plan: PlanDto; task: PlanDto['tasks'][number] }>>();
    for (const plan of plans) {
      for (const task of plan.tasks) {
        if (typeof task.runtimeTaskId !== 'string' || task.runtimeTaskId.length === 0) continue;
        const matches = byRuntime.get(task.runtimeTaskId) ?? [];
        matches.push({ plan, task });
        byRuntime.set(task.runtimeTaskId, matches);
      }
    }
    const reviews = [];
    for (const bundle of this.#active.values()) {
      const matches = byRuntime.get(bundle.taskId) ?? [];
      if (matches.length !== 1) continue;
      const mapped = matches[0];
      if (mapped === undefined) continue;
      const { plan, task } = mapped;
      if (task.runtimeState !== 'REVIEWING') continue;
      if (task.planId !== plan.planId) continue;
      if (task.runtimeTaskId !== bundle.taskId) continue;
      if (task.assignmentId !== null && task.assignmentId !== bundle.assignmentId) continue;
      if (task.agentId !== null && task.agentId !== bundle.agentId) continue;
      reviews.push(lifecycleReviewDto(bundle, {
        planId: plan.planId,
        planVersion: task.planVersion,
        planTaskId: task.planTaskId,
      }));
    }
    return Object.freeze(reviews);
  }

  public clear(): void {
    this.#active.clear();
    this.#expired.clear();
    this.#claimed.clear();
    this.#persist();
  }

  #persist(): void {
    if (this.#database === undefined) return;
    const snapshot = {
      schemaVersion: 1 as const,
      bundles: [...this.#active.values()],
    };
    this.#database.connection.prepare(
      'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ).run(SETTINGS_KEY, JSON.stringify(snapshot), new Date().toISOString());
  }

  #load(): void {
    if (this.#database === undefined) return;
    const row = this.#database.connection.prepare('SELECT value FROM settings WHERE key=?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (row === undefined) return;
    try {
      const raw = JSON.parse(row.value) as unknown;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
      const record = raw as { schemaVersion?: unknown; bundles?: unknown };
      if (record.schemaVersion !== 1 || !Array.isArray(record.bundles)) return;
      for (const item of record.bundles) {
        try {
          const bundle = snapshotTaskReviewBundle(item);
          this.#active.set(bundle.reviewBundleSha256, bundle);
        } catch {
          // Fail closed: skip a corrupt/forged bundle without resurrecting it.
        }
      }
    } catch {
      this.#active.clear();
    }
  }
}
