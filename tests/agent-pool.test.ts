import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentPoolError,
  AgentProviderFactory,
  ClaudeAgentProvider,
  CodexAgentProvider,
  CodexProviderStatus,
  EventBus,
  type AgentHubWorkerResult,
  type AgentPoolRegistration,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
  type AgentRuntimeBinding,
  type ClaudeWorkerSessionLike,
  type ClaudeWorkerTurnResult,
  type CodexManagerUseCaseLike,
  type ManagerDirective,
  type ManagerDirectiveTurnResult,
} from '../src/index.js';

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['manager-directive'] as const),
  sessionContinuation: true,
});

const directive: ManagerDirective = {
  action: 'INFORM', taskId: 'T', title: '', instructions: '', acceptanceCriteria: [],
  issues: [], requestedChecks: [], summary: 'done',
};

const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1, outcome: 'COMPLETED', summary: 'done', changedFiles: [], checks: [],
  blockers: [], questions: [], risks: [], notes: [],
};

class FakeSession implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public started = false;
  public active = false;
  public readonly sessionId: string;
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public startBarrier: Promise<void> | undefined;
  public runBarrier: Promise<void> | undefined;
  public shutdownBarrier: Promise<void> | undefined;
  public startError: Error | undefined;
  public runError: Error | undefined;
  public shutdownError: Error | undefined;
  public stopAfterRun = false;
  public onStart: (() => void) | undefined;
  public onRun: (() => void) | undefined;
  public onShutdown: (() => void) | undefined;

  public constructor(public readonly agentId: string) {
    this.sessionId = `session-${agentId}`;
  }

  public async start(): Promise<void> {
    this.startCalls += 1;
    this.onStart?.();
    if (this.startBarrier !== undefined) await this.startBarrier;
    if (this.startError !== undefined) throw this.startError;
    this.started = true;
  }

  public async runTurn(): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.onRun?.();
    this.active = true;
    if (this.runBarrier !== undefined) await this.runBarrier;
    this.active = false;
    if (this.stopAfterRun) this.started = false;
    if (this.runError !== undefined) throw this.runError;
    return managerResult(this.sessionId);
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.onShutdown?.();
    if (this.shutdownBarrier !== undefined) await this.shutdownBarrier;
    if (this.shutdownError !== undefined) throw this.shutdownError;
    this.started = false;
    this.active = false;
  }
}

class FakeProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public createCalls = 0;
  public createError: Error | undefined;
  public readonly sessions: FakeSession[] = [];
  public readonly options: AgentProviderSessionCreateOptions[] = [];
  public nextSession: ((options: AgentProviderSessionCreateOptions) => FakeSession) | undefined;

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.createCalls += 1;
    this.options.push(options);
    if (this.createError !== undefined) throw this.createError;
    const session = this.nextSession?.(options) ?? new FakeSession(contextAgentId(options));
    this.sessions.push(session);
    return session;
  }
}

