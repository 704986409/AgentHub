import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentHubHttpServer,
  agentDeleteDto,
  agentDto,
  snapshotCreateAgent,
  snapshotUpdateAgent,
} from '../src/api/index.js';
import {
  AgentAuthority,
  AgentManagementError,
  AgentManagementService,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentStatus,
  AssignmentManager,
  Database,
  DomainEventType,
  EventBus,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  type Agent,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type CreateManagedAgentInput,
  type UpdateManagedAgentInput,
} from '../src/index.js';

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return '';
}

const timeout = 15_000;
const fetchTimeout = { signal: AbortSignal.timeout(8_000) };
const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class FakeProvider implements AgentProvider {
  public createCalls = 0;
  public constructor(public readonly id: string) {}
  public readonly capabilities = capabilities;
  public createSession(): AgentProviderSession {
    this.createCalls += 1;
    throw new Error('management tests must not create provider sessions');
  }
}

class ControllableProfiles extends AgentProfileManager {
  public failNextWrites = 0;
  public failRemove = false;
  public override writeProfile(agent: Agent, userRules = ''): string {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error('injected profile write failure');
    }
    return super.writeProfile(agent, userRules);
  }
  public override removeProfile(agentId: string): void {
    if (this.failRemove) throw new Error('injected profile remove failure');
    super.removeProfile(agentId);
  }
}

const validCreate: CreateManagedAgentInput = Object.freeze({
  projectId: null,
  name: 'Worker',
  providerId: 'claude',
  modelId: 'claude-sonnet-4',
  position: 'Developer',
  allowedComplexities: Object.freeze([TaskComplexity.SIMPLE]),
  allowedRiskLevels: Object.freeze([TaskRisk.LOW]),
  capabilities: Object.freeze(['coding']),
  specialties: Object.freeze(['typescript']),
  authority: AgentAuthority.STANDARD,
  routingPriority: 1,
  enabled: true,
});

function updateFrom(agent: Agent, overrides: Partial<UpdateManagedAgentInput> = {}): UpdateManagedAgentInput {
  return {
    name: overrides.name ?? agent.name,
    providerId: overrides.providerId ?? agent.provider,
    modelId: overrides.modelId ?? agent.model,
    position: overrides.position ?? agent.position,
    allowedComplexities: overrides.allowedComplexities ?? [...agent.allowedComplexities],
    allowedRiskLevels: overrides.allowedRiskLevels ?? [...agent.allowedRiskLevels],
    capabilities: overrides.capabilities ?? [...agent.capabilities],
    specialties: overrides.specialties ?? [...agent.specialties],
    authority: overrides.authority ?? agent.authority,
    routingPriority: overrides.routingPriority ?? agent.routingPriority,
  };
}

