import { randomUUID } from 'node:crypto';

import type { AgentHubEvent } from '../core/types.js';
import { assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { CreateEventInput, EventRepository } from './interfaces.js';
import { mapEvent, type EventRow } from './mappers.js';

export class SqliteEventRepository implements EventRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateEventInput): AgentHubEvent {
    assertNonEmpty(input.entityType, 'entityType');
    assertNonEmpty(input.eventType, 'eventType');
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO events
        (id, project_id, entity_type, entity_id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.projectId ?? null,
        input.entityType.trim(),
        input.entityId ?? null,
        input.eventType.trim(),
        JSON.stringify(input.payload ?? {}),
        now,
      );
    return this.findRequired(id);
  }

  public findById(id: string): AgentHubEvent | null {
    const row = this.database.connection.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return row === undefined ? null : mapEvent(row);
  }

  public list(): AgentHubEvent[] {
    return (this.database.connection.prepare('SELECT * FROM events ORDER BY created_at, id').all() as EventRow[]).map(
      mapEvent,
    );
  }

  private findRequired(id: string): AgentHubEvent {
    const event = this.findById(id);
    if (event === null) throw new Error(`Created event ${id} was not found`);
    return event;
  }
}
