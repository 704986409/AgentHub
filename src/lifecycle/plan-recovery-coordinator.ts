import { DomainEventType } from '../core/types.js';
import type { DomainEvent, EventBus } from '../events/event-bus.js';
import { PLAN_ASSIGNMENT_RECOVERY_REQUIRED } from './plan-execution-recovery.js';
import { PLAN_REVIEW_RECONCILIATION_REQUIRED } from './review-transition-coordinator.js';
import type { ReviewTransitionCoordinator } from './review-transition-coordinator.js';
import type { PlanExecutionCoordinator } from './plan-execution-coordinator.js';
import type { PlanLifecycleService } from './plan-lifecycle.js';

export const PLAN_RECOVERY_FAILED = 'PlanRecoveryFailed';
export const RECOVERY_BACKOFF_MS = Object.freeze([0, 250, 1_000, 5_000]);

export type PlanRecoveryCategory = 'safety' | 'unavailable' | 'operational' | 'contract';

export interface RecoveryClock {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface PlanRecoveryCoordinatorOptions {
  readonly planLifecycle: PlanLifecycleService;
  readonly planExecution: PlanExecutionCoordinator;
  readonly reviewTransitions: ReviewTransitionCoordinator;
  readonly eventBus: EventBus;
  readonly clock?: RecoveryClock;
}

const WAKE_EVENTS = new Set<string>([
  'PlanTaskReviewResolved',
  DomainEventType.ASSIGNMENT_COMPLETED,
  DomainEventType.AGENT_UNLOCKED,
  DomainEventType.AGENT_UPDATED,
  DomainEventType.AGENT_CREATED,
]);

export class PlanRecoveryCoordinator {
  readonly #planLifecycle: PlanLifecycleService;
  readonly #planExecution: PlanExecutionCoordinator;
  readonly #reviewTransitions: ReviewTransitionCoordinator;
  readonly #eventBus: EventBus;
  readonly #clock: RecoveryClock;
  #stopped = false;
  #started = false;
  #queued = false;
  #running: Promise<void> | null = null;
  #timer: unknown = null;
  #timerDelay = 0;
  #backoffIndex = 0;
  #unsubscribe: (() => void) | null = null;
  #passCount = 0;

  public constructor(options: PlanRecoveryCoordinatorOptions) {
    this.#planLifecycle = options.planLifecycle;
    this.#planExecution = options.planExecution;
    this.#reviewTransitions = options.reviewTransitions;
    this.#eventBus = options.eventBus;
    this.#clock = options.clock ?? nativeRecoveryClock();
  }

