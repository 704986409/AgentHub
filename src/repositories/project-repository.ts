import { randomUUID } from 'node:crypto';

import { assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { CreateProjectInput, ProjectRepository } from './interfaces.js';
import { mapProject, type ProjectRow } from './mappers.js';
import type { Project } from '../core/types.js';

export class SqliteProjectRepository implements ProjectRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateProjectInput): Project {
    assertNonEmpty(input.name, 'name');
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name.trim(), input.description ?? null, now, now);
    return this.findRequired(id);
  }

  public findById(id: string): Project | null {
    const row = this.database.connection.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row === undefined ? null : mapProject(row);
  }

  public list(): Project[] {
    return (this.database.connection.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as ProjectRow[]).map(
      mapProject,
    );
  }

  private findRequired(id: string): Project {
    const project = this.findById(id);
    if (project === null) throw new Error(`Created project ${id} was not found`);
    return project;
  }
}
