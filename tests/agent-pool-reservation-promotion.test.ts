import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentProviderFactory,
  EventBus,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderTurnResult,
  type AgentRuntimeBinding,
} from '../src/index.js';

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
  public shutdownCalls = 0;
  public startError: Error | undefined;
  public startBarrier: Promise<void> | undefined;
  public async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startBarrier !== undefined) await this.startBarrier;
    if (this.startError !== undefined) throw this.startError;
    this.started = true;
  }
  public runTurn(): Promise<AgentProviderTurnResult> {
    throw new Error('unused');
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
  public createCalls = 0;
  public createError: Error | undefined;
  public createSession(): AgentProviderSession {
    this.createCalls += 1;
    if (this.createError !== undefined) throw this.createError;
    return this.session;
  }
}

describe('AgentPool reserved assignment promotion', () => {
  it('atomically consumes the exact reservation, owns it, and starts once', async () => {
    const { pool, provider } = harness();
    pool.reserve('agent-a', binding());
    await pool.startReserved('agent-a', binding());
    expect(pool.getSnapshot('agent-a')).toMatchObject({
      state: 'OWNED', busy: true, reserved: false, taskId: 'task-a', assignmentId: 'assignment-a',
    });
    expect(provider.createCalls).toBe(1);
    expect(provider.session.startCalls).toBe(1);
    await pool.shutdown('agent-a', 'assignment-a');
    expect(provider.session.shutdownCalls).toBe(1);
    expect(pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: false });
  });

  it.each([
    ['wrong task', { taskId: 'task-x' }],
    ['wrong assignment', { assignmentId: 'assignment-x' }],
    ['wrong spec', { specVersion: '2.0.0' }],
    ['wrong profile', { profileHash: 'profile-x' }],
  ])('rejects %s without consuming the reservation', async (_name, change) => {
    const { pool, provider } = harness();
    pool.reserve('agent-a', binding());
    await expect(pool.startReserved('agent-a', { ...binding(), ...change })).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    expect(pool.getSnapshot('agent-a').reserved).toBe(true);
    expect(provider.createCalls).toBe(0);
  });

  it('rejects an unreserved promotion and keeps direct start blocked while reserved', async () => {
    const { pool } = harness();
    await expect(pool.startReserved('agent-a', binding())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    pool.reserve('agent-a', binding());
    await expect(pool.start('agent-a', binding())).rejects.toMatchObject({ code: 'AGENT_POOL_AGENT_BUSY' });
  });

  it('blocks promotion through the wrong agent', async () => {
    const { pool } = harness();
    pool.register({ agentId: 'agent-b', projectId: 'project-a', providerId: 'fake' });
    pool.reserve('agent-a', binding());
    await expect(pool.startReserved('agent-b', binding())).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_MISMATCH',
    });
    expect(pool.getSnapshot('agent-a').reserved).toBe(true);
  });

  it('restores the exact reservation after an authoritatively clean start failure', async () => {
    const { pool, provider } = harness();
    provider.createError = new Error('clean factory failure');
    pool.reserve('agent-a', binding());
    await expect(pool.startReserved('agent-a', binding())).rejects.toThrow('clean factory failure');
    expect(pool.getSnapshot('agent-a')).toMatchObject({
      state: 'IDLE', reserved: true, reservedAssignmentId: 'assignment-a',
    });
    expect('assignmentId' in pool.getSnapshot('agent-a')).toBe(false);
  });

  it('retains runtime ownership evidence after a dirty start failure', async () => {
    const { pool, provider } = harness();
    provider.session.startError = new Error('dirty session failure');
    pool.reserve('agent-a', binding());
    await expect(pool.startReserved('agent-a', binding())).rejects.toThrow('dirty session failure');
    expect(pool.getSnapshot('agent-a')).toMatchObject({
      state: 'FAILED', reserved: false, assignmentId: 'assignment-a', taskId: 'task-a',
    });
    await pool.shutdown('agent-a', 'assignment-a');
  });

  it('allows only one concurrent promotion', async () => {
    const { pool, provider } = harness();
    let release!: () => void;
    provider.session.startBarrier = new Promise<void>((resolve) => { release = resolve; });
    pool.reserve('agent-a', binding());
    const first = pool.startReserved('agent-a', binding());
    await expect(pool.startReserved('agent-a', binding())).rejects.toMatchObject({
      code: 'AGENT_POOL_OPERATION_BUSY',
    });
    release();
    await first;
    expect(provider.session.startCalls).toBe(1);
    await pool.shutdown('agent-a', 'assignment-a');
  });

  it('blocks promotion while draining and preserves the reservation', async () => {
    const { pool, provider } = harness();
    pool.reserve('agent-a', binding());
    const drain = pool.shutdownAll();
    await expect(pool.startReserved('agent-a', binding())).rejects.toMatchObject({
      code: 'AGENT_POOL_POOL_DRAINING',
    });
    await drain;
    expect(pool.getSnapshot('agent-a').reserved).toBe(true);
    expect(provider.createCalls).toBe(0);
  });
});

function harness(): { pool: AgentPool; provider: Provider } {
  const provider = new Provider();
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const pool = new AgentPool({ providerFactory: factory, eventBus: new EventBus() });
  pool.register({ agentId: 'agent-a', projectId: 'project-a', providerId: 'fake' });
  return { pool, provider };
}

function binding(): AgentRuntimeBinding {
  return { taskId: 'task-a', assignmentId: 'assignment-a', specVersion: '1.0.0', profileHash: 'profile-a' };
}
