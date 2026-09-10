import { randomUUID } from 'node:crypto';

import { TaskComplexity, TaskRisk, TaskStatus, type Task } from '../core/types.js';
import { assertEnumValue, assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { CreateTaskInput, TaskRepository, UpdateTaskInput } from './interfaces.js';
import { mapTask, type TaskRow } from './mappers.js';

export class SqliteTaskRepository implements TaskRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateTaskInput): Task {
    assertNonEmpty(input.title, 'title');
    const status = input.status ?? TaskStatus.CREATED;
    assertEnumValue(TaskStatus, status, 'status');
    assertEnumValue(TaskComplexity, input.complexity, 'complexity');
    assertEnumValue(TaskRisk, input.risk, 'risk');

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO tasks
        (id, project_id, title, description, required_capabilities, required_specialties, acceptance_criteria,
         status, complexity, risk, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.projectId,
        input.title.trim(),
        input.description ?? null,
        JSON.stringify(input.requiredCapabilities ?? []),
        JSON.stringify(input.requiredSpecialties ?? []),
        JSON.stringify(input.acceptanceCriteria ?? []),
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

  public update(id: string, input: UpdateTaskInput): Task {
    const current = this.findRequired(id);
    const next = {
      ...current,
      ...input,
      requiredCapabilities: input.requiredCapabilities ?? current.requiredCapabilities,
      requiredSpecialties: input.requiredSpecialties ?? current.requiredSpecialties,
      acceptanceCriteria: input.acceptanceCriteria ?? current.acceptanceCriteria,
      assignedAgentId: input.assignedAgentId === undefined ? current.assignedAgentId : input.assignedAgentId,
      assignmentId: input.assignmentId === undefined ? current.assignmentId : input.assignmentId,
      updatedAt: new Date().toISOString(),
    };
    assertNonEmpty(next.title, 'title');
    assertEnumValue(TaskComplexity, next.complexity, 'complexity');
    assertEnumValue(TaskRisk, next.risk, 'risk');
    this.database.connection
      .prepare(`UPDATE tasks SET title = ?, description = ?, required_capabilities = ?, required_specialties = ?,
        acceptance_criteria = ?, complexity = ?, risk = ?, assigned_agent_id = ?, assignment_id = ?, updated_at = ?
        WHERE id = ?`)
      .run(
        next.title.trim(),
        next.description,
        JSON.stringify(next.requiredCapabilities),
        JSON.stringify(next.requiredSpecialties),
        JSON.stringify(next.acceptanceCriteria),
        next.complexity,
        next.risk,
        next.assignedAgentId,
        next.assignmentId,
        next.updatedAt,
        id,
      );
    return this.findRequired(id);
  }

  public setStatus(id: string, status: TaskStatus): Task {
    assertEnumValue(TaskStatus, status, 'status');
    this.findRequired(id);
    this.database.connection
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return this.findRequired(id);
  }

  private findRequired(id: string): Task {
    const task = this.findById(id);
    if (task === null) throw new Error(`Created task ${id} was not found`);
    return task;
  }
}
