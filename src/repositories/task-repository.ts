import { randomUUID } from 'node:crypto';

import { TaskComplexity, TaskRisk, TaskStatus, type Task } from '../core/types.js';
import { assertEnumValue, assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { CreateTaskInput, TaskRepository } from './interfaces.js';
import { mapTask, type TaskRow } from './mappers.js';

export class SqliteTaskRepository implements TaskRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateTaskInput): Task {
    assertNonEmpty(input.title, 'title');
    const status = input.status ?? TaskStatus.PENDING;
    assertEnumValue(TaskStatus, status, 'status');
    assertEnumValue(TaskComplexity, input.complexity, 'complexity');
    assertEnumValue(TaskRisk, input.risk, 'risk');

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO tasks
        (id, project_id, title, description, status, complexity, risk, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.projectId,
        input.title.trim(),
        input.description ?? null,
        status,
        input.complexity,
        input.risk,
        now,
        now,
      );
    return this.findRequired(id);
  }

  public findById(id: string): Task | null {
    const row = this.database.connection.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row === undefined ? null : mapTask(row);
  }

  public list(): Task[] {
    return (this.database.connection.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as TaskRow[]).map(
      mapTask,
    );
  }

  private findRequired(id: string): Task {
    const task = this.findById(id);
    if (task === null) throw new Error(`Created task ${id} was not found`);
    return task;
  }
}
