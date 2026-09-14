import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentProviderFactory,
  EventBus,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
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
  public readonly sessionId = 'session';
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public runTurn(): Promise<AgentProviderTurnResult> { throw new Error('unused'); }
  public shutdown(): Promise<void> { this.started = false; return Promise.resolve(); }
}

class Provider implements AgentProvider {
  public readonly id = 'fake';
  public readonly capabilities = capabilities;
  public readonly session = new Session();
  public options: AgentProviderSessionCreateOptions | undefined;
  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.options = options;
    return this.session;
  }
}

describe('runtime workspace binding', () => {
  it('snapshots reserved promotion workspace context and passes it to the provider factory', async () => {
    const provider = new Provider();
    const factory = new AgentProviderFactory();
    factory.register(provider);
    const pool = new AgentPool({ providerFactory: factory, eventBus: new EventBus() });
    pool.register({ agentId: 'agent-a', providerId: 'fake' });
    const binding = runtimeBinding();
    pool.reserve('agent-a', binding);
    const workspacePath = resolve('task-worktree');
    const context = { workspacePath };
    const started = pool.startReserved('agent-a', binding, context);
    context.workspacePath = resolve('mutated');
    await started;
    expect(provider.options?.workspacePath).toBe(workspacePath);
    await pool.shutdown('agent-a', binding.assignmentId);
  });
});

function runtimeBinding(): AgentRuntimeBinding {
  return { taskId: 'task-a', assignmentId: 'assignment-a', specVersion: '1', profileHash: 'profile' };
}
