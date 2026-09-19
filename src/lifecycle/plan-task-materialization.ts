import type { Database } from '../database/database.js';

export interface PlanTaskMaterializationRecord {
  readonly planId: string;
  readonly planVersion: number;
  readonly planTaskId: string;
  readonly runtimeTaskId: string;
  readonly createdAt: string;
}

interface MaterializationRow {
  plan_id: string;
  plan_version: number;
  plan_task_id: string;
  runtime_task_id: string;
  created_at: string;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  return code.includes('SQLITE_CONSTRAINT') || code.includes('CONSTRAINT');
}

export class PlanTaskMaterializationStore {
  public constructor(private readonly database: Database) {}

  public get(planId: string, planVersion: number, planTaskId: string): PlanTaskMaterializationRecord | null {
    const row = this.database.connection.prepare(
      `SELECT * FROM plan_task_materializations WHERE plan_id = ? AND plan_version = ? AND plan_task_id = ?`,
    ).get(planId, planVersion, planTaskId) as MaterializationRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  public findByRuntimeTaskId(runtimeTaskId: string): PlanTaskMaterializationRecord | null {
    const rows = this.database.connection.prepare(
      `SELECT * FROM plan_task_materializations WHERE runtime_task_id = ?`,
    ).all(runtimeTaskId) as MaterializationRow[];
    if (rows.length > 1) failReconciliation();
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }

  public listByPlan(planId: string, planVersion: number): readonly PlanTaskMaterializationRecord[] {
    return (this.database.connection.prepare(
      `SELECT * FROM plan_task_materializations WHERE plan_id = ? AND plan_version = ?`,
    ).all(planId, planVersion) as MaterializationRow[]).map(mapRow);
  }

  public persist(record: PlanTaskMaterializationRecord): PlanTaskMaterializationRecord {
    const existing = this.get(record.planId, record.planVersion, record.planTaskId);
    if (existing) {
      if (existing.runtimeTaskId !== record.runtimeTaskId) failReconciliation();
      const byRuntime = this.findByRuntimeTaskId(record.runtimeTaskId);
      if (byRuntime && (byRuntime.planId !== record.planId || byRuntime.planVersion !== record.planVersion ||
        byRuntime.planTaskId !== record.planTaskId)) failReconciliation();
      return existing;
    }
    const owned = this.findByRuntimeTaskId(record.runtimeTaskId);
    if (owned) failReconciliation();
    try {
      this.database.connection.prepare(
        `INSERT INTO plan_task_materializations (plan_id, plan_version, plan_task_id, runtime_task_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(record.planId, record.planVersion, record.planTaskId, record.runtimeTaskId, record.createdAt);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = this.get(record.planId, record.planVersion, record.planTaskId);
      if (raced && raced.runtimeTaskId === record.runtimeTaskId) return raced;
      failReconciliation();
    }
    const stored = this.get(record.planId, record.planVersion, record.planTaskId);
    if (!stored) failReconciliation();
    return stored;
  }
}

function mapRow(row: MaterializationRow): PlanTaskMaterializationRecord {
  return Object.freeze({
    planId: row.plan_id,
    planVersion: row.plan_version,
    planTaskId: row.plan_task_id,
    runtimeTaskId: row.runtime_task_id,
    createdAt: row.created_at,
  });
}

function failReconciliation(): never {
  const error = new Error('PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED') as Error & { code: string };
  error.code = 'PLAN_RUNTIME_MATERIALIZATION_RECONCILIATION_REQUIRED';
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
