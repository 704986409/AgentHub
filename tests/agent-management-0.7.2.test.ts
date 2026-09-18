import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentManagementError,
  AgentManagementService,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentStatus,
  Database,
  EventBus,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type CreateManagedAgentInput,
  type UpdateManagedAgentInput,
} from '../src/index.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class FakeProvider implements AgentProvider {
  public constructor(public readonly id: string) {}
  public readonly capabilities = capabilities;
  public createSession(): AgentProviderSession {
    return {
      providerId: this.id,
      capabilities: this.capabilities,
      started: false,
      active: false,
      sessionId: undefined,
      start: () => Promise.resolve(),
      runTurn: () => Promise.reject(new Error('not implemented')),
      shutdown: () => Promise.resolve(),
    };
  }
}

const temporaryDirectories: string[] = [];
const openDatabases: Database[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCreateInput(overrides: Partial<CreateManagedAgentInput> = {}): CreateManagedAgentInput {
  return {
    projectId: null,
    name: overrides.name ?? 'Test Agent',
    providerId: overrides.providerId ?? 'claude',
    modelId: overrides.modelId ?? 'claude-3-7-sonnet',
    position: overrides.position ?? 'Developer',
    allowedComplexities: overrides.allowedComplexities ?? [TaskComplexity.SIMPLE],
    allowedRiskLevels: overrides.allowedRiskLevels ?? [TaskRisk.LOW],
    capabilities: overrides.capabilities ?? [],
    specialties: overrides.specialties ?? [],
    authority: overrides.authority ?? AgentAuthority.STANDARD,
    routingPriority: overrides.routingPriority ?? 1,
    enabled: overrides.enabled ?? true,
  };
}

function makeUpdateInput(agent: { name: string; position: string }, overrides: Partial<UpdateManagedAgentInput> = {}): UpdateManagedAgentInput {
  return {
    name: overrides.name ?? agent.name,
    providerId: overrides.providerId ?? 'claude',
    modelId: overrides.modelId ?? 'claude-3-7-sonnet',
    position: overrides.position ?? agent.position,
    allowedComplexities: overrides.allowedComplexities ?? [TaskComplexity.SIMPLE],
    allowedRiskLevels: overrides.allowedRiskLevels ?? [TaskRisk.LOW],
    capabilities: overrides.capabilities ?? [],
    specialties: overrides.specialties ?? [],
    authority: overrides.authority ?? AgentAuthority.STANDARD,
    routingPriority: overrides.routingPriority ?? 1,
  };
}

function setupHarness(options: { usableProviders?: Set<string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-mgt-072-'));
  temporaryDirectories.push(root);

  const database = new Database(join(root, 'test.db'));
  database.initialize();
  openDatabases.push(database);

  const agentRepository = new SqliteAgentRepository(database);
  const taskRepository = new SqliteTaskRepository(database);
  const assignmentRepository = new SqliteAssignmentRepository(database);
  const projectRepository = new SqliteProjectRepository(database);
  const eventBus = new EventBus();

  const profiles = new AgentProfileManager({ agentsDirectory: join(root, 'agents') });
  const agentRegistry = new AgentRegistry(agentRepository, profiles, eventBus);
  const taskManager = new TaskManager(taskRepository, new TaskStateMachine(), eventBus);

  const providerFactory = new AgentProviderFactory();
  providerFactory.register(new FakeProvider('claude'));
  providerFactory.register(new FakeProvider('cursor'));
  providerFactory.register(new FakeProvider('antigravity'));

  const pool = new AgentPool({ providerFactory, eventBus });

  const usableSet = options.usableProviders ?? new Set(['claude']);

  const service = new AgentManagementService({
    agentRegistry,
    agentPool: pool,
    providerFactory,
    projects: projectRepository,
    assignments: assignmentRepository,
    tasks: taskManager,
    eventBus,
    isProviderUsable: (id) => usableSet.has(id),
  });

  return { service, usableSet, agentRegistry };
}

describe('AgentManagementService 0.7.2 Provider Usability Guard', () => {
  it('rejects createAgent with enabled=true if provider is not usable (422 PROVIDER_NOT_USABLE)', () => {
    const { service } = setupHarness({ usableProviders: new Set(['claude']) });

    // cursor is registered in factory but unusable
    expect(() =>
      service.createAgent(
        makeCreateInput({
          name: 'Unusable Cursor Agent',
          providerId: 'cursor',
          modelId: 'cursor-fast',
          enabled: true,
        }),
      ),
    ).toThrow(AgentManagementError);

    try {
      service.createAgent(
        makeCreateInput({
          name: 'Unusable Cursor Agent',
          providerId: 'cursor',
          modelId: 'cursor-fast',
          enabled: true,
        }),
      );
    } catch (err) {
      expect((err as AgentManagementError).code).toBe('AGENT_PROVIDER_UNAVAILABLE');
    }
  }, 5_000);

  it('allows createAgent with enabled=false even if provider is temporarily unusable', () => {
    const { service } = setupHarness({ usableProviders: new Set(['claude']) });

    const agent = service.createAgent(
      makeCreateInput({
        name: 'Disabled Cursor Agent',
        providerId: 'cursor',
        modelId: 'cursor-fast',
        enabled: false,
      }),
    );

    expect(agent.provider).toBe('cursor');
    expect(agent.status).toBe(AgentStatus.DISABLED);
  }, 5_000);

  it('rejects enableAgent if provider is not usable, but succeeds once usable', () => {
    const { service, usableSet } = setupHarness({ usableProviders: new Set<string>() });

    const agent = service.createAgent(
      makeCreateInput({
        name: 'Pending Agent',
        providerId: 'antigravity',
        modelId: 'gemini-1.5-pro',
        enabled: false,
      }),
    );

    // Attempt enable when unusable -> 422
    expect(() => service.enableAgent(agent.id)).toThrow(AgentManagementError);
    try {
      service.enableAgent(agent.id);
    } catch (err) {
      expect((err as AgentManagementError).code).toBe('AGENT_PROVIDER_UNAVAILABLE');
    }

    // Now make it usable
    usableSet.add('antigravity');
    const enabled = service.enableAgent(agent.id);
    expect(enabled.status).toBe(AgentStatus.IDLE);
  }, 5_000);

  it('rejects updateAgent for active agent switching to unusable provider', () => {
    const { service } = setupHarness({ usableProviders: new Set(['claude']) });

    const agent = service.createAgent(
      makeCreateInput({
        name: 'Active Claude Agent',
        providerId: 'claude',
        modelId: 'claude-3-7-sonnet',
        enabled: true,
      }),
    );

    // Update to unusable provider 'cursor' while enabled -> 422
    expect(() =>
      service.updateAgent(
        agent.id,
        makeUpdateInput(agent, {
          providerId: 'cursor',
          modelId: 'cursor-fast',
        }),
      ),
    ).toThrow(AgentManagementError);

    // Disable agent first, then update -> succeeds
    service.disableAgent(agent.id);
    const updated = service.updateAgent(
      agent.id,
      makeUpdateInput(agent, {
        providerId: 'cursor',
        modelId: 'cursor-fast',
      }),
    );
    expect(updated.provider).toBe('cursor');
  }, 5_000);
});
