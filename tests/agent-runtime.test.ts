import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  AgentRuntime,
  AgentRuntimeError,
  ClaudeAgentProvider,
  CodexAgentProvider,
  CodexProviderStatus,
  EventBus,
  type AgentHubWorkerResult,
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

const providerCapabilities: AgentProviderCapabilities = Object.freeze({
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
  #started = false;
  #active = false;
  #sessionId: string | undefined = 'session-1';
  #capabilities: AgentProviderCapabilities;
  public startedReads = 0;
  public activeReads = 0;
  public sessionIdReads = 0;
  public capabilityReads = 0;
  public onStartedRead: (() => void) | undefined;
  public onActiveRead: (() => void) | undefined;
  public onSessionIdRead: (() => void) | undefined;
  public onCapabilitiesRead: (() => void) | undefined;
  public startCalls = 0;
  public runCalls = 0;
  public readonly requests: AgentProviderTurnRequest[] = [];
  public shutdownCalls = 0;
  public startBarrier: Promise<void> | undefined;
  public runBarrier: Promise<void> | undefined;
  public shutdownBarrier: Promise<void> | undefined;
  public startError: Error | undefined;
  public runError: Error | undefined;
  public shutdownError: Error | undefined;
  public falseStart = false;
  public activeAfterStart = false;
  public keepActiveAfterRun = false;
  public stopAfterRun = false;
  public keepStartedAfterShutdown = false;
  public keepActiveAfterShutdown = false;
  public onStart: (() => void) | undefined;
  public onRun: (() => void) | undefined;
  public onShutdown: (() => void) | undefined;
  public result: AgentProviderTurnResult = managerResult();

  public constructor(
    public readonly providerId = 'fake',
    capabilities: AgentProviderCapabilities = providerCapabilities,
  ) { this.#capabilities = capabilities; }

  public get started(): boolean { this.startedReads += 1; this.onStartedRead?.(); return this.#started; }
  public set started(value: boolean) { this.#started = value; }
  public get active(): boolean { this.activeReads += 1; this.onActiveRead?.(); return this.#active; }
  public set active(value: boolean) { this.#active = value; }
  public get sessionId(): string | undefined { this.sessionIdReads += 1; this.onSessionIdRead?.(); return this.#sessionId; }
  public set sessionId(value: string | undefined) { this.#sessionId = value; }
  public get capabilities(): AgentProviderCapabilities {
    this.capabilityReads += 1;
    this.onCapabilitiesRead?.();
    return this.#capabilities;
  }
  public set capabilities(value: AgentProviderCapabilities) { this.#capabilities = value; }

  public async start(): Promise<void> {
    this.startCalls += 1;
    this.onStart?.();
    if (this.startBarrier !== undefined) await this.startBarrier;
    if (this.startError !== undefined) throw this.startError;
    if (!this.falseStart) this.started = true;
    if (this.activeAfterStart) this.active = true;
  }

  public async runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    this.runCalls += 1;
    this.requests.push(request);
    this.onRun?.();
    this.active = true;
    if (this.runBarrier !== undefined) await this.runBarrier;
    if (!this.keepActiveAfterRun) this.active = false;
    if (this.stopAfterRun) this.started = false;
    if (this.runError !== undefined) throw this.runError;
    return this.result;
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.onShutdown?.();
    if (this.shutdownBarrier !== undefined) await this.shutdownBarrier;
    if (this.shutdownError !== undefined) throw this.shutdownError;
    if (!this.keepStartedAfterShutdown) this.started = false;
    if (!this.keepActiveAfterShutdown) this.active = false;
  }
}

class FakeProvider implements AgentProvider {
  public readonly id = 'fake';
  public createCalls = 0;
  public createError: Error | undefined;
  public readonly sessions: FakeSession[] = [];
  public readonly options: AgentProviderSessionCreateOptions[] = [];
  public nextSession: (() => FakeSession) | undefined;

  public constructor(public readonly capabilities: AgentProviderCapabilities = providerCapabilities) {}

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.createCalls += 1;
    this.options.push(options);
    if (this.createError !== undefined) throw this.createError;
    const session = this.nextSession?.() ?? new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

describe('AgentRuntime', () => {
  it('constructs side-effect free with validated role-neutral identity and snapshots outer config', async () => {
    const { runtime, provider } = harness();
    expect(runtime).toMatchObject({
      agentId: 'agent-1', projectId: 'project-1', providerId: 'fake',
      state: 'IDLE', busy: false, active: false, binding: undefined, sessionId: undefined,
    });
    expect(provider.createCalls).toBe(0);
    await runtime.shutdown();
    expect(provider.createCalls).toBe(0);

    const config = { mode: 'A' };
    const configured = harness({ providerConfig: config });
    config.mode = 'B';
    await configured.runtime.start(bindingA());
    expect(configured.provider.options[0]?.config).toEqual({ mode: 'A' });
    await configured.runtime.shutdown();
  });

  it('reads constructor identity and providerConfig fields once and keeps the validated generation', async () => {
    const factory = new AgentProviderFactory();
    const provider = new FakeProvider();
    factory.register(provider);
    const eventBus = new EventBus();
    const reads = { agentId: 0, projectId: 0, providerId: 0, providerConfig: 0 };
    const options = {
      providerFactory: factory,
      eventBus,
      get agentId() { reads.agentId += 1; return reads.agentId === 1 ? 'agent-first' : ''; },
      get projectId() { reads.projectId += 1; return reads.projectId === 1 ? 'project-first' : ''; },
      get providerId() { reads.providerId += 1; return reads.providerId === 1 ? 'fake' : ''; },
      get providerConfig() {
        reads.providerConfig += 1;
        return reads.providerConfig === 1 ? { mode: 'A' } : { mode: 'B' };
      },
    };
    const runtime = new AgentRuntime(options);
    expect(reads).toEqual({ agentId: 1, projectId: 1, providerId: 1, providerConfig: 1 });
    expect(runtime).toMatchObject({ agentId: 'agent-first', projectId: 'project-first', providerId: 'fake' });
    await runtime.start(bindingA());
    expect(provider.options[0]?.config).toEqual({ mode: 'A' });
    await runtime.shutdown();
  });

  it('propagates a constructor getter failure without provider work', () => {
    const factory = new AgentProviderFactory();
    const provider = new FakeProvider();
    factory.register(provider);
    const failure = new Error('identity getter failed');
    expect(() => new AgentRuntime({
      get agentId(): string { throw failure; },
      providerId: 'fake', providerFactory: factory, eventBus: new EventBus(),
    })).toThrow(failure);
    expect(provider.createCalls).toBe(0);
  });

  it.each([
    { agentId: '', providerId: 'fake' },
    { agentId: 'agent', providerId: ' ' },
    { agentId: 'agent', providerId: 'fake', projectId: '' },
  ])('rejects invalid identity without provider work', (identity) => {
    const factory = new AgentProviderFactory();
    expect(() => new AgentRuntime({ ...identity, providerFactory: factory, eventBus: new EventBus() }))
      .toThrow(/identity/);
  });

  it.each([null, [], 'string', () => undefined])(
    'rejects invalid providerConfig before it can be normalized: %j',
    (providerConfig) => {
      const factory = new AgentProviderFactory();
      factory.register(new FakeProvider());
      let thrown: unknown;
      try {
        new AgentRuntime({
          agentId: 'agent', providerId: 'fake', providerFactory: factory,
          eventBus: new EventBus(), providerConfig: providerConfig as never,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AgentRuntimeError);
      expect(thrown).toMatchObject({ code: 'AGENT_RUNTIME_INVALID_CONFIG' });
    },
  );

  it.each([
    ['started', { started: true }],
    ['active', { active: true }],
    ['started and active', { started: true, active: true }],
  ])('quarantines a fresh session that is already %s', async (_label, lifecycle) => {
    const { runtime, provider } = harness();
    provider.nextSession = () => Object.assign(new FakeSession(), lifecycle);
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CLEANUP_REQUIRED' });
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CLEANUP_REQUIRED' });
    await runtime.shutdown();
    expect(session.shutdownCalls).toBe(1);
    expect(runtime.state).toBe('IDLE');
  });

  it('accepts an undefined or configured nonblank fresh sessionId and rejects a blank one', async () => {
    for (const sessionId of [undefined, 'configured-session']) {
      const { runtime, provider } = harness();
      provider.nextSession = () => Object.assign(new FakeSession(), { sessionId });
      await runtime.start(bindingA());
      expect(requireSession(provider).startCalls).toBe(1);
      await runtime.shutdown();
    }

    const blank = harness();
    blank.provider.nextSession = () => Object.assign(new FakeSession(), { sessionId: ' ' });
    await expect(blank.runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(blank.provider);
    expect(session.startCalls).toBe(0);
    session.sessionId = undefined;
    await blank.runtime.shutdown();
  });

  it('quarantines a non-string sessionId observed after Factory construction', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onSessionIdRead = () => {
        if (session.sessionIdReads === 2) {
          session.onSessionIdRead = undefined;
          (session as unknown as { sessionId: unknown }).sessionId = 42;
        }
      };
      return session;
    };
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(0);
    session.sessionId = undefined;
    await runtime.shutdown();
  });

  it('reads provider result runtime metadata exactly once from stable locals', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const reads = { providerId: 0, protocol: 0, sessionId: 0, durationMs: 0 };
    const result = {
      directiveStatus: 'valid',
      directive,
      get providerId() { reads.providerId += 1; return reads.providerId === 1 ? 'fake' : 'other'; },
      get protocol() {
        reads.protocol += 1;
        return reads.protocol === 1 ? 'manager-directive' as const : 'worker-result' as const;
      },
      get sessionId() { reads.sessionId += 1; return reads.sessionId === 1 ? 'session-1' : 'other'; },
      get durationMs() { reads.durationMs += 1; return reads.durationMs === 1 ? 1 : -1; },
    } as AgentProviderTurnResult;
    requireSession(provider).result = result;
    await expect(runtime.runTurn(managerRequest())).resolves.toBe(result);
    expect(reads).toEqual({ providerId: 1, protocol: 1, sessionId: 1, durationMs: 1 });
    expect(runtime.state).toBe('OWNED');
    await runtime.shutdown();
  });

  it('retains a Factory-returned session when Runtime lifecycle inspection throws', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onStartedRead = () => {
        if (session.startedReads === 2) {
          session.onStartedRead = undefined;
          throw new Error('lifecycle getter failed');
        }
      };
      return session;
    };
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    await runtime.shutdown();
    expect(session.shutdownCalls).toBe(1);
  });

  it('does not perform a second Session capability read after Factory validation', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onCapabilitiesRead = () => {
        if (session.capabilityReads > 1) {
          throw new Error('capability getter failed');
        }
      };
      return session;
    };
    await runtime.start(bindingA());
    const session = requireSession(provider);
    expect(session.capabilityReads).toBe(1);
    expect(session.startCalls).toBe(1);
    expect(runtime.state).toBe('OWNED');
    session.onCapabilitiesRead = undefined;
    await runtime.shutdown();
  });

  it('serves public sessionId from trusted Runtime cache without executing lower getters', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    const readsBeforeTelemetry = session.sessionIdReads;
    session.onSessionIdRead = () => { throw new Error('telemetry touched lower getter'); };
    expect(runtime.sessionId).toBe('session-1');
    expect(runtime.sessionId).toBe('session-1');
    expect(session.sessionIdReads).toBe(readsBeforeTelemetry);
    expect(runtime.state).toBe('OWNED');
    session.onSessionIdRead = undefined;
    await runtime.shutdown();
    expect(runtime.sessionId).toBeUndefined();
  });

  it('does not let public sessionId telemetry trigger provider shutdown side effects', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    let lowerGetterTriggered = false;
    session.onSessionIdRead = () => {
      lowerGetterTriggered = true;
      void runtime.shutdown();
    };
    expect(runtime.sessionId).toBe('session-1');
    expect(lowerGetterTriggered).toBe(false);
    expect(runtime.state).toBe('OWNED');
    session.onSessionIdRead = undefined;
    await runtime.shutdown();
  });

  it('clears sessionId after release and caches the next assignment generation independently', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => Object.assign(new FakeSession(), {
      sessionId: provider.createCalls === 1 ? 'session-A' : 'session-B',
    });
    await runtime.start(bindingA());
    expect(runtime.sessionId).toBe('session-A');
    await runtime.shutdown();
    expect(runtime.sessionId).toBeUndefined();
    await runtime.start(bindingB());
    expect(runtime.sessionId).toBe('session-B');
    await runtime.shutdown();
  });

  it('refreshes trusted sessionId cache after start and turn settlement', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onStart = () => { session.sessionId = 'started-session'; };
      session.onRun = () => { session.sessionId = 'turn-session'; };
      session.result = { ...managerResult(), sessionId: 'turn-session' };
      return session;
    };
    await runtime.start(bindingA());
    expect(runtime.sessionId).toBe('started-session');
    await runtime.runTurn(managerRequest());
    expect(runtime.sessionId).toBe('turn-session');
    await runtime.shutdown();
  });

  it('keeps the Factory descriptor authoritative over a later valid Session capability generation', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onCapabilitiesRead = () => {
        if (session.capabilityReads > 1) {
          session.capabilities = { outputProtocols: ['worker-result'], sessionContinuation: false };
        }
      };
      return session;
    };
    await runtime.start(bindingA());
    const session = requireSession(provider);
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    await expect(runtime.runTurn(workerRequest())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(session.capabilityReads).toBe(1);
    expect(session.runCalls).toBe(1);
    await runtime.shutdown();
  });

  it('accepts both protocols from a registered hybrid provider descriptor', async () => {
    const { runtime, provider } = harness({
      sessionCapabilities: {
        outputProtocols: ['manager-directive', 'worker-result'], sessionContinuation: true,
      },
    });
    await runtime.start(bindingA());
    const session = requireSession(provider);
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    session.result = workerFailure();
    await expect(runtime.runTurn(workerRequest())).resolves.toMatchObject({ protocolValid: false });
    expect(session.runCalls).toBe(2);
    await runtime.shutdown();
  });

  it.each([
    null,
    { outputProtocols: [], sessionContinuation: true },
    { outputProtocols: ['manager-directive', 'manager-directive'], sessionContinuation: true },
    { outputProtocols: ['future-protocol'], sessionContinuation: true },
    { outputProtocols: ['manager-directive'], sessionContinuation: 'yes' },
  ])('returns cleanly to IDLE when Factory rejects malformed Session capabilities: %j', async (invalidCapabilities) => {
    const { runtime, provider } = harness();
    provider.nextSession = () => new FakeSession('fake', invalidCapabilities as AgentProviderCapabilities);
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_PROVIDER_CONTRACT_VIOLATION',
    });
    expect(requireSession(provider).startCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });
  });

  it.each(['taskId', 'assignmentId', 'specVersion', 'profileHash'] as const)(
    'rejects blank binding field %s before Factory construction', async (key) => {
      const { runtime, provider } = harness();
      await expect(runtime.start({ ...bindingA(), [key]: ' ' })).rejects.toMatchObject({ code: 'AGENT_RUNTIME_INVALID_BINDING' });
      expect(runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });
      expect(provider.createCalls).toBe(0);
    },
  );

  it('reserves STARTING before a binding getter can attempt a nested start', async () => {
    const { runtime, provider } = harness();
    let nested: Promise<void> | undefined;
    let taskIdReads = 0;
    const binding = {
      get taskId() {
        taskIdReads += 1;
        nested = runtime.start(bindingB());
        return 'task-A';
      },
      assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A',
    };
    await runtime.start(binding);
    await expect(nested).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    expect(taskIdReads).toBe(1);
    expect(provider.createCalls).toBe(1);
    expect(runtime.binding).toEqual(bindingA());
    await runtime.shutdown();
  });

  it('lets binding-getter shutdown win before Factory or lower start dispatch', async () => {
    const { runtime, provider } = harness();
    let shutdown: Promise<void> | undefined;
    const binding = {
      get taskId() { shutdown = runtime.shutdown(); return 'task-A'; },
      assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A',
    };
    await expect(runtime.start(binding)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    await shutdown;
    expect(provider.createCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });
  });

  it('reads every binding field exactly once before storing its frozen snapshot', async () => {
    const { runtime } = harness();
    const reads = { taskId: 0, assignmentId: 0, specVersion: 0, profileHash: 0 };
    const first = bindingA();
    const binding = Object.fromEntries(Object.keys(reads).map((key) => [key, undefined])) as unknown as AgentRuntimeBinding;
    for (const key of Object.keys(reads) as (keyof typeof reads)[]) {
      Object.defineProperty(binding, key, {
        enumerable: true,
        get() {
          reads[key] += 1;
          return reads[key] === 1 ? first[key] : '';
        },
      });
    }
    await runtime.start(binding);
    expect(reads).toEqual({ taskId: 1, assignmentId: 1, specVersion: 1, profileHash: 1 });
    expect(runtime.binding).toEqual(bindingA());
    await runtime.shutdown();
  });

  it('releases STARTING when a binding getter throws before Factory construction', async () => {
    const { runtime, provider } = harness();
    const failure = new Error('binding getter failed');
    const binding = {
      get taskId(): string { throw failure; },
      assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A',
    };
    await expect(runtime.start(binding)).rejects.toBe(failure);
    expect(provider.createCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, active: false, binding: undefined });
  });

  it('snapshots binding and creates exact assignment context', async () => {
    const { runtime, provider } = harness();
    const binding = bindingA();
    await runtime.start(binding);
    binding.taskId = 'mutated';
    expect(runtime.binding).toEqual(bindingA());
    expect(Object.isFrozen(runtime.binding)).toBe(true);
    expect(provider.options[0]?.context).toEqual({
      provider: 'fake', projectId: 'project-1', agentId: 'agent-1',
      taskId: 'task-A', assignmentId: 'assignment-A',
    });
    await runtime.shutdown();
  });

  it('returns to IDLE when Factory construction fails or provider is unknown', async () => {
    const created = harness();
    const constructionError = new Error('construction failed');
    created.provider.createError = constructionError;
    await expect(created.runtime.start(bindingA())).rejects.toBe(constructionError);
    expect(created.runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });

    const unknown = new AgentRuntime({
      agentId: 'agent', providerId: 'missing', providerFactory: new AgentProviderFactory(), eventBus: new EventBus(),
    });
    await expect(unknown.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_NOT_FOUND' });
    expect(unknown.state).toBe('IDLE');
  });

  it('rejects turns before ownership and a second start while owned', async () => {
    const { runtime, provider } = harness();
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_NOT_OWNED' });
    await runtime.start(bindingA());
    await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_ALREADY_OWNED' });
    expect(provider.createCalls).toBe(1);
    await runtime.shutdown();
  });

  it('retains the same session and ownership after start failure or false start until cleanup', async () => {
    for (const falseStart of [false, true]) {
      const { runtime, provider } = harness();
      const error = new Error('start failed');
      provider.nextSession = () => Object.assign(new FakeSession(), falseStart ? { falseStart: true } : { startError: error });
      if (falseStart) {
        await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
      } else {
        await expect(runtime.start(bindingA())).rejects.toBe(error);
      }
      expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
      await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CLEANUP_REQUIRED' });
      expect(provider.createCalls).toBe(1);
      await runtime.shutdown();
      expect(provider.sessions[0]?.shutdownCalls).toBe(1);
      expect(runtime.state).toBe('IDLE');
    }
  });

  it('quarantines a session whose successful start leaves lower execution active', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => Object.assign(new FakeSession(), { activeAfterStart: true });
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(1);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    await runtime.shutdown();
  });

  it('quarantines a lifecycle inspection failure after lower start resolves', async () => {
    const { runtime, provider } = harness();
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onStart = () => {
        session.onActiveRead = () => {
          session.onActiveRead = undefined;
          throw new Error('post-start lifecycle getter failed');
        };
      };
      return session;
    };
    await expect(runtime.start(bindingA())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(1);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    await runtime.shutdown();
  });

  it('lets reentrant shutdown win before lower start dispatch during acquisition', async () => {
    const { runtime, provider } = harness();
    let shutdown: Promise<void> | undefined;
    provider.nextSession = () => {
      const session = new FakeSession();
      session.onCapabilitiesRead = () => {
        if (session.capabilityReads === 1) {
          session.onCapabilitiesRead = undefined;
          shutdown = runtime.shutdown();
        }
      };
      return session;
    };
    await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    const session = requireSession(provider);
    expect(session.startCalls).toBe(0);
    await shutdown;
    expect(session.shutdownCalls).toBe(1);
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });
  });

  it('serializes start/shutdown without resurrecting OWNED', async () => {
    const { runtime, provider } = harness();
    const gate = deferred();
    provider.nextSession = () => Object.assign(new FakeSession(), { startBarrier: gate.promise });
    const starting = runtime.start(bindingA());
    expect(runtime).toMatchObject({ state: 'STARTING', busy: true });
    await expect(runtime.start(bindingA())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    const shutdown = runtime.shutdown();
    expect(runtime.state).toBe('STOPPING');
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    gate.resolve();
    await starting;
    await shutdown;
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, binding: undefined });
    expect(provider.sessions[0]?.shutdownCalls).toBe(1);
  });

  it('retains lifecycle barriers when lower methods synchronously reenter shutdown', async () => {
    const startCase = harness();
    let startShutdown: Promise<void> | undefined;
    startCase.provider.nextSession = () => Object.assign(new FakeSession(), {
      onStart: () => { startShutdown = startCase.runtime.shutdown(); },
    });
    await startCase.runtime.start(bindingA());
    await startShutdown;
    expect(startCase.runtime.state).toBe('IDLE');
    expect(requireSession(startCase.provider).shutdownCalls).toBe(1);

    const turnCase = harness();
    await turnCase.runtime.start(bindingA());
    let turnShutdown: Promise<void> | undefined;
    requireSession(turnCase.provider).onRun = () => { turnShutdown = turnCase.runtime.shutdown(); };
    await turnCase.runtime.runTurn(managerRequest());
    await turnShutdown;
    expect(turnCase.runtime.state).toBe('IDLE');
    expect(requireSession(turnCase.provider).shutdownCalls).toBe(1);
  });

  it('preflights requests and blocks a second active turn before provider dispatch', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    await expect(runtime.runTurn({ prompt: ' ', protocol: 'manager-directive' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONTRACT_VIOLATION' });
    await expect(runtime.runTurn({ prompt: 'x', protocol: 'manager-directive', timeoutMs: 0 })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONTRACT_VIOLATION' });
    await expect(runtime.runTurn({ prompt: 'x', protocol: 'worker-result' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(session.runCalls).toBe(0);
    const gate = deferred();
    session.runBarrier = gate.promise;
    const first = runtime.runTurn(managerRequest());
    expect(runtime.active).toBe(true);
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_TURN_ALREADY_ACTIVE' });
    gate.resolve();
    await first;
    expect(session.runCalls).toBe(1);
    await runtime.shutdown();
  });

  it.each(['prompt', 'protocol', 'timeoutMs'] as const)(
    'reserves the outer turn before the %s getter can attempt a nested turn',
    async (triggerField) => {
      const { runtime, provider } = harness();
      await runtime.start(bindingA());
      let nested: Promise<AgentProviderTurnResult> | undefined;
      const reads = { prompt: 0, protocol: 0, timeoutMs: 0 };
      const request = {
        get prompt() {
          reads.prompt += 1;
          if (triggerField === 'prompt') nested = runtime.runTurn(managerRequest());
          return 'outer';
        },
        get protocol() {
          reads.protocol += 1;
          if (triggerField === 'protocol') nested = runtime.runTurn(managerRequest());
          return 'manager-directive' as const;
        },
        get timeoutMs() {
          reads.timeoutMs += 1;
          if (triggerField === 'timeoutMs') nested = runtime.runTurn(managerRequest());
          return 1000;
        },
      };
      await expect(runtime.runTurn(request)).resolves.toMatchObject({ directiveStatus: 'valid' });
      await expect(nested).rejects.toMatchObject({ code: 'AGENT_RUNTIME_TURN_ALREADY_ACTIVE' });
      expect(reads).toEqual({ prompt: 1, protocol: 1, timeoutMs: 1 });
      expect(requireSession(provider).runCalls).toBe(1);
      await runtime.shutdown();
    },
  );

  it('passes one frozen request snapshot despite post-return caller mutation', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const request: { prompt: string; protocol: 'manager-directive' | 'worker-result'; timeoutMs: number } = {
      prompt: 'ORIGINAL', protocol: 'manager-directive', timeoutMs: 1000,
    };
    const turn = runtime.runTurn(request);
    request.prompt = 'MUTATED';
    request.protocol = 'worker-result';
    request.timeoutMs = 1;
    await turn;
    const captured = requireSession(provider).requests[0];
    expect(captured).toEqual({ prompt: 'ORIGINAL', protocol: 'manager-directive', timeoutMs: 1000 });
    expect(Object.isFrozen(captured)).toBe(true);
    await runtime.shutdown();
  });

  it('reads unstable request getters once and dispatches only their validated first values', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const reads = { prompt: 0, protocol: 0, timeoutMs: 0 };
    const request = {
      get prompt() { reads.prompt += 1; return reads.prompt === 1 ? 'FIRST' : ''; },
      get protocol() {
        reads.protocol += 1;
        return reads.protocol === 1 ? 'manager-directive' as const : 'worker-result' as const;
      },
      get timeoutMs() { reads.timeoutMs += 1; return reads.timeoutMs === 1 ? 1000 : 0; },
    };
    await runtime.runTurn(request);
    expect(reads).toEqual({ prompt: 1, protocol: 1, timeoutMs: 1 });
    expect(requireSession(provider).requests[0]).toEqual({
      prompt: 'FIRST', protocol: 'manager-directive', timeoutMs: 1000,
    });
    await runtime.shutdown();
  });

  it('lets request-getter shutdown win without a post-STOPPING lower turn', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    let shutdown: Promise<void> | undefined;
    const request = {
      get prompt() { shutdown = runtime.shutdown(); return 'outer'; },
      protocol: 'manager-directive' as const,
    };
    await expect(runtime.runTurn(request)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    expect(requireSession(provider).runCalls).toBe(0);
    await shutdown;
    expect(runtime).toMatchObject({ state: 'IDLE', active: false });
  });

  it('releases the turn reservation when a request getter throws', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const failure = new Error('request getter failed');
    await expect(runtime.runTurn({
      get prompt(): string { throw failure; },
      protocol: 'manager-directive',
    })).rejects.toBe(failure);
    expect(runtime).toMatchObject({ state: 'OWNED', active: false });
    expect(requireSession(provider).runCalls).toBe(0);
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    await runtime.shutdown();
  });

  it('quarantines a lower session that is already active before Runtime turn dispatch', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    session.active = true;
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION',
    });
    expect(session.runCalls).toBe(0);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, active: false });
    await runtime.shutdown();
  });

  it('does not dispatch a turn when a lifecycle getter reenters shutdown during preflight', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    let shutdown: Promise<void> | undefined;
    session.onStartedRead = () => {
      session.onStartedRead = undefined;
      shutdown = runtime.shutdown();
    };
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    expect(session.runCalls).toBe(0);
    await shutdown;
    expect(session.shutdownCalls).toBe(1);
    expect(runtime.state).toBe('IDLE');
  });

  it('uses one immutable capability snapshot for the full ownership generation', async () => {
    const mutableCapabilities: AgentProviderCapabilities = {
      outputProtocols: ['manager-directive'], sessionContinuation: true,
    };
    const { runtime, provider } = harness();
    provider.nextSession = () => new FakeSession('fake', mutableCapabilities);
    await runtime.start(bindingA());
    const session = requireSession(provider);
    session.capabilities = { outputProtocols: ['worker-result'], sessionContinuation: false };
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    await expect(runtime.runTurn(workerRequest())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(session.runCalls).toBe(1);
    expect(session.capabilityReads).toBe(1);
    await runtime.shutdown();
  });

  it('reads capability object fields once while creating the Runtime-owned snapshot', async () => {
    const { runtime, provider } = harness();
    const reads = { outputProtocols: 0, sessionContinuation: 0 };
    provider.nextSession = () => {
      return new FakeSession('fake', {
        get outputProtocols() { reads.outputProtocols += 1; return ['manager-directive'] as const; },
        get sessionContinuation() { reads.sessionContinuation += 1; return true; },
      });
    };
    await runtime.start(bindingA());
    expect(reads).toEqual({ outputProtocols: 1, sessionContinuation: 1 });
    await runtime.runTurn(managerRequest());
    expect(reads).toEqual({ outputProtocols: 1, sessionContinuation: 1 });
    await runtime.shutdown();
  });

  it('takes a fresh capability snapshot for the next assignment', async () => {
    const { runtime, provider } = harness();
    const capabilitySources: AgentProviderCapabilities[] = [];
    provider.nextSession = () => {
      const capabilities: AgentProviderCapabilities = {
        outputProtocols: ['manager-directive'], sessionContinuation: true,
      };
      capabilitySources.push(capabilities);
      return new FakeSession('fake', capabilities);
    };
    await runtime.start(bindingA());
    await runtime.runTurn(managerRequest());
    await runtime.shutdown();
    (capabilitySources[0] as { outputProtocols: AgentProviderCapabilities['outputProtocols'] }).outputProtocols = ['worker-result'];
    await runtime.start(bindingB());
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    await expect(runtime.runTurn(workerRequest())).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(requireSession(provider, 1).runCalls).toBe(1);
    expect(capabilitySources).toHaveLength(2);
    await runtime.shutdown();
  });

  it.each([
    ['providerId', { providerId: 'other' }],
    ['protocol', { protocol: 'worker-result' }],
    ['sessionId', { sessionId: 'other-session' }],
    ['blank sessionId', { sessionId: ' ' }],
    ['duration', { durationMs: -1 }],
    ['NaN duration', { durationMs: Number.NaN }],
    ['infinite duration', { durationMs: Number.POSITIVE_INFINITY }],
  ])('quarantines invalid provider result metadata: %s', async (_label, change) => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    requireSession(provider).result = { ...managerResult(), ...change } as AgentProviderTurnResult;
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CLEANUP_REQUIRED' });
    await runtime.shutdown();
  });

  it('quarantines a non-object provider result', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    requireSession(provider).result = null as unknown as AgentProviderTurnResult;
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
    expect(runtime.state).toBe('FAILED');
    await runtime.shutdown();
  });

  it('returns structured manager/worker failures without releasing ownership', async () => {
    const manager = harness();
    await manager.runtime.start(bindingA());
    requireSession(manager.provider).result = managerInvalidResult();
    await expect(manager.runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'invalid' });
    expect(manager.runtime.state).toBe('OWNED');
    await manager.runtime.shutdown();

    const worker = harness({
      result: workerFailure(),
      sessionCapabilities: { outputProtocols: ['worker-result'], sessionContinuation: true },
    });
    await worker.runtime.start(bindingA());
    await expect(worker.runtime.runTurn(workerRequest())).resolves.toMatchObject({ protocolValid: false });
    expect(worker.runtime.state).toBe('OWNED');
    await worker.runtime.shutdown();
  });

  it('preserves provider errors when reusable and quarantines provider loss', async () => {
    for (const losesProvider of [false, true]) {
      const { runtime, provider } = harness();
      await runtime.start(bindingA());
      const session = requireSession(provider);
      const error = new Error('provider failed');
      session.runError = error;
      session.stopAfterRun = losesProvider;
      await expect(runtime.runTurn(managerRequest())).rejects.toBe(error);
      expect(runtime.state).toBe(losesProvider ? 'FAILED' : 'OWNED');
      expect(runtime.binding).toEqual(bindingA());
      if (!losesProvider) {
        session.runError = undefined;
        await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
      }
      await runtime.shutdown();
    }
  });

  it('returns a valid result while quarantining continuity when provider dies after completion', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    requireSession(provider).stopAfterRun = true;
    await expect(runtime.runTurn(managerRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true });
    await runtime.shutdown();
  });

  it.each([false, true])('quarantines a settled lower turn that remains active (reject=%s)', async (rejects) => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    session.keepActiveAfterRun = true;
    if (rejects) session.runError = new Error('lower rejected');
    await expect(runtime.runTurn(managerRequest())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
    expect(runtime.state).toBe('FAILED');
    session.keepActiveAfterShutdown = false;
    await runtime.shutdown();
  });

  it('reuses one session for revisions and creates a fresh assignment-bound session after clean release', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    await runtime.runTurn(managerRequest());
    await runtime.runTurn(managerRequest());
    expect(provider.createCalls).toBe(1);
    expect(provider.sessions[0]?.runCalls).toBe(2);
    await runtime.shutdown();
    await runtime.start(bindingB());
    expect(provider.createCalls).toBe(2);
    expect(provider.sessions[1]).not.toBe(provider.sessions[0]);
    expect(provider.options[1]?.context).toMatchObject({ taskId: 'task-B', assignmentId: 'assignment-B' });
    expect(provider.options[1]?.context).not.toMatchObject({ taskId: 'task-A', assignmentId: 'assignment-A' });
    await runtime.shutdown();
  });

  it('shares concurrent shutdown and validates lower quiescence before releasing binding', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    const gate = deferred();
    session.shutdownBarrier = gate.promise;
    const first = runtime.shutdown();
    const second = runtime.shutdown();
    expect(first).toBe(second);
    expect(runtime).toMatchObject({ state: 'STOPPING', busy: true, binding: bindingA() });
    await expect(runtime.start(bindingB())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_LIFECYCLE_BUSY' });
    gate.resolve();
    await Promise.all([first, second]);
    expect(session.shutdownCalls).toBe(1);
    expect(runtime.state).toBe('IDLE');
  });

  it('waits for active turn settlement before successful release', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const gate = deferred();
    requireSession(provider).runBarrier = gate.promise;
    const turn = runtime.runTurn(managerRequest());
    const shutdown = runtime.shutdown();
    expect(runtime).toMatchObject({ state: 'STOPPING', busy: true, active: true });
    gate.resolve();
    await turn;
    await shutdown;
    expect(runtime).toMatchObject({ state: 'IDLE', busy: false, active: false, binding: undefined });
  });

  it('returns failed active shutdown promptly and late turn settlement cannot resurrect ownership', async () => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    const gate = deferred();
    session.runBarrier = gate.promise;
    const turn = runtime.runTurn(managerRequest());
    const failure = new Error('shutdown failed');
    session.shutdownError = failure;
    const outcome = await Promise.race([
      runtime.shutdown().then(() => 'resolved', (error: unknown) => error),
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
    ]);
    expect(outcome).toBe(failure);
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, active: true, binding: bindingA() });
    expect(runtime.sessionId).toBe('session-1');
    gate.resolve();
    await turn;
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, active: false, binding: bindingA() });
    await expect(runtime.start(bindingB())).rejects.toMatchObject({ code: 'AGENT_RUNTIME_CLEANUP_REQUIRED' });
    session.shutdownError = undefined;
    await runtime.shutdown();
    expect(runtime.state).toBe('IDLE');
    expect(runtime.sessionId).toBeUndefined();
    expect(provider.createCalls).toBe(1);
  });

  it.each([
    ['started', { keepStartedAfterShutdown: true }],
    ['active', { keepActiveAfterShutdown: true }],
  ])('rejects false clean when lower remains %s and retries cleanup on the same session', async (_label, change) => {
    const { runtime, provider } = harness();
    await runtime.start(bindingA());
    const session = requireSession(provider);
    Object.assign(session, change);
    if (_label === 'active') session.active = true;
    await expect(runtime.shutdown()).rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
    expect(runtime).toMatchObject({ state: 'FAILED', busy: true, binding: bindingA() });
    session.keepStartedAfterShutdown = false;
    session.keepActiveAfterShutdown = false;
    await runtime.shutdown();
    expect(runtime.state).toBe('IDLE');
    expect(session.shutdownCalls).toBe(2);
    expect(provider.createCalls).toBe(1);
  });
});

