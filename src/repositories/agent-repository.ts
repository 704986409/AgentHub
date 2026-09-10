import { randomUUID } from 'node:crypto';

import { AgentAuthority, AgentCapability, AgentStatus, type Agent } from '../core/types.js';
import { assertEnumValue, assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { AgentRepository, CreateAgentInput } from './interfaces.js';
import { mapAgent, type AgentRow } from './mappers.js';

export class SqliteAgentRepository implements AgentRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateAgentInput): Agent {
    assertNonEmpty(input.name, 'name');
    const status = input.status ?? AgentStatus.IDLE;
    const authority = input.authority ?? AgentAuthority.STANDARD;
    const capabilities = input.capabilities ?? [];
    assertEnumValue(AgentStatus, status, 'status');
    assertEnumValue(AgentAuthority, authority, 'authority');
    capabilities.forEach((capability) => assertEnumValue(AgentCapability, capability, 'capability'));

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO agents
        (id, project_id, name, status, capabilities, authority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId ?? null, input.name.trim(), status, JSON.stringify(capabilities), authority, now, now);
    return this.findRequired(id);
  }

  public findById(id: string): Agent | null {
    const row = this.database.connection.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row === undefined ? null : mapAgent(row);
  }

  public list(): Agent[] {
    return (this.database.connection.prepare('SELECT * FROM agents ORDER BY created_at, id').all() as AgentRow[]).map(
      mapAgent,
    );
  }

  private findRequired(id: string): Agent {
    const agent = this.findById(id);
    if (agent === null) throw new Error(`Created agent ${id} was not found`);
    return agent;
  }
}
