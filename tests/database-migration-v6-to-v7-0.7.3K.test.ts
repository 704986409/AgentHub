import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Database, MigrationManager, migrations, type Migration } from '../src/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('0.7.3K schema v6 to v7 assignment foreign-key integrity', () => {
  it('K1-K5/K8/K10/K12. v6 → v7 preserves assignment and event references', () => {
    const seeded = seedV6();
    expect(seeded.connection.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get()).toEqual({ version: 6 });
    seeded.connection.close();

    const database = new Database(seeded.path);
    database.initialize();
    expect(database.migrationManager.currentVersion()).toBe(7);
    expect(foreignKeys(database.connection)).toBe(1);
    expect(foreignKeyCheck(database.connection)).toEqual([]);

    const assignmentA = row(database.connection, 'SELECT * FROM assignments WHERE id = ?', seeded.assignmentA);
    const assignmentB = row(database.connection, 'SELECT * FROM assignments WHERE id = ?', seeded.assignmentB);
    const released = row(database.connection, 'SELECT * FROM assignments WHERE id = ?', seeded.released);
    const completed = row(database.connection, 'SELECT * FROM assignments WHERE id = ?', seeded.completed);
    expect(assignmentA).toMatchObject({ id: seeded.assignmentA, task_id: seeded.taskA, agent_id: seeded.agentId, status: 'DISPATCHING' });
    expect(assignmentB).toMatchObject({ id: seeded.assignmentB, task_id: seeded.taskB, agent_id: seeded.agentId, status: 'ACCEPTED' });
    expect(released).toMatchObject({ id: seeded.released, status: 'RELEASED' });
    expect(completed).toMatchObject({ id: seeded.completed, status: 'COMPLETED' });

    const events = database.connection.prepare('SELECT event_type, assignment_id, task_id, agent_id FROM events ORDER BY id')
      .all() as Array<{ event_type: string; assignment_id: string; task_id: string; agent_id: string }>;
    expect(events).toEqual([
      { event_type: 'AssignmentCreated', assignment_id: seeded.assignmentA, task_id: seeded.taskA, agent_id: seeded.agentId },
      { event_type: 'AssignmentAccepted', assignment_id: seeded.assignmentB, task_id: seeded.taskB, agent_id: seeded.agentId },
      { event_type: 'TaskStatusChanged', assignment_id: seeded.assignmentA, task_id: seeded.taskA, agent_id: seeded.agentId },
      { event_type: 'PlanTaskDispatched', assignment_id: seeded.assignmentB, task_id: seeded.taskB, agent_id: seeded.agentId },
    ]);

    const taskA = row(database.connection, 'SELECT assignment_id, assigned_agent_id FROM tasks WHERE id = ?', seeded.taskA);
    expect(taskA).toEqual({ assignment_id: seeded.assignmentA, assigned_agent_id: seeded.agentId });

    database.initialize();
    expect(database.migrationManager.currentVersion()).toBe(7);
    expect(foreignKeys(database.connection)).toBe(1);
    database.close();
  });

  it('K6/K7. live unique index is enforced and RELEASED plus new live assignment is allowed', () => {
    const seeded = seedV6();
    seeded.connection.close();
    const database = new Database(seeded.path);
    database.initialize();

    expect(() => database.connection.prepare(`INSERT INTO assignments
      (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
      VALUES ('live-dup', ?, ?, '1.0.0', 'hash', 'DISPATCHING', 'now', 'now')`)
      .run(seeded.taskA, seeded.agentId)).toThrow();

    database.connection.prepare(`INSERT INTO assignments
      (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
      VALUES ('live-after-released', ?, ?, '1.0.0', 'hash', 'DISPATCHING', 'now', 'now')`)
      .run(seeded.releasedTask, seeded.agentId);
    expect(row(database.connection, 'SELECT status FROM assignments WHERE id = ?', 'live-after-released'))
      .toEqual({ status: 'DISPATCHING' });
    expect(row(database.connection, 'SELECT status FROM assignments WHERE id = ?', seeded.released))
      .toEqual({ status: 'RELEASED' });
    database.close();
  });

  it('K9/K11. migration 7 failure rolls back and restores foreign_keys', () => {
    const seeded = seedV6();
    const beforeEvents = seeded.connection.prepare('SELECT id, assignment_id FROM events ORDER BY id').all();
    seeded.connection.close();

    const connection = new BetterSqlite3(seeded.path);
    connection.pragma('foreign_keys = ON');
    const failing: Migration = {
      version: 7,
      name: 'assignment_dispatch_recovery',
      foreignKeysOff: true,
      up: `
        CREATE TABLE assignments_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          spec_version TEXT NOT NULL DEFAULT '1.0.0',
          profile_hash TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO assignments_new (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
          SELECT id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at FROM assignments;
        DROP TABLE assignments;
        ALTER TABLE assignments_new RENAME TO assignments;
        SELECT * FROM __migration_7_failpoint__;
      `,
    };
    expect(() => new MigrationManager(connection, [...migrations.filter((item) => item.version <= 6), failing]).migrate())
      .toThrow();
    expect(connection.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get())
      .toEqual({ version: 6 });
    expect(row(connection, 'SELECT id FROM assignments WHERE id = ?', seeded.assignmentA))
      .toEqual({ id: seeded.assignmentA });
    expect(connection.prepare('SELECT id, assignment_id FROM events ORDER BY id').all()).toEqual(beforeEvents);
    expect(foreignKeys(connection)).toBe(1);
    connection.close();
  });
});

