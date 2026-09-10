import type { Task } from '../core/types.js';
import { TaskStatus } from '../core/types.js';
import type { CreateTaskInput, TaskRepository, UpdateTaskInput } from '../repositories/interfaces.js';
import { TaskStateMachine } from './task-state-machine.js';
import type { EventBus } from '../events/event-bus.js';
import { DomainEventType } from '../core/types.js';

export class TaskManager {
  public constructor(
    private readonly repository: TaskRepository,
    private readonly stateMachine: TaskStateMachine = new TaskStateMachine(),
    private readonly eventBus?: EventBus,
  ) {}

  public createTask(input: CreateTaskInput): Task {
    const task = this.repository.create({ ...input, status: TaskStatus.CREATED });
    this.eventBus?.publish({ eventType: DomainEventType.TASK_CREATED, taskId: task.id, projectId: task.projectId, payload: task });
    return task;
  }

  public getTask(id: string): Task | null {
    return this.repository.findById(id);
  }

  public listTasks(): Task[] {
    return this.repository.list();
  }

  public updateTask(id: string, input: UpdateTaskInput): Task {
    return this.repository.update(id, input);
  }

  public transitionTask(id: string, next: TaskStatus): Task {
    const task = this.requireTask(id);
    this.stateMachine.transition(task.status, next);
    const updated = this.repository.setStatus(id, next);
    this.eventBus?.publish({
      eventType: DomainEventType.TASK_STATUS_CHANGED,
      taskId: updated.id,
      projectId: updated.projectId,
      oldStatus: task.status,
      newStatus: updated.status,
      payload: { taskId: updated.id },
    });
    return updated;
  }

  public cancelTask(id: string): Task {
    const task = this.requireTask(id);
    this.stateMachine.transition(task.status, TaskStatus.CANCELLED);
    return this.transitionTask(id, TaskStatus.CANCELLED);
  }

  private requireTask(id: string): Task {
    const task = this.repository.findById(id);
    if (task === null) throw new Error(`Task ${id} was not found`);
    return task;
  }
}
