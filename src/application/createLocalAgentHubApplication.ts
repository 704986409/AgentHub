import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Database } from '../database/index.js';
import { EventBus, EventStore } from '../events/index.js';
import { AgentScheduler, AssignmentDispatcher, TaskLifecycleOrchestrator } from '../orchestration/index.js';
import { SqliteAgentRepository, SqliteAssignmentRepository, SqliteEventRepository,
  SqliteProjectRepository, SqliteTaskRepository } from '../repositories/index.js';
import { AgentPool, AgentProviderFactory, AntigravityAgentProvider, ClaudeAgentProvider, CodexAgentProvider, CursorAgentProvider } from '../runtime/index.js';
import { AgentManagementService, AgentProfileManager, AgentRegistry, AssignmentManager, ProviderCatalogService, TaskManager, TaskStateMachine } from '../services/index.js';
import { GitCommandRunner, GitWorktreeManager, type GitCommandRunnerLike } from '../workspace/index.js';
import type { AgentHubApplication } from './AgentHubApplication.js';
import { PlanLifecycleService } from '../lifecycle/plan-lifecycle.js';
import { PlanExecutionCoordinator } from '../lifecycle/plan-execution-coordinator.js';
import { PlanExecutionRecoveryService } from '../lifecycle/plan-execution-recovery.js';
import { PlanRecoveryCoordinator } from '../lifecycle/plan-recovery-coordinator.js';
import {
  PLAN_REVIEW_RECONCILIATION_REQUIRED,
  ReviewTransitionCoordinator,
} from '../lifecycle/review-transition-coordinator.js';
import { ReviewHandleStore } from '../api/ReviewHandleStore.js';

export interface LocalAgentHubOptions { readonly repositoryRoot?: string; readonly dataDirectory?: string }
export interface OwnedAgentHubApplication {
  readonly application: AgentHubApplication;
  readonly database: Database;
  close(): Promise<void>;
}

export async function resolvePrimaryBranch(repositoryRoot: string,
  runner: GitCommandRunnerLike = new GitCommandRunner()): Promise<string> {
  const root = resolve(repositoryRoot);
  const result = await runner.run(['symbolic-ref', '--quiet', 'HEAD'], {
    cwd: root, acceptedExitCodes: [0, 1],
  });
  const symbolicRef = result.stdout.trim();
  if (result.exitCode !== 0 || !symbolicRef.startsWith('refs/heads/') || symbolicRef.includes('\n') || symbolicRef.includes('\r')) {
    throw new Error('Repository must have a checked-out local branch');
  }
  const branch = symbolicRef.slice('refs/heads/'.length);
  const valid = await runner.run(['check-ref-format', '--branch', branch], {
    cwd: root, acceptedExitCodes: [0, 1],
  });
  const local = await runner.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: root, acceptedExitCodes: [0, 1],
  });
  if (valid.exitCode !== 0 || local.exitCode !== 0) throw new Error('Repository local branch is invalid');
  return branch;
}

/** Production composition root. The transport borrows this graph and never owns it. */
export async function createLocalAgentHubApplication(options: LocalAgentHubOptions = {}): Promise<OwnedAgentHubApplication> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const dataDirectory = resolve(options.dataDirectory ?? join(repositoryRoot, 'data'));
  const targetBranch = await resolvePrimaryBranch(repositoryRoot);
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
  providerFactory.register(new CodexAgentProvider());
  providerFactory.register(new ClaudeAgentProvider());
  providerFactory.register(new CursorAgentProvider());
  providerFactory.register(new AntigravityAgentProvider());
  const providerCatalog = new ProviderCatalogService({ providerFactory });
  const pool = new AgentPool({ providerFactory, eventBus });
  for (const agent of agents.listAgents()) if (providerFactory.has(agent.provider)) {
    pool.register({ agentId: agent.id, ...(agent.projectId === null ? {} : { projectId: agent.projectId }),
      providerId: agent.provider, providerConfig: { model: agent.model } });
  }
  const scheduler = new AgentScheduler({ taskManager: tasks, agentRegistry: agents, providerFactory,
    agentPool: pool, assignmentManager: assignments });
  const planLifecycle = new PlanLifecycleService(projectRepository, agents, eventBus, database, tasks, assignmentRepository);
  const agentManagement = new AgentManagementService({
    agentRegistry: agents, agentPool: pool, providerFactory, projects: projectRepository,
    assignments: assignmentRepository, tasks, eventBus,
    isProviderUsable: (id) => providerCatalog.isUsableSync(id),
    isLifecycleReferenced: (agentId) => planLifecycle.isLeadReferenced(agentId),
  });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees });
  const reviews = new ReviewHandleStore(database);
  const reviewTransitions = new ReviewTransitionCoordinator({
    database, reviews, planLifecycle, tasks,
  });
  const assignmentRecovery = new PlanExecutionRecoveryService({
    database, planLifecycle, tasks, assignments, agentPool: pool, eventBus, reviews,
  });
  const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees, reviewTransitions,
    assignmentRecovery });
  const planExecution = new PlanExecutionCoordinator({ planLifecycle, tasks, scheduler, dispatcher,
    taskLifecycle: lifecycle, targetBranch, buildTestPlan: Object.freeze({ commands: Object.freeze([{ id: 'node-runtime-check', phase: 'test' as const,
      executable: process.execPath, args: Object.freeze(['-e', 'process.exit(0)']), timeoutMs: 30_000 }]) }), eventBus, reviewTransitions, assignmentRecovery });
  const planRecovery = new PlanRecoveryCoordinator({
    planLifecycle, planExecution, reviewTransitions, eventBus,
  });
  recoverLifecycleAfterStartup({ reviewTransitions, recovery: planRecovery });
  const application: AgentHubApplication = Object.freeze({ projects: projectRepository, agents, agentManagement, tasks,
    assignments, assignmentQueries: assignmentRepository, events, eventBus, scheduler, dispatcher, lifecycle,
    planLifecycle, planExecution, assignmentRecovery, reviews, reviewTransitions,
    buildTestPlan: Object.freeze({ commands: Object.freeze([{ id: 'node-runtime-check', phase: 'test' as const,
      executable: process.execPath, args: Object.freeze(['-e', 'process.exit(0)']), timeoutMs: 30_000 }]) }),
    targetBranch, providerCatalog });
  return {
    application,
    database,
    async close() {
      await planRecovery.stop();
      await pool.shutdownAll();
      events.close();
      database.close();
    },
  };
}

/** Synchronous Review-authority gate, then arm asynchronous execution recovery. */
export function recoverLifecycleAfterStartup(options: {
  readonly reviewTransitions: ReviewTransitionCoordinator;
  readonly recovery: PlanRecoveryCoordinator;
}): void {
  try {
    options.reviewTransitions.reconcile();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== PLAN_REVIEW_RECONCILIATION_REQUIRED) throw error;
    return;
  }
  options.recovery.start();
}
