import type { Task } from '../core/types.js';
import { TaskStatus } from '../core/types.js';
import type { CreateTaskInput, TaskRepository, UpdateTaskInput } from '../repositories/interfaces.js';
import { TaskStateMachine } from './task-state-machine.js';

export class TaskManager {
  public constructor(
    private readonly repository: TaskRepository,
    private readonly stateMachine: TaskStateMachine = new TaskStateMachine(),
  ) {}

  public createTask(input: CreateTaskInput): Task {
    return this.repository.create({ ...input, status: TaskStatus.CREATED });
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
    return this.repository.setStatus(id, next);
  }

  public cancelTask(id: string): Task {
    const task = this.requireTask(id);
    this.stateMachine.transition(task.status, TaskStatus.CANCELLED);
    return this.repository.setStatus(id, TaskStatus.CANCELLED);
  }

  private requireTask(id: string): Task {
    const task = this.repository.findById(id);
    if (task === null) throw new Error(`Task ${id} was not found`);
    return task;
  }
}