  public get passCount(): number { return this.#passCount; }
  public get stopped(): boolean { return this.#stopped; }

  public start(): void {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#eventBus.subscribe((event) => {
      if (this.#shouldWake(event)) this.requestRescan('event', true);
    });
    this.requestRescan('startup', true);
  }

  public requestRescan(_reason: string, resetBackoff = false): void {
    if (this.#stopped || this.#reviewTransitions.reconciliationRequired) return;
    if (resetBackoff) this.#backoffIndex = 0;
    this.#queued = true;
    this.#arm(resetBackoff ? 0 : undefined);
  }

  public async idle(): Promise<void> {
    for (let i = 0; i < 32; i += 1) {
      await Promise.resolve();
      if (this.#running) {
        await this.#running;
        continue;
      }
      if (this.#timer !== null && this.#timerDelay === 0) {
        await new Promise<void>((resolve) => { queueMicrotask(resolve); });
        continue;
      }
      return;
    }
  }

  public async runPass(): Promise<void> {
    if (this.#stopped || this.#reviewTransitions.reconciliationRequired) return;
    try { this.#reviewTransitions.assertReady(); }
    catch { return; }
    this.#queued = false;
    this.#passCount += 1;
    let deferred = 0;
    let dispatched = 0;
    for (const plan of this.#planLifecycle.listPlans()) {
      // stop() can flip this while resume() is in flight
      if (this.stopped) return;
      try {
        const result = await this.#planExecution.resume(plan.planId);
        deferred += result.deferredEligible;
        dispatched += result.dispatched;
      } catch (error) {
        const category = classify(error);
        const retryable = category === 'operational' || category === 'unavailable';
        const code = errorCode(error);
        this.#eventBus.publish({
          eventType: PLAN_RECOVERY_FAILED,
          payload: {
            planId: plan.planId,
            category,
            code,
            retryable,
          },
        });
        if (category === 'safety') {
          if (code === PLAN_REVIEW_RECONCILIATION_REQUIRED || code === 'PLAN_CORRUPT_SNAPSHOT') return;
          continue;
        }
        if (retryable) deferred += 1;
      }
    }
    if (dispatched > 0) this.#backoffIndex = 0;
    if (deferred > 0) {
      this.#queued = true;
      if (dispatched === 0) {
        this.#backoffIndex = Math.min(this.#backoffIndex + 1, RECOVERY_BACKOFF_MS.length - 1);
      }
    }
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#queued = false;
    this.#clearTimer();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#running) await this.#running;
  }

  #shouldWake(event: DomainEvent): boolean {
    return WAKE_EVENTS.has(event.eventType);
  }

  #arm(delayOverride?: number): void {
    if (this.#stopped || this.#running !== null) return;
    const delay = delayOverride ?? RECOVERY_BACKOFF_MS[this.#backoffIndex] ?? 5_000;
    if (this.#timer !== null) {
      if (delay >= this.#timerDelay) return;
      this.#clearTimer();
    }
    this.#timerDelay = delay;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#begin();
    }, delay);
  }

  #begin(): void {
    if (this.#stopped || this.#running !== null) return;
    this.#running = this.runPass()
      .catch((error: unknown) => {
        this.#eventBus.publishSystemError(error, {
          component: 'plan-recovery',
          category: 'operational',
          retryable: true,
        });
      })
      .finally(() => {
        this.#running = null;
        if (this.#stopped) return;
        if (this.#queued) this.#arm();
      });
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

function nativeRecoveryClock(): RecoveryClock {
  return {
    setTimeout(handler, delayMs) {
      if (delayMs <= 0) {
        let cancelled = false;
        queueMicrotask(() => { if (!cancelled) handler(); });
        return { cancel() { cancelled = true; } };
      }
      return setTimeout(handler, delayMs);
    },
    clearTimeout(id) {
      if (isCancelHandle(id)) {
        id.cancel();
        return;
      }
      clearTimeout(id as ReturnType<typeof setTimeout>);
    },
  };
}

function isCancelHandle(id: unknown): id is { cancel(): void } {
  return typeof id === 'object' && id !== null && 'cancel' in id
    && typeof (id as { cancel?: unknown }).cancel === 'function';
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string };
    if (typeof coded.code === 'string' && coded.code.length > 0) return coded.code;
    return error.message;
  }
  return 'PLAN_RECOVERY_UNKNOWN';
}

function classify(error: unknown): PlanRecoveryCategory {
  const code = errorCode(error);
  if (code === PLAN_REVIEW_RECONCILIATION_REQUIRED || code === 'PLAN_CORRUPT_SNAPSHOT'
    || code === PLAN_ASSIGNMENT_RECOVERY_REQUIRED
    || code === 'AGENT_DISPATCH_TURN_FAILED'
    || code === 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED'
    || code === 'AGENT_DISPATCH_RECONCILIATION_REQUIRED'
    || code === 'AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION'
    || code === 'AGENT_DISPATCH_STALE_PROFILE'
    || code === 'AGENT_DISPATCH_STALE_RESERVATION'
    || code === 'TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED') return 'safety';
  if (code === 'no-available-agent' || code === 'AGENT_SCHEDULER_NO_AVAILABLE_AGENT') return 'unavailable';
  if (code === 'PLAN_RUNTIME_LINK_CONFLICT' || code === 'PLAN_NOT_FOUND') return 'contract';
  return 'operational';
}