describe('AgentRuntime built-in adapter integration', () => {
  it('binds Claude adapter sessions to each assignment and reuses one session for revisions', async () => {
    const contexts: AgentProviderSessionCreateOptions['context'][] = [];
    const workers: FakeClaudeWorker[] = [];
    const factory = new AgentProviderFactory();
    factory.register(new ClaudeAgentProvider({ createWorkerSession: (options) => {
      contexts.push(options.context);
      const worker = new FakeClaudeWorker();
      workers.push(worker);
      return worker;
    } }));
    const runtime = new AgentRuntime({
      agentId: 'agent', projectId: 'project', providerId: 'claude', providerFactory: factory, eventBus: new EventBus(),
    });
    await runtime.start(bindingA());
    await runtime.runTurn(workerRequest()); await runtime.runTurn(workerRequest());
    await runtime.shutdown(); await runtime.start(bindingB());
    expect(workers).toHaveLength(2);
    expect(workers[0]?.runCalls).toBe(2);
    expect(contexts).toEqual([
      { provider: 'claude', projectId: 'project', agentId: 'agent', taskId: 'task-A', assignmentId: 'assignment-A' },
      { provider: 'claude', projectId: 'project', agentId: 'agent', taskId: 'task-B', assignmentId: 'assignment-B' },
    ]);
    await runtime.shutdown();
  });

  it('binds fresh Codex adapter sessions and contexts to successive assignments', async () => {
    const contexts: AgentProviderSessionCreateOptions['context'][] = [];
    const useCases: FakeCodexUseCase[] = [];
    const factory = new AgentProviderFactory();
    factory.register(new CodexAgentProvider({
      createUseCase: () => { const useCase = new FakeCodexUseCase(); useCases.push(useCase); return useCase; },
      createEventMapper: (options) => {
        contexts.push(options.context);
        return { attach() {}, dispose() {} };
      },
    }));
    const runtime = new AgentRuntime({
      agentId: 'agent', projectId: 'project', providerId: 'codex', providerFactory: factory, eventBus: new EventBus(),
    });
    await runtime.start(bindingA());
    await runtime.runTurn({ prompt: 'one', protocol: 'manager-directive' });
    await runtime.runTurn({ prompt: 'revision', protocol: 'manager-directive' });
    await runtime.shutdown(); await runtime.start(bindingB());
    expect(useCases).toHaveLength(2);
    expect(useCases[0]?.runCalls).toBe(2);
    expect(contexts.map(({ taskId, assignmentId, provider }) => ({ taskId, assignmentId, provider }))).toEqual([
      { taskId: 'task-A', assignmentId: 'assignment-A', provider: 'codex' },
      { taskId: 'task-B', assignmentId: 'assignment-B', provider: 'codex' },
    ]);
    await runtime.shutdown();
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
  public runDirectiveTurn(): Promise<ManagerDirectiveTurnResult> { this.runCalls += 1; return Promise.resolve(codexResult()); }
  public getManagerSession() { return this.status === CodexProviderStatus.READY ? { threadId: 'thread', sessionId: 'codex-session' } : undefined; }
  public getStatus() { return this.status; }
  public onNotification() { return () => undefined; }
  public onServerRequest() { return () => undefined; }
  public onProtocolError() { return () => undefined; }
  public onProcessExit() { return () => undefined; }
  public onProcessError() { return () => undefined; }
}

function harness(overrides: {
  providerConfig?: Record<string, unknown>;
  result?: AgentProviderTurnResult;
  sessionCapabilities?: AgentProviderCapabilities;
} = {}) {
  const selectedCapabilities = overrides.sessionCapabilities ?? providerCapabilities;
  const provider = new FakeProvider(selectedCapabilities);
  if (overrides.result !== undefined || overrides.sessionCapabilities !== undefined) {
    provider.nextSession = () => {
      const session = new FakeSession('fake', selectedCapabilities);
      if (overrides.result !== undefined) session.result = overrides.result;
      return session;
    };
  }
  const factory = new AgentProviderFactory();
  factory.register(provider);
  const runtime = new AgentRuntime({
    agentId: 'agent-1', projectId: 'project-1', providerId: 'fake',
    providerFactory: factory, eventBus: new EventBus(),
    ...(overrides.providerConfig === undefined ? {} : { providerConfig: overrides.providerConfig }),
  });
  return { runtime, provider, factory };
}

function bindingA(): AgentRuntimeBinding & { taskId: string } {
  return { taskId: 'task-A', assignmentId: 'assignment-A', specVersion: 'spec-A', profileHash: 'profile-A' };
}

function bindingB(): AgentRuntimeBinding {
  return { taskId: 'task-B', assignmentId: 'assignment-B', specVersion: 'spec-B', profileHash: 'profile-B' };
}

function managerRequest(): AgentProviderTurnRequest {
  return { prompt: 'plan', protocol: 'manager-directive' };
}

function workerRequest(): AgentProviderTurnRequest {
  return { prompt: 'work', protocol: 'worker-result' };
}

function managerResult(): AgentProviderTurnResult {
  return {
    providerId: 'fake', protocol: 'manager-directive', directiveStatus: 'valid', directive,
    sessionId: 'session-1', durationMs: 1,
  };
}

function workerFailure(): AgentProviderTurnResult {
  return {
    providerId: 'fake', protocol: 'worker-result', protocolValid: false,
    failure: { kind: 'missing_result', message: 'missing' }, sessionId: 'session-1', durationMs: 1,
  };
}

function managerInvalidResult(): AgentProviderTurnResult {
  return {
    providerId: 'fake', protocol: 'manager-directive', directiveStatus: 'invalid', directive: null,
    failure: { kind: 'missing_directive', message: 'missing' }, sessionId: 'session-1', durationMs: 1,
  };
}

function requireSession(provider: FakeProvider, index = 0): FakeSession {
  const session = provider.sessions[index];
  if (session === undefined) throw new Error('Expected fake session');
  return session;
}

function codexResult(): ManagerDirectiveTurnResult {
  return {
    initialTurn: {
      threadId: 'thread', sessionId: 'codex-session', turnId: 'turn', status: 'completed', text: '', events: [],
    },
    directive, directiveStatus: 'valid',
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
