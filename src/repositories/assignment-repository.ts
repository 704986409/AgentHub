import { randomUUID } from 'node:crypto';

import { AssignmentStatus, type Assignment } from '../core/types.js';
import { assertEnumValue } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { AssignmentRepository, CreateAssignmentInput } from './interfaces.js';
import { mapAssignment, type AssignmentRow } from './mappers.js';

export class SqliteAssignmentRepository implements AssignmentRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateAssignmentInput): Assignment {
    const status = input.status ?? AssignmentStatus.PENDING;
    assertEnumValue(AssignmentStatus, status, 'status');
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO assignments
        (id, task_id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, input.taskId, input.agentId, status, now, now);
    return this.findRequired(id);
  }

  public findById(id: string): Assignment | null {
    const row = this.database.connection.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      | AssignmentRow
      | undefined;
    return row === undefined ? null : mapAssignment(row);
  }

  public list(): Assignment[] {
    return (
      this.database.connection.prepare('SELECT * FROM assignments ORDER BY created_at, id').all() as AssignmentRow[]
    ).map(mapAssignment);
  }

  private findRequired(id: string): Assignment {
    const assignment = this.findById(id);
    if (assignment === null) throw new Error(`Created assignment ${id} was not found`);
    return assignment;
  }
}
