/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars, @typescript-eslint/no-unnecessary-condition */
import { randomUUID, createHash } from 'node:crypto';
import type { EventBus } from '../events/event-bus.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { ProjectRepository } from '../repositories/interfaces.js';
import type { Database } from '../database/database.js';

export type PlanState = 'DRAFT' | 'WAITING_APPROVAL' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'CANCELLED' | 'EXECUTING' | 'REVIEWING' | 'COMPLETED' | 'FAILED';
export type PlanTaskState = 'PENDING' | 'BLOCKED' | 'ELIGIBLE' | 'RUNNING' | 'REVIEWING' | 'COMPLETED' | 'FAILED';
export type DependencyState = 'BLOCKED' | 'ELIGIBLE' | 'RUNNING' | 'SATISFIED';
export type PlanDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';

export interface IntakeDto { readonly intakeId: string; readonly projectId: string; readonly createdBy: string; readonly goal: string; readonly leadAgentId: string; readonly status: 'OPEN' | 'PLANNING' | 'CANCELLED' | 'CLOSED'; readonly createdAt: string; }
export interface PlanVersionDto { readonly planId: string; readonly version: number; readonly proposalHash: string; readonly summary: string; readonly createdByAgentId: string; readonly createdAt: string; readonly tasks: readonly PlanTaskDto[]; readonly dependencies: readonly PlanDependencyDto[]; }
export interface PlanTaskDto { readonly planTaskId: string; readonly planId: string; readonly planVersion: number; readonly parentPlanTaskId: string | null; readonly taskId: string | null; readonly title: string; readonly description: string | null; readonly acceptanceCriteria: readonly string[]; readonly requiredCapabilities: readonly string[]; readonly requiredSpecialties: readonly string[]; readonly state: PlanTaskState; readonly dependencyState: DependencyState; readonly blockedBy: readonly string[]; readonly createdAt: string; }
export interface PlanDependencyDto { readonly planId: string; readonly planVersion: number; readonly prerequisitePlanTaskId: string; readonly dependentPlanTaskId: string; }
export interface PlanAggregateDto { readonly total: number; readonly pending: number; readonly blocked: number; readonly eligible: number; readonly running: number; readonly reviewing: number; readonly completed: number; readonly failed: number; readonly state: PlanState; }
export interface PlanDto { readonly planId: string; readonly intakeId: string; readonly projectId: string; readonly leadAgentId: string; readonly currentVersion: number; readonly state: PlanState; readonly aggregate: PlanAggregateDto; readonly createdAt: string; readonly updatedAt: string; readonly completedAt: string | null; readonly current: PlanVersionDto | null; }

interface InternalPlan extends Omit<PlanDto, 'state'|'aggregate'|'updatedAt'|'completedAt'|'current'> { state: PlanState; aggregate: PlanAggregateDto; updatedAt: string; completedAt: string | null; current: PlanVersionDto | null; versions: Map<number, PlanVersionDto>; }
type InternalIntake = IntakeDto;

export interface CreateIntakeInput { projectId: string; createdBy: string; goal: string; leadAgentId: string; }
export interface CreatePlanTaskInput { readonly clientId: string; readonly parentClientId?: string | null; readonly title: string; readonly description?: string | null; readonly acceptanceCriteria?: readonly string[]; readonly requiredCapabilities?: readonly string[]; readonly requiredSpecialties?: readonly string[]; }
export interface CreatePlanInput { intakeId: string; leadAgentId: string; summary: string; tasks: readonly CreatePlanTaskInput[]; dependencies: readonly { prerequisiteClientId: string; dependentClientId: string }[]; }

