import type { Database } from '../../../database/database.js';
import {
  type CodexSession,
  type CodexSessionRecord,
  type CodexSessionStore,
  normalizeSessionKey,
  validateCodexSession,
} from './CodexSessionStore.js';

interface CodexSessionRow {
  session_key: string;
  thread_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
}

export class SqliteCodexSessionStore implements CodexSessionStore {
  public constructor(private readonly database: Database) {}

  public get(sessionKey: string): CodexSessionRecord | undefined {
    const normalizedKey = normalizeSessionKey(sessionKey);
    const row = this.database.connection
      .prepare('SELECT * FROM codex_sessions WHERE session_key = ?')
      .get(normalizedKey) as CodexSessionRow | undefined;
    return row === undefined ? undefined : mapSessionRow(row);
  }

  public save(sessionKey: string, session: CodexSession): CodexSessionRecord {
    const normalizedKey = normalizeSessionKey(sessionKey);
    const validated = validateCodexSession(session);
    const now = new Date().toISOString();
    this.database.connection.prepare(`
      INSERT INTO codex_sessions (session_key, thread_id, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        thread_id = excluded.thread_id,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(normalizedKey, validated.threadId, validated.sessionId, now, now);
    const saved = this.get(normalizedKey);
    if (saved === undefined) throw new Error(`Saved Codex session ${normalizedKey} was not found`);
    return saved;
  }

  public delete(sessionKey: string): void {
    this.database.connection
      .prepare('DELETE FROM codex_sessions WHERE session_key = ?')
      .run(normalizeSessionKey(sessionKey));
  }
}

function mapSessionRow(row: CodexSessionRow): CodexSessionRecord {
  const session = validateCodexSession({ threadId: row.thread_id, sessionId: row.session_id });
  return {
    sessionKey: normalizeSessionKey(row.session_key),
    ...session,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
