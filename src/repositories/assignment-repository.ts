import { randomUUID } from 'node:crypto';

import { AssignmentStatus, type Assignment } from '../core/types.js';
import { assertEnumValue } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { AssignmentRepository, CreateAssignmentInput, UpdateAssignmentInput } from './interfaces.js';
import { mapAssignment, type AssignmentRow } from './mappers.js';

export class SqliteAssignmentRepository implements AssignmentRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateAssignmentInput): Assignment {
    const status = input.status ?? AssignmentStatus.DISPATCHING;
    assertEnumValue(AssignmentStatus, status, 'status');
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO assignments
        (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.taskId, input.agentId, input.specVersion ?? '1.0.0', input.profileHash ?? '', status, now, now);
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

  public update(id: string, input: UpdateAssignmentInput): Assignment {
    const current = this.findRequired(id);
    const next = {
      ...current,
      ...input,
      specVersion: input.specVersion ?? current.specVersion,
      profileHash: input.profileHash ?? current.profileHash,
      updatedAt: new Date().toISOString(),
    };
    assertEnumValue(AssignmentStatus, next.status, 'status');
    this.database.connection
      .prepare('UPDATE assignments SET spec_version = ?, profile_hash = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next.specVersion, next.profileHash, next.status, next.updatedAt, id);
    return this.findRequired(id);
  }

  private findRequired(id: string): Assignment {
    const assignment = this.findById(id);
    if (assignment === null) throw new Error(`Created assignment ${id} was not found`);
    return assignment;
  }
}