export class PlanLifecycleService {
  readonly #intakes = new Map<string, InternalIntake>();
  readonly #plans = new Map<string, InternalPlan>();
  public constructor(private readonly projects: ProjectRepository, private readonly agents: AgentRegistry, private readonly events: EventBus, private readonly database?: Database) { this.#load(); }

  public listIntakes(): readonly IntakeDto[] { return [...this.#intakes.values()].map((x) => ({ ...x })); }
  public listPlans(): readonly PlanDto[] { return [...this.#plans.values()].map((x) => this.#publicPlan(x)); }
  public getPlan(id: string): PlanDto | null { const p = this.#plans.get(id); return p ? this.#publicPlan(p) : null; }
  public createIntake(input: CreateIntakeInput): IntakeDto {
    this.#text(input.projectId, 256); this.#text(input.createdBy, 256); this.#text(input.goal, 128 * 1024); this.#text(input.leadAgentId, 256);
    if (!this.projects.findById(input.projectId) || !this.agents.getAgent(input.leadAgentId)) this.#error('NOT_FOUND');
    const now = new Date().toISOString(); const value: InternalIntake = Object.freeze({ intakeId: randomUUID(), ...input, status: 'OPEN', createdAt: now });
    this.#intakes.set(value.intakeId, value); this.#save(); this.#emit('IntakeCreated', value.intakeId, { intakeId: value.intakeId, projectId: value.projectId, leadAgentId: value.leadAgentId }); return value;
  }
  public createPlan(input: CreatePlanInput): PlanDto {
    const intake = this.#intakes.get(input.intakeId); if (!intake) this.#error('NOT_FOUND');
    if (!this.agents.getAgent(input.leadAgentId)) this.#error('NOT_FOUND');
    if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 1000) this.#error('INVALID');
    const planId = randomUUID(); const now = new Date().toISOString(); const ids: string[] = input.tasks.map(() => randomUUID());
    const clientIds = new Set(input.tasks.map((t) => t.clientId)); if (clientIds.size !== input.tasks.length || [...clientIds].some((x) => !x || x.includes('\0'))) this.#error('INVALID');
    const idSet = new Set<string>(ids); const idByClient = new Map(input.tasks.map((t, i) => [t.clientId, ids[i]]));
    const deps = input.dependencies.map((d) => ({ planId, planVersion: 1, prerequisitePlanTaskId: idByClient.get(d.prerequisiteClientId) ?? '', dependentPlanTaskId: idByClient.get(d.dependentClientId) ?? '' }));
    for (const d of deps) if (!idSet.has(d.prerequisitePlanTaskId) || !idSet.has(d.dependentPlanTaskId) || d.prerequisitePlanTaskId === d.dependentPlanTaskId) this.#error('INVALID');
    const tasks: PlanTaskDto[] = input.tasks.map((t, i) => ({ planTaskId: ids[i]!, planId, planVersion: 1, parentPlanTaskId: t.parentClientId ? (idByClient.get(t.parentClientId) ?? null) : null, taskId: null, title: this.#text(t.title, 16 * 1024), description: t.description ?? null, acceptanceCriteria: [...(t.acceptanceCriteria ?? [])], requiredCapabilities: [...(t.requiredCapabilities ?? [])], requiredSpecialties: [...(t.requiredSpecialties ?? [])], state: 'PENDING', dependencyState: 'ELIGIBLE', blockedBy: [], createdAt: now }));
    this.#validateDag(tasks, deps); const version: PlanVersionDto = { planId, version: 1, proposalHash: this.#hash({ summary: input.summary, tasks, deps }), summary: this.#text(input.summary, 16 * 1024), createdByAgentId: input.leadAgentId, createdAt: now, tasks: Object.freeze(tasks), dependencies: Object.freeze(deps) };
    const plan: InternalPlan = { planId, intakeId: input.intakeId, projectId: intake!.projectId, leadAgentId: input.leadAgentId, currentVersion: 1, state: 'WAITING_APPROVAL', aggregate: this.#aggregate('WAITING_APPROVAL', tasks), createdAt: now, updatedAt: now, completedAt: null, current: version, versions: new Map([[1, version]]) };
    this.#plans.set(planId, plan); this.#save(); this.#emit('PlanProposed', planId, { planId, planVersion: 1, intakeId: input.intakeId }); return this.#publicPlan(plan);
  }
  public decide(planId: string, version: number, decision: PlanDecision, actorId: string, summary: string): PlanDto {
    const plan = this.#plans.get(planId); if (!plan) this.#error('NOT_FOUND'); if (version !== plan!.currentVersion) this.#error('STALE'); if (!this.#text(actorId, 256)) this.#error('INVALID');
    if (!['WAITING_APPROVAL', 'CHANGES_REQUESTED'].includes(plan!.state)) this.#error('CONFLICT');
    const next: PlanState = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
    if (decision === 'REQUEST_CHANGES' && !this.#text(summary, 16 * 1024)) this.#error('INVALID'); plan!.state = next; plan!.updatedAt = new Date().toISOString(); plan!.aggregate = this.#aggregate(next, plan!.current!.tasks); this.#save(); this.#emit('PlanApprovalDecision', planId, { planId, planVersion: version, decision, actorId, summary }); return this.#publicPlan(plan!);
  }
  public start(planId: string, version: number): PlanDto { const p = this.#plans.get(planId); if (!p) this.#error('NOT_FOUND'); if (p!.currentVersion !== version || p!.state !== 'APPROVED') this.#error('CONFLICT'); p!.state = 'EXECUTING'; p!.updatedAt = new Date().toISOString(); p!.aggregate = this.#aggregate('EXECUTING', p!.current!.tasks); this.#save(); this.#emit('PlanStarted', planId, { planId, planVersion: version }); return this.#publicPlan(p!); }
  #publicPlan(p: InternalPlan): PlanDto { const { versions: _versions, ...rest } = p; return Object.freeze({ ...rest, current: p.current ? Object.freeze({ ...p.current, tasks: Object.freeze(p.current.tasks.map((t) => ({ ...t }))), dependencies: Object.freeze(p.current.dependencies.map((d) => ({ ...d }))) }) : null }); }
  #aggregate(state: PlanState, tasks: readonly PlanTaskDto[]): PlanAggregateDto { const count = (s: PlanTaskState) => tasks.filter((t) => t.state === s).length; return { total: tasks.length, pending: count('PENDING'), blocked: count('BLOCKED'), eligible: count('ELIGIBLE'), running: count('RUNNING'), reviewing: count('REVIEWING'), completed: count('COMPLETED'), failed: count('FAILED'), state }; }
  #validateDag(tasks: readonly PlanTaskDto[], deps: readonly PlanDependencyDto[]): void { const edges = new Map<string, string[]>(); for (const t of tasks) edges.set(t.planTaskId, []); for (const d of deps) edges.get(d.prerequisitePlanTaskId)!.push(d.dependentPlanTaskId); const visiting = new Set<string>(), done = new Set<string>(); const visit = (id: string): void => { if (visiting.has(id)) this.#error('CYCLE'); if (done.has(id)) return; visiting.add(id); for (const n of edges.get(id) ?? []) visit(n); visiting.delete(id); done.add(id); }; for (const id of edges.keys()) visit(id); }
  #emit(eventType: string, id: string, payload: unknown): void { this.events.publish({ eventType, projectId: null, payload: { planId: id, ...payload as Record<string, unknown> }, actor: 'system' }); }
  #hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  #save(): void { if (!this.database) return; const value = JSON.stringify({ intakes: [...this.#intakes.values()], plans: [...this.#plans.values()].map((p) => ({ ...p, versions: [...p.versions.entries()] })) }); this.database.connection.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run('public_lifecycle_snapshot', value, new Date().toISOString()); }
  #load(): void { if (!this.database) return; const row = this.database.connection.prepare('SELECT value FROM settings WHERE key=?').get('public_lifecycle_snapshot') as { value?: string } | undefined; if (!row?.value) return; try { const parsed = JSON.parse(row.value) as { intakes?: InternalIntake[]; plans?: Array<InternalPlan & { versions: [number, PlanVersionDto][] }> }; for (const intake of parsed.intakes ?? []) this.#intakes.set(intake.intakeId, Object.freeze(intake)); for (const plan of parsed.plans ?? []) this.#plans.set(plan.planId, { ...plan, versions: new Map(plan.versions ?? []) }); } catch { /* corrupt lifecycle data is ignored; API remains fail-closed */ } }
  #text(value: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) this.#error('INVALID'); return value; }
  #error(kind: string): never { const e = new Error(`PLAN_${kind}`); throw e; }
}
