import BetterSqlite3 from 'better-sqlite3';

import { MigrationManager } from './migration-manager.js';
import { migrations } from './migrations.js';

export interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export class Database {
  readonly #connection: BetterSqlite3.Database;
  readonly #migrationManager: MigrationManager;

  public constructor(path: string, options: DatabaseOptions = {}) {
    this.#connection = new BetterSqlite3(path, options);
    this.#connection.pragma('foreign_keys = ON');
    this.#connection.pragma('journal_mode = WAL');
    this.#migrationManager = new MigrationManager(this.#connection, migrations);
  }

  public initialize(): void {
    this.#migrationManager.migrate();
  }

  public get migrationManager(): MigrationManager {
    return this.#migrationManager;
  }

  /** Internal data-layer access. Application modules should use repositories. */
  public get connection(): BetterSqlite3.Database {
    return this.#connection;
  }

  public close(): void {
    if (this.#connection.open) {
      this.#connection.close();
    }
  }
}