describe('V0.7.1 agent DTO snapshots', () => {
  it('exposes exact modelId and never the raw model field', { timeout }, () => {
    const dto = agentDto({
      id: 'agent-a', projectId: null, name: 'Worker', provider: 'claude', model: 'claude-sonnet-4',
      position: 'Developer', status: AgentStatus.IDLE, allowedComplexities: [TaskComplexity.SIMPLE],
      allowedRiskLevels: [TaskRisk.LOW], capabilities: ['coding'], specialties: ['typescript'],
      authority: AgentAuthority.STANDARD, routingPriority: 1, enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(dto.modelId).toBe('claude-sonnet-4');
    expect(JSON.stringify(dto)).not.toContain('"model"');
    expect(JSON.parse(JSON.stringify(dto))).toEqual(expect.objectContaining({ modelId: 'claude-sonnet-4' }));
    expect(agentDeleteDto({ agentId: 'agent-a', deleted: true })).toEqual({ agentId: 'agent-a', deleted: true });
  });

  it('accepts exact create/update contracts and rejects extra keys, status, whitespace, and bounds', { timeout }, () => {
    const created = snapshotCreateAgent(validCreate);
    expect(created.modelId).toBe('claude-sonnet-4');
    expect(() => snapshotCreateAgent({ ...validCreate, status: 'IDLE' })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, extra: true })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, name: ' Worker' })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, name: 'Worker\0' })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, routingPriority: 1.5 })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, routingPriority: -1 })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, routingPriority: '1' })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, capabilities: ['coding', 'coding'] })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, allowedComplexities: ['SIMPLE', 'SIMPLE'] })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, allowedComplexities: ['simple'] })).toThrow();
    expect(() => snapshotCreateAgent({ ...validCreate, capabilities: Array.from({ length: 257 }, (_, index) => `c${String(index)}`) })).toThrow();
    const updated = snapshotUpdateAgent(updateFrom({
      id: 'agent-a', projectId: null, name: validCreate.name, provider: validCreate.providerId,
      model: validCreate.modelId, position: validCreate.position, status: AgentStatus.IDLE,
      allowedComplexities: [...validCreate.allowedComplexities],
      allowedRiskLevels: [...validCreate.allowedRiskLevels],
      capabilities: [...validCreate.capabilities], specialties: [...validCreate.specialties],
      authority: validCreate.authority, routingPriority: validCreate.routingPriority, enabled: true,
      createdAt: '', updatedAt: '',
    }));
    expect(updated.modelId).toBe('claude-sonnet-4');
    expect(() => snapshotUpdateAgent({ ...updated, enabled: true })).toThrow();
    expect(() => snapshotUpdateAgent({ ...updated, status: 'IDLE' })).toThrow();
    expect(() => snapshotUpdateAgent({ ...updated, projectId: null })).toThrow();
    expect(() => snapshotUpdateAgent({ ...updated, extra: 1 })).toThrow();
  });
});

