import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentStatus,
  AssignmentDispatcher,
  AssignmentManager,
  AssignmentStatus,
  Database,
  EventBus,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStatus,
  TaskStateMachine,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
  type AgentScheduleReservation,
  type CreatedTaskWorkspace,
} from '../src/index.js';
import { createAssignmentDispatcherForTest } from
  '../src/orchestration/internal/AssignmentDispatcherTestHarness.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class Session implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public started = false;
  public active = false;
  public readonly sessionId = 'session-a';
  public startCalls = 0;
  public runCalls = 0;
  public readonly requests: AgentProviderTurnRequest[] = [];
  public shutdownCalls = 0;
  public startError: Error | undefined;
  public runError: Error | undefined;
  public result: AgentProviderTurnResult = successResult(7);
  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.started = true;
    return Promise.resolve();
  }
  public runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.requests.push(request);
    this.active = true;
    this.active = false;
    if (this.runError !== undefined) return Promise.reject(this.runError);
    return Promise.resolve(this.result);
  }
  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    this.active = false;
    return Promise.resolve();
  }
}

class Provider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public readonly session = new Session();
  public createError: Error | undefined;
  public readonly createOptions: AgentProviderSessionCreateOptions[] = [];
  public onCreate: (() => void) | undefined;
  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.createOptions.push(options);
    this.onCreate?.();
    if (this.createError !== undefined) throw this.createError;
    return this.session;
  }
}

