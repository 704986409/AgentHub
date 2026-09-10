import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  Database,
  MigrationManager,
  migrations,
  SqliteCodexSessionStore,
} from '../src/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite Codex session store', () => {
  it('saves, gets, overwrites, and deletes provider-level sessions', () => {
    const database = createDatabase();
    const store = new SqliteCodexSessionStore(database);
    const first = store.save(' agent-A ', { threadId: 'thread-A', sessionId: 'session-A' });

    expect(store.get('agent-A')).toEqual(first);
    const updated = store.save('agent-A', { threadId: 'thread-A', sessionId: 'session-A-resumed' });
    expect(updated).toMatchObject({
      sessionKey: 'agent-A', threadId: 'thread-A', sessionId: 'session-A-resumed', createdAt: first.createdAt,
    });
    expect(database.connection.prepare('SELECT * FROM codex_sessions').all()).toHaveLength(1);

    store.delete('agent-A');
    expect(store.get('agent-A')).toBeUndefined();
    database.close();
  });

  it('persists multiple isolated session keys across a real database restart', () => {
    const directory = createDirectory();
    const path = join(directory, 'sessions.db');
    let database = new Database(path);
    database.initialize();
    let store = new SqliteCodexSessionStore(database);
    store.save('agent-A', { threadId: 'thread-A', sessionId: 'session-A' });
    store.save('agent-B', { threadId: 'thread-B', sessionId: 'session-B' });
    database.close();

    database = new Database(path);
    database.initialize();
    store = new SqliteCodexSessionStore(database);
    expect(store.get('agent-A')).toMatchObject({ threadId: 'thread-A', sessionId: 'session-A' });
    expect(store.get('agent-B')).toMatchObject({ threadId: 'thread-B', sessionId: 'session-B' });
    database.close();
  });

  it('rejects empty, overlong, and invalid persisted session metadata', () => {
    const database = createDatabase();
    const store = new SqliteCodexSessionStore(database);
    expect(() => store.get('   ')).toThrow(/sessionKey/);
    expect(() => store.get('x'.repeat(257))).toThrow(/sessionKey/);
    expect(() => store.save('valid', { threadId: '', sessionId: 'session' })).toThrow(/threadId/);
    expect(() => store.save('valid', { threadId: 'thread', sessionId: '' })).toThrow(/sessionId/);

    database.connection.pragma('ignore_check_constraints = ON');
    database.connection.prepare(`INSERT INTO codex_sessions
      (session_key, thread_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('invalid-row', '', '', 'now', 'now');
    expect(() => store.get('invalid-row')).toThrow(/threadId/);
    database.close();
  });

  it('migrates an existing V0.2 database without changing existing data', () => {
    const directory = createDirectory();
    const path = join(directory, 'v02.db');
    const connection = new BetterSqlite3(path);
    new MigrationManager(connection, migrations.filter((migration) => migration.version <= 4)).migrate();
    connection.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', 'Existing project', null, 'before', 'before');
    connection.close();

    const database = new Database(path);
    database.initialize();
    expect(database.migrationManager.currentVersion()).toBe(5);
    expect(database.connection.prepare('SELECT name FROM projects WHERE id = ?').get('project-1'))
      .toEqual({ name: 'Existing project' });
    expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_sessions'").get())
      .toEqual({ name: 'codex_sessions' });
    database.close();
  });
});

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.initialize();
  return database;
}

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-session-'));
  directories.push(directory);
  return directory;
}
