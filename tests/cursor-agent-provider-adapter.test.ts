import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  CursorAgentProvider,
  EventBus,
  type AgentHubWorkerResult,
  type CursorWorkerSessionLike,
  type CursorWorkerTurnResult,
} from '../src/index.js';

const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'cursor done',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
};

class FakeCursorWorker implements CursorWorkerSessionLike {
  public started = false;
  public active = false;
  public sessionId: string | undefined = 'cursor-session-1';
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public result: CursorWorkerTurnResult = {
    protocolValid: true,
    workerResult,
    sessionId: 'cursor-session-1',
    durationMs: 42,
  };
  public runError: Error | undefined;

  public start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
    return Promise.resolve();
  }

  public runTurn(): Promise<CursorWorkerTurnResult> {
    this.runCalls += 1;
    return this.runError === undefined ? Promise.resolve(this.result) : Promise.reject(this.runError);
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    return Promise.resolve();
  }
}

describe('Cursor agent provider adapter', () => {
  it('exposes worker-result output capability and registers with AgentProviderFactory', () => {
    const provider = new CursorAgentProvider();
    expect(provider.id).toBe('cursor');
    expect(provider.capabilities).toEqual({
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    });

    const factory = new AgentProviderFactory();
    factory.register(provider);
    expect(factory.has('cursor')).toBe(true);
  }, 5_000);

  it('delegates session start, runTurn, and shutdown to CursorWorkerSession', async () => {
    const fakeWorker = new FakeCursorWorker();
    const provider = new CursorAgentProvider({
      createWorkerSession: () => fakeWorker,
    });

    const session = provider.createSession({
      context: {
        agentId: 'agent-1',
        provider: 'cursor',
      },
      eventBus: new EventBus(),
    });

    expect(session.providerId).toBe('cursor');
    expect(session.capabilities).toEqual(provider.capabilities);

    await session.start();
    expect(fakeWorker.startCalls).toBe(1);
    expect(session.started).toBe(true);

    const turnResult = await session.runTurn({
      prompt: 'do something in cursor',
      protocol: 'worker-result',
      timeoutMs: 10_000,
    });

    expect(fakeWorker.runCalls).toBe(1);
    expect(turnResult.protocol).toBe('worker-result');
    if (turnResult.protocol === 'worker-result' && turnResult.protocolValid) {
      expect(turnResult.workerResult).toEqual(workerResult);
      expect(turnResult.sessionId).toBe('cursor-session-1');
      expect(turnResult.durationMs).toBe(42);
    }

    await session.shutdown();
    expect(fakeWorker.shutdownCalls).toBe(1);
    expect(session.started).toBe(false);
  }, 5_000);

  it('handles invalid worker-result protocol output from Cursor turn', async () => {
    const fakeWorker = new FakeCursorWorker();
    fakeWorker.result = {
      protocolValid: false,
      kind: 'worker_result_protocol',
      failure: {
        kind: 'missing_result',
        message: 'No worker result block',
      },
      sessionId: 'cursor-session-1',
      durationMs: 15,
    };

    const provider = new CursorAgentProvider({
      createWorkerSession: () => fakeWorker,
    });

    const session = provider.createSession({
      context: {
        agentId: 'agent-2',
        provider: 'cursor',
      },
      eventBus: new EventBus(),
    });

    await session.start();
    const turnResult = await session.runTurn({ prompt: 'test', protocol: 'worker-result' });
    expect(turnResult.protocol).toBe('worker-result');
    if (turnResult.protocol === 'worker-result' && !turnResult.protocolValid) {
      expect(turnResult.failure.kind).toBe('missing_result');
      expect(turnResult.sessionId).toBe('cursor-session-1');
    }
  }, 5_000);
});
