import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentHubHttpServer,
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AssignmentManager,
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
  type AgentHubApplication,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
} from '../src/index.js';

class MockProvider implements AgentProvider {
  public constructor(
    public readonly id: string,
    public readonly capabilities: AgentProviderCapabilities,
  ) {}

  public createSession(): AgentProviderSession {
    return {
      providerId: this.id,
      capabilities: this.capabilities,
      started: false,
      active: false,
      sessionId: undefined,
      start: () => Promise.resolve(),
      runTurn: () => Promise.reject(new Error('not used')),
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

function setupSchedulerHarness() {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-exec-routing-'));
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
  const agents = new AgentRegistry(agentRepository, profiles, eventBus);
  const tasks = new TaskManager(taskRepository, new TaskStateMachine(), eventBus);
  const assignments = new AssignmentManager(
    assignmentRepository,
    tasks,
    agents,
    (id) => agents.calculateProfileHash(id),
    eventBus,
  );

  const providerFactory = new AgentProviderFactory();
  // Codex: only manager-directive
  providerFactory.register(
    new MockProvider('codex', {
      outputProtocols: ['manager-directive'],
      sessionContinuation: false,
    }),
  );
  // Claude: worker-result
  providerFactory.register(
    new MockProvider('claude', {
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    }),
  );
  // Cursor: worker-result
  providerFactory.register(
    new MockProvider('cursor', {
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    }),
  );
  // Antigravity: worker-result
  providerFactory.register(
    new MockProvider('antigravity', {
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    }),
  );

  const pool = new AgentPool({ providerFactory, eventBus });

  const scheduler = new AgentScheduler({
    taskManager: tasks,
    agentRegistry: agents,
    providerFactory,
    agentPool: pool,
    assignmentManager: assignments,
  });

  const project = projectRepository.create({ name: 'Project Routing' });

  return {
    database,
    agents,
    tasks,
    assignments,
    pool,
    scheduler,
    providerFactory,
    projectId: project.id,
    eventBus,
  };
}

describe('Execution routing protocol closure (0.7.2)', () => {
  it('excludes manager-directive-only codex provider when requiredOutputProtocols requires worker-result', () => {
    const harness = setupSchedulerHarness();

    // Register only a codex agent
    const codexAgent = harness.agents.createAgent({
      name: 'Codex Agent',
      provider: 'codex',
      model: 'codex-1',
      authority: AgentAuthority.STANDARD,
    });
    harness.pool.register({
      agentId: codexAgent.id,
      providerId: 'codex',
    });

    const task = harness.tasks.createTask({
      projectId: harness.projectId,
      title: 'Task for worker-result',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });

    // Schedule with requirements: worker-result
    const result = harness.scheduler.scheduleTask({
      taskId: task.id,
      requirements: { requiredOutputProtocols: ['worker-result'] },
    });

    // Codex cannot satisfy worker-result protocol
    expect(result.outcome).toBe('no-available-agent');
  }, 5_000);

  it('selects cursor or antigravity when worker-result protocol is required', () => {
    const harness = setupSchedulerHarness();

    // Register cursor agent
    const cursorAgent = harness.agents.createAgent({
      name: 'Cursor Worker',
      provider: 'cursor',
      model: 'cursor-fast',
      authority: AgentAuthority.STANDARD,
    });
    harness.pool.register({
      agentId: cursorAgent.id,
      providerId: 'cursor',
    });

    const task = harness.tasks.createTask({
      projectId: harness.projectId,
      title: 'Task for cursor',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });

    const result = harness.scheduler.scheduleTask({
      taskId: task.id,
      requirements: { requiredOutputProtocols: ['worker-result'] },
    });

    expect(result.outcome).toBe('reserved');
    if (result.outcome === 'reserved') {
      expect(result.agentId).toBe(cursorAgent.id);
      expect(result.providerId).toBe('cursor');
    }
  }, 5_000);

  it('POST /api/v1/tasks/:taskId/execute passes requiredOutputProtocols: [worker-result] to scheduler', async () => {
    const harness = setupSchedulerHarness();

    let capturedRequirements: unknown;
    const trackingScheduler = {
      scheduleTask: (req: { taskId: string; requirements?: unknown }) => {
        capturedRequirements = req.requirements;
        return { outcome: 'unassigned' as const };
      },
    };

    const task = harness.tasks.createTask({
      projectId: harness.projectId,
      title: 'API Execute Test',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });

    const app: AgentHubApplication = {
      projects: { list: () => [], findById: () => null, create: () => null },
      agents: { listAgents: () => [], getAgent: () => null },
      agentManagement: {} as never,
      tasks: harness.tasks,
      assignments: harness.assignments,
      assignmentQueries: { list: () => [], findById: () => null },
      events: { list: () => [] },
      eventBus: harness.eventBus,
      scheduler: trackingScheduler as never,
      dispatcher: {} as never,
      lifecycle: {} as never,
      buildTestPlan: { commands: [] },
      targetBranch: 'main',
    } as unknown as AgentHubApplication;

    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;

    try {
      const res = await fetch(`${base}/api/v1/tasks/${task.id}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'exec-test-1',
        },
        body: JSON.stringify({
          prompt: 'Execute task',
          baseRef: 'main',
        }),
      });

      // Since mock scheduler returned unassigned, outcome is 409 conflict
      expect(res.status).toBe(409);
      expect(capturedRequirements).toEqual({
        requiredOutputProtocols: ['worker-result'],
      });
    } finally {
      await server.stop();
    }
  }, 5_000);
});
