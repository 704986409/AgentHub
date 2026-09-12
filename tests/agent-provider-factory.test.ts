import { describe, expect, it } from 'vitest';

import {
  AgentProviderError,
  AgentProviderFactory,
  EventBus,
  validateAgentProviderTurnRequest,
  type AgentOutputProtocol,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../src/index.js';

class FakeSession implements AgentProviderSession {
  public started = false;
  public active = false;
  public sessionId: string | undefined;
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;

  public constructor(
    public readonly providerId: string,
    public readonly capabilities: AgentProviderCapabilities,
  ) {}

  public start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
    return Promise.resolve();
  }

  public runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    return Promise.resolve().then(() => {
      validateAgentProviderTurnRequest(request, this.capabilities);
      this.runCalls += 1;
      return {
        providerId: this.providerId,
        protocol: 'worker-result',
        protocolValid: false,
        failure: { kind: 'missing_result', message: 'fake' },
      } satisfies AgentProviderTurnResult;
    });
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    return Promise.resolve();
  }
}

class FakeProvider implements AgentProvider {
  public createCalls = 0;
  public readonly sessions: FakeSession[] = [];
  public lastOptions: AgentProviderSessionCreateOptions | undefined;
  public createError: Error | undefined;
  public returnedProviderId: string | undefined;
  public returnedCapabilities: AgentProviderCapabilities | undefined;

  public constructor(
    public readonly id: string,
    public readonly capabilities: AgentProviderCapabilities,
  ) {}

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.createCalls += 1;
    this.lastOptions = options;
    if (this.createError !== undefined) throw this.createError;
    const session = new FakeSession(
      this.returnedProviderId ?? this.id,
      this.returnedCapabilities ?? this.capabilities,
    );
    this.sessions.push(session);
    return session;
  }
}

describe('agent provider factory', () => {
  it.each([
    'codex',
    'claude',
    'local.llama',
    'remote-worker',
    'provider_v2',
    'a'.repeat(64),
  ])('registers open canonical provider ID %s', (id) => {
    const factory = new AgentProviderFactory();
    factory.register(provider(id));
    expect(factory.has(id)).toBe(true);
    expect(factory.list()[0]?.id).toBe(id);
  });

  it.each(['', ' Claude', 'CODEX', '../claude', 'foo/bar', '..', 'a'.repeat(65)])(
    'rejects invalid provider ID %j',
    (id) => {
      const factory = new AgentProviderFactory();
      expectProviderError(() => factory.register(provider(id)), 'AGENT_PROVIDER_INVALID_ID');
      expect(factory.list()).toEqual([]);
    },
  );

  it('registers a hybrid provider without role coupling', () => {
    const factory = new AgentProviderFactory();
    factory.register(provider('hybrid-test', ['manager-directive', 'worker-result']));
    expect(factory.list()).toEqual([{
      id: 'hybrid-test',
      capabilities: {
        outputProtocols: ['manager-directive', 'worker-result'],
        sessionContinuation: true,
      },
    }]);
  });

  it('snapshots provider ID, capabilities, and this-bound construction exactly once', () => {
    const factory = new AgentProviderFactory();
    const reads = { id: 0, capabilities: 0, createSession: 0 };
    let originalCalls = 0;
    let replacementCalls = 0;
    const dynamic = {
      marker: 'registration-this',
      get id() { reads.id += 1; return reads.id === 1 ? 'provider-a' : 'invalid/id'; },
      get capabilities() { reads.capabilities += 1; return capabilities(['worker-result']); },
      get createSession() {
        reads.createSession += 1;
        return function(this: { marker: string }): AgentProviderSession {
          expect(this.marker).toBe('registration-this');
          originalCalls += 1;
          return new FakeSession('provider-a', capabilities(['worker-result']));
        };
      },
    } as unknown as AgentProvider;
    factory.register(dynamic);
    Object.defineProperty(dynamic, 'createSession', {
      value: () => { replacementCalls += 1; return new FakeSession('provider-a', capabilities(['worker-result'])); },
    });
    const session = factory.createSession('provider-a', request());
    expect(session.providerId).toBe('provider-a');
    expect(reads).toEqual({ id: 1, capabilities: 1, createSession: 1 });
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
    expect(factory.has('provider-a')).toBe(true);
    expect(factory.has('invalid/id')).toBe(false);
    expect(factory.list()[0]?.id).toBe('provider-a');
  });

  it('rejects the first invalid provider ID without trusting a later valid getter value', () => {
    const factory = new AgentProviderFactory();
    let reads = 0;
    const dynamic = {
      get id() { reads += 1; return reads === 1 ? 'invalid/id' : 'provider-a'; },
      capabilities: capabilities(['worker-result']),
      createSession: () => new FakeSession('provider-a', capabilities(['worker-result'])),
    } as AgentProvider;
    expectProviderError(() => factory.register(dynamic), 'AGENT_PROVIDER_INVALID_ID');
    expect(reads).toBe(1);
    expect(factory.list()).toEqual([]);
  });

  it('uses the first snapshotted ID for duplicate detection and never registers a later ID', () => {
    const factory = new AgentProviderFactory();
    factory.register(provider('provider-x'));
    let reads = 0;
    const dynamic = {
      get id() { reads += 1; return reads === 1 ? 'provider-x' : 'provider-y'; },
      capabilities: capabilities(['worker-result']),
      createSession: () => new FakeSession('provider-y', capabilities(['worker-result'])),
    } as AgentProvider;
    expectProviderError(() => factory.register(dynamic), 'AGENT_PROVIDER_DUPLICATE');
    expect(reads).toBe(1);
    expect(factory.has('provider-y')).toBe(false);
    expect(factory.list().map(({ id }) => id)).toEqual(['provider-x']);
  });

  it('reads capability fields once and detaches the registered protocol array', () => {
    const factory = new AgentProviderFactory();
    const protocols: AgentOutputProtocol[] = ['worker-result'];
    const reads = { outputProtocols: 0, sessionContinuation: 0 };
    const dynamicCapabilities = {
      get outputProtocols() { reads.outputProtocols += 1; return protocols; },
      get sessionContinuation() { reads.sessionContinuation += 1; return true; },
    };
    factory.register(new FakeProvider('provider-x', dynamicCapabilities));
    protocols.push('manager-directive');
    expect(reads).toEqual({ outputProtocols: 1, sessionContinuation: 1 });
    expect(factory.list()[0]?.capabilities).toEqual({
      outputProtocols: ['worker-result'], sessionContinuation: true,
    });
  });

  it('rejects empty, duplicate, unknown, and malformed capabilities', () => {
    const invalid = [
      capabilities([]),
      capabilities(['worker-result', 'worker-result']),
      capabilities(['future-protocol' as AgentOutputProtocol]),
      { outputProtocols: ['worker-result'] },
    ];
    for (const [index, value] of invalid.entries()) {
      const factory = new AgentProviderFactory();
      const fake = new FakeProvider(`invalid-${String(index)}`, value as AgentProviderCapabilities);
      expectProviderError(() => factory.register(fake), 'AGENT_PROVIDER_INVALID_CAPABILITIES');
    }
  });

  it('rejects duplicate registration without replacing the original', () => {
    const factory = new AgentProviderFactory();
    const original = provider('provider-x');
    factory.register(original);
    expectProviderError(() => factory.register(provider('provider-x')), 'AGENT_PROVIDER_DUPLICATE');
    const session = factory.createSession('provider-x', request());
    expect(session).toBe(original.sessions[0]);
  });

  it('keeps factory registries independent and preserves registration order', () => {
    const first = new AgentProviderFactory();
    const second = new AgentProviderFactory();
    first.register(provider('provider-z'));
    first.register(provider('provider-a'));
    expect(first.list().map(({ id }) => id)).toEqual(['provider-z', 'provider-a']);
    expect(second.has('provider-z')).toBe(false);
    expect(second.list()).toEqual([]);
  });

  it('snapshots capabilities against source and descriptor mutation', () => {
    const protocols: AgentOutputProtocol[] = ['worker-result'];
    const factory = new AgentProviderFactory();
    factory.register(provider('provider-x', protocols));
    protocols.push('manager-directive');
    const descriptor = factory.list()[0];
    expect(descriptor?.capabilities.outputProtocols).toEqual(['worker-result']);
    expect(() => (descriptor?.capabilities.outputProtocols as AgentOutputProtocol[]).push('manager-directive')).toThrow();
    expect(() => {
      (descriptor as { id: string }).id = 'changed';
    }).toThrow();
    expect(factory.list()[0]).toEqual({
      id: 'provider-x',
      capabilities: { outputProtocols: ['worker-result'], sessionContinuation: true },
    });
  });

  it('injects immutable provider attribution without mutating caller context or config', () => {
    const factory = new AgentProviderFactory();
    const fake = provider('provider-x');
    factory.register(fake);
    const context = {
      provider: 'spoofed',
      agentId: 'agent-A',
      taskId: 'TASK-1',
      assignmentId: 'ASSIGN-1',
      projectId: 'project-A',
    };
    const config = { token: 'PRIVATE_CONFIG_SENTINEL', mode: 'test' };
    const eventBus = new EventBus();
    factory.createSession('provider-x', { eventBus, context, config });

    expect(context.provider).toBe('spoofed');
    expect(fake.lastOptions?.context).toEqual({
      provider: 'provider-x',
      agentId: 'agent-A',
      taskId: 'TASK-1',
      assignmentId: 'ASSIGN-1',
      projectId: 'project-A',
    });
    expect(fake.lastOptions?.context).not.toBe(context);
    expect(Object.isFrozen(fake.lastOptions?.context)).toBe(true);
    expect(fake.lastOptions?.config).toEqual(config);
    expect(fake.lastOptions?.config).not.toBe(config);
    expect(Object.isFrozen(fake.lastOptions?.config)).toBe(true);
    expect(config).toEqual({ token: 'PRIVATE_CONFIG_SENTINEL', mode: 'test' });
  });

  it('reads createSession request fields once and passes only their first snapshots', () => {
    const factory = new AgentProviderFactory();
    const fake = provider('provider-x');
    factory.register(fake);
    const eventBus = new EventBus();
    const otherEventBus = new EventBus();
    const reads = { eventBus: 0, context: 0, config: 0, projectId: 0 };
    const firstContext = {
      provider: 'spoofed',
      get projectId() { reads.projectId += 1; return reads.projectId === 1 ? 'project-A' : 'project-B'; },
    };
    const dynamicRequest = {
      get eventBus() { reads.eventBus += 1; return reads.eventBus === 1 ? eventBus : otherEventBus; },
      get context() { reads.context += 1; return reads.context === 1 ? firstContext : { projectId: 'project-B' }; },
      get config() { reads.config += 1; return reads.config === 1 ? { mode: 'A' } : { mode: 'B' }; },
    };
    factory.createSession('provider-x', dynamicRequest);
    expect(reads).toEqual({ eventBus: 1, context: 1, config: 1, projectId: 1 });
    expect(fake.lastOptions?.eventBus).toBe(eventBus);
    expect(fake.lastOptions?.context).toEqual({ provider: 'provider-x', projectId: 'project-A' });
    expect(fake.lastOptions?.config).toEqual({ mode: 'A' });
  });

  it('reads every returned Session validation field exactly once', () => {
    const factory = new AgentProviderFactory();
    const reads = {
      providerId: 0, capabilities: 0, started: 0, active: 0,
      sessionId: 0, start: 0, runTurn: 0, shutdown: 0,
      outputProtocols: 0, sessionContinuation: 0,
    };
    const session = {
      get providerId() { reads.providerId += 1; return 'provider-x'; },
      get capabilities() {
        reads.capabilities += 1;
        return {
          get outputProtocols() { reads.outputProtocols += 1; return ['worker-result'] as const; },
          get sessionContinuation() { reads.sessionContinuation += 1; return true; },
        };
      },
      get started() { reads.started += 1; return false; },
      get active() { reads.active += 1; return false; },
      get sessionId() { reads.sessionId += 1; return undefined; },
      get start() { reads.start += 1; return () => Promise.resolve(); },
      get runTurn() {
        reads.runTurn += 1;
        return () => Promise.resolve({
          providerId: 'provider-x', protocol: 'worker-result', protocolValid: false,
          failure: { kind: 'missing_result', message: 'fake' },
        } satisfies AgentProviderTurnResult);
      },
      get shutdown() { reads.shutdown += 1; return () => Promise.resolve(); },
    } as AgentProviderSession;
    factory.register({
      id: 'provider-x', capabilities: capabilities(['worker-result']), createSession: () => session,
    });
    expect(factory.createSession('provider-x', request())).toBe(session);
    expect(reads).toEqual({
      providerId: 1, capabilities: 1, started: 1, active: 1,
      sessionId: 1, start: 1, runTurn: 1, shutdown: 1,
      outputProtocols: 1, sessionContinuation: 1,
    });
  });

  it('creates distinct sessions without starting, running, shutting down, publishing, or caching', () => {
    const factory = new AgentProviderFactory();
    const fake = provider('provider-x');
    const eventBus = new EventBus();
    let eventCount = 0;
    eventBus.subscribe(() => { eventCount += 1; });
    factory.register(fake);

    const first = factory.createSession('provider-x', request(eventBus));
    const second = factory.createSession('provider-x', request(eventBus));
    expect(first).not.toBe(second);
    expect(fake.createCalls).toBe(2);
    expect(fake.sessions).toHaveLength(2);
    for (const session of fake.sessions) {
      expect(session.startCalls).toBe(0);
      expect(session.runCalls).toBe(0);
      expect(session.shutdownCalls).toBe(0);
    }
    expect(eventCount).toBe(0);
  });

  it('lets sessions reject invalid turns before fake provider execution', async () => {
    const factory = new AgentProviderFactory();
    const fake = provider('provider-x');
    factory.register(fake);
    const session = factory.createSession('provider-x', request()) as FakeSession;

    await expect(session.runTurn({ prompt: ' ', protocol: 'worker-result' })).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_CONTRACT_VIOLATION',
    });
    await expect(session.runTurn({ prompt: 'plan', protocol: 'manager-directive' })).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL',
    });
    expect(session.runCalls).toBe(0);
    expect(session.started).toBe(false);
  });

  it('rejects unknown providers without selecting a default or fallback', () => {
    const factory = new AgentProviderFactory();
    const registered = provider('provider-x');
    factory.register(registered);
    expectProviderError(
      () => factory.createSession('missing', request()),
      'AGENT_PROVIDER_NOT_FOUND',
    );
    expect(registered.createCalls).toBe(0);
  });

  it('propagates provider construction errors exactly without retry or fallback', () => {
    const factory = new AgentProviderFactory();
    const first = provider('provider-x');
    const fallback = provider('provider-y');
    const error = new Error('construction failed');
    first.createError = error;
    factory.register(first);
    factory.register(fallback);
    expect(() => factory.createSession('provider-x', request())).toThrow(error);
    expect(first.createCalls).toBe(1);
    expect(fallback.createCalls).toBe(0);
  });

  it('rejects a returned session with a conflicting provider identity', () => {
    const factory = new AgentProviderFactory();
    const fake = provider('provider-x');
    fake.returnedProviderId = 'provider-y';
    factory.register(fake);
    expectProviderError(
      () => factory.createSession('provider-x', request()),
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
    );
  });

  it('rejects returned sessions with incoherent capabilities or lifecycle shape', () => {
    const mismatchFactory = new AgentProviderFactory();
    const mismatch = provider('provider-x');
    mismatch.returnedCapabilities = capabilities(['manager-directive']);
    mismatchFactory.register(mismatch);
    expectProviderError(
      () => mismatchFactory.createSession('provider-x', request()),
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
    );

    const malformedFactory = new AgentProviderFactory();
    const malformed = provider('provider-y');
    malformed.createSession = () => ({ providerId: 'provider-y' }) as AgentProviderSession;
    malformedFactory.register(malformed);
    expectProviderError(
      () => malformedFactory.createSession('provider-y', request()),
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
    );
  });

  it('rejects a malformed provider contract during registration without invoking it', () => {
    const factory = new AgentProviderFactory();
    const malformed = {
      id: 'provider-x',
      capabilities: capabilities(['worker-result']),
    } as unknown as AgentProvider;
    expectProviderError(() => factory.register(malformed), 'AGENT_PROVIDER_CONTRACT_VIOLATION');
    expect(factory.list()).toEqual([]);
  });
});

function provider(
  id: string,
  outputProtocols: AgentOutputProtocol[] = ['worker-result'],
): FakeProvider {
  return new FakeProvider(id, capabilities(outputProtocols));
}

function capabilities(outputProtocols: AgentOutputProtocol[]): AgentProviderCapabilities {
  return { outputProtocols, sessionContinuation: true };
}

function request(eventBus = new EventBus()): {
  eventBus: EventBus;
  context: { projectId: string };
} {
  return { eventBus, context: { projectId: 'project-A' } };
}

function expectProviderError(callback: () => void, code: AgentProviderError['code']): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentProviderError);
  expect(caught).toMatchObject({ code });
}
