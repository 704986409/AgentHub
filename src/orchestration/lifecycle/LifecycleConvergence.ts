import { AssignmentStatus, TaskStatus } from '../../core/types.js';
import type { TaskMergeResult } from '../../workspace/index.js';
import type { AssignmentManager } from '../../services/assignment-manager.js';
import type { TaskManager } from '../../services/task-manager.js';
import { lifecycleError, type TaskLifecycleReviewResult } from './TaskLifecycleContract.js';

export interface LifecycleReceipt {
  readonly mergeResult?: TaskMergeResult;
  readonly result: TaskLifecycleReviewResult;
}

const receipts = new WeakMap<AssignmentManager, Map<string, LifecycleReceipt>>();

type Assignments = Pick<AssignmentManager, 'getAssignment' | 'suspendActiveAssignment' |
  'finalizeFailedAssignment' | 'finalizeCompletedAssignment'>;
type Tasks = Pick<TaskManager, 'getTask'>;

/** Owns terminal convergence and process-local completion receipt recovery. */
export class LifecycleConvergence {
  readonly #assignments: Assignments;
  readonly #tasks: Tasks;
  readonly #receiptOwner: AssignmentManager;

  public constructor(assignments: Assignments, tasks: Tasks) {
    this.#assignments = assignments;
    this.#tasks = tasks;
    this.#receiptOwner = assignments as AssignmentManager;
  }

  public suspend(assignmentId: string, status: TaskStatus.BLOCKED | TaskStatus.WAITING_INPUT): void {
    try { this.#assignments.suspendActiveAssignment(assignmentId, status); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
  }

  public finalizeFailed(assignmentId: string): void {
    try { this.#assignments.finalizeFailedAssignment(assignmentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RECONCILIATION_REQUIRED'); }
  }

  public finalizeCompleted(assignmentId: string, merge?: TaskMergeResult): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { this.#assignments.finalizeCompletedAssignment(assignmentId); } catch { /* retry exact partial state */ }
      if (this.isCompletionConverged(assignmentId)) return;
    }
    throw lifecycleError('TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED', merge);
  }

  public isCompletionConverged(assignmentId: string): boolean {
    const assignment = this.#assignments.getAssignment(assignmentId);
    const task = assignment === null ? null : this.#tasks.getTask(assignment.taskId);
    return assignment?.status === AssignmentStatus.COMPLETED && task?.status === TaskStatus.COMPLETED &&
      task.assignedAgentId === null && task.assignmentId === null;
  }

  public getReceipt(key: string): LifecycleReceipt | undefined {
    return receipts.get(this.#receiptOwner)?.get(key);
  }

  public rememberReceipt(key: string, receipt: LifecycleReceipt): void {
    const byKey = receipts.get(this.#receiptOwner) ?? new Map<string, LifecycleReceipt>();
    byKey.set(key, receipt);
    receipts.set(this.#receiptOwner, byKey);
  }
}