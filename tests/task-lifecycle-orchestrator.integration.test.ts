import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
  TaskLifecycleOrchestrator,
  TaskStatus,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  type AgentHubWorkerOutcome,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
  type BuildTestEvidencePlan,
  type ReviewDecisionInput,
} from '../src/index.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

interface TurnScript {
  readonly outcome: AgentHubWorkerOutcome;
  readonly write?: { readonly path: string; readonly content: string };
  readonly throwAfterWrite?: boolean;
}

class LifecycleSession implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public readonly sessionId = 'lifecycle-session';
  public started = false;
  public active = false;
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public readonly prompts: string[] = [];

  public constructor(private readonly workspacePath: string, private readonly scripts: TurnScript[]) {}

  public start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
    return Promise.resolve();
  }

  public runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    const script = this.scripts[this.runCalls];
    this.runCalls += 1;
    this.prompts.push(request.prompt);
    if (script === undefined) return Promise.reject(new Error('unexpected turn'));
    if (script.write !== undefined) writeFileSync(join(this.workspacePath, script.write.path), script.write.content, 'utf8');
    if (script.throwAfterWrite === true) return Promise.reject(new Error('provider failed after writing source'));
    return Promise.resolve({
      providerId: this.providerId,
      sessionId: this.sessionId,
      protocol: 'worker-result',
      protocolValid: true,
      workerResult: worker(script.outcome),
    });
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    this.active = false;
    return Promise.resolve();
  }
}

class LifecycleProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public session: LifecycleSession | undefined;
  public createCalls = 0;

  public constructor(private readonly scripts: TurnScript[]) {}

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.createCalls += 1;
    if (options.workspacePath === undefined) throw new Error('workspace path required');
    this.session = new LifecycleSession(options.workspacePath, this.scripts);
    return this.session;
  }
}

function worker(outcome: AgentHubWorkerOutcome) {
  return {
    protocolVersion: 1 as const,
    outcome,
    summary: `${outcome} result`,
    changedFiles: ['untrusted-worker-claim.txt'],
    checks: [{ name: 'untrusted', status: 'PASSED' as const, detail: 'claim only' }],
    blockers: outcome === 'BLOCKED' ? ['blocked'] : [],
    questions: outcome === 'NEEDS_INPUT' ? ['need input'] : [],
    risks: [],
    notes: [],
  };
}

const passingPlan: BuildTestEvidencePlan = {
  commands: [{
    id: 'test', phase: 'test', executable: process.execPath,
    args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {},
  }],
};
const failingPlan: BuildTestEvidencePlan = {
  commands: [{
    id: 'test', phase: 'test', executable: process.execPath,
    args: ['-e', 'process.exit(7)'], cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {},
  }],
};
const accept: ReviewDecisionInput = {
  reviewId: 'review-accept', reviewerId: 'human', verdict: 'ACCEPT', summary: 'accepted', findings: [],
};
const revise: ReviewDecisionInput = {
  reviewId: 'review-revise', reviewerId: 'human', verdict: 'REQUEST_REVISION', summary: 'revise once',
  findings: [{ code: 'FIX_1', severity: 'error', message: 'Update the implementation', path: 'actual.txt' }],
};
const block: ReviewDecisionInput = {
  reviewId: 'review-block', reviewerId: 'human', verdict: 'BLOCK', summary: 'blocked by review',
  findings: [{ code: 'BLOCK_1', severity: 'blocker', message: 'Do not merge', path: 'actual.txt' }],
};

