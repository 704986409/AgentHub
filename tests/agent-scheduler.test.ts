import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentPool,
  AgentProfileManager,
  AgentProviderFactory,
  AgentRegistry,
  AgentScheduler,
  AgentSchedulerError,
  snapshotAgentScheduleReservation,
  AgentAuthority,
  AgentStatus,
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
  TaskRouter,
  TaskStateMachine,
  TaskStatus,
  type Agent,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentScheduleResult,
  type AgentScheduleRequest,
  type CreateAssignmentInput,
} from '../src/index.js';

const providerCapabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

class CountingProvider implements AgentProvider {
  public readonly capabilities = providerCapabilities;
  public createCalls = 0;
  public constructor(public readonly id: string) {}
  public createSession(): AgentProviderSession {
    this.createCalls += 1;
    throw new Error('scheduler must not create provider sessions');
  }
}

describe('AgentScheduler', () => {
  let directory: string;
  let database: Database;
  let bus: EventBus;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignments: AssignmentManager;
  let assignmentRepository: SqliteAssignmentRepository;
  let providerFactory: AgentProviderFactory;
  let provider: CountingProvider;
  let pool: AgentPool;
  let scheduler: AgentScheduler;
  let projectId: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-scheduler-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    bus = new EventBus();
    agents = new AgentRegistry(
      new SqliteAgentRepository(database),
      new AgentProfileManager({ agentsDirectory: join(directory, 'data', 'agents') }),
      bus,
    );
    tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignmentRepository = new SqliteAssignmentRepository(database);
    assignments = new AssignmentManager(
      assignmentRepository,
      tasks,
      agents,
      (agentId) => agents.calculateProfileHash(agentId),
      bus,
    );
    providerFactory = new AgentProviderFactory();
    provider = new CountingProvider('fake');
    providerFactory.register(provider);
    pool = new AgentPool({ providerFactory, eventBus: bus });
    scheduler = createScheduler();
    projectId = new SqliteProjectRepository(database).create({ id: 'project-a', name: 'Scheduler' }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects missing, already-owned, and terminal tasks while accepting CREATED and QUEUED', () => {
    expectSchedulerError(() => scheduler.scheduleTask({ taskId: 'missing' }), 'AGENT_SCHEDULER_TASK_NOT_FOUND');
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const created = createTask('created');
    expect(scheduler.scheduleTask({ taskId: created.id }).outcome).toBe('reserved');

    const queuedAgent = createAgent({ id: 'agent-b' });
    register(queuedAgent);
    const queued = createTask('queued');
    tasks.transitionTask(queued.id, TaskStatus.QUEUED);
    expect(scheduler.scheduleTask({ taskId: queued.id }).outcome).toBe('reserved');

    const owned = createTask('owned');
    const owner = createAgent({ id: 'agent-owner' });
    assignments.createAssignment({ taskId: owned.id, agentId: owner.id });
    expectSchedulerError(() => scheduler.scheduleTask({ taskId: owned.id }), 'AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE');
    const terminal = createTask('terminal');
    tasks.cancelTask(terminal.id);
    expectSchedulerError(() => scheduler.scheduleTask({ taskId: terminal.id }), 'AGENT_SCHEDULER_TASK_NOT_SCHEDULABLE');
  });

  it('routes from current task, registry, and provider descriptors on every call', () => {
    const task = createTask('fresh', ['coding']);
    const resultBeforeAgent = scheduler.scheduleTask({ taskId: task.id });
    expect(resultBeforeAgent).toMatchObject({ outcome: 'no-available-agent', unavailable: [] });

    const agent = createAgent({ id: 'agent-late', capabilities: ['coding'] });
    register(agent);
    const result = scheduler.scheduleTask({ taskId: task.id });
    expect(result).toMatchObject({ outcome: 'reserved', agentId: agent.id, candidateRank: 1 });
    expect(result.routePlanSha256).not.toBe(resultBeforeAgent.routePlanSha256);
  });

  it('reads every request and requirements field once and uses one identity throughout scheduling', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const taskA = createTask('task-a');
    const taskB = createTask('task-b');
    const reads = {
      taskId: 0,
      specVersion: 0,
      requirements: 0,
      minimumAuthority: 0,
      requiredOutputProtocols: 0,
    };
    const requirements = {
      get minimumAuthority() {
        reads.minimumAuthority += 1;
        if (reads.minimumAuthority > 1) throw new Error('minimumAuthority reread');
        return AgentAuthority.STANDARD;
      },
      get requiredOutputProtocols() {
        reads.requiredOutputProtocols += 1;
        if (reads.requiredOutputProtocols > 1) throw new Error('protocols reread');
        return ['worker-result'] as const;
      },
    };
    const request = {
      get taskId() {
        reads.taskId += 1;
        if (reads.taskId > 1) throw new Error('taskId reread');
        return taskA.id;
      },
      get specVersion() {
        reads.specVersion += 1;
        if (reads.specVersion > 1) throw new Error('specVersion reread');
        return '2.4.6';
      },
      get requirements() {
        reads.requirements += 1;
        if (reads.requirements > 1) throw new Error('requirements reread');
        return requirements;
      },
    } as AgentScheduleRequest;

    const result = scheduler.scheduleTask(request);
    if (result.outcome !== 'reserved') throw new Error('expected reservation');
    expect(reads).toEqual({
      taskId: 1,
      specVersion: 1,
      requirements: 1,
      minimumAuthority: 1,
      requiredOutputProtocols: 1,
    });
    expect(result.taskId).toBe(taskA.id);
    expect(result.specVersion).toBe('2.4.6');
    expect(pool.getSnapshot(agent.id)).toMatchObject({
      reservedTaskId: taskA.id,
      reservedSpecVersion: '2.4.6',
    });
    expect(assignments.getAssignment(result.assignmentId)).toMatchObject({
      taskId: taskA.id,
      specVersion: '2.4.6',
    });
    expect(tasks.getTask(taskA.id)?.status).toBe(TaskStatus.ASSIGNED);
    expect(tasks.getTask(taskB.id)?.status).toBe(TaskStatus.CREATED);
  });

  it('detaches requirements and protocol arrays before the first service call', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('detached');
    const protocols: ('worker-result' | 'manager-directive')[] = ['worker-result'];
    const requirements = {
      minimumAuthority: AgentAuthority.READ_ONLY,
      requiredOutputProtocols: protocols,
    };
    const originalList = providerFactory.list.bind(providerFactory);
    Object.defineProperty(providerFactory, 'list', { value: () => {
      requirements.minimumAuthority = AgentAuthority.ADMIN;
      protocols.splice(0, protocols.length, 'manager-directive');
      return originalList();
    }});

    const result = scheduler.scheduleTask({ taskId: task.id, requirements });

    expect(result).toMatchObject({ outcome: 'reserved', agentId: agent.id });
    expect(requirements.minimumAuthority).toBe(AgentAuthority.ADMIN);
    expect(protocols).toEqual(['manager-directive']);
  });

  it('passes a deeply frozen owned requirements snapshot to TaskRouter', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('frozen');
    const originalRoute = TaskRouter.prototype.route.bind(new TaskRouter());
    let requirementsFrozen = false;
    let protocolsFrozen = false;
    const spy = vi.spyOn(TaskRouter.prototype, 'route').mockImplementation((request) => {
      requirementsFrozen = Object.isFrozen(request.requirements);
      protocolsFrozen = Object.isFrozen(request.requirements?.requiredOutputProtocols);
      return originalRoute(request);
    });
    try {
      expect(scheduler.scheduleTask({
        taskId: task.id,
        requirements: { requiredOutputProtocols: ['worker-result'] },
      }).outcome).toBe('reserved');
    } finally {
      spy.mockRestore();
    }
    expect(requirementsFrozen).toBe(true);
    expect(protocolsFrozen).toBe(true);
  });

  it('normalizes throwing request getters before any service side effect', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('getter-failure');
    const requests = [
      Object.defineProperty({}, 'taskId', { get: () => { throw new Error('task getter secret'); } }),
      Object.defineProperty({ taskId: task.id }, 'specVersion', { get: () => { throw new Error('spec getter secret'); } }),
      Object.defineProperty({ taskId: task.id }, 'requirements', { get: () => { throw new Error('requirements getter secret'); } }),
      { taskId: task.id, requirements: Object.defineProperty({}, 'minimumAuthority', {
        get: () => { throw new Error('authority getter secret'); },
      }) },
      { taskId: task.id, requirements: Object.defineProperty({}, 'requiredOutputProtocols', {
        get: () => { throw new Error('protocol getter secret'); },
      }) },
    ];

    for (const request of requests) {
      expectSchedulerError(
        () => scheduler.scheduleTask(request as AgentScheduleRequest),
        'AGENT_SCHEDULER_INVALID_REQUEST',
      );
    }
    expect(pool.getSnapshot(agent.id).reserved).toBe(false);
    expect(assignments.getAssignment('missing')).toBeNull();
    expect(assignmentRepository.list()).toHaveLength(0);
    expect(tasks.getTask(task.id)).toMatchObject({ status: TaskStatus.CREATED, assignedAgentId: null, assignmentId: null });
    expect(provider.createCalls).toBe(0);
  });

  it.each([
    '',
    '   ',
    'task\0id',
    'a'.repeat(257),
    '界'.repeat(86),
  ])('rejects an invalid or oversized taskId without side effects %#', (taskId) => {
    expectSchedulerError(() => scheduler.scheduleTask({ taskId }), 'AGENT_SCHEDULER_INVALID_REQUEST');
    expect(assignmentRepository.list()).toHaveLength(0);
  });

  it('enforces specVersion safety and uses the exact default', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('spec-version');
    for (const specVersion of ['', '  ', '1.0\0x', '1.0\r2', '1.0\n2', 'a'.repeat(129), '界'.repeat(43)]) {
      expectSchedulerError(
        () => scheduler.scheduleTask({ taskId: task.id, specVersion }),
        'AGENT_SCHEDULER_INVALID_REQUEST',
      );
    }
    const result = scheduler.scheduleTask({ taskId: task.id });
    if (result.outcome !== 'reserved') throw new Error('expected reservation');
    expect(result.specVersion).toBe('1.0.0');
    expect(pool.getSnapshot(agent.id).reservedSpecVersion).toBe('1.0.0');
    expect(assignments.getAssignment(result.assignmentId)?.specVersion).toBe('1.0.0');
  });

  it('rejects an oversized protocol array before routing or reservation', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('protocol-bound');
    const requiredOutputProtocols = Array.from({ length: 33 }, () => 'worker-result' as const);

    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: task.id, requirements: { requiredOutputProtocols } }),
      'AGENT_SCHEDULER_INVALID_REQUEST',
    );
    expect(pool.getSnapshot(agent.id).reserved).toBe(false);
    expect(assignmentRepository.list()).toHaveLength(0);
    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.CREATED);
  });

  it('copies protocol indices without invoking a caller-owned custom iterator', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('custom-iterator');
    const requiredOutputProtocols = ['worker-result'];
    let iteratorReads = 0;
    Object.defineProperty(requiredOutputProtocols, Symbol.iterator, {
      value: function* () {
        iteratorReads += 1;
        for (let index = 0; index < 33; index += 1) yield 'manager-directive';
      },
    });

    expect(scheduler.scheduleTask({
      taskId: task.id,
      requirements: { requiredOutputProtocols: requiredOutputProtocols as ['worker-result'] },
    })).toMatchObject({ outcome: 'reserved', agentId: agent.id });
    expect(iteratorReads).toBe(0);
  });

  it('rejects non-primitive requirement values before any service call', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('non-primitive');
    const requests = [
      { taskId: task.id, requirements: { minimumAuthority: { value: 'STANDARD' } } },
      { taskId: task.id, requirements: { requiredOutputProtocols: [{ value: 'worker-result' }] } },
    ];

    for (const request of requests) {
      expectSchedulerError(
        () => scheduler.scheduleTask(request as unknown as AgentScheduleRequest),
        'AGENT_SCHEDULER_INVALID_REQUEST',
      );
    }
    expect(pool.getSnapshot(agent.id).reserved).toBe(false);
    expect(assignmentRepository.list()).toHaveLength(0);
    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.CREATED);
  });

  it('requires live registry IDLE state and reports BUSY and OFFLINE deterministically', () => {
    const busy = createAgent({ id: 'agent-busy', status: AgentStatus.BUSY, routingPriority: 2 });
    const offline = createAgent({ id: 'agent-offline', status: AgentStatus.OFFLINE, routingPriority: 1 });
    register(busy);
    register(offline);

    const result = scheduler.scheduleTask({ taskId: createTask('unavailable').id });
    expect(result).toMatchObject({
      outcome: 'no-available-agent',
      unavailable: [
        { agentId: 'agent-busy', reason: 'REGISTRY_NOT_IDLE' },
        { agentId: 'agent-offline', reason: 'REGISTRY_NOT_IDLE' },
      ],
    });
  });

  it('preserves static rank order and falls back from a missing or reserved rank-1 agent', () => {
    const first = createAgent({ id: 'agent-a', routingPriority: 20 });
    const second = createAgent({ id: 'agent-b', routingPriority: 10 });
    register(second);
    const task = createTask('fallback-missing');
    const result = scheduler.scheduleTask({ taskId: task.id });
    expect(result).toMatchObject({ outcome: 'reserved', agentId: second.id, candidateRank: 2 });

    const third = createAgent({ id: 'agent-c', routingPriority: 5 });
    register(third);
    pool.register({ agentId: first.id, projectId, providerId: first.provider });
    pool.reserve(first.id, { taskId: 'other-task', assignmentId: 'other-assignment', specVersion: '1', profileHash: 'h' });
    const another = scheduler.scheduleTask({ taskId: createTask('fallback-reserved').id });
    expect(another).toMatchObject({ outcome: 'reserved', agentId: third.id, candidateRank: 3 });
  });

  it('reports pool live-state diagnostics without creating a session', () => {
    const missing = createAgent({ id: 'missing', routingPriority: 3 });
    const busy = createAgent({ id: 'busy', routingPriority: 2 });
    const reserved = createAgent({ id: 'reserved', routingPriority: 1 });
    register(busy);
    register(reserved);
    const originalGetSnapshot = pool.getSnapshot.bind(pool);
    Object.defineProperty(pool, 'getSnapshot', { value: (agentId: string) => {
      const snapshot = originalGetSnapshot(agentId);
      return agentId === busy.id ? { ...snapshot, busy: true } : snapshot;
    }});
    pool.reserve(reserved.id, { taskId: 'other', assignmentId: 'reserved-assignment', specVersion: '1', profileHash: 'h' });

    const result = scheduler.scheduleTask({ taskId: createTask('pool-live').id });
    expect(result).toMatchObject({
      outcome: 'no-available-agent',
      unavailable: [
        { agentId: missing.id, reason: 'POOL_NOT_REGISTERED' },
        { agentId: busy.id, reason: 'POOL_BUSY' },
        { agentId: reserved.id, reason: 'POOL_RESERVED' },
      ],
    });
    expect(provider.createCalls).toBe(0);
  });

  it('fails fatally on provider and project pool registration mismatches', () => {
    const otherProvider = new CountingProvider('other');
    providerFactory.register(otherProvider);
    const providerMismatch = createAgent({ id: 'provider-mismatch' });
    pool.register({ agentId: providerMismatch.id, projectId, providerId: 'other' });
    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: createTask('provider-contract').id }),
      'AGENT_SCHEDULER_CONTRACT_VIOLATION',
    );

    pool.unregister(providerMismatch.id);
    agents.disableAgent(providerMismatch.id);
    const projectMismatch = createAgent({ id: 'project-mismatch' });
    pool.register({ agentId: projectMismatch.id, projectId: 'wrong-project', providerId: 'fake' });
    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: createTask('project-contract').id }),
      'AGENT_SCHEDULER_CONTRACT_VIOLATION',
    );
  });

  it('fails with a bounded error while the pool is draining', async () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const draining = pool.shutdownAll();

    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: createTask('draining').id }),
      'AGENT_SCHEDULER_POOL_DRAINING',
    );
    await draining;
    expect(provider.createCalls).toBe(0);
  });

  it('reserves before persistence and leaves exact DISPATCHING/ASSIGNED/IDLE evidence', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('success');
    const profileHash = agents.calculateProfileHash(agent.id);
    const originalCreate = assignments.createAssignment.bind(assignments);
    let reservedBeforeCreate = false;
    Object.defineProperty(assignments, 'createAssignment', { value: (input: CreateAssignmentInput) => {
      const snapshot = pool.getSnapshot(input.agentId);
      reservedBeforeCreate = snapshot.reserved && snapshot.reservedAssignmentId === input.id;
      return originalCreate(input);
    }});

    const result = scheduler.scheduleTask({
      taskId: task.id,
      specVersion: '2.3.4',
      assignmentId: 'caller-controlled',
    } as unknown as { taskId: string; specVersion: string });
    if (result.outcome !== 'reserved') throw new Error('expected reservation');

    expect(reservedBeforeCreate).toBe(true);
    expect(result.assignmentId).not.toBe('caller-controlled');
    expect(result.assignmentId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.profileHash).toBe(profileHash);
    expect(result.specVersion).toBe('2.3.4');
    expect(assignments.getAssignment(result.assignmentId)).toMatchObject({ status: 'DISPATCHING' });
    expect(tasks.getTask(task.id)).toMatchObject({
      status: TaskStatus.ASSIGNED, assignedAgentId: agent.id, assignmentId: result.assignmentId,
    });
    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.IDLE);
    expect(pool.getSnapshot(agent.id)).toMatchObject({
      state: 'IDLE', busy: false, active: false, reserved: true,
      reservedAssignmentId: result.assignmentId,
    });
    expect(provider.createCalls).toBe(0);
  });

  it('blocks same-task reentrancy across scheduler instances with one assignment and reservation', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('reentrant');
    const secondScheduler = createScheduler();
    let nestedCode: string | undefined;
    bus.subscribe((event) => {
      if (event.eventType !== 'TaskStatusChanged' || event.taskId !== task.id || nestedCode !== undefined) return;
      try { secondScheduler.scheduleTask({ taskId: task.id }); }
      catch (error) { nestedCode = error instanceof AgentSchedulerError ? error.code : 'unexpected'; }
    });

    const result = scheduler.scheduleTask({ taskId: task.id });
    expect(result.outcome).toBe('reserved');
    expect(nestedCode).toBe('AGENT_SCHEDULER_TASK_BUSY');
    expect(assignmentRepository.list()).toHaveLength(1);
    expect(pool.list().filter(({ reserved }) => reserved)).toHaveLength(1);
  });

  it('prevents two tasks from owning one agent during deterministic event reentrancy', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const firstTask = createTask('first');
    const secondTask = createTask('second');
    let nested: AgentScheduleResult | undefined;
    bus.subscribe((event) => {
      if (event.eventType === 'AssignmentCreated' && event.taskId === firstTask.id) {
        nested = scheduler.scheduleTask({ taskId: secondTask.id });
      }
    });

    expect(scheduler.scheduleTask({ taskId: firstTask.id }).outcome).toBe('reserved');
    expect(nested).toMatchObject({
      outcome: 'no-available-agent',
      unavailable: [{ agentId: agent.id, reason: 'POOL_RESERVED' }],
    });
    expect(assignmentRepository.list()).toHaveLength(1);
  });

  it('releases reservation after a verified pre-commit assignment failure', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('precommit');
    Object.defineProperty(assignments, 'createAssignment', { value: () => { throw new Error('precommit'); } });

    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: task.id }),
      'AGENT_SCHEDULER_ASSIGNMENT_CREATE_FAILED',
    );
    expect(pool.getSnapshot(agent.id).reserved).toBe(false);
    expect(tasks.getTask(task.id)).toMatchObject({ status: TaskStatus.CREATED, assignedAgentId: null, assignmentId: null });
    expect(assignmentRepository.list()).toHaveLength(0);
  });

  it('retains reservation when post-commit AssignmentCreated notification fails', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('postcommit');
    bus.subscribe((event) => {
      if (event.eventType === 'AssignmentCreated') throw new Error('notification');
    });

    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: task.id }),
      'AGENT_SCHEDULER_COMMITTED_WITH_NOTIFICATION_FAILURE',
    );
    expect(pool.getSnapshot(agent.id).reserved).toBe(true);
    expect(tasks.getTask(task.id)).toMatchObject({ status: TaskStatus.ASSIGNED, assignedAgentId: agent.id });
    expect(assignmentRepository.list()).toHaveLength(1);
  });

  it('fails closed when post-create persistence verification cannot be read', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const task = createTask('read-failure');
    Object.defineProperty(assignments, 'getAssignment', { value: () => { throw new Error('read failure'); } });

    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: task.id }),
      'AGENT_SCHEDULER_RECONCILIATION_REQUIRED',
    );
    expect(pool.getSnapshot(agent.id).reserved).toBe(true);
    expect(assignmentRepository.list()).toHaveLength(1);
  });

  it('fails closed on partial persistence and reservation rollback ambiguity', () => {
    const partialAgent = createAgent({ id: 'agent-partial', routingPriority: 2 });
    register(partialAgent);
    const partialTask = createTask('partial');
    bus.subscribe((event) => {
      if (event.eventType === 'TaskStatusChanged' && event.taskId === partialTask.id) throw new Error('partial');
    });
    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: partialTask.id }),
      'AGENT_SCHEDULER_RECONCILIATION_REQUIRED',
    );
    expect(pool.getSnapshot(partialAgent.id).reserved).toBe(true);
    expect(assignmentRepository.list()).toHaveLength(1);

    const rollbackAgent = createAgent({ id: 'agent-rollback', routingPriority: 1 });
    register(rollbackAgent);
    const rollbackTask = createTask('rollback');
    Object.defineProperty(assignments, 'createAssignment', { value: () => { throw new Error('precommit'); } });
    Object.defineProperty(pool, 'releaseReservation', { value: () => { throw new Error('release'); } });
    expectSchedulerError(
      () => scheduler.scheduleTask({ taskId: rollbackTask.id }),
      'AGENT_SCHEDULER_RECONCILIATION_REQUIRED',
    );
    expect(pool.getSnapshot(rollbackAgent.id).reserved).toBe(true);
  });

  it('returns deeply immutable results and deterministic reservation digests', () => {
    createAgent({ id: 'agent-a' });
    const task = createTask('digest');
    const first = scheduler.scheduleTask({ taskId: task.id });
    const second = scheduler.scheduleTask({ taskId: task.id });

    expect(first).toEqual(second);
    if (first.outcome !== 'no-available-agent') throw new Error('expected unavailable result');
    expect(first.reservationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expectDeepFrozen(first);
    expect(() => (first.unavailable as unknown as { reason: string }[]).push({ reason: 'changed' })).toThrow();
  });

  it('authenticates an exact reservation snapshot and rejects tampering', () => {
    const agent = createAgent({ id: 'agent-a' });
    register(agent);
    const result = scheduler.scheduleTask({ taskId: createTask('reservation-auth').id });
    if (result.outcome !== 'reserved') throw new Error('expected reservation');

    const snapshot = snapshotAgentScheduleReservation({ ...result });
    expect(snapshot).toEqual(result);
    expectDeepFrozen(snapshot);
    expect(snapshotAgentScheduleReservation({ ...result, agentId: 'agent-tampered' })).toBeNull();
    expect(snapshotAgentScheduleReservation({ ...result, extra: true })).toBeNull();
  });

  function createScheduler(): AgentScheduler {
    return new AgentScheduler({ taskManager: tasks, agentRegistry: agents, providerFactory, agentPool: pool, assignmentManager: assignments });
  }

  function createAgent(overrides: Partial<Agent> = {}): Agent {
    return agents.createAgent({
      id: overrides.id ?? 'agent-a',
      projectId: overrides.projectId ?? projectId,
      name: overrides.name ?? 'Worker',
      provider: overrides.provider ?? 'fake',
      model: overrides.model ?? 'model',
      position: overrides.position ?? 'Developer',
      status: overrides.status ?? AgentStatus.IDLE,
      capabilities: overrides.capabilities ?? [],
      specialties: overrides.specialties ?? [],
      routingPriority: overrides.routingPriority ?? 1,
      enabled: overrides.enabled ?? true,
    });
  }

  function register(agent: Agent): void {
    pool.register({ agentId: agent.id, providerId: agent.provider, ...(agent.projectId === null ? {} : { projectId: agent.projectId }) });
  }

  function createTask(id: string, requiredCapabilities: string[] = []) {
    return tasks.createTask({
      id,
      projectId,
      title: id,
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
      requiredCapabilities,
    });
  }
});

function expectSchedulerError(callback: () => unknown, code: string): void {
  let caught: unknown;
  try { callback(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AgentSchedulerError);
  expect(caught).toMatchObject({ code });
}

function expectDeepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) expectDeepFrozen(nested);
  }
}