describe('AgentPool registration', () => {
  it('constructs without provider/model work and registers explicit agents in immutable order', () => {
    const { pool, provider } = harness();
    expect(pool).toMatchObject({ size: 0, draining: false });
    expect(provider.createCalls).toBe(0);
    pool.register(registration('agent-B'));
    pool.register(registration('agent-A'));
    const list = pool.list();
    expect(list.map(({ agentId }) => agentId)).toEqual(['agent-B', 'agent-A']);
    expect(list[0]).toMatchObject({ providerId: 'fake', state: 'IDLE', busy: false, active: false });
    expect('providerConfig' in (list[0] ?? {})).toBe(false);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(provider.createCalls).toBe(0);
    expect('getRuntime' in pool).toBe(false);
  });

  it('rejects duplicate agents and unknown providers without replacement or fallback', () => {
    const { pool, provider } = harness();
    pool.register(registration('agent-A'));
    expectPoolError(() => pool.register(registration('agent-A')), 'AGENT_POOL_AGENT_DUPLICATE');
    expectPoolError(
      () => pool.register({ agentId: 'agent-X', providerId: 'missing' }),
      'AGENT_POOL_INVALID_REGISTRATION',
    );
    expect(pool.size).toBe(1);
    expect(provider.createCalls).toBe(0);
  });

  it('reads registration fields once and snapshots outer provider config', async () => {
    const { pool, provider } = harness();
    const reads = { agentId: 0, projectId: 0, providerId: 0, providerConfig: 0 };
    const source = {
      get agentId() { reads.agentId += 1; return reads.agentId === 1 ? 'agent-A' : 'agent-X'; },
      get projectId() { reads.projectId += 1; return reads.projectId === 1 ? 'project-A' : 'project-X'; },
      get providerId() { reads.providerId += 1; return reads.providerId === 1 ? 'fake' : 'missing'; },
      get providerConfig() {
        reads.providerConfig += 1;
        return reads.providerConfig === 1 ? { mode: 'A' } : { mode: 'B' };
      },
    };
    pool.register(source);
    expect(reads).toEqual({ agentId: 1, projectId: 1, providerId: 1, providerConfig: 1 });
    await pool.start('agent-A', binding('A'));
    expect(provider.options[0]?.config).toEqual({ mode: 'A' });
    expect(provider.options[0]?.context).toMatchObject({ agentId: 'agent-A', projectId: 'project-A' });
    await pool.shutdown('agent-A', 'assignment-A');
  });

  it('reserves registration snapshotting against synchronous reentrancy and drain races', async () => {
    const { pool } = harness();
    let nestedError: unknown;
    const registrationWithNested = {
      get agentId() {
        try { pool.register(registration('agent-B')); } catch (error) { nestedError = error; }
        return 'agent-A';
      },
      providerId: 'fake',
    };
    pool.register(registrationWithNested);
    expect(nestedError).toMatchObject({ code: 'AGENT_POOL_OPERATION_BUSY' });
    expect(pool.list().map(({ agentId }) => agentId)).toEqual(['agent-A']);

    const next = harness();
    let drain: Promise<void> | undefined;
    expectPoolError(() => next.pool.register({
      get agentId() { drain = next.pool.shutdownAll(); return 'agent-X'; },
      providerId: 'fake',
    }), 'AGENT_POOL_POOL_DRAINING');
    await drain;
    expect(next.pool.size).toBe(0);
    next.pool.register(registration('agent-X'));
  });

  it('releases a registration snapshot reservation when a getter throws', () => {
    const { pool } = harness();
    const failure = new Error('registration getter failed');
    expect(() => pool.register({
      get agentId(): string { throw failure; },
      providerId: 'fake',
    })).toThrow(failure);
    pool.register(registration('agent-A'));
    expect(pool.has('agent-A')).toBe(true);
  });

  it('unregisters only IDLE agents and allows explicit re-registration', async () => {
    const { pool } = harness();
    pool.register(registration('agent-A'));
    pool.unregister('agent-A');
    expect(pool.has('agent-A')).toBe(false);
    pool.register(registration('agent-A'));
    await pool.start('agent-A', binding('A'));
    expectPoolError(() => pool.unregister('agent-A'), 'AGENT_POOL_AGENT_BUSY');
    await pool.shutdown('agent-A', 'assignment-A');
    pool.unregister('agent-A');
    expect(pool.size).toBe(0);
  });
});