describe('V0.7.1 runtime-safe agent management', () => {
  let directory!: string;
  let database!: Database;
  let profiles!: ControllableProfiles;
  let agents!: AgentRegistry;
  let tasks!: TaskManager;
  let assignmentRepository!: SqliteAssignmentRepository;
  let assignments!: AssignmentManager;
  let projects!: SqliteProjectRepository;
  let agentRepository!: SqliteAgentRepository;
  let bus!: EventBus;
  let providerFactory!: AgentProviderFactory;
  let claude!: FakeProvider;
  let codex!: FakeProvider;
  let pool!: AgentPool;
  let management!: AgentManagementService;
  let scheduler!: AgentScheduler;

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function setup(): void {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-mgmt-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    bus = new EventBus();
    profiles = new ControllableProfiles({ agentsDirectory: join(directory, 'agents') });
    agentRepository = new SqliteAgentRepository(database);
    agents = new AgentRegistry(agentRepository, profiles, bus);
    tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignmentRepository = new SqliteAssignmentRepository(database);
    assignments = new AssignmentManager(assignmentRepository, tasks, agents, (id) => agents.calculateProfileHash(id), bus);
    projects = new SqliteProjectRepository(database);
    providerFactory = new AgentProviderFactory();
    claude = new FakeProvider('claude');
    codex = new FakeProvider('codex');
    providerFactory.register(claude);
    providerFactory.register(codex);
    pool = new AgentPool({ providerFactory, eventBus: bus });
    management = new AgentManagementService({
      agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments: assignmentRepository, tasks, eventBus: bus,
    });
    scheduler = new AgentScheduler({
      taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments,
    });
  }

  it('registers created agents into the shared pool without restart and keeps them schedulable', { timeout }, () => {
    setup();
    const project = projects.create({ name: 'Office' });
    const agent = management.createAgent({ ...validCreate, projectId: project.id });
    expect(pool.has(agent.id)).toBe(true);
    expect(pool.getSnapshot(agent.id)).toMatchObject({ providerId: 'claude', state: 'IDLE' });
    expect(JSON.stringify(agentDto(agent))).toContain('"modelId":"claude-sonnet-4"');
    const task = tasks.createTask({
      projectId: project.id, title: 'Work', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
      requiredCapabilities: ['coding'],
    });
    expect(scheduler.scheduleTask({ taskId: task.id })).toMatchObject({ outcome: 'reserved', agentId: agent.id });
    expect(claude.createCalls).toBe(0);
    expect(codex.createCalls).toBe(0);
  });

  it('registers disabled supported agents and keeps them out of scheduling until enabled', { timeout }, () => {
    setup();
    const project = projects.create({ name: 'Office' });
    const agent = management.createAgent({ ...validCreate, projectId: project.id, enabled: false });
    expect(agent.enabled).toBe(false);
    expect(agent.status).toBe(AgentStatus.DISABLED);
    expect(pool.has(agent.id)).toBe(true);
    const task = tasks.createTask({
      projectId: project.id, title: 'Work', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    expect(scheduler.scheduleTask({ taskId: task.id }).outcome).toBe('no-available-agent');
    const enabled = management.enableAgent(agent.id);
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe(AgentStatus.IDLE);
    expect(scheduler.scheduleTask({ taskId: task.id })).toMatchObject({ outcome: 'reserved', agentId: agent.id });
  });

  it('rebinds pool identity on provider/model change and leaves it unchanged for profile-only edits', { timeout }, () => {
    setup();
    const agent = management.createAgent(validCreate);
    const before = pool.getSnapshot(agent.id);
    const renamed = management.updateAgent(agent.id, updateFrom(agent, { name: 'Renamed' }));
    expect(pool.getSnapshot(renamed.id)).toMatchObject({ providerId: 'claude' });
    expect(pool.getSnapshot(renamed.id).agentId).toBe(before.agentId);
    const modeled = management.updateAgent(agent.id, updateFrom(renamed, { modelId: 'claude-opus-4' }));
    expect(pool.getSnapshot(modeled.id)).toMatchObject({ providerId: 'claude' });
    expect(agents.getAgent(agent.id)?.model).toBe('claude-opus-4');
    const rebound = management.updateAgent(agent.id, updateFrom(modeled, { providerId: 'codex', modelId: 'gpt-5' }));
    expect(pool.getSnapshot(rebound.id)).toMatchObject({ providerId: 'codex' });
    expect(agents.getAgent(agent.id)?.provider).toBe('codex');
  });

  it('rejects unsupported providers before mutating registry, profile, or pool', { timeout }, () => {
    setup();
    expect(() => management.createAgent({ ...validCreate, providerId: 'cursor' })).toThrow(AgentManagementError);
    expect(agents.listAgents()).toEqual([]);
    expect(pool.list()).toEqual([]);
  });

  it('allows disable of legacy unsupported agents and rejects enable until rebound to a supported provider', { timeout }, () => {
    setup();
    const legacy = agentRepository.create({
      name: 'Legacy', provider: 'cursor', model: 'cursor-model', position: 'Developer', enabled: true,
    });
    profiles.writeProfile(legacy);
    expect(() => management.enableAgent(legacy.id)).toThrow(AgentManagementError);
    const disabled = management.disableAgent(legacy.id);
    expect(disabled.enabled).toBe(false);
    const rebound = management.updateAgent(legacy.id, updateFrom(disabled, { providerId: 'claude', modelId: 'claude-sonnet-4' }));
    expect(pool.has(rebound.id)).toBe(true);
    expect(pool.getSnapshot(rebound.id).providerId).toBe('claude');
  });

  it('protects busy/reserved agents from update, disable, and delete', { timeout }, () => {
    setup();
    const project = projects.create({ name: 'Office' });
    const agent = management.createAgent({ ...validCreate, projectId: project.id });
    const task = tasks.createTask({
      projectId: project.id, title: 'Busy', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    const reserved = scheduler.scheduleTask({ taskId: task.id });
    expect(reserved.outcome).toBe('reserved');
    expect(() => management.updateAgent(agent.id, updateFrom(agent, { name: 'No' }))).toThrow(AgentManagementError);
    expect(() => management.disableAgent(agent.id)).toThrow(AgentManagementError);
    expect(() => management.deleteAgent(agent.id)).toThrow(AgentManagementError);
    expect(agents.getAgent(agent.id)).not.toBeNull();
  });

  it('deletes unused idle agents and denies history or task-referenced agents', { timeout }, () => {
    setup();
    const project = projects.create({ name: 'Office' });
    const unused = management.createAgent({ ...validCreate, projectId: project.id, name: 'Unused' });
    const deleted = management.deleteAgent(unused.id);
    expect(deleted).toEqual({ agentId: unused.id, deleted: true });
    expect(agents.getAgent(unused.id)).toBeNull();
    expect(pool.has(unused.id)).toBe(false);
    expect(existsSync(profiles.profilePath(unused.id))).toBe(false);

    const historical = management.createAgent({ ...validCreate, projectId: project.id, name: 'Historical' });
    const task = tasks.createTask({
      projectId: project.id, title: 'History', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    assignments.createAssignment({ taskId: task.id, agentId: historical.id });
    expect(() => management.deleteAgent(historical.id)).toThrow(AgentManagementError);
    expect(agents.getAgent(historical.id)).not.toBeNull();
    expect(assignmentRepository.list()).toHaveLength(1);

    const referenced = management.createAgent({ ...validCreate, projectId: project.id, name: 'Referenced' });
    const referencedTask = tasks.createTask({
      projectId: project.id, title: 'Assigned', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    tasks.updateTask(referencedTask.id, { assignedAgentId: referenced.id });
    expect(tasks.getTask(referencedTask.id)?.assignedAgentId).toBe(referenced.id);
    expect(() => management.deleteAgent(referenced.id)).toThrow(AgentManagementError);
  });

  it('publishes AgentDeleted only after a complete safe delete', { timeout }, () => {
    setup();
    const published: string[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });
    const agent = management.createAgent(validCreate);
    management.deleteAgent(agent.id);
    expect(published).toContain(DomainEventType.AGENT_CREATED);
    expect(published).toContain(DomainEventType.AGENT_DELETED);
  });

  it('rolls back registry create when profile write fails', { timeout }, () => {
    setup();
    profiles.failNextWrites = 1;
    expect(() => management.createAgent(validCreate)).toThrow();
    expect(agents.listAgents()).toEqual([]);
  });

  it('restores prior registry/profile when update profile write fails', { timeout }, () => {
    setup();
    const agent = management.createAgent(validCreate);
    profiles.failNextWrites = 1;
    expect(() => management.updateAgent(agent.id, updateFrom(agent, { name: 'Broken' }))).toThrow();
    expect(agents.getAgent(agent.id)?.name).toBe('Worker');
  });

  it('restores the agent when profile removal fails during safe delete', { timeout }, () => {
    setup();
    const agent = management.createAgent(validCreate);
    profiles.failRemove = true;
    expect(() => management.deleteAgent(agent.id)).toThrow();
    expect(agents.getAgent(agent.id)?.id).toBe(agent.id);
    expect(pool.has(agent.id)).toBe(true);
  });

  it('compensates registry/profile when pool registration fails after create', { timeout }, () => {
    setup();
    const original = pool.register.bind(pool);
    Object.assign(pool, { register: () => { throw new Error('injected pool failure'); } });
    expect(() => management.createAgent(validCreate)).toThrow();
    expect(agents.listAgents()).toEqual([]);
    Object.assign(pool, { register: original });
  });

  it('restores previous runtime binding when rebind registration fails', { timeout }, () => {
    setup();
    const agent = management.createAgent(validCreate);
    const original = pool.register.bind(pool);
    let failNext = true;
    Object.assign(pool, {
      register: (registration: Parameters<AgentPool['register']>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected rebind failure');
        }
        return original(registration);
      },
    });
    expect(() => management.updateAgent(agent.id, updateFrom(agent, { providerId: 'codex', modelId: 'gpt-5' }))).toThrow();
    expect(agents.getAgent(agent.id)?.provider).toBe('claude');
    expect(pool.has(agent.id)).toBe(true);
    expect(pool.getSnapshot(agent.id).providerId).toBe('claude');
  });

  it('surfaces reconciliation-required when compensation itself fails', { timeout }, () => {
    setup();
    const agent = management.createAgent(validCreate);
    profiles.failNextWrites = 2;
    try {
      management.updateAgent(agent.id, updateFrom(agent, { name: 'Broken' }));
      throw new Error('expected reconciliation');
    } catch (error) {
      expect(errorCode(error)).toContain('RECONCILIATION');
    }
  });
});

describe('V0.7.1 agent HTTP API', () => {
  let directory: string | undefined;
  let database: Database | undefined;
  let server: AgentHubHttpServer | undefined;
  let base = '';
  let pool!: AgentPool;
  let agents!: AgentRegistry;
  let assignmentRepository!: SqliteAssignmentRepository;
  let claude!: FakeProvider;
  let projectId = '';

  afterEach(async () => {
    if (server !== undefined) {
      await Promise.race([
        server.stop(),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('server stop timed out')), 5_000); }),
      ]).catch(() => undefined);
    }
    if (database !== undefined) database.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-http-mgmt-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    const bus = new EventBus();
    const profiles = new AgentProfileManager({ agentsDirectory: join(directory, 'agents') });
    const agentRepository = new SqliteAgentRepository(database);
    agents = new AgentRegistry(agentRepository, profiles, bus);
    const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignmentRepository = new SqliteAssignmentRepository(database);
    const assignments = new AssignmentManager(assignmentRepository, tasks, agents, (id) => agents.calculateProfileHash(id), bus);
    const projects = new SqliteProjectRepository(database);
    const project = projects.create({ name: 'Office' });
    projectId = project.id;
    const providerFactory = new AgentProviderFactory();
    claude = new FakeProvider('claude');
    providerFactory.register(claude);
    providerFactory.register(new FakeProvider('codex'));
    pool = new AgentPool({ providerFactory, eventBus: bus });
    const management = new AgentManagementService({
      agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments: assignmentRepository, tasks, eventBus: bus,
    });
    const scheduler = new AgentScheduler({
      taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments,
    });
    const application = {
      projects, agents, agentManagement: management, tasks, assignments, assignmentQueries: assignmentRepository,
      events: { list: () => [] }, eventBus: bus, scheduler, dispatcher: {}, lifecycle: {},
      buildTestPlan: { commands: [] }, targetBranch: 'main',
    } as never;
    server = new AgentHubHttpServer({ application, port: 0 });
    const address = await server.start();
    base = `http://${address.host}:${String(address.port)}`;
  }

  function headers(key: string): Record<string, string> {
    return { 'content-type': 'application/json', 'idempotency-key': key };
  }

  it('exposes health 0.7.1-a.1 and full agent mutation routes with idempotency', { timeout }, async () => {
    await start();
    const health = await fetch(`${base}/api/v1/health`, fetchTimeout);
    expect(await health.json()).toMatchObject({ ok: true, data: { status: 'ok', version: '0.7.1-a.1' } });
    const createBody = JSON.stringify({ ...validCreate, projectId });
    const created = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('create-1'), body: createBody, ...fetchTimeout,
    });
    expect(created.status).toBe(201);
    const createdJson = await created.json() as { data: { agentId: string; modelId: string; status: string } };
    expect(createdJson.data.modelId).toBe('claude-sonnet-4');
    expect(createdJson.data.status).toBe('IDLE');
    const agentId = createdJson.data.agentId;
    expect(pool.has(agentId)).toBe(true);

    const replay = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('create-1'), body: createBody, ...fetchTimeout,
    });
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: { agentId: string } }).data.agentId).toBe(agentId);

    const conflict = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('create-1'),
      body: JSON.stringify({ ...validCreate, projectId, name: 'Other' }), ...fetchTimeout,
    });
    expect(conflict.status).toBe(409);

    const missingKey = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: createBody, ...fetchTimeout,
    });
    expect(missingKey.status).toBe(400);

    const updateBody = JSON.stringify({
      name: 'Renamed', providerId: 'claude', modelId: 'claude-sonnet-4', position: 'Developer',
      allowedComplexities: ['SIMPLE'], allowedRiskLevels: ['LOW'], capabilities: ['coding'],
      specialties: ['typescript'], authority: 'STANDARD', routingPriority: 1,
    });
    const updated = await fetch(`${base}/api/v1/agents/${agentId}`, {
      method: 'PUT', headers: headers('update-1'), body: updateBody, ...fetchTimeout,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { name: string } }).data.name).toBe('Renamed');

    const disabled = await fetch(`${base}/api/v1/agents/${agentId}/disable`, {
      method: 'POST', headers: headers('disable-1'), body: '{}', ...fetchTimeout,
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json() as { data: { enabled: boolean; status: string } }).data).toMatchObject({
      enabled: false, status: 'DISABLED',
    });

    const enabled = await fetch(`${base}/api/v1/agents/${agentId}/enable`, {
      method: 'POST', headers: headers('enable-1'), body: '{}', ...fetchTimeout,
    });
    expect(enabled.status).toBe(200);

    const alreadyEnabled = await fetch(`${base}/api/v1/agents/${agentId}/enable`, {
      method: 'POST', headers: headers('enable-again'), body: '{}', ...fetchTimeout,
    });
    expect(alreadyEnabled.status).toBe(409);
    expect(await alreadyEnabled.json()).toMatchObject({
      error: { code: 'AGENTHUB_API_CONFLICT' },
    });

    const methodConflict = await fetch(`${base}/api/v1/agents/${agentId}/disable`, {
      method: 'POST', headers: headers('update-1'), body: '{}', ...fetchTimeout,
    });
    expect(methodConflict.status).toBe(409);

    const deleted = await fetch(`${base}/api/v1/agents/${agentId}`, {
      method: 'DELETE', headers: { 'idempotency-key': 'delete-1' }, ...fetchTimeout,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { agentId, deleted: true } });
    expect(agents.getAgent(agentId)).toBeNull();
    expect(pool.has(agentId)).toBe(false);
    expect(claude.createCalls).toBe(0);
  });

  it('maps provider, not-found, and history-delete conflicts onto public API codes', { timeout }, async () => {
    await start();
    const unsupported = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('cursor-1'),
      body: JSON.stringify({ ...validCreate, projectId, providerId: 'cursor' }), ...fetchTimeout,
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({
      error: { code: 'AGENTHUB_API_PROVIDER_UNAVAILABLE' },
    });

    const missingProject = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('missing-project'),
      body: JSON.stringify({ ...validCreate, projectId: 'missing' }), ...fetchTimeout,
    });
    expect(missingProject.status).toBe(404);

    const created = await fetch(`${base}/api/v1/agents`, {
      method: 'POST', headers: headers('keep-history'),
      body: JSON.stringify({ ...validCreate, projectId }), ...fetchTimeout,
    });
    const agentId = (await created.json() as { data: { agentId: string } }).data.agentId;
    const task = await fetch(`${base}/api/v1/tasks`, {
      method: 'POST', headers: headers('task-1'),
      body: JSON.stringify({ projectId, title: 'Keep', complexity: 'SIMPLE', risk: 'LOW' }), ...fetchTimeout,
    });
    expect(task.status).toBe(201);
    const taskId = (await task.json() as { data: { taskId: string } }).data.taskId;
    assignmentRepository.create({ taskId, agentId });
    const denied = await fetch(`${base}/api/v1/agents/${agentId}`, {
      method: 'DELETE', headers: { 'idempotency-key': 'delete-history' }, ...fetchTimeout,
    });
    expect(denied.status).toBe(409);
    expect(agents.getAgent(agentId)).not.toBeNull();
    expect(assignmentRepository.list()).toHaveLength(1);
  });
});

