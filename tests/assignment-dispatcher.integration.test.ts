import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentStatus,
  AssignmentDispatcher,
  AssignmentManager,
  Database,
  EventBus,
  GitWorktreeManager,
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
  type AgentProviderTurnResult,
} from '../src/index.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class IntegrationSession implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public started = false;
  public active = false;
  public readonly sessionId = 'integration-session';
  public startCalls = 0;
  public runCalls = 0;
  public startError: Error | undefined;
  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.started = true;
    return Promise.resolve();
  }
  public runTurn(): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    return Promise.resolve({
      providerId: 'fake', sessionId: this.sessionId, protocol: 'worker-result', protocolValid: true,
      workerResult: {
        protocolVersion: 1, outcome: 'COMPLETED', summary: 'first turn complete', changedFiles: [],
        checks: [], blockers: [], questions: [], risks: [], notes: [],
      },
    });
  }
  public shutdown(): Promise<void> {
    this.started = false;
    this.active = false;
    return Promise.resolve();
  }
}

class IntegrationProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public readonly session = new IntegrationSession();
  public createError: Error | undefined;
  public createSession(): AgentProviderSession {
    if (this.createError !== undefined) throw this.createError;
    return this.session;
  }
}

describe('AssignmentDispatcher integration', () => {
  it('dispatches through SQLite, a real Git worktree, AgentPool, and one fake provider turn', async () => {
    const h = await integrationHarness();
    try {
      const reservation = h.reserve();
      const result = await h.dispatcher.dispatch({
        reservation, baseRef: 'HEAD', turn: { prompt: 'Implement once', protocol: 'worker-result' },
      });
      expect(result).toMatchObject({
        assignmentStatus: 'ACTIVE', taskStatus: 'IMPLEMENTING',
        workspace: { created: true, baseCommit: h.baseCommit, headCommit: h.baseCommit },
      });
      expect(h.provider.session.runCalls).toBe(1);
      expect(h.provider.session.startCalls).toBe(1);
      expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'ACTIVE' });
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'IMPLEMENTING' });
      expect(h.agents.getAgent('agent-a')).toMatchObject({ status: 'BUSY' });
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  it('fails a bad base ref before acceptance and preserves the reservation', async () => {
    const h = await integrationHarness();
    try {
      const reservation = h.reserve();
      await expect(h.dispatcher.dispatch({
        reservation, baseRef: 'refs/heads/does-not-exist',
        turn: { prompt: 'Implement once', protocol: 'worker-result' },
      })).rejects.toMatchObject({ code: 'AGENT_DISPATCH_WORKSPACE_FAILED' });
      expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'DISPATCHING' });
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: true });
      expect(h.provider.session.runCalls).toBe(0);
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  it('retains the real worktree and restores reservation on a clean runtime factory failure', async () => {
    const h = await integrationHarness();
    try {
      h.provider.createError = new Error('clean runtime failure');
      const reservation = h.reserve();
      await expect(h.dispatcher.dispatch({
        reservation, baseRef: 'HEAD', turn: { prompt: 'Implement once', protocol: 'worker-result' },
      })).rejects.toMatchObject({ code: 'AGENT_DISPATCH_RUNTIME_START_FAILED' });
      expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'ACCEPTED' });
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: true });
      const reused = await h.worktreeManager.createWorkspace({ taskId: 'task-a', baseRef: 'HEAD' });
      expect(reused.created).toBe(false);
    } finally {
      await h.cleanup();
    }
  }, 15_000);
});

async function integrationHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-dispatch-integration-'));
  const repositoryRoot = join(directory, 'repository');
  execFileSync('git', ['init', repositoryRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub Tests'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, 'README.md'), '# test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot, stdio: 'ignore' });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();

  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agents = new AgentRegistry(
    new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), bus,
  );
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
  const assignments = new AssignmentManager(
    new SqliteAssignmentRepository(database), tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), bus,
  );
  const projectId = new SqliteProjectRepository(database).create({ id: 'project-a', name: 'Integration' }).id;
  agents.createAgent({
    id: 'agent-a', projectId, name: 'Worker', provider: 'fake', model: 'fake-model',
    position: 'Developer', status: AgentStatus.IDLE, capabilities: [], specialties: [], enabled: true,
  });
  tasks.createTask({
    id: 'task-a', projectId, title: 'Task', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
  });
  const provider = new IntegrationProvider();
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(provider);
  const pool = new AgentPool({ providerFactory, eventBus: bus });
  pool.register({ agentId: 'agent-a', projectId, providerId: 'fake' });
  const scheduler = new AgentScheduler({
    taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments,
  });
  const worktreeManager = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments, agentPool: pool, worktreeManager,
  });
  return {
    baseCommit, agents, tasks, assignments, provider, pool, worktreeManager, dispatcher,
    reserve() {
      const result = scheduler.scheduleTask({ taskId: 'task-a' });
      if (result.outcome !== 'reserved') throw new Error('expected a reservation');
      return result;
    },
    async cleanup(): Promise<void> {
      const snapshot = pool.getSnapshot('agent-a');
      if (snapshot.assignmentId !== undefined) {
        await pool.shutdown('agent-a', snapshot.assignmentId).catch(() => undefined);
      }
      await worktreeManager.removeWorkspace('task-a').catch(() => undefined);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
