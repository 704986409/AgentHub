import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  AntigravityAgentProvider,
  EventBus,
  type AgentHubWorkerResult,
  type AntigravityWorkerSessionLike,
  type AntigravityWorkerTurnResult,
} from '../src/index.js';

const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'antigravity done',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
};

class FakeAntigravityWorker implements AntigravityWorkerSessionLike {
  public started = false;
  public active = false;
  public sessionId: string | undefined = 'antigravity-session-1';
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public result: AntigravityWorkerTurnResult = {
    protocolValid: true,
    workerResult,
    conversationId: 'antigravity-session-1',
    durationMs: 33,
  };
  public runError: Error | undefined;

  public start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
    return Promise.resolve();
  }

  public runTurn(): Promise<AntigravityWorkerTurnResult> {
    this.runCalls += 1;
    return this.runError === undefined ? Promise.resolve(this.result) : Promise.reject(this.runError);
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    return Promise.resolve();
  }
}

describe('Antigravity agent provider adapter', () => {
  it('exposes worker-result output capability and registers with AgentProviderFactory', () => {
    const provider = new AntigravityAgentProvider();
    expect(provider.id).toBe('antigravity');
    expect(provider.capabilities).toEqual({
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    });

    const factory = new AgentProviderFactory();
    factory.register(provider);
    expect(factory.has('antigravity')).toBe(true);
  }, 5_000);

  it('delegates session start, runTurn, and shutdown to AntigravityWorkerSession', async () => {
    const fakeWorker = new FakeAntigravityWorker();
    const provider = new AntigravityAgentProvider({
      createWorkerSession: () => fakeWorker,
    });

    const session = provider.createSession({
      context: {
        agentId: 'agent-agy-1',
        provider: 'antigravity',
      },
      eventBus: new EventBus(),
    });

    expect(session.providerId).toBe('antigravity');
    expect(session.capabilities).toEqual(provider.capabilities);

    await session.start();
    expect(fakeWorker.startCalls).toBe(1);
    expect(session.started).toBe(true);

    const turnResult = await session.runTurn({
      prompt: 'do something in antigravity',
      protocol: 'worker-result',
      timeoutMs: 10_000,
    });

    expect(fakeWorker.runCalls).toBe(1);
    expect(turnResult.protocol).toBe('worker-result');
    if (turnResult.protocol === 'worker-result' && turnResult.protocolValid) {
      expect(turnResult.workerResult).toEqual(workerResult);
      expect(turnResult.sessionId).toBe('antigravity-session-1');
      expect(turnResult.durationMs).toBe(33);
    }

    await session.shutdown();
    expect(fakeWorker.shutdownCalls).toBe(1);
    expect(session.started).toBe(false);
  }, 5_000);

  it('handles invalid worker-result protocol output from Antigravity turn', async () => {
    const fakeWorker = new FakeAntigravityWorker();
    fakeWorker.result = {
      protocolValid: false,
      kind: 'worker_result_protocol',
      failure: {
        kind: 'malformed_json',
        message: 'SyntaxError: unexpected token',
      },
      conversationId: 'antigravity-session-1',
      durationMs: 20,
    };

    const provider = new AntigravityAgentProvider({
      createWorkerSession: () => fakeWorker,
    });

    const session = provider.createSession({
      context: {
        agentId: 'agent-agy-2',
        provider: 'antigravity',
      },
      eventBus: new EventBus(),
    });

    await session.start();
    const turnResult = await session.runTurn({ prompt: 'test', protocol: 'worker-result' });
    expect(turnResult.protocol).toBe('worker-result');
    if (turnResult.protocol === 'worker-result' && !turnResult.protocolValid) {
      expect(turnResult.failure.kind).toBe('malformed_json');
      expect(turnResult.sessionId).toBe('antigravity-session-1');
    }
  }, 5_000);
});
