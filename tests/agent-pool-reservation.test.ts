import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentPoolError,
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

class CountingProvider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public createCalls = 0;

  public createSession(): AgentProviderSession {
    this.createCalls += 1;
    return new NeverStartedSession();
  }
}

class NeverStartedSession implements AgentProviderSession {
  public readonly providerId = 'fake';
  public readonly capabilities = capabilities;
  public readonly started = false;
  public readonly active = false;
  public readonly sessionId = undefined;
  public start(): Promise<void> { return Promise.reject(new Error('reservation must not start a session')); }
  public runTurn(): Promise<AgentProviderTurnResult> {
    return Promise.reject(new Error('reservation must not run a turn'));
  }
  public shutdown(): Promise<void> { return Promise.reject(new Error('reservation must not stop a session')); }
}

describe('AgentPool reservation-only lifecycle', () => {
  it('reserves a clean IDLE agent without starting runtime or creating a provider session', () => {
    const { pool, provider } = harness();
    pool.register({ agentId: 'agent-a', projectId: 'project-a', providerId: 'fake' });

    const reservation = pool.reserve('agent-a', binding('assignment-a'));

    expect(reservation).toEqual({ agentId: 'agent-a', ...binding('assignment-a') });
    expect(Object.isFrozen(reservation)).toBe(true);
    expect(pool.getSnapshot('agent-a')).toMatchObject({
      state: 'IDLE', busy: false, active: false, reserved: true,
      reservedTaskId: 'task-a', reservedAssignmentId: 'assignment-a',
      reservedSpecVersion: '1.0.0', reservedProfileHash: 'profile-a',
    });
    expect(provider.createCalls).toBe(0);
  });

  it('blocks a second reservation for one agent and one assignment across agents', () => {
    const { pool } = harness();
    pool.register({ agentId: 'agent-a', providerId: 'fake' });
    pool.register({ agentId: 'agent-b', providerId: 'fake' });
    pool.reserve('agent-a', binding('assignment-a'));

    expectPoolError(() => pool.reserve('agent-a', binding('assignment-b')), 'AGENT_POOL_AGENT_BUSY');
    expectPoolError(() => pool.reserve('agent-b', binding('assignment-a')), 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED');
    expect(pool.getSnapshot('agent-b').reserved).toBe(false);
  });

  it('releases only an exact reservation and leaves runtime untouched', () => {
    const { pool, provider } = harness();
    pool.register({ agentId: 'agent-a', providerId: 'fake' });
    pool.reserve('agent-a', binding('assignment-a'));

    expectPoolError(() => pool.releaseReservation('agent-a', 'wrong'), 'AGENT_POOL_ASSIGNMENT_MISMATCH');
    expect(pool.getSnapshot('agent-a').reserved).toBe(true);
    pool.releaseReservation('agent-a', 'assignment-a');

    expect(pool.getSnapshot('agent-a')).toMatchObject({
      state: 'IDLE', busy: false, active: false, reserved: false,
    });
    expect(provider.createCalls).toBe(0);
  });

  it('blocks unregister and direct runtime start while reserved', async () => {
    const { pool, provider } = harness();
    pool.register({ agentId: 'agent-a', providerId: 'fake' });
    pool.register({ agentId: 'agent-b', providerId: 'fake' });
    pool.reserve('agent-a', binding('assignment-a'));

    expectPoolError(() => pool.unregister('agent-a'), 'AGENT_POOL_AGENT_BUSY');
    await expect(pool.start('agent-a', binding('assignment-a'))).rejects.toMatchObject({
      code: 'AGENT_POOL_AGENT_BUSY',
    });
    await expect(pool.start('agent-b', binding('assignment-a'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    expect(pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', busy: false, reserved: true });
    expect(pool.getSnapshot('agent-b')).toMatchObject({ state: 'IDLE', busy: false, reserved: false });
    expect(provider.createCalls).toBe(0);
  });

  it('blocks reservation while draining and retains existing reservations across a runtime-only drain', async () => {
    const { pool, provider } = harness();
    pool.register({ agentId: 'agent-a', providerId: 'fake' });
    pool.register({ agentId: 'agent-b', providerId: 'fake' });
    pool.reserve('agent-a', binding('assignment-a'));

    const draining = pool.shutdownAll();
    expectPoolError(() => pool.reserve('agent-b', binding('assignment-b')), 'AGENT_POOL_POOL_DRAINING');
    await draining;

    expect(pool.getSnapshot('agent-a')).toMatchObject({ state: 'IDLE', reserved: true });
    expect(pool.getSnapshot('agent-b')).toMatchObject({ state: 'IDLE', reserved: false });
    expect(provider.createCalls).toBe(0);
  });
});

function harness(): { pool: AgentPool; provider: CountingProvider } {
  const provider = new CountingProvider();
  const providerFactory = new AgentProviderFactory();
  providerFactory.register(provider);
  return { pool: new AgentPool({ providerFactory, eventBus: new EventBus() }), provider };
}

function binding(assignmentId: string): AgentRuntimeBinding {
  return { taskId: 'task-a', assignmentId, specVersion: '1.0.0', profileHash: 'profile-a' };
}

function expectPoolError(callback: () => unknown, code: string): void {
  let caught: unknown;
  try { callback(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AgentPoolError);
  expect(caught).toMatchObject({ code });
}