describe('AgentPool assignment ownership', () => {
  it('reads Pool binding fields once and blocks nested start/unregister during reservation', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    const reads = { taskId: 0, assignmentId: 0, specVersion: 0, profileHash: 0 };
    let nestedStart: Promise<void> | undefined;
    let unregisterError: unknown;
    const source = {
      get taskId() {
        reads.taskId += 1;
        nestedStart = pool.start('agent-B', binding('A'));
        try { pool.unregister('agent-A'); } catch (error) { unregisterError = error; }
        return 'task-A';
      },
      get assignmentId() { reads.assignmentId += 1; return reads.assignmentId === 1 ? 'assignment-A' : ''; },
      get specVersion() { reads.specVersion += 1; return reads.specVersion === 1 ? 'spec-A' : ''; },
      get profileHash() { reads.profileHash += 1; return reads.profileHash === 1 ? 'profile-A' : ''; },
    };
    await pool.start('agent-A', source);
    await expect(nestedStart).rejects.toMatchObject({ code: 'AGENT_POOL_OPERATION_BUSY' });
    expect(unregisterError).toMatchObject({ code: 'AGENT_POOL_OPERATION_BUSY' });
    expect(reads).toEqual({ taskId: 1, assignmentId: 1, specVersion: 1, profileHash: 1 });
    expect(provider.createCalls).toBe(1);
    expect(pool.getSnapshot('agent-A')).toMatchObject(binding('A'));
    await pool.shutdown('agent-A', 'assignment-A');
  });

  it('lets shutdownAll win from a binding getter before assignment or Runtime start', async () => {
    const { pool, provider } = registeredHarness('agent-A');
    let drain: Promise<void> | undefined;
    const source = {
      get taskId() { drain = pool.shutdownAll(); return 'task-A'; },
      assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A',
    };
    await expect(pool.start('agent-A', source)).rejects.toMatchObject({ code: 'AGENT_POOL_POOL_DRAINING' });
    await drain;
    expect(provider.createCalls).toBe(0);
    expect(pool.getSnapshot('agent-A').state).toBe('IDLE');
    await pool.start('agent-A', binding('A'));
    await pool.shutdown('agent-A', 'assignment-A');
  });

  it('releases Pool input reservation and assignment state when a binding getter throws', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    const failure = new Error('binding getter failed');
    await expect(pool.start('agent-A', {
      get taskId(): string { throw failure; },
      assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A',
    })).rejects.toBe(failure);
    expect(provider.createCalls).toBe(0);
    await pool.start('agent-B', binding('A'));
    await pool.shutdown('agent-B', 'assignment-A');
  });

  it('globally reserves assignments and permits independent agents', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    const gateA = deferred();
    provider.nextSession = (options) => Object.assign(new FakeSession(contextAgentId(options)), {
      startBarrier: options.context.agentId === 'agent-A' ? gateA.promise : undefined,
    });
    const startA = pool.start('agent-A', binding('A'));
    await expect(pool.start('agent-A', binding('B'))).rejects.toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
    await expect(pool.start('agent-B', binding('A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    const startB = pool.start('agent-B', binding('B'));
    await startB;
    gateA.resolve();
    await startA;
    expect(provider.createCalls).toBe(2);
    expect(pool.getSnapshot('agent-A')).toMatchObject({ assignmentId: 'assignment-A', state: 'OWNED' });
    expect(pool.getSnapshot('agent-B')).toMatchObject({ assignmentId: 'assignment-B', state: 'OWNED' });
    await pool.shutdownAll();
  });

  it('releases an IDLE start failure reservation and retains a FAILED start reservation', async () => {
    const idle = registeredHarness('agent-A', 'agent-B');
    const constructionError = new Error('construction failed');
    idle.provider.createError = constructionError;
    await expect(idle.pool.start('agent-A', binding('A'))).rejects.toBe(constructionError);
    idle.provider.createError = undefined;
    await idle.pool.start('agent-B', binding('A'));
    await idle.pool.shutdown('agent-B', 'assignment-A');

    const failed = registeredHarness('agent-A', 'agent-B');
    failed.provider.nextSession = (options) => Object.assign(new FakeSession(contextAgentId(options)), {
      startError: new Error('start failed'),
    });
    await expect(failed.pool.start('agent-A', binding('A'))).rejects.toThrow('start failed');
    await expect(failed.pool.start('agent-B', binding('A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    await expect(failed.pool.start('agent-A', binding('B'))).rejects.toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
    await failed.pool.shutdown('agent-A', 'assignment-A');
  });

  it('blocks reentrant same-assignment start and unregister after synchronous reservation', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    let nestedStart: Promise<void> | undefined;
    let unregisterError: unknown;
    provider.nextSession = (options) => {
      const session = new FakeSession(contextAgentId(options));
      if (options.context.agentId === 'agent-A') {
        session.onStart = () => {
          nestedStart = pool.start('agent-B', binding('A'));
          try { pool.unregister('agent-A'); } catch (error) { unregisterError = error; }
        };
      }
      return session;
    };
    await pool.start('agent-A', binding('A'));
    await expect(nestedStart).rejects.toMatchObject({ code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED' });
    expect(unregisterError).toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
    expect(provider.createCalls).toBe(1);
    await pool.shutdown('agent-A', 'assignment-A');
  });
});

describe('AgentPool assignment fences', () => {
  it('allows only the current agent and assignment to dispatch a turn', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await pool.start('agent-A', binding('A'));
    await expect(pool.runTurn('agent-A', 'assignment-X', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    await expect(pool.runTurn('agent-B', 'assignment-A', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    await expect(pool.runTurn('missing', 'assignment-A', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_AGENT_NOT_FOUND',
    });
    expect(sessionFor(provider, 'agent-A').runCalls).toBe(0);
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).resolves.toMatchObject({ directiveStatus: 'valid' });
    expect(sessionFor(provider, 'agent-A').runCalls).toBe(1);
    await pool.shutdown('agent-A', 'assignment-A');
  });

  it('fences released and old assignments from a new assignment on the same task', async () => {
    const { pool, provider } = registeredHarness('agent-A');
    await pool.start('agent-A', binding('A', 'same-task'));
    await pool.shutdown('agent-A', 'assignment-A');
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    await pool.start('agent-A', binding('B', 'same-task'));
    const current = sessionFor(provider, 'agent-A', 1);
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    expect(current.runCalls).toBe(0);
    await pool.runTurn('agent-A', 'assignment-B', request());
    expect(current.runCalls).toBe(1);
    await pool.shutdown('agent-A', 'assignment-B');
  });

  it('fences stale shutdown so an old assignment cannot stop a new one', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await pool.start('agent-A', binding('A'));
    await expect(pool.shutdown('agent-A', 'assignment-X')).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    await expect(pool.shutdown('agent-B', 'assignment-A')).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    expect(sessionFor(provider, 'agent-A').shutdownCalls).toBe(0);
    await pool.shutdown('agent-A', 'assignment-A');
    await pool.start('agent-A', binding('B'));
    const current = sessionFor(provider, 'agent-A', 1);
    await expect(pool.shutdown('agent-A', 'assignment-A')).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    expect(current.shutdownCalls).toBe(0);
    await pool.shutdown('agent-A', 'assignment-B');
  });
});

describe('AgentPool lifecycle concurrency', () => {
  it('runs different agents concurrently without a global turn mutex', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await Promise.all([
      pool.start('agent-A', binding('A')),
      pool.start('agent-B', binding('B')),
    ]);
    const gateA = deferred();
    const gateB = deferred();
    sessionFor(provider, 'agent-A').runBarrier = gateA.promise;
    sessionFor(provider, 'agent-B').runBarrier = gateB.promise;
    const turnA = pool.runTurn('agent-A', 'assignment-A', request());
    const turnB = pool.runTurn('agent-B', 'assignment-B', request());
    expect(pool.getSnapshot('agent-A').active).toBe(true);
    expect(pool.getSnapshot('agent-B').active).toBe(true);
    gateA.resolve(); gateB.resolve();
    await Promise.all([turnA, turnB]);
    await pool.shutdownAll();
  });

  it('shares concurrent shutdown and releases one exact assignment', async () => {
    const { pool, provider } = registeredHarness('agent-A');
    await pool.start('agent-A', binding('A'));
    const gate = deferred();
    const session = sessionFor(provider, 'agent-A');
    session.shutdownBarrier = gate.promise;
    const first = pool.shutdown('agent-A', 'assignment-A');
    const second = pool.shutdown('agent-A', 'assignment-A');
    gate.resolve();
    await Promise.all([first, second]);
    expect(session.shutdownCalls).toBe(1);
    expect(pool.getSnapshot('agent-A').state).toBe('IDLE');
  });

  it('reconciles start/shutdown and turn/shutdown races without early release', async () => {
    const starting = registeredHarness('agent-A');
    const startGate = deferred();
    starting.provider.nextSession = (options) => Object.assign(new FakeSession(contextAgentId(options)), {
      startBarrier: startGate.promise,
    });
    const start = starting.pool.start('agent-A', binding('A'));
    const stopStarting = starting.pool.shutdown('agent-A', 'assignment-A');
    await expect(starting.pool.start('agent-A', binding('B'))).rejects.toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
    startGate.resolve();
    await Promise.allSettled([start, stopStarting]);
    expect(starting.pool.getSnapshot('agent-A').state).toBe('IDLE');

    const turning = registeredHarness('agent-A');
    await turning.pool.start('agent-A', binding('A'));
    const turnGate = deferred();
    sessionFor(turning.provider, 'agent-A').runBarrier = turnGate.promise;
    const turn = turning.pool.runTurn('agent-A', 'assignment-A', request());
    const stopTurn = turning.pool.shutdown('agent-A', 'assignment-A');
    expect(turning.pool.getSnapshot('agent-A')).toMatchObject({ state: 'STOPPING', active: true });
    turnGate.resolve();
    await Promise.all([turn, stopTurn]);
    expect(turning.pool.getSnapshot('agent-A').state).toBe('IDLE');
  });

  it('retains ownership after failed cleanup and releases it only after explicit retry', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await pool.start('agent-A', binding('A'));
    const session = sessionFor(provider, 'agent-A');
    session.shutdownError = new Error('cleanup failed');
    await expect(pool.shutdown('agent-A', 'assignment-A')).rejects.toThrow('cleanup failed');
    expect(pool.getSnapshot('agent-A').state).toBe('FAILED');
    await expect(pool.start('agent-B', binding('A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    await expect(pool.start('agent-A', binding('B'))).rejects.toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
    session.shutdownError = undefined;
    await pool.shutdown('agent-A', 'assignment-A');
    await pool.start('agent-A', binding('B'));
    expect(provider.createCalls).toBe(2);
    await pool.shutdown('agent-A', 'assignment-B');
  });

  it('never replays a failed turn or falls back to another agent', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await pool.start('agent-A', binding('A'));
    const session = sessionFor(provider, 'agent-A');
    const failure = new Error('turn failed');
    session.runError = failure;
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).rejects.toBe(failure);
    expect(session.runCalls).toBe(1);
    expect(provider.createCalls).toBe(1);
    expect(pool.getSnapshot('agent-A')).toMatchObject({ state: 'OWNED', assignmentId: 'assignment-A' });
    expect(pool.getSnapshot('agent-B').state).toBe('IDLE');
    await pool.shutdown('agent-A', 'assignment-A');
  });

  it('retains the assignment when a turn loses the Runtime provider', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await pool.start('agent-A', binding('A'));
    const session = sessionFor(provider, 'agent-A');
    session.stopAfterRun = true;
    session.runError = new Error('provider lost');
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).rejects.toThrow('provider lost');
    expect(pool.getSnapshot('agent-A').state).toBe('FAILED');
    await expect(pool.start('agent-B', binding('A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    expect(provider.createCalls).toBe(1);
    await pool.shutdown('agent-A', 'assignment-A');
  });
});

describe('AgentPool shutdownAll', () => {
  it('is idempotent for empty and all-IDLE pools', async () => {
    const { pool, provider } = registeredHarness('agent-A');
    await pool.shutdownAll();
    await pool.shutdownAll();
    expect(provider.createCalls).toBe(0);
    expect(pool.draining).toBe(false);
  });

  it('shares one drain and starts independent cleanups concurrently', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B');
    await Promise.all([pool.start('agent-A', binding('A')), pool.start('agent-B', binding('B'))]);
    const gateA = deferred();
    const gateB = deferred();
    const sessionA = sessionFor(provider, 'agent-A');
    const sessionB = sessionFor(provider, 'agent-B');
    sessionA.shutdownBarrier = gateA.promise;
    sessionB.shutdownBarrier = gateB.promise;
    const first = pool.shutdownAll();
    const second = pool.shutdownAll();
    expect(first).toBe(second);
    expect(pool.draining).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(sessionA.shutdownCalls).toBe(1);
    expect(sessionB.shutdownCalls).toBe(1);
    await expect(pool.start('agent-A', binding('C'))).rejects.toMatchObject({ code: 'AGENT_POOL_POOL_DRAINING' });
    await expect(pool.runTurn('agent-A', 'assignment-A', request())).rejects.toMatchObject({
      code: 'AGENT_POOL_POOL_DRAINING',
    });
    await expect(pool.shutdown('agent-A', 'assignment-A')).rejects.toMatchObject({
      code: 'AGENT_POOL_POOL_DRAINING',
    });
    expectPoolError(() => pool.unregister('agent-A'), 'AGENT_POOL_POOL_DRAINING');
    expectPoolError(() => pool.register(registration('agent-C')), 'AGENT_POOL_POOL_DRAINING');
    gateA.resolve(); gateB.resolve();
    await Promise.all([first, second]);
    expect(pool.draining).toBe(false);
    expect(pool.list().every(({ state }) => state === 'IDLE')).toBe(true);
  });

  it('drains STARTING and active runtimes without losing reservations', async () => {
    const starting = registeredHarness('agent-A');
    const startGate = deferred();
    starting.provider.nextSession = (options) => Object.assign(new FakeSession(contextAgentId(options)), {
      startBarrier: startGate.promise,
    });
    const start = starting.pool.start('agent-A', binding('A'));
    const drainStarting = starting.pool.shutdownAll();
    await expect(starting.pool.start('agent-A', binding('B'))).rejects.toMatchObject({ code: 'AGENT_POOL_POOL_DRAINING' });
    startGate.resolve();
    await Promise.allSettled([start, drainStarting]);
    expect(starting.pool.getSnapshot('agent-A').state).toBe('IDLE');

    const active = registeredHarness('agent-A');
    await active.pool.start('agent-A', binding('A'));
    const turnGate = deferred();
    sessionFor(active.provider, 'agent-A').runBarrier = turnGate.promise;
    const turn = active.pool.runTurn('agent-A', 'assignment-A', request());
    const drainActive = active.pool.shutdownAll();
    turnGate.resolve();
    await Promise.all([turn, drainActive]);
    expect(active.pool.getSnapshot('agent-A').state).toBe('IDLE');
  });

  it('lets reentrant shutdownAll win during start without assignment resurrection', async () => {
    const { pool, provider } = registeredHarness('agent-A');
    let drain: Promise<void> | undefined;
    provider.nextSession = (options) => {
      const session = new FakeSession(contextAgentId(options));
      session.onStart = () => { drain = pool.shutdownAll(); };
      return session;
    };
    const start = pool.start('agent-A', binding('A'));
    await Promise.allSettled([start]);
    await drain;
    expect(pool.getSnapshot('agent-A').state).toBe('IDLE');
    expect(sessionFor(provider, 'agent-A').shutdownCalls).toBe(1);
  });

  it('partially releases successes, retains failures, and permits explicit retry', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B', 'agent-C');
    await Promise.all([pool.start('agent-A', binding('A')), pool.start('agent-B', binding('B'))]);
    const sessionA = sessionFor(provider, 'agent-A');
    sessionA.shutdownError = new Error('A cleanup failed');
    const first = pool.shutdownAll();
    await expect(first).rejects.toMatchObject({
      code: 'AGENT_POOL_SHUTDOWN_FAILED', failedAgentIds: ['agent-A'],
    });
    expect(pool.draining).toBe(false);
    expect(pool.getSnapshot('agent-A').state).toBe('FAILED');
    expect(pool.getSnapshot('agent-B').state).toBe('IDLE');
    await expect(pool.start('agent-C', binding('A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    await pool.start('agent-B', binding('C'));
    await pool.shutdown('agent-B', 'assignment-C');
    sessionA.shutdownError = undefined;
    await pool.shutdownAll();
    expect(sessionA.shutdownCalls).toBe(2);
    expect(pool.getSnapshot('agent-A').state).toBe('IDLE');
    await pool.start('agent-C', binding('A'));
    await pool.shutdown('agent-C', 'assignment-A');
  });

  it('aggregates multiple failed agents and retries only non-IDLE runtimes', async () => {
    const { pool, provider } = registeredHarness('agent-A', 'agent-B', 'agent-C');
    await Promise.all([pool.start('agent-A', binding('A')), pool.start('agent-B', binding('B'))]);
    const sessionA = sessionFor(provider, 'agent-A');
    const sessionB = sessionFor(provider, 'agent-B');
    sessionA.shutdownError = new Error('A failed');
    sessionB.shutdownError = new Error('B failed');
    await expect(pool.shutdownAll()).rejects.toMatchObject({
      code: 'AGENT_POOL_SHUTDOWN_FAILED', failedAgentIds: ['agent-A', 'agent-B'],
    });
    expect(sessionA.shutdownCalls).toBe(1);
    expect(sessionB.shutdownCalls).toBe(1);
    sessionA.shutdownError = undefined;
    sessionB.shutdownError = undefined;
    await pool.shutdownAll();
    expect(sessionA.shutdownCalls).toBe(2);
    expect(sessionB.shutdownCalls).toBe(2);
    expect(pool.getSnapshot('agent-C').state).toBe('IDLE');
    expect(provider.sessions.filter(({ agentId }) => agentId === 'agent-C')).toHaveLength(0);
  });
});

describe('AgentPool controlled built-in integration', () => {
  it('composes Pool → Runtime → ClaudeAgentProvider without real model work', async () => {
    const factory = new AgentProviderFactory();
    const workers: FakeClaudeWorker[] = [];
    factory.register(new ClaudeAgentProvider({
      createWorkerSession: () => { const worker = new FakeClaudeWorker(); workers.push(worker); return worker; },
    }));
    const pool = new AgentPool({ providerFactory: factory, eventBus: new EventBus() });
    pool.register({ agentId: 'claude-agent', providerId: 'claude' });
    await pool.start('claude-agent', binding('A'));
    await pool.runTurn('claude-agent', 'assignment-A', { prompt: 'work', protocol: 'worker-result' });
    await pool.shutdown('claude-agent', 'assignment-A');
    expect(workers).toHaveLength(1);
    expect(workers[0]?.runCalls).toBe(1);
  });

  it('composes Pool → Runtime → CodexAgentProvider without real model work', async () => {
    const factory = new AgentProviderFactory();
    const useCases: FakeCodexUseCase[] = [];
    factory.register(new CodexAgentProvider({
      createUseCase: () => { const useCase = new FakeCodexUseCase(); useCases.push(useCase); return useCase; },
      createEventMapper: () => ({ attach() {}, dispose() {} }),
    }));
    const pool = new AgentPool({ providerFactory: factory, eventBus: new EventBus() });
    pool.register({ agentId: 'codex-agent', providerId: 'codex' });
    await pool.start('codex-agent', binding('A'));
    await pool.runTurn('codex-agent', 'assignment-A', request());
    await pool.shutdown('codex-agent', 'assignment-A');
    expect(useCases).toHaveLength(1);
    expect(useCases[0]?.runCalls).toBe(1);
  });
});

class FakeClaudeWorker implements ClaudeWorkerSessionLike {
  public started = false;
  public active = false;
  public sessionId: string | undefined = 'claude-session';
  public runCalls = 0;
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public runTurn(): Promise<ClaudeWorkerTurnResult> {
    this.runCalls += 1;
    return Promise.resolve({
      protocolValid: true, workerResult, transport: 'persistent-stream',
      sessionId: 'claude-session', durationMs: 1,
    });
  }
  public shutdown(): Promise<void> { this.started = false; return Promise.resolve(); }
}

class FakeCodexUseCase implements CodexManagerUseCaseLike {
  public status = CodexProviderStatus.STOPPED;
  public runCalls = 0;
  public initialize(): Promise<void> { this.status = CodexProviderStatus.READY; return Promise.resolve(); }
  public shutdown(): Promise<void> { this.status = CodexProviderStatus.STOPPED; return Promise.resolve(); }
  public runDirectiveTurn(): Promise<ManagerDirectiveTurnResult> {
    this.runCalls += 1;
    return Promise.resolve(codexResult());
  }
  public getManagerSession() {
    return this.status === CodexProviderStatus.READY
      ? { threadId: 'thread', sessionId: 'codex-session' }
      : undefined;
  }
  public getStatus() { return this.status; }
  public onNotification() { return () => undefined; }
  public onServerRequest() { return () => undefined; }
  public onProtocolError() { return () => undefined; }
  public onProcessExit() { return () => undefined; }
  public onProcessError() { return () => undefined; }
}

function harness() {
  const provider = new FakeProvider();
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: new EventBus() });
  return { pool, provider, factory };
}

function registeredHarness(...agentIds: string[]) {
  const result = harness();
  for (const agentId of agentIds) result.pool.register(registration(agentId));
  return result;
}

function registration(agentId: string): AgentPoolRegistration {
  return { agentId, projectId: 'project', providerId: 'fake' };
}

function binding(suffix: string, taskId = `task-${suffix}`): AgentRuntimeBinding {
  return {
    taskId, assignmentId: `assignment-${suffix}`,
    specVersion: `spec-${suffix}`, profileHash: `profile-${suffix}`,
  };
}

function request(): AgentProviderTurnRequest {
  return { prompt: 'plan', protocol: 'manager-directive' };
}

function managerResult(sessionId: string): AgentProviderTurnResult {
  return {
    providerId: 'fake', protocol: 'manager-directive', directiveStatus: 'valid', directive,
    sessionId, durationMs: 1,
  };
}

function sessionFor(provider: FakeProvider, agentId: string, generation = 0): FakeSession {
  const sessions = provider.sessions.filter((session) => session.agentId === agentId);
  const session = sessions[generation];
  if (session === undefined) throw new Error(`Missing session for ${agentId}`);
  return session;
}

function contextAgentId(options: AgentProviderSessionCreateOptions): string {
  const agentId = options.context.agentId;
  if (agentId === undefined) throw new Error('Missing agent context');
  return agentId;
}

function expectPoolError(callback: () => void, code: AgentPoolError['code']): void {
  let caught: unknown;
  try { callback(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AgentPoolError);
  expect(caught).toMatchObject({ code });
}

function codexResult(): ManagerDirectiveTurnResult {
  return {
    initialTurn: {
      threadId: 'thread', sessionId: 'codex-session', turnId: 'turn',
      status: 'completed', text: '', events: [],
    },
    directive, directiveStatus: 'valid',
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