class WorkspaceStub {
  public readonly repositoryRoot: string;
  public calls = 0;
  public readonly baseRefs: string[] = [];
  public error: Error | undefined;
  public barrier: Promise<void> | undefined;
  public created = true;
  public secondWorktreePath: string | undefined;
  public invalidCommit = false;
  public constructor(repositoryRoot: string) {
    this.repositoryRoot = repositoryRoot;
  }
  public async createWorkspace(request: { readonly baseRef: string }): Promise<CreatedTaskWorkspace> {
    this.calls += 1;
    this.baseRefs.push(request.baseRef);
    if (this.barrier !== undefined) await this.barrier;
    if (this.error !== undefined) throw this.error;
    const defaultPath = join(this.repositoryRoot, '.agenthub', 'worktrees', 'task-a');
    return {
      taskId: 'task-a', repositoryRoot: this.repositoryRoot,
      worktreePath: this.calls === 2 && this.secondWorktreePath !== undefined
        ? this.secondWorktreePath
        : defaultPath,
      branchName: 'agenthub/task-a',
      baseCommit: this.invalidCommit ? 'not-an-object-id' : 'a'.repeat(40),
      headCommit: 'a'.repeat(40),
      created: this.created,
    };
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('AssignmentDispatcher', () => {
  it('blocks structural workspace doubles at the public trust boundary', () => {
    const h = harness();
    expect(() => new AssignmentDispatcher({
      taskManager: h.tasks,
      agentRegistry: h.agents,
      assignmentManager: h.assignments,
      agentPool: h.pool,
      worktreeManager: h.workspace as never,
    })).toThrow('Assignment dispatch request is invalid');
  });
  it('validates the digest, snapshots getters once, and rejects bounded input before effects', async () => {
    const h = harness();
    const reservation = h.reserve();
    const reads = { reservation: 0, baseRef: 0, turn: 0, prompt: 0, protocol: 0, timeout: 0 };
    const turn = {
      get prompt() { reads.prompt += 1; return 'implement'; },
      get protocol() { reads.protocol += 1; return 'worker-result' as const; },
      get timeoutMs() { reads.timeout += 1; return 1000; },
    };
    const request = {
      get reservation() { reads.reservation += 1; return reservation; },
      get baseRef() { reads.baseRef += 1; return 'HEAD'; },
      get turn() { reads.turn += 1; return turn; },
    };
    await h.dispatcher.dispatch(request);
    expect(reads).toEqual({ reservation: 1, baseRef: 1, turn: 1, prompt: 1, protocol: 1, timeout: 1 });
    expect(h.provider.session.requests[0]).toEqual({ prompt: 'implement', protocol: 'worker-result', timeoutMs: 1000 });
    expect(Object.isFrozen(h.provider.session.requests[0])).toBe(true);

    const invalid = harness();
    const tampered = { ...invalid.reserve(), providerId: 'other' };
    await expect(invalid.dispatcher.dispatch({
      reservation: tampered, baseRef: 'HEAD', turn: { prompt: 'x', protocol: 'worker-result' },
    })).rejects.toMatchObject({ code: 'AGENT_DISPATCH_INVALID_RESERVATION' });
    expect(invalid.workspace.calls).toBe(0);

    const bounded = harness();
    await expect(bounded.dispatcher.dispatch({
      reservation: bounded.reserve(), baseRef: 'bad\nref', turn: { prompt: 'x', protocol: 'worker-result' },
    })).rejects.toMatchObject({ code: 'AGENT_DISPATCH_INVALID_REQUEST' });
    expect(bounded.workspace.calls).toBe(0);
  });

  it.each([
    ['blank prompt', { prompt: ' ', protocol: 'worker-result' as const }],
    ['zero timeout', { prompt: 'x', protocol: 'worker-result' as const, timeoutMs: 0 }],
    ['long timeout', { prompt: 'x', protocol: 'worker-result' as const, timeoutMs: 3_600_001 }],
  ])('rejects %s at the request boundary', async (_name, turn) => {
    const h = harness();
    await expect(h.dispatcher.dispatch({ reservation: h.reserve(), baseRef: 'HEAD', turn })).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_INVALID_REQUEST',
    });
    expect(h.workspace.calls).toBe(0);
    expect(h.provider.session.startCalls).toBe(0);
  });

  it('creates or reuses the workspace, activates ownership, and runs exactly one first turn', async () => {
    const h = harness();
    h.workspace.created = false;
    const reservation = h.reserve();
    const result = await h.dispatcher.dispatch(request(reservation));
    expect(result).toMatchObject({
      version: 1, taskId: 'task-a', projectId: h.projectId, agentId: 'agent-a', providerId: 'fake',
      assignmentId: reservation.assignmentId, assignmentStatus: 'ACTIVE', taskStatus: 'IMPLEMENTING',
      workspace: { created: false, branchName: 'agenthub/task-a' },
      turnResult: { protocol: 'worker-result', protocolValid: true },
    });
    expect(result.dispatchSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.workspace).not.toHaveProperty('worktreePath');
    expect(JSON.stringify(result)).not.toContain(h.directory);
    expectDeepFrozen(result);
    expect(h.workspace.calls).toBe(2);
    expect(h.provider.session.startCalls).toBe(1);
    expect(h.provider.session.runCalls).toBe(1);
    expect(h.provider.createOptions[0]?.workspacePath).toBe(
      join(h.directory, '.agenthub', 'worktrees', 'task-a'),
    );
    expect(h.workspace.baseRefs).toEqual(['HEAD', 'a'.repeat(40)]);
    expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'OWNED', reserved: false });
    expect(h.agents.getAgent('agent-a')).toMatchObject({ status: AgentStatus.BUSY });
  });

  it('detects profile drift and pool reservation mismatch before workspace creation', async () => {
    const profile = harness();
    const profileReservation = profile.reserve();
    profile.agents.updateAgent('agent-a', { position: 'Reviewer' });
    await expect(profile.dispatcher.dispatch(request(profileReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_PROFILE',
    });
    expect(profile.workspace.calls).toBe(0);
    expect(profile.pool.getSnapshot('agent-a').reserved).toBe(true);

    const mismatch = harness();
    const mismatchReservation = mismatch.reserve();
    mismatch.pool.releaseReservation('agent-a', mismatchReservation.assignmentId);
    await expect(mismatch.dispatcher.dispatch(request(mismatchReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_RESERVATION_MISMATCH',
    });
    expect(mismatch.workspace.calls).toBe(0);
  });

  it('rejects stale assignment and task identities before workspace creation', async () => {
    const staleAssignment = harness();
    const assignmentReservation = staleAssignment.reserve();
    staleAssignment.assignmentRepository.update(assignmentReservation.assignmentId, { status: AssignmentStatus.STALE });
    await expect(staleAssignment.dispatcher.dispatch(request(assignmentReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_RESERVATION',
    });
    expect(staleAssignment.workspace.calls).toBe(0);

    const staleTask = harness();
    const taskReservation = staleTask.reserve();
    staleTask.taskRepository.update('task-a', { assignedAgentId: null });
    await expect(staleTask.dispatcher.dispatch(request(taskReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_RESERVATION',
    });
    expect(staleTask.workspace.calls).toBe(0);
  });

  it('rejects malformed trusted workspace identity before acceptance', async () => {
    const h = harness();
    h.workspace.invalidCommit = true;
    await expect(h.dispatcher.dispatch(request(h.reserve()))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_WORKSPACE_FAILED',
    });
    expect(h.provider.createOptions).toHaveLength(0);
    expect(h.provider.session.runCalls).toBe(0);
  });
  it('leaves reservation and persistent lifecycle untouched when workspace creation fails', async () => {
    const h = harness();
    const reservation = h.reserve();
    h.workspace.error = new Error('secret workspace detail');
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_WORKSPACE_FAILED',
    });
    expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'DISPATCHING' });
    expect(h.tasks.getTask('task-a')).toMatchObject({ status: 'ASSIGNED' });
    expect(h.agents.getAgent('agent-a')).toMatchObject({ status: 'IDLE' });
    expect(h.pool.getSnapshot('agent-a')).toMatchObject({ reserved: true, state: 'IDLE' });
    expect(h.provider.session.startCalls).toBe(0);
  });

  it('blocks workspace identity drift after acceptance before provider startup', async () => {
    const h = harness();
    h.workspace.secondWorktreePath = join(h.directory, '.agenthub', 'worktrees', 'other');
    const reservation = h.reserve();
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_WORKSPACE_STALE',
    });
    expect(h.workspace.baseRefs).toEqual(['HEAD', 'a'.repeat(40)]);
    expect(h.provider.createOptions).toHaveLength(0);
    expect(h.provider.session.runCalls).toBe(0);
  });

  it('blocks execution-profile drift during acceptance', async () => {
    const h = harness();
    h.bus.subscribe((event) => {
      if (event.eventType === 'AssignmentAccepted') {
        h.agents.updateAgent('agent-a', { position: 'Changed during acceptance' });
      }
    });
    await expect(h.dispatcher.dispatch(request(h.reserve()))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_PROFILE',
    });
    expect(h.provider.createOptions).toHaveLength(0);
    expect(h.provider.session.runCalls).toBe(0);
  });

  it('shuts down and blocks activation when profile drifts during provider startup', async () => {
    const h = harness();
    h.provider.onCreate = () => h.agents.updateAgent('agent-a', { model: 'changed-model' });
    const reservation = h.reserve();
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_PROFILE',
    });
    expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'ACCEPTED' });
    expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: false });
    expect(h.provider.session.shutdownCalls).toBe(1);
    expect(h.provider.session.runCalls).toBe(0);
  });

  it('blocks the first turn when profile drifts during activation events', async () => {
    const h = harness();
    h.bus.subscribe((event) => {
      if (event.eventType === 'TaskStatusChanged' && event.newStatus === TaskStatus.IMPLEMENTING) {
        h.agents.updateAgent('agent-a', { capabilities: ['changed-during-activation'] });
      }
    });
    await expect(h.dispatcher.dispatch(request(h.reserve()))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_STALE_PROFILE',
    });
    expect(h.provider.session.runCalls).toBe(0);
    expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'OWNED' });
  });

  it('reconciles committed acceptance notification failure and continues', async () => {
    const h = harness();
    const reservation = h.reserve();
    h.bus.subscribe((event) => {
      if (event.eventType === 'AssignmentAccepted') throw new Error('notification failed');
    });
    const result = await h.dispatcher.dispatch(request(reservation));
    expect(result.assignmentStatus).toBe('ACTIVE');
    expect(h.provider.session.runCalls).toBe(1);
  });

  it('reports a verified pre-commit accept failure without consuming the reservation', async () => {
    const h = harness();
    const reservation = h.reserve();
    Object.defineProperty(h.assignments, 'acceptAssignment', { value: () => { throw new Error('precommit'); } });
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_ACCEPT_FAILED',
    });
    expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'DISPATCHING' });
    expect(h.pool.getSnapshot('agent-a').reserved).toBe(true);
    expect(h.provider.session.startCalls).toBe(0);
  });

  it('distinguishes clean and dirty runtime start failures', async () => {
    const clean = harness();
    clean.provider.createError = new Error('factory failed');
    const cleanReservation = clean.reserve();
    await expect(clean.dispatcher.dispatch(request(cleanReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_RUNTIME_START_FAILED',
    });
    expect(clean.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: true });
    expect(clean.assignments.getAssignment(cleanReservation.assignmentId)).toMatchObject({ status: 'ACCEPTED' });

    const dirty = harness();
    dirty.provider.session.startError = new Error('session failed');
    const dirtyReservation = dirty.reserve();
    await expect(dirty.dispatcher.dispatch(request(dirtyReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_RUNTIME_RECONCILIATION_REQUIRED',
    });
    expect(dirty.pool.getSnapshot('agent-a')).toMatchObject({ state: 'FAILED', reserved: false });
  });

  it('shuts down promoted runtime after a verified pre-activation failure', async () => {
    const h = harness();
    const reservation = h.reserve();
    Object.defineProperty(h.assignments, 'activateAssignment', { value: () => { throw new Error('precommit'); } });
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_ACTIVATION_FAILED',
    });
    expect(h.assignments.getAssignment(reservation.assignmentId)).toMatchObject({ status: 'ACCEPTED' });
    expect(h.pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: false });
    expect(h.provider.session.runCalls).toBe(0);
  });

  it('continues after committed activation throws, but fails closed on partial activation', async () => {
    const committed = harness();
    const committedReservation = committed.reserve();
    const activate = committed.assignments.activateAssignment.bind(committed.assignments);
    Object.defineProperty(committed.assignments, 'activateAssignment', {
      value: (id: string) => { activate(id); throw new Error('postcommit'); },
    });
    const result = await committed.dispatcher.dispatch(request(committedReservation));
    expect(result.assignmentStatus).toBe('ACTIVE');
    expect(committed.provider.session.runCalls).toBe(1);

    const partial = harness();
    const partialReservation = partial.reserve();
    Object.defineProperty(partial.assignments, 'activateAssignment', {
      value: () => { partial.tasks.transitionTask('task-a', TaskStatus.IMPLEMENTING); throw new Error('partial'); },
    });
    await expect(partial.dispatcher.dispatch(request(partialReservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_RECONCILIATION_REQUIRED',
    });
    expect(partial.provider.session.runCalls).toBe(0);
    expect(partial.pool.getSnapshot('agent-a')).toMatchObject({ state: 'OWNED', assignmentId: partialReservation.assignmentId });
  });

  it('returns structured invalid output without retry and keeps active ownership', async () => {
    const h = harness();
    h.provider.session.result = {
      providerId: 'fake', sessionId: 'session-a', protocol: 'worker-result', protocolValid: false,
      failure: { kind: 'malformed_json', message: 'invalid structured result' },
    };
    const result = await h.dispatcher.dispatch(request(h.reserve()));
    expect(result.turnResult).toMatchObject({ protocolValid: false, failure: { kind: 'malformed_json' } });
    expect(h.provider.session.runCalls).toBe(1);
    expect(h.pool.getSnapshot('agent-a').state).toBe('OWNED');
  });

  it('does not retry a transport failure and classifies a provider contract failure', async () => {
    const transport = harness();
    transport.provider.session.runError = new Error('transport secret');
    await expect(transport.dispatcher.dispatch(request(transport.reserve()))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_TURN_FAILED',
    });
    expect(transport.provider.session.runCalls).toBe(1);
    expect(transport.pool.getSnapshot('agent-a').state).toBe('OWNED');

    const contract = harness();
    contract.provider.session.result = { ...successResult(1), providerId: 'wrong-provider' };
    await expect(contract.dispatcher.dispatch(request(contract.reserve()))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_PROVIDER_CONTRACT_VIOLATION',
    });
    expect(contract.provider.session.runCalls).toBe(1);
  });

  it('produces a deterministic digest that excludes prompt and duration', async () => {
    const h = harness();
    const reservation = h.reserve();
    h.workspace.created = false;
    const first = await h.dispatcher.dispatch({
      reservation, baseRef: 'HEAD', turn: { prompt: 'first secret prompt', protocol: 'worker-result' },
    });
    await h.pool.shutdown('agent-a', reservation.assignmentId);
    h.assignmentRepository.update(reservation.assignmentId, { status: AssignmentStatus.DISPATCHING });
    h.taskRepository.setStatus('task-a', TaskStatus.ASSIGNED);
    h.agents.updateAgent('agent-a', { status: AgentStatus.IDLE });
    h.pool.reserve('agent-a', {
      taskId: reservation.taskId, assignmentId: reservation.assignmentId,
      specVersion: reservation.specVersion, profileHash: reservation.profileHash,
    });
    h.provider.session.result = successResult(999_999);
    const second = await h.dispatcher.dispatch({
      reservation, baseRef: 'HEAD', turn: { prompt: 'different prompt', protocol: 'worker-result' },
    });
    expect(second.dispatchSha256).toBe(first.dispatchSha256);
    expect(second.dispatchSha256).not.toContain('prompt');
  });

  it('rejects same-task concurrent dispatch while allowing only the first lifecycle', async () => {
    const h = harness();
    const reservation = h.reserve();
    let release!: () => void;
    h.workspace.barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = h.dispatcher.dispatch(request(reservation));
    await expect(h.dispatcher.dispatch(request(reservation))).rejects.toMatchObject({
      code: 'AGENT_DISPATCH_TASK_BUSY',
    });
    release();
    await first;
    expect(h.workspace.calls).toBe(2);
    expect(h.provider.session.runCalls).toBe(1);
  });
});

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-dispatcher-'));
  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  const bus = new EventBus();
  const agentRepository = new SqliteAgentRepository(database);
  const taskRepository = new SqliteTaskRepository(database);
  const assignmentRepository = new SqliteAssignmentRepository(database);
  const agents = new AgentRegistry(
    agentRepository,
    new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }),
    bus,
  );
  const tasks = new TaskManager(taskRepository, new TaskStateMachine(), bus);
  const assignments = new AssignmentManager(
    assignmentRepository, tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId), bus,
  );
  const provider = new Provider();
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: bus });
  const projectId = new SqliteProjectRepository(database).create({ id: 'project-a', name: 'Dispatch' }).id;
  agents.createAgent({
    id: 'agent-a', projectId, name: 'Worker', provider: 'fake', model: 'fake-model',
    position: 'Developer', status: AgentStatus.IDLE, capabilities: [], specialties: [], enabled: true,
  });
  pool.register({ agentId: 'agent-a', projectId, providerId: 'fake' });
  tasks.createTask({
    id: 'task-a', projectId, title: 'Task', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
  });
  const scheduler = new AgentScheduler({
    taskManager: tasks, agentRegistry: agents, providerFactory: factory, agentPool: pool, assignmentManager: assignments,
  });
  const workspace = new WorkspaceStub(directory);
  const dispatcher = createAssignmentDispatcherForTest({
    taskManager: tasks, agentRegistry: agents, assignmentManager: assignments,
    agentPool: pool, worktreeManager: workspace,
  });
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, database, bus, agents, tasks, assignments, provider, pool, projectId, workspace, dispatcher,
    agentRepository, taskRepository, assignmentRepository,
    reserve(): AgentScheduleReservation {
      const result = scheduler.scheduleTask({ taskId: 'task-a' });
      if (result.outcome !== 'reserved') throw new Error('expected a reservation');
      return result;
    },
  };
}

function request(reservation: AgentScheduleReservation) {
  return { reservation, baseRef: 'HEAD', turn: { prompt: 'Implement the task', protocol: 'worker-result' as const } };
}

function successResult(durationMs: number): AgentProviderTurnResult {
  return {
    providerId: 'fake', sessionId: 'session-a', durationMs, protocol: 'worker-result', protocolValid: true,
    workerResult: {
      protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [],
      blockers: [], questions: [], risks: [], notes: [],
    },
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) expectDeepFrozen(nested);
  }
}
