import { TaskStatus, type Task } from '../core/types.js';
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
  readonly #rounds = new Map<string, number>();
  readonly #database: Database | undefined;

  public constructor(database?: Database) {
    this.#database = database;
    this.#load();
  }

  public register(bundle: Readonly<TaskReviewBundle>): string {
    return this.replaceActiveForTask(bundle.taskId, bundle);
  }

  public getReviewRound(taskId: string): number {
    return this.#rounds.get(taskId) ?? 1;
  }

  public advanceReviewRound(taskId: string): number {
    const next = (this.#rounds.get(taskId) ?? 1) + 1;
    this.#rounds.set(taskId, next);
    this.#persist();
    return next;
  }

  public replaceActiveForTask(
    runtimeTaskId: string,
    bundle: Readonly<TaskReviewBundle>,
    expectedPriorHandle?: string,
  ): string {
    if (bundle.taskId !== runtimeTaskId) throw apiError('AGENTHUB_API_CONFLICT', 409);
    const handle = bundle.reviewBundleSha256;
    if (this.#expired.has(handle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    const existing = this.#active.get(handle);
    if (existing !== undefined && existing !== bundle &&
      JSON.stringify(existing) !== JSON.stringify(bundle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    const priorForTask = this.getActiveForTask(runtimeTaskId);
    if (expectedPriorHandle !== undefined && priorForTask !== undefined &&
      priorForTask.reviewBundleSha256 !== expectedPriorHandle) {
      throw apiError('AGENTHUB_API_CONFLICT', 409);
    }
    const snapshot = this.#snapshot();
    for (const [activeHandle, active] of this.#active) {
      if (active.taskId === runtimeTaskId && activeHandle !== handle) {
        this.#active.delete(activeHandle);
        this.#expired.add(activeHandle);
      }
    }
    this.#expired.delete(handle);
    this.#active.set(handle, bundle);
    try {
      this.#persist();
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
    return handle;
  }

  public getActiveForTask(runtimeTaskId: string): Readonly<TaskReviewBundle> | undefined {
    for (const bundle of this.#active.values()) {
      if (bundle.taskId === runtimeTaskId) return bundle;
    }
    return undefined;
  }

  public listActive(): readonly Readonly<TaskReviewBundle>[] {
    return Object.freeze([...this.#active.values()]);
  }

  public resolve(handle: string): Readonly<TaskReviewBundle> {
    const bundle = this.#active.get(handle);
    if (bundle === undefined) throw apiError('AGENTHUB_API_REVIEW_HANDLE_EXPIRED', 410);
    return bundle;
  }

  public expire(handle: string): void {
    if (!this.#active.has(handle)) return;
    const snapshot = this.#snapshot();
    this.#active.delete(handle);
    this.#expired.add(handle);
    try {
      this.#persist();
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  public claim(handle: string): void {
    if (this.#claimed.has(handle)) throw apiError('AGENTHUB_API_CONFLICT', 409);
    this.#claimed.add(handle);
  }

  public release(handle: string): void { this.#claimed.delete(handle); }

  public listPublic(
    plans: readonly PlanDto[] = [],
    tasks?: { getTask(id: string): Task | null },
  ): readonly ReturnType<typeof lifecycleReviewDto>[] {
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
      if (this.#expired.has(bundle.reviewBundleSha256)) continue;
      if (tasks !== undefined) {
        const realTask = tasks.getTask(bundle.taskId);
        if (realTask === null) continue;
        if (realTask.status !== TaskStatus.REVIEWING) continue;
        if (realTask.id !== bundle.taskId) continue;
        if (realTask.assignmentId !== null && realTask.assignmentId !== bundle.assignmentId) continue;
        if (realTask.assignedAgentId !== null && realTask.assignedAgentId !== bundle.agentId) continue;
      }
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
    this.#rounds.clear();
    this.#persist();
  }

  #persist(): void {
    if (this.#database === undefined) return;
    const snapshot = {
      schemaVersion: 1 as const,
      bundles: [...this.#active.values()],
      expired: [...this.#expired],
      rounds: [...this.#rounds.entries()],
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
      const record = raw as { schemaVersion?: unknown; bundles?: unknown; expired?: unknown; rounds?: unknown };
      if (record.schemaVersion !== 1 || !Array.isArray(record.bundles)) return;
      const byTask = new Map<string, Readonly<TaskReviewBundle>>();
      for (const item of record.bundles) {
        try {
          const bundle = snapshotTaskReviewBundle(item);
          byTask.set(bundle.taskId, bundle);
        } catch {
          // Fail closed: skip a corrupt/forged bundle without resurrecting it.
        }
      }
      for (const bundle of byTask.values()) this.#active.set(bundle.reviewBundleSha256, bundle);
      if (Array.isArray(record.expired)) {
        for (const h of record.expired) {
          if (typeof h === 'string') this.#expired.add(h);
        }
      }
      if (Array.isArray(record.rounds)) {
        for (const entry of record.rounds) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
            this.#rounds.set(entry[0], entry[1]);
          }
        }
      }
    } catch {
      this.#active.clear();
      this.#expired.clear();
      this.#rounds.clear();
    }
  }

  #snapshot(): { active: Map<string, Readonly<TaskReviewBundle>>; expired: Set<string>; rounds: Map<string, number> } {
    return { active: new Map(this.#active), expired: new Set(this.#expired), rounds: new Map(this.#rounds) };
  }

  #restore(snapshot: { active: Map<string, Readonly<TaskReviewBundle>>; expired: Set<string>; rounds: Map<string, number> }): void {
    this.#active.clear();
    this.#expired.clear();
    this.#rounds.clear();
    for (const [handle, bundle] of snapshot.active) this.#active.set(handle, bundle);
    for (const handle of snapshot.expired) this.#expired.add(handle);
    for (const [taskId, round] of snapshot.rounds) this.#rounds.set(taskId, round);
  }
}
