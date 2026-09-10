import { randomUUID } from 'node:crypto';

import {
  AgentAuthority,
  AgentStatus,
  TaskComplexity,
  TaskRisk,
  type Agent,
} from '../core/types.js';
import { assertEnumValue, assertNonEmpty } from '../core/validation.js';
import type { Database } from '../database/database.js';
import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from './interfaces.js';
import { mapAgent, type AgentRow } from './mappers.js';

export class SqliteAgentRepository implements AgentRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateAgentInput): Agent {
    assertNonEmpty(input.name, 'name');
    const status = input.status ?? AgentStatus.IDLE;
    const authority = input.authority ?? AgentAuthority.STANDARD;
    const capabilities = input.capabilities ?? [];
    const allowedComplexities = input.allowedComplexities ?? Object.values(TaskComplexity);
    const allowedRiskLevels = input.allowedRiskLevels ?? Object.values(TaskRisk);
    const specialties = input.specialties ?? [];
    assertEnumValue(AgentStatus, status, 'status');
    assertEnumValue(AgentAuthority, authority, 'authority');
    allowedComplexities.forEach((complexity) => assertEnumValue(TaskComplexity, complexity, 'allowedComplexity'));
    allowedRiskLevels.forEach((risk) => assertEnumValue(TaskRisk, risk, 'allowedRiskLevel'));
    if (!Number.isInteger(input.routingPriority ?? 0) || (input.routingPriority ?? 0) < 0) {
      throw new TypeError('routingPriority must be a non-negative integer');
    }
    [input.name, input.provider ?? 'unknown', input.model ?? 'unknown', input.position ?? 'Agent'].forEach((value) =>
      assertNonEmpty(value, 'agent field'),
    );

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(`INSERT INTO agents
        (id, project_id, name, provider, model, position, status, allowed_complexities, allowed_risk_levels,
         capabilities, specialties, authority, routing_priority, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.projectId ?? null,
        input.name.trim(),
        (input.provider ?? 'unknown').trim(),
        (input.model ?? 'unknown').trim(),
        (input.position ?? 'Agent').trim(),
        status,
        JSON.stringify(allowedComplexities),
        JSON.stringify(allowedRiskLevels),
        JSON.stringify(capabilities),
        JSON.stringify(specialties),
        authority,
        input.routingPriority ?? 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
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

  public update(id: string, input: UpdateAgentInput): Agent {
    const current = this.findRequired(id);
    if (current.status === AgentStatus.BUSY && Object.keys(input).some((key) => key !== 'status')) {
      throw new Error(`Agent ${id} is BUSY and its profile is locked`);
    }
    const next = {
      ...current,
      ...input,
      allowedComplexities: input.allowedComplexities ?? current.allowedComplexities,
      allowedRiskLevels: input.allowedRiskLevels ?? current.allowedRiskLevels,
      capabilities: input.capabilities ?? current.capabilities,
      specialties: input.specialties ?? current.specialties,
      updatedAt: new Date().toISOString(),
    };
    assertNonEmpty(next.name, 'name');
    assertNonEmpty(next.provider, 'provider');
    assertNonEmpty(next.model, 'model');
    assertNonEmpty(next.position, 'position');
    assertEnumValue(AgentStatus, next.status, 'status');
    assertEnumValue(AgentAuthority, next.authority, 'authority');
    next.allowedComplexities.forEach((complexity) => assertEnumValue(TaskComplexity, complexity, 'allowedComplexity'));
    next.allowedRiskLevels.forEach((risk) => assertEnumValue(TaskRisk, risk, 'allowedRiskLevel'));
    if (!Number.isInteger(next.routingPriority) || next.routingPriority < 0) {
      throw new TypeError('routingPriority must be a non-negative integer');
    }
    this.database.connection
      .prepare(`UPDATE agents SET name = ?, provider = ?, model = ?, position = ?, status = ?,
        allowed_complexities = ?, allowed_risk_levels = ?, capabilities = ?, specialties = ?, authority = ?,
        routing_priority = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .run(
        next.name.trim(),
        next.provider.trim(),
        next.model.trim(),
        next.position.trim(),
        next.status,
        JSON.stringify(next.allowedComplexities),
        JSON.stringify(next.allowedRiskLevels),
        JSON.stringify(next.capabilities),
        JSON.stringify(next.specialties),
        next.authority,
        next.routingPriority,
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return this.findRequired(id);
  }

  public delete(id: string): void {
    const current = this.findRequired(id);
    if (current.status === AgentStatus.BUSY) {
      throw new Error(`Agent ${id} is BUSY and cannot be deleted`);
    }
    this.database.connection.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  private findRequired(id: string): Agent {
    const agent = this.findById(id);
    if (agent === null) throw new Error(`Created agent ${id} was not found`);
    return agent;
  }
}