describe('0.7.1A Enable guard hardening', () => {
  let directory: string | undefined;
  let database: Database | undefined;
  let bus: EventBus;
  let profiles: ControllableProfiles;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignmentRepository: SqliteAssignmentRepository;
  let projects: SqliteProjectRepository;
  let providerFactory: AgentProviderFactory;
  let pool: AgentPool;
  let management: AgentManagementService;

  function setup(): void {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-enable-guard-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    bus = new EventBus();
    profiles = new ControllableProfiles({ agentsDirectory: join(directory, 'agents') });
    const agentRepository = new SqliteAgentRepository(database);
    agents = new AgentRegistry(agentRepository, profiles, bus);
    tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignmentRepository = new SqliteAssignmentRepository(database);
    new AssignmentManager(assignmentRepository, tasks, agents, (id) => agents.calculateProfileHash(id), bus);
    projects = new SqliteProjectRepository(database);
    providerFactory = new AgentProviderFactory();
    providerFactory.register(new FakeProvider('claude'));
    providerFactory.register(new FakeProvider('codex'));
    pool = new AgentPool({ providerFactory, eventBus: bus });
    management = new AgentManagementService({
      agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments: assignmentRepository, tasks, eventBus: bus,
    });
  }

  afterEach(() => {
    if (database !== undefined) database.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('enables disabled supported agent when runtime is clean', { timeout }, () => {
    setup();
    const created = management.createAgent({ ...validCreate, enabled: false });
    expect(created.enabled).toBe(false);
    expect(created.status).toBe(AgentStatus.DISABLED);

    const enabled = management.enableAgent(created.id);
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe(AgentStatus.IDLE);
    expect(pool.has(created.id)).toBe(true);
  });

  it('rejects enable when agent is already enabled', { timeout }, () => {
    setup();
    const created = management.createAgent({ ...validCreate, enabled: true });
    expect(created.enabled).toBe(true);

    try {
      management.enableAgent(created.id);
      expect.unreachable('expected enable conflict');
    } catch (error) {
      expect(errorCode(error)).toBe('AGENT_ALREADY_ENABLED');
    }
  });

  it('denies enable when agent status is BUSY', { timeout }, () => {
    setup();
    const created = management.createAgent({ ...validCreate, enabled: false });
    agents.updateAgent(created.id, { status: AgentStatus.BUSY });

    try {
      management.enableAgent(created.id);
      expect.unreachable('expected runtime busy error');
    } catch (error) {
      expect(errorCode(error)).toBe('AGENT_RUNTIME_BUSY');
    }
  });

  it('denies enable when runtime pool snapshot is reserved', { timeout }, () => {
    setup();
    const created = management.createAgent({ ...validCreate, enabled: false });
    pool.reserve(created.id, { taskId: 'task-mock', assignmentId: 'assign-mock', specVersion: '1.0.0', profileHash: 'hash-mock' });

    try {
      management.enableAgent(created.id);
      expect.unreachable('expected runtime busy error');
    } catch (error) {
      expect(errorCode(error)).toBe('AGENT_RUNTIME_BUSY');
    }
  });

  it('denies enable for legacy unsupported disabled agent', { timeout }, () => {
    setup();
    const legacy = agents.createAgent({
      name: 'Legacy Cursor',
      provider: 'cursor',
      model: 'auto',
      position: 'Developer',
      status: AgentStatus.DISABLED,
      allowedComplexities: [TaskComplexity.SIMPLE],
      allowedRiskLevels: [TaskRisk.LOW],
      capabilities: ['coding'],
      specialties: [],
      authority: AgentAuthority.STANDARD,
      routingPriority: 1,
      enabled: false,
    });

    try {
      management.enableAgent(legacy.id);
      expect.unreachable('expected provider unavailable error');
    } catch (error) {
      expect(errorCode(error)).toBe('AGENT_PROVIDER_UNAVAILABLE');
    }
  });
});

describe('0.7.1A Management event atomicity', () => {
  let directory: string | undefined;
  let database: Database | undefined;
  let bus: EventBus;
  let profiles: ControllableProfiles;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignmentRepository: SqliteAssignmentRepository;
  let projects: SqliteProjectRepository;
  let providerFactory: AgentProviderFactory;
  let pool: AgentPool;
  let management: AgentManagementService;

  function setup(): void {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-event-atomicity-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    bus = new EventBus();
    profiles = new ControllableProfiles({ agentsDirectory: join(directory, 'agents') });
    const agentRepository = new SqliteAgentRepository(database);
    agents = new AgentRegistry(agentRepository, profiles, bus);
    tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignmentRepository = new SqliteAssignmentRepository(database);
    new AssignmentManager(assignmentRepository, tasks, agents, (id) => agents.calculateProfileHash(id), bus);
    projects = new SqliteProjectRepository(database);
    providerFactory = new AgentProviderFactory();
    providerFactory.register(new FakeProvider('claude'));
    providerFactory.register(new FakeProvider('codex'));
    pool = new AgentPool({ providerFactory, eventBus: bus });
    management = new AgentManagementService({
      agentRegistry: agents, agentPool: pool, providerFactory, projects, assignments: assignmentRepository, tasks, eventBus: bus,
    });
  }

  afterEach(() => {
    if (database !== undefined) database.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('emits zero AgentCreated and zero AgentDeleted when create fails during pool registration', { timeout }, () => {
    setup();
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    const originalRegister = pool.register.bind(pool);
    Object.assign(pool, {
      register: () => { throw new Error('injected pool register failure'); },
    });

    expect(() => management.createAgent(validCreate)).toThrow();
    Object.assign(pool, { register: originalRegister });

    expect(published.filter((e) => e === DomainEventType.AGENT_CREATED)).toHaveLength(0);
    expect(published.filter((e) => e === DomainEventType.AGENT_DELETED)).toHaveLength(0);
    expect(agents.listAgents()).toEqual([]);
  });

  it('emits no false successful AgentUpdated event when update rebind fails', { timeout }, () => {
    setup();
    const created = management.createAgent(validCreate);
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    const originalRegister = pool.register.bind(pool);
    let failNext = true;
    Object.assign(pool, {
      register: (registration: Parameters<AgentPool['register']>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected rebind failure');
        }
        return originalRegister(registration);
      },
    });

    expect(() => management.updateAgent(created.id, updateFrom(created, { providerId: 'codex', modelId: 'gpt-5' }))).toThrow();
    Object.assign(pool, { register: originalRegister });

    const updateEvents = published.filter((e) => e === DomainEventType.AGENT_UPDATED);
    expect(updateEvents).toHaveLength(0);
    expect(agents.getAgent(created.id)?.provider).toBe('claude');
  });

  it('emits no AgentDeleted event when delete fails and compensates', { timeout }, () => {
    setup();
    const created = management.createAgent(validCreate);
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    profiles.failRemove = true;
    expect(() => management.deleteAgent(created.id)).toThrow();
    profiles.failRemove = false;

    const deleteEvents = published.filter((e) => e === DomainEventType.AGENT_DELETED);
    expect(deleteEvents).toHaveLength(0);
    expect(agents.getAgent(created.id)?.id).toBe(created.id);
  });

  it('publishes exactly one AgentCreated on successful create', { timeout }, () => {
    setup();
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    management.createAgent(validCreate);
    expect(published.filter((e) => e === DomainEventType.AGENT_CREATED)).toHaveLength(1);
    expect(published.filter((e) => e === DomainEventType.AGENT_DELETED)).toHaveLength(0);
  });

  it('publishes exactly one AgentUpdated on successful update', { timeout }, () => {
    setup();
    const created = management.createAgent(validCreate);
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    management.updateAgent(created.id, updateFrom(created, { name: 'Renamed Worker' }));
    expect(published.filter((e) => e === DomainEventType.AGENT_UPDATED)).toHaveLength(1);
  });

  it('publishes exactly one AgentDeleted on successful safe delete', { timeout }, () => {
    setup();
    const created = management.createAgent(validCreate);
    const published: DomainEventType[] = [];
    bus.subscribe((event) => { published.push(event.eventType); });

    management.deleteAgent(created.id);
    expect(published.filter((e) => e === DomainEventType.AGENT_DELETED)).toHaveLength(1);
  });
});
