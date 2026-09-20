import type { Database } from '../database/index.js';
import type { ReviewHandleStore } from '../api/ReviewHandleStore.js';
import type { TaskReviewBundle } from '../orchestration/TaskLifecycleOrchestrator.js';
import { TaskStatus } from '../core/types.js';
import type { TaskManager } from '../services/task-manager.js';
import type { PlanLifecycleService } from './plan-lifecycle.js';

export const PLAN_REVIEW_RECONCILIATION_REQUIRED = 'PLAN_REVIEW_RECONCILIATION_REQUIRED';

export interface ReviewTransitionFailpoints {
  readonly beforeAuthoritativeReviewPersist?: () => void;
  readonly afterAuthoritativeReviewPersist?: () => void;
  readonly beforePlanReviewPending?: () => void;
  readonly afterTaskCompletedBeforeExpire?: () => void;
  readonly afterNewReviewBeforeOldExpire?: () => void;
  readonly beforeDependentReviewPersist?: () => void;
  readonly afterTerminalReviewExpiredBeforePlanResolution?: () => void;
}

export interface ReviewTransitionCoordinatorOptions {
  readonly reviews: ReviewHandleStore;
  readonly planLifecycle: PlanLifecycleService;
  readonly tasks: TaskManager;
  readonly database?: Database;
  readonly failpoints?: ReviewTransitionFailpoints;
}

export class ReviewTransitionCoordinator {
  readonly #reviews: ReviewHandleStore;
  readonly #planLifecycle: PlanLifecycleService;
  readonly #tasks: TaskManager;
  readonly #database: Database | undefined;
  readonly #failpoints: ReviewTransitionFailpoints;
  #reconciliationRequired = false;
  #reviewPersistCount = 0;

  public constructor(options: ReviewTransitionCoordinatorOptions) {
    this.#reviews = options.reviews;
    this.#planLifecycle = options.planLifecycle;
    this.#tasks = options.tasks;
    this.#database = options.database;
    this.#failpoints = options.failpoints ?? {};
  }

  public get reviews(): ReviewHandleStore { return this.#reviews; }
  public get reconciliationRequired(): boolean { return this.#reconciliationRequired; }

  public commitPrepared(bundle: TaskReviewBundle, persistReviewing: () => void): void {
    this.#reviewPersistCount += 1;
    if (this.#reviewPersistCount > 1) this.#fail('beforeDependentReviewPersist');
    this.#fail('beforeAuthoritativeReviewPersist');
    this.#transaction(() => {
      this.#reviews.replaceActiveForTask(bundle.taskId, bundle);
      persistReviewing();
    });
    this.#fail('afterAuthoritativeReviewPersist');
    this.#fail('afterNewReviewBeforeOldExpire');
  }

  public markPlanReviewPending(runtimeTaskId: string): void {
    this.#fail('beforePlanReviewPending');
    this.#planLifecycle.markReviewPendingByTask(runtimeTaskId, true);
  }

  public expireAfterTerminalDecision(handle: string): void {
    this.#fail('afterTaskCompletedBeforeExpire');
    this.#reviews.expire(handle);
    this.#fail('afterTerminalReviewExpiredBeforePlanResolution');
  }

  public reconcile(): void {
    this.#reconciliationRequired = false;
    const links = this.#planLifecycle.listReviewAuthority();
    const byTask = new Map(links.map((link) => [link.runtimeTaskId, link]));

    for (const bundle of this.#reviews.listActive()) {
      const task = this.#tasks.getTask(bundle.taskId);
      const link = byTask.get(bundle.taskId);
      if (task !== null && !isReviewRequired(task.status) && !(link?.reviewPending ?? false)) {
        this.#reviews.expire(bundle.reviewBundleSha256);
        continue;
      }
      if (task !== null && task.status === TaskStatus.COMPLETED) {
        this.#reviews.expire(bundle.reviewBundleSha256);
        if (link?.reviewPending === true) this.#planLifecycle.markReviewPendingByTask(bundle.taskId, false);
        continue;
      }
      if (task !== null && task.status === TaskStatus.IMPLEMENTING) {
        try { this.#tasks.transitionTask(bundle.taskId, TaskStatus.REVIEWING); }
        catch { /* keep fail-closed below if still not review-required */ }
      }
      if (link !== undefined && !link.reviewPending) {
        this.#planLifecycle.markReviewPendingByTask(bundle.taskId, true);
      }
    }

    for (const link of this.#planLifecycle.listReviewAuthority()) {
      const task = this.#tasks.getTask(link.runtimeTaskId);
      const activeReview = this.#reviews.getActiveForTask(link.runtimeTaskId);
      if (task !== null && (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED
        || task.status === TaskStatus.CANCELLED)) {
        if (link.reviewPending && activeReview === undefined) {
          this.#planLifecycle.markReviewPendingByTask(link.runtimeTaskId, false);
        }
        continue;
      }
      const reviewing = link.reviewPending || task?.status === TaskStatus.REVIEWING;
      if (!reviewing) continue;
      if (activeReview !== undefined) continue;
      this.#reconciliationRequired = true;
      throw coded(PLAN_REVIEW_RECONCILIATION_REQUIRED);
    }
  }

  public assertReady(): void {
    if (this.#reconciliationRequired) throw coded(PLAN_REVIEW_RECONCILIATION_REQUIRED);
  }

  #transaction<T>(fn: () => T): T {
    if (this.#database === undefined) return fn();
    return this.#database.connection.transaction(fn)();
  }

  #fail(name: keyof ReviewTransitionFailpoints): void {
    this.#failpoints[name]?.();
  }
}

function isReviewRequired(status: TaskStatus): boolean {
  return status === TaskStatus.REVIEWING || status === TaskStatus.IMPLEMENTING
    || status === TaskStatus.REVISION_REQUIRED;
}

function coded(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}