async function harness(scripts: TurnScript[]) {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-lifecycle-'));
  const repositoryRoot = join(directory, 'repository');
  execFileSync('git', ['init', '-b', 'main', repositoryRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'AgentHub Tests'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.invalid'], { cwd: repositoryRoot });
  writeFileSync(join(repositoryRoot, 'README.md'), '# test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot, stdio: 'ignore' });

  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agents = new AgentRegistry(new SqliteAgentRepository(database),
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }), bus);
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
  const assignments = new AssignmentManager(new SqliteAssignmentRepository(database), tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), bus);
  const projectId = new SqliteProjectRepository(database).create({ id: 'project-a', name: 'Lifecycle' }).id;
  agents.createAgent({ id: 'agent-a', projectId, name: 'Worker', provider: 'fake', model: 'fake-model',
    position: 'Developer', status: AgentStatus.IDLE, capabilities: [], specialties: [], enabled: true });
  tasks.createTask({ id: 'task-a', projectId, title: 'Task', description: 'Implement it',
    complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW, acceptanceCriteria: ['actual change is present'] });
  const provider = new LifecycleProvider(scripts);
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(provider);
  const pool = new AgentPool({ providerFactory, eventBus: bus });
  pool.register({ agentId: 'agent-a', projectId, providerId: 'fake' });
  const scheduler = new AgentScheduler({ taskManager: tasks, agentRegistry: agents,
    providerFactory, agentPool: pool, assignmentManager: assignments });
  const worktrees = await GitWorktreeManager.open({ repositoryRoot });
  const dispatcher = new AssignmentDispatcher({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees });
  const lifecycle = new TaskLifecycleOrchestrator({ taskManager: tasks, agentRegistry: agents,
    assignmentManager: assignments, agentPool: pool, worktreeManager: worktrees });
  const scheduled = scheduler.scheduleTask({ taskId: 'task-a' });
  if (scheduled.outcome !== 'reserved') throw new Error('expected reservation');
  const dispatch = await dispatcher.dispatch({ reservation: scheduled, baseRef: 'HEAD',
    turn: { prompt: 'Implement once', protocol: 'worker-result' } });
  return {
    repositoryRoot, database, agents, tasks, assignments, provider, pool, scheduler, dispatcher, worktrees, lifecycle, dispatch,
    async cleanup() {
      const snapshot = pool.getSnapshot('agent-a');
      if (snapshot.assignmentId !== undefined) await pool.shutdown('agent-a', snapshot.assignmentId).catch(() => undefined);
      await worktrees.removeWorkspace('task-a').catch(() => undefined);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('TaskLifecycleOrchestrator real integration', { timeout: 120_000 }, () => {
  it('commits, collects evidence, reviews, shuts down, and merges the actual source', async () => {
    const h = await harness([{ outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'actual\n' } }]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      expect(prepared.outcome).toBe('review-ready');
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      expect(prepared.reviewBundle.taskCommit.outcome).toBe('committed');
      expect(prepared.reviewBundle.source.changedPaths).toContain('actual.txt');
      expect(prepared.reviewBundle.source.changedPaths).not.toContain('untrusted-worker-claim.txt');
      expect(h.tasks.getTask('task-a')?.status).toBe('REVIEWING');

      const tamperedBundle = { ...prepared.reviewBundle, source: { ...prepared.reviewBundle.source,
        committed: { ...prepared.reviewBundle.source.committed,
          patch: { status: 'captured', text: 'tampered', byteLength: 1, sha256: '0'.repeat(64) } } } };
      await expect(h.lifecycle.applyReview({ reviewBundle: tamperedBundle as unknown as typeof prepared.reviewBundle,
        decision: accept, buildTestPlan: passingPlan, targetBranch: 'main' }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_INVALID_REVIEW_BUNDLE' });
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'OWNED', busy: true });

      const mergeSpy = vi.spyOn(h.worktrees, 'mergeTaskWorkspace');
      const finalize = h.assignments.finalizeCompletedAssignment.bind(h.assignments);
      let completionAvailable = false;
      vi.spyOn(h.assignments, 'finalizeCompletedAssignment').mockImplementation((id) => {
        if (!completionAvailable) {
          h.tasks.transitionTask('task-a', TaskStatus.COMPLETED);
          throw new Error('completion persistence partially failed');
        }
        return finalize(id);
      });
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: accept, buildTestPlan: passingPlan, targetBranch: 'main' }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED' });
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      completionAvailable = true;
      const completed = await h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: accept, buildTestPlan: passingPlan, targetBranch: 'main' });
      expect(completed.outcome).toBe('completed');
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'COMPLETED', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('COMPLETED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, active: false });
      expect(readFileSync(join(h.repositoryRoot, 'actual.txt'), 'utf8')).toBe('actual\r\n');
      expect(existsSync(join(h.repositoryRoot, '.agenthub', 'worktrees', 'task-a'))).toBe(true);

      h.tasks.createTask({ id: 'task-b', projectId: 'project-a', title: 'New task', description: 'New ownership',
        complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
      const scheduledB = h.scheduler.scheduleTask({ taskId: 'task-b' });
      if (scheduledB.outcome !== 'reserved') throw new Error('expected second reservation');
      const dispatchB = await h.dispatcher.dispatch({ reservation: scheduledB, baseRef: 'main',
        turn: { prompt: 'Implement task B', protocol: 'worker-result' } });
      expect(dispatchB.assignmentId).not.toBe(h.dispatch.assignmentId);
      expect(h.agents.getAgent('agent-a')?.status).toBe(AgentStatus.BUSY);
      const taskBBefore = h.tasks.getTask('task-b');
      const assignmentBBefore = h.assignments.getAssignment(dispatchB.assignmentId);
      const poolBBefore = h.pool.getSnapshot('agent-a');
      const mergeCalls = mergeSpy.mock.calls.length;
      const replayed = await h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: accept, buildTestPlan: passingPlan, targetBranch: 'main' });
      expect(replayed).toEqual(completed);
      expect(mergeSpy).toHaveBeenCalledTimes(mergeCalls);
      expect(h.tasks.getTask('task-b')).toEqual(taskBBefore);
      expect(h.assignments.getAssignment(dispatchB.assignmentId)).toEqual(assignmentBBefore);
      expect(h.agents.getAgent('agent-a')?.status).toBe(AgentStatus.BUSY);
      expect(h.pool.getSnapshot('agent-a')).toEqual(poolBBefore);
    } finally { await h.cleanup(); }
  });

  it('reuses one assignment and healthy provider session for exactly one revision turn', async () => {
    const h = await harness([
      { outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'first\n' } },
      { outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'revised\n' } },
    ]);
    try {
      const first = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (first.outcome !== 'review-ready') throw new Error('expected first review bundle');
      const second = await h.lifecycle.applyReview({ reviewBundle: first.reviewBundle,
        decision: revise, buildTestPlan: passingPlan });
      expect(second.outcome).toBe('review-ready');
      if (second.outcome !== 'review-ready') throw new Error('expected revised review bundle');
      expect(second.reviewEvidence).toMatchObject({ verdict: 'REQUEST_REVISION', reviewId: revise.reviewId });
      expect(Object.isFrozen(second.reviewEvidence)).toBe(true);
      expect(second.reviewBundle.assignmentId).toBe(first.reviewBundle.assignmentId);
      expect(second.reviewBundle.taskCommit.headAfter).not.toBe(first.reviewBundle.taskCommit.headAfter);
      expect(h.provider.createCalls).toBe(1);
      expect(h.provider.session).toMatchObject({ runCalls: 2, startCalls: 1, shutdownCalls: 0 });
      expect(h.provider.session?.prompts[1]).toContain('FIX_1');
      const completed = await h.lifecycle.applyReview({ reviewBundle: second.reviewBundle,
        decision: { ...accept, reviewId: 'review-accept-2' }, buildTestPlan: passingPlan, targetBranch: 'main' });
      expect(completed.outcome).toBe('completed');
      expect(readFileSync(join(h.repositoryRoot, 'actual.txt'), 'utf8')).toBe('revised\r\n');
    } finally { await h.cleanup(); }
  });

  it('quarantines and preserves source when a revision writes then throws', async () => {
    const h = await harness([
      { outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'first\n' } },
      { outcome: 'COMPLETED', write: { path: 'partial.txt', content: 'forensic\n' }, throwAfterWrite: true },
    ]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REVISION_FAILED' });
      expect(readFileSync(join(h.repositoryRoot, '.agenthub', 'worktrees', 'task-a', 'partial.txt'), 'utf8'))
        .toBe('forensic\n');
      await expect(h.worktrees.createWorkspace({ taskId: 'task-a', baseRef: 'main' }))
        .rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
      await expect(h.worktrees.commitTaskWorkspace('task-a'))
        .rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
      await expect(h.worktrees.collectBuildTestEvidence('task-a', passingPlan))
        .rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_STALE_EXECUTION' });
      expect(h.provider.session?.runCalls).toBe(2);
    } finally { await h.cleanup(); }
  });

  it('closes a failed revision turn without allowing the stale review to run again', async () => {
    const h = await harness([{ outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'first\n' } }]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REVISION_FAILED' });
      expect(h.provider.createCalls).toBe(1);
      expect(h.provider.session).toMatchObject({ runCalls: 2, startCalls: 1, shutdownCalls: 1 });
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'BLOCKED', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('RELEASED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, active: false });
      const workspace = await h.worktrees.inspectWorkspace('task-a');
      expect(workspace).toBeDefined();
      expect(readFileSync(join(h.repositoryRoot, '.agenthub', 'worktrees', 'task-a', 'actual.txt'), 'utf8')).toBe('first\n');
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_STALE_EXECUTION' });
      expect(h.provider.session?.runCalls).toBe(2);
    } finally { await h.cleanup(); }
  });

  it('preserves visible ownership and quarantines source when failed revision shutdown is unproven', async () => {
    const h = await harness([
      { outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'first\n' } },
      { outcome: 'COMPLETED', write: { path: 'partial.txt', content: 'forensic\n' }, throwAfterWrite: true },
    ]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      const suspend = vi.spyOn(h.assignments, 'suspendActiveAssignment');
      vi.spyOn(h.pool, 'shutdown').mockRejectedValue(new Error('unproven runtime shutdown'));
      const commit = vi.spyOn(h.worktrees, 'commitTaskWorkspace');
      const evidence = vi.spyOn(h.worktrees, 'collectBuildTestEvidence');
      const capture = vi.spyOn(h.worktrees, 'captureWorkspaceChanges');
      const gate = vi.spyOn(h.worktrees, 'evaluateMergeGate');
      const merge = vi.spyOn(h.worktrees, 'mergeTaskWorkspace');
      const callsBefore = {
        commit: commit.mock.calls.length,
        evidence: evidence.mock.calls.length,
        capture: capture.mock.calls.length,
        gate: gate.mock.calls.length,
        merge: merge.mock.calls.length,
      };

      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED' });

      expect(suspend).not.toHaveBeenCalled();
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('ACTIVE');
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'IMPLEMENTING',
        assignedAgentId: 'agent-a', assignmentId: h.dispatch.assignmentId });
      expect(h.agents.getAgent('agent-a')?.status).toBe('BUSY');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'OWNED', busy: true,
        assignmentId: h.dispatch.assignmentId });
      expect(readFileSync(join(h.repositoryRoot, '.agenthub', 'worktrees', 'task-a', 'partial.txt'), 'utf8'))
        .toBe('forensic\n');
      expect({
        commit: commit.mock.calls.length,
        evidence: evidence.mock.calls.length,
        capture: capture.mock.calls.length,
        gate: gate.mock.calls.length,
        merge: merge.mock.calls.length,
      }).toEqual({ ...callsBefore, capture: callsBefore.capture + 1 });
      await expect(h.worktrees.createWorkspace({ taskId: 'task-a', baseRef: 'main' }))
        .rejects.toMatchObject({ code: 'GIT_WORKTREE_TASK_QUARANTINED' });
      await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: revise, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_STALE_EXECUTION' });
      expect(h.provider.session?.runCalls).toBe(2);
    } finally { await h.cleanup(); }
  });

  it('retains immutable BLOCK review evidence and binds it into lifecycle identity', async () => {
    const h = await harness([{ outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'actual\n' } }]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      const failed = await h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: block, buildTestPlan: passingPlan });
      expect(failed.outcome).toBe('failed');
      if (failed.outcome !== 'failed' || failed.reviewEvidence === undefined) throw new Error('expected BLOCK evidence');
      expect(failed.reviewEvidence).toMatchObject({ verdict: 'BLOCK', reviewId: block.reviewId });
      expect(Object.isFrozen(failed.reviewEvidence)).toBe(true);
      expect(failed.lifecycleSha256).toBe(lifecycleDigest({ outcome: 'failed', taskId: 'task-a',
        assignmentId: h.dispatch.assignmentId, reviewEvidenceSha256: failed.reviewEvidence.reviewEvidenceSha256 }));
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'FAILED', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('RELEASED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
    } finally { await h.cleanup(); }
  });

  it('replays no-change completion without repeating the final gate after partial persistence', async () => {
    const h = await harness([{ outcome: 'COMPLETED' }, { outcome: 'BLOCKED' }]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      expect(prepared.reviewBundle.taskCommit.outcome).toBe('no-changes');
      const gateSpy = vi.spyOn(h.worktrees, 'evaluateMergeGate');
      const finalize = h.assignments.finalizeCompletedAssignment.bind(h.assignments);
      let completionAvailable = false;
      vi.spyOn(h.assignments, 'finalizeCompletedAssignment').mockImplementation((id) => {
        if (!completionAvailable) {
          h.tasks.transitionTask('task-a', TaskStatus.COMPLETED);
          throw new Error('no-change completion persistence partially failed');
        }
        return finalize(id);
      });
      const request = { reviewBundle: prepared.reviewBundle, decision: accept,
        buildTestPlan: passingPlan, allowNoChangeCompletion: true };
      await expect(h.lifecycle.applyReview(request))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_POST_MERGE_RECONCILIATION_REQUIRED' });
      expect(gateSpy).toHaveBeenCalledTimes(2);
      completionAvailable = true;
      const completed = await h.lifecycle.applyReview(request);
      expect(completed.outcome).toBe('completed-no-change');
      expect(gateSpy).toHaveBeenCalledTimes(2);
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'COMPLETED', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('COMPLETED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, active: false });

      h.tasks.createTask({ id: 'task-b', projectId: 'project-a', title: 'New no-change task', description: 'New ownership',
        complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
      const scheduledB = h.scheduler.scheduleTask({ taskId: 'task-b' });
      if (scheduledB.outcome !== 'reserved') throw new Error('expected second reservation');
      const dispatchB = await h.dispatcher.dispatch({ reservation: scheduledB, baseRef: 'main',
        turn: { prompt: 'Implement task B', protocol: 'worker-result' } });
      const taskBBefore = h.tasks.getTask('task-b');
      const assignmentBBefore = h.assignments.getAssignment(dispatchB.assignmentId);
      const agentBefore = h.agents.getAgent('agent-a');
      const poolBBefore = h.pool.getSnapshot('agent-a');
      const gateCalls = gateSpy.mock.calls.length;
      const replayed = await h.lifecycle.applyReview(request);
      expect(replayed).toEqual(completed);
      expect(gateSpy).toHaveBeenCalledTimes(gateCalls);
      expect(h.tasks.getTask('task-b')).toEqual(taskBBefore);
      expect(h.assignments.getAssignment(dispatchB.assignmentId)).toEqual(assignmentBBefore);
      expect(h.agents.getAgent('agent-a')).toEqual(agentBefore);
      expect(h.pool.getSnapshot('agent-a')).toEqual(poolBBefore);
    } finally { await h.cleanup(); }
  });
  it.each(['source', 'visibility'] as const)(
    'revalidates no-change %s identity after shutdown before completion', async (drift) => {
      const h = await harness([{ outcome: 'COMPLETED' }]);
      try {
        const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
        if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
        expect(prepared.reviewBundle.taskCommit.outcome).toBe('no-changes');
        const workspace = await h.worktrees.inspectWorkspace('task-a');
        if (workspace === undefined) throw new Error('expected workspace');
        const originalShutdown = h.pool.shutdown.bind(h.pool);
        h.pool.shutdown = async (agentId: string, assignmentId: string) => {
          await originalShutdown(agentId, assignmentId);
          if (drift === 'source') writeFileSync(join(workspace.worktreePath, 'shutdown-source.txt'), 'drift\n');
          else {
            const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
              cwd: workspace.worktreePath, encoding: 'utf8',
            }).trim();
            const excludePath = isAbsolute(exclude) ? exclude : resolve(workspace.worktreePath, exclude);
            writeFileSync(excludePath, 'shutdown-visibility.txt\n');
          }
        };
        await expect(h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle, decision: accept,
          buildTestPlan: passingPlan, allowNoChangeCompletion: true }))
          .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_GATE_DENIED' });
        expect(h.tasks.getTask('task-a')?.status).toBe('REVIEWING');
        expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('ACTIVE');
        expect(h.agents.getAgent('agent-a')?.status).toBe('BUSY');
      } finally { await h.cleanup(); }
    },
  );
  it('converges NEEDS_INPUT without evidence and clears all scheduling ownership', async () => {
    const h = await harness([{ outcome: 'NEEDS_INPUT' }]);
    try {
      const result = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan });
      expect(result.outcome).toBe('waiting-input');
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'WAITING_INPUT', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('RELEASED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, active: false });
    } finally { await h.cleanup(); }
  });

  it('preserves evidence-created source without committing it and rejects the old dispatch retry', async () => {
    const h = await harness([{ outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'actual\n' } }]);
    try {
      const workspace = await h.worktrees.inspectWorkspace('task-a');
      if (workspace === undefined) throw new Error('expected workspace');
      const mutatingPlan: BuildTestEvidencePlan = { commands: [{
        id: 'mutating-test', phase: 'test', executable: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('evidence-created.txt','forensic source\\n')"],
        cwd: '.', timeoutMs: 5_000, inheritEnv: [], env: {},
      }] };
      const first = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: mutatingPlan });
      expect(first.outcome).toBe('blocked');
      expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'BLOCKED', assignedAgentId: null, assignmentId: null });
      expect(h.assignments.getAssignment(h.dispatch.assignmentId)?.status).toBe('RELEASED');
      expect(h.agents.getAgent('agent-a')?.status).toBe('IDLE');
      expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, active: false });
      expect(readFileSync(join(workspace.worktreePath, 'evidence-created.txt'), 'utf8')).toBe('forensic source\n');
      const committedFiles = execFileSync('git', ['show', '--pretty=', '--name-only', 'HEAD'], {
        cwd: workspace.worktreePath, encoding: 'utf8',
      }).split(/\r?\n/u).filter(Boolean);
      expect(committedFiles).toContain('actual.txt');
      expect(committedFiles).not.toContain('evidence-created.txt');
      await expect(h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: passingPlan }))
        .rejects.toMatchObject({ code: 'TASK_LIFECYCLE_STALE_EXECUTION' });
      const committedAfterRetry = execFileSync('git', ['show', '--pretty=', '--name-only', 'HEAD'], {
        cwd: workspace.worktreePath, encoding: 'utf8',
      }).split(/\r?\n/u).filter(Boolean);
      expect(committedAfterRetry).not.toContain('evidence-created.txt');
    } finally { await h.cleanup(); }
  });
  it('captures failed stable evidence but refuses ACCEPT at the merge gate', async () => {
    const h = await harness([{ outcome: 'COMPLETED', write: { path: 'actual.txt', content: 'actual\n' } }]);
    try {
      const prepared = await h.lifecycle.prepareReview({ dispatchResult: h.dispatch, buildTestPlan: failingPlan });
      if (prepared.outcome !== 'review-ready') throw new Error('expected review bundle');
      expect(prepared.reviewBundle.buildTestEvidence.outcome).toBe('failed');
      const denied = await h.lifecycle.applyReview({ reviewBundle: prepared.reviewBundle,
        decision: accept, buildTestPlan: passingPlan, targetBranch: 'main' });
      expect(denied.outcome).toBe('merge-denied');
      expect(h.tasks.getTask('task-a')?.status).toBe('REVIEWING');
      expect(existsSync(join(h.repositoryRoot, 'actual.txt'))).toBe(false);
    } finally { await h.cleanup(); }
  });
});

function lifecycleDigest(identity: unknown): string {
  return createHash('sha256').update(`AgentHub.TaskLifecycleResult.v1\0${canonical(identity)}`).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