function seedV6() {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-073K-'));
  directories.push(directory);
  const path = join(directory, 'v6.db');
  const connection = new BetterSqlite3(path);
  new MigrationManager(connection, migrations.filter((migration) => migration.version <= 6)).migrate();
  connection.pragma('foreign_keys = ON');

  const now = '2026-01-01T00:00:00.000Z';
  const projectId = 'project-1';
  const agentId = 'agent-1';
  const taskA = 'task-a';
  const taskB = 'task-b';
  const releasedTask = 'task-released';
  const completedTask = 'task-completed';
  const assignmentA = 'asg-a';
  const assignmentB = 'asg-b';
  const released = 'asg-released';
  const completed = 'asg-completed';

  connection.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)')
    .run(projectId, 'P', now, now);
  connection.prepare(`INSERT INTO agents
    (id, project_id, name, status, capabilities, authority, created_at, updated_at, provider, model, position, enabled)
    VALUES (?, ?, 'Worker', 'IDLE', '[]', 'STANDARD', ?, ?, 'fake', 'm', 'Developer', 1)`)
    .run(agentId, projectId, now, now);

  for (const [id, assignmentId] of [
    [taskA, assignmentA], [taskB, assignmentB], [releasedTask, released], [completedTask, completed],
  ] as const) {
    connection.prepare(`INSERT INTO tasks
      (id, project_id, title, status, complexity, risk, assigned_agent_id, assignment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'ASSIGNED', 'SIMPLE', 'LOW', ?, ?, ?, ?)`)
      .run(id, projectId, id, agentId, assignmentId, now, now);
  }

  connection.prepare(`INSERT INTO assignments
    (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, '1.0.0', 'hash', ?, ?, ?)`)
    .run(assignmentA, taskA, agentId, 'DISPATCHING', now, now);
  connection.prepare(`INSERT INTO assignments
    (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, '1.0.0', 'hash', ?, ?, ?)`)
    .run(assignmentB, taskB, agentId, 'ACCEPTED', now, now);
  connection.prepare(`INSERT INTO assignments
    (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, '1.0.0', 'hash', ?, ?, ?)`)
    .run(released, releasedTask, agentId, 'RELEASED', now, now);
  connection.prepare(`INSERT INTO assignments
    (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, '1.0.0', 'hash', ?, ?, ?)`)
    .run(completed, completedTask, agentId, 'COMPLETED', now, now);

  insertEvent(connection, 'e1', 'AssignmentCreated', assignmentA, taskA, agentId, projectId, now);
  insertEvent(connection, 'e2', 'AssignmentAccepted', assignmentB, taskB, agentId, projectId, now);
  insertEvent(connection, 'e3', 'TaskStatusChanged', assignmentA, taskA, agentId, projectId, now);
  insertEvent(connection, 'e4', 'PlanTaskDispatched', assignmentB, taskB, agentId, projectId, now);

  return {
    path, connection, agentId, taskA, taskB, releasedTask, assignmentA, assignmentB, released, completed,
  };
}

function insertEvent(
  connection: BetterSqlite3.Database,
  id: string,
  eventType: string,
  assignmentId: string,
  taskId: string,
  agentId: string,
  projectId: string,
  now: string,
): void {
  connection.prepare(`INSERT INTO events
    (id, event_id, project_id, agent_id, task_id, assignment_id, entity_type, entity_id, event_type, payload, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'assignment', ?, ?, '{}', ?, ?)`)
    .run(id, id, projectId, agentId, taskId, assignmentId, assignmentId, eventType, now, now);
}

function row(connection: BetterSqlite3.Database, sql: string, id: string): Record<string, unknown> {
  return connection.prepare(sql).get(id) as Record<string, unknown>;
}

function foreignKeys(connection: BetterSqlite3.Database): number {
  return Number(connection.pragma('foreign_keys', { simple: true }));
}

function foreignKeyCheck(connection: BetterSqlite3.Database): unknown[] {
  return connection.pragma('foreign_key_check') as unknown[];
}
