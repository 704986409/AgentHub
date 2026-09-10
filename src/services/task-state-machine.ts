import { TaskStatus } from '../core/types.js';
import { assertEnumValue } from '../core/validation.js';

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TaskStatus.CREATED]: [TaskStatus.QUEUED, TaskStatus.CANCELLED],
  [TaskStatus.QUEUED]: [TaskStatus.ASSIGNED, TaskStatus.PAUSED, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
  [TaskStatus.ASSIGNED]: [TaskStatus.IMPLEMENTING, TaskStatus.QUEUED, TaskStatus.CANCELLED],
  [TaskStatus.IMPLEMENTING]: [TaskStatus.REVIEWING, TaskStatus.COMPLETED, TaskStatus.QUEUED, TaskStatus.WAITING_INPUT, TaskStatus.WAITING_APPROVAL, TaskStatus.WAITING_DEPENDENCY, TaskStatus.PAUSED, TaskStatus.BLOCKED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.REVIEWING]: [TaskStatus.COMPLETED, TaskStatus.REVISION_REQUIRED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.REVISION_REQUIRED]: [TaskStatus.IMPLEMENTING, TaskStatus.CANCELLED],
  [TaskStatus.WAITING_INPUT]: [TaskStatus.IMPLEMENTING, TaskStatus.CANCELLED],
  [TaskStatus.WAITING_APPROVAL]: [TaskStatus.IMPLEMENTING, TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  [TaskStatus.WAITING_DEPENDENCY]: [TaskStatus.QUEUED, TaskStatus.IMPLEMENTING, TaskStatus.CANCELLED],
  [TaskStatus.PAUSED]: [TaskStatus.QUEUED, TaskStatus.CANCELLED],
  [TaskStatus.BLOCKED]: [TaskStatus.QUEUED, TaskStatus.CANCELLED, TaskStatus.FAILED],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.PENDING]: [TaskStatus.QUEUED, TaskStatus.CANCELLED],
  [TaskStatus.IN_PROGRESS]: [TaskStatus.REVIEWING, TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED],
};

export class TaskStateMachine {
  public transition(current: TaskStatus, next: TaskStatus): TaskStatus {
    assertEnumValue(TaskStatus, current, 'current task status');
    assertEnumValue(TaskStatus, next, 'next task status');
    if (current === next) return current;
    if (!transitions[current].includes(next)) {
      throw new Error(`Invalid task transition: ${current} -> ${next}`);
    }
    return next;
  }

  public canTransition(current: TaskStatus, next: TaskStatus): boolean {
    assertEnumValue(TaskStatus, current, 'current task status');
    assertEnumValue(TaskStatus, next, 'next task status');
    return current === next || transitions[current].includes(next);
  }
}
