import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Database } from '../database/index.js';
import { EventBus, EventStore } from '../events/index.js';
import { AgentScheduler, AssignmentDispatcher, TaskLifecycleOrchestrator } from '../orchestration/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteEventRepository,
  SqliteProjectRepository, SqliteTaskRepository } from '../repositories/index.js';
import { AgentPool, AgentProviderFactory, ClaudeAgentProvider, CodexAgentProvider } from '../runtime/index.js';
import { AgentProfileManager, AgentRegistry, AssignmentManager, TaskManager, TaskStateMachine } from '../services/index.js';
import { GitWorktreeManager } from '../workspace/index.js';
import type { AgentHubApplication } from './AgentHubApplication.js';

export interface LocalAgentHubOptions { readonly repositoryRoot?: string; readonly dataDirectory?: string }
export interface OwnedAgentHubApplication { readonly application: AgentHubApplication; close(): Promise<void> }

/** Production composition root. The transport borrows this graph and never owns it. */
export async function createLocalAgentHubApplication(options: LocalAgentHubOptions = {}): Promise<OwnedAgentHubApplication> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const dataDirectory = resolve(options.dataDirectory ?? join(repositoryRoot, 'data'));
  mkdirSync(dataDirectory, { recursive: true });
  const database = new Database(join(dataDirectory, 'agenthub.db')); database.initialize();
  const eventBus = new EventBus();
  const projectRepository = new SqliteProjectRepository(database);
  const agentRepository = new SqliteAgentRepository(database);
  const taskRepository = new SqliteTaskRepository(database);
  const assignmentRepository = new SqliteAssignmentRepository(database);
  const events = new EventStore(new SqliteEventRepository(database), eventBus);
  const profiles = new AgentProfileManager({ agentsDirectory: join(dataDirectory, 'agents') });
  const agents = new AgentRegistry(agentRepository, profiles, eventBus);
  const tasks = new TaskManager(taskRepository, new TaskStateMachine(), eventBus);
  const assignments = new AssignmentManager(assignmentRepository, tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), eventBus);
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(new CodexAgentProvider()); providerFactory.register(new ClaudeAgentProvider());
  const pool = new AgentPool({ providerFactory, eventBus });
  for (const agent of agents.listAgents()) if (providerFactory.has(agent.provider)) {
    pool.register({ agentId: agent.id, ...(agent.projectId === null ? {} : { projectId: agent.projectId }),
      providerId: agent.provider, providerConfig: { model: agent.model } });
  }
  const scheduler = new AgentScheduler({ taskManager: tasks, agentRegistry: agents, providerFactory,
    agentPool: pool, assignmentManager: assignments });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees });
  const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees });
  const application: AgentHubApplication = Object.freeze({ projects: projectRepository, agents, tasks,
    assignments, assignmentQueries: assignmentRepository, events, eventBus, scheduler, dispatcher, lifecycle,
    buildTestPlan: Object.freeze({ commands: Object.freeze([{ id: 'node-runtime-check', phase: 'test' as const,
      executable: process.execPath, args: Object.freeze(['-e', 'process.exit(0)']), timeoutMs: 30_000 }]) }),
    targetBranch: 'HEAD' });
  return { application, async close() { await pool.shutdownAll(); events.close(); database.close(); } };
}
