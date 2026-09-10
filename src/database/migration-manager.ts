import type BetterSqlite3 from 'better-sqlite3';

import type { Migration } from './migrations.js';

export class MigrationManager {
  public constructor(
    private readonly connection: BetterSqlite3.Database,
    private readonly migrations: readonly Migration[],
  ) {}

  public migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      this.connection
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => (row as { version: number }).version),
    );

    const pending = [...this.migrations]
      .sort((left, right) => left.version - right.version)
      .filter((migration) => !applied.has(migration.version));

    for (const migration of pending) {
      this.apply(migration);
    }
  }

  public currentVersion(): number {
    const table = this.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (table === undefined) {
      return 0;
    }

    const row = this.connection
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };
    return row.version;
  }

  private apply(migration: Migration): void {
    this.connection.transaction(() => {
      this.connection.exec(migration.up);
      this.connection
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
