import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  CodexAgentProvider,
  CodexProviderStatus,
  EventBus,
  type CodexManagerUseCaseLike,
  type CodexNotificationHandler,
  type CodexProcessErrorHandler,
  type CodexProcessExitHandler,
  type CodexProviderOptions,
  type CodexProtocolErrorHandler,
  type CodexServerRequestHandler,
  type DomainEvent,
  type ManagerDirective,
  type ManagerDirectiveTurnResult,
  type CodexManagerUseCaseOptions,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));

const directive: ManagerDirective = {
  action: 'INFORM', taskId: 'T', title: '', instructions: '', acceptanceCriteria: [],
  issues: [], requestedChecks: [], summary: 'done',
};

class FakeUseCase implements CodexManagerUseCaseLike {
  public status = CodexProviderStatus.STOPPED;
  public initializeCalls = 0;
  public shutdownCalls = 0;
  public runCalls = 0;
  public initializeError: Error | undefined;
  public shutdownError: Error | undefined;
  public initializeStatus = CodexProviderStatus.READY;
  public shutdownStatus = CodexProviderStatus.STOPPED;
  public emitExitDuringShutdown = false;
  public turnWait: Promise<void> | undefined;
  public result = resultOf('valid');
  public managerSession: { threadId: string; sessionId: string } | undefined = {
    threadId: 'thread-1', sessionId: 'session-1',
  };
  readonly notifications = new Set<CodexNotificationHandler>();
  readonly serverRequests = new Set<CodexServerRequestHandler>();
  readonly protocolErrors = new Set<CodexProtocolErrorHandler>();
  readonly processExits = new Set<CodexProcessExitHandler>();
  readonly processErrors = new Set<CodexProcessErrorHandler>();

  public initialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.initializeError !== undefined) return Promise.reject(this.initializeError);
    this.status = this.initializeStatus;
    this.managerSession ??= { threadId: 'thread-1', sessionId: 'session-1' };
    return Promise.resolve();
  }
  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.status = CodexProviderStatus.STOPPING;
    if (this.emitExitDuringShutdown) {
      for (const handler of this.processExits) handler(0, null);
    }
    if (this.shutdownError !== undefined) return Promise.reject(this.shutdownError);
    this.status = this.shutdownStatus;
    if (this.status === CodexProviderStatus.STOPPED) this.managerSession = undefined;
    return Promise.resolve();
  }
  public async runDirectiveTurn(): Promise<ManagerDirectiveTurnResult> {
    this.runCalls += 1;
    this.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    if (this.turnWait !== undefined) await this.turnWait;
    this.notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    return this.result;
  }
  public getManagerSession() { return this.managerSession; }
  public getStatus() { return this.status; }
  public onNotification(handler: CodexNotificationHandler) { this.notifications.add(handler); return () => this.notifications.delete(handler); }
  public onServerRequest(handler: CodexServerRequestHandler) { this.serverRequests.add(handler); return () => this.serverRequests.delete(handler); }
  public onProtocolError(handler: CodexProtocolErrorHandler) { this.protocolErrors.add(handler); return () => this.protocolErrors.delete(handler); }
  public onProcessExit(handler: CodexProcessExitHandler) { this.processExits.add(handler); return () => this.processExits.delete(handler); }
  public onProcessError(handler: CodexProcessErrorHandler) { this.processErrors.add(handler); return () => this.processErrors.delete(handler); }
  public notification(method: string, params: unknown) { for (const handler of this.notifications) handler(method, params); }
  public exit() { this.status = CodexProviderStatus.ERROR; for (const handler of this.processExits) handler(1, null); }
}

describe('Codex AgentProvider adapter', () => {
  it('has frozen role-neutral identity and Factory construction has no lifecycle side effects', () => {
    const fake = new FakeUseCase();
    let creates = 0;
    const provider = new CodexAgentProvider({ createUseCase: () => { creates += 1; return fake; } });
    const factory = new AgentProviderFactory();
    factory.register(provider);
    const session = factory.createSession('codex', factoryRequest());
    expect(factory.list()).toEqual([{ id: 'codex', capabilities: { outputProtocols: ['manager-directive'], sessionContinuation: true } }]);
    expect(Object.isFrozen(provider.capabilities)).toBe(true);
    expect(Object.isFrozen(provider.capabilities.outputProtocols)).toBe(true);
    expect(provider).not.toHaveProperty('role');
    expect(provider).not.toHaveProperty('isManager');
    expect(creates).toBe(1);
    expect(fake.initializeCalls).toBe(0);
    expect(session.started).toBe(false);
  });

  it('enforces explicit lifecycle, local concurrency, shutdown quiescence, and restart', async () => {
    const fake = new FakeUseCase();
    const session = createSession(fake);
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_NOT_STARTED' });
    await session.start();
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_ALREADY_STARTED' });
    let release!: () => void;
    fake.turnWait = new Promise<void>((resolve) => { release = resolve; });
    const turn = session.runTurn(turnRequest());
    expect(session.active).toBe(true);
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_TURN_ALREADY_ACTIVE' });
    const shutdown = session.shutdown();
    release();
    await turn;
    await shutdown;
    expect(session).toMatchObject({ started: false, active: false, sessionId: undefined });
    await session.start();
    expect(session.started).toBe(true);
    await session.shutdown();
    expect(fake.runCalls).toBe(1);
    expect(fake.initializeCalls).toBe(2);
  });

  it('quarantines failed start, failed shutdown, and unexpected process exit until cleanup', async () => {
    const fake = new FakeUseCase();
    const session = createSession(fake);
    fake.initializeError = new Error('start failed');
    await expect(session.start()).rejects.toBe(fake.initializeError);
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    fake.initializeError = undefined;
    await session.shutdown();
    await session.start();
    fake.shutdownError = new Error('stop failed');
    await expect(session.shutdown()).rejects.toBe(fake.shutdownError);
    expect(session.started).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    fake.shutdownError = undefined;
    await session.shutdown();
    await session.start();
    fake.exit();
    expect(session.started).toBe(false);
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await session.shutdown();
  });

  it.each(['valid', 'repaired'] as const)('maps %s directives with safe neutral metadata', async (status) => {
    const fake = new FakeUseCase();
    fake.result = resultOf(status);
    const session = createSession(fake);
    await session.start();
    const result = await session.runTurn(turnRequest());
    expect(result).toMatchObject({
      providerId: 'codex', protocol: 'manager-directive', directiveStatus: status,
      directive, sessionId: 'session-1',
    });
    expect(typeof result.durationMs).toBe('number');
    expect(result).not.toHaveProperty('initialTurn');
    expect(result).not.toHaveProperty('repairTurn');
    expect(result).not.toHaveProperty('text');
    await session.shutdown();
  });

  it.each([
    'missing_directive', 'multiple_directives', 'malformed_json', 'schema_invalid', 'semantic_invalid',
    'initial_turn_failed', 'repair_turn_failed',
  ] as const)('preserves manager failure kind %s', async (kind) => {
    const fake = new FakeUseCase();
    fake.result = { ...resultOf('invalid'), failure: { kind, message: 'failure' } };
    const session = createSession(fake);
    await session.start();
    await expect(session.runTurn(turnRequest())).resolves.toMatchObject({
      providerId: 'codex', directiveStatus: 'invalid', directive: null, failure: { kind, message: 'failure' },
    });
    await session.shutdown();
  });

  it('rejects contradictory initial and repair session identities', async () => {
    const fake = new FakeUseCase();
    fake.result = {
      ...resultOf('repaired'),
      repairTurn: { ...turnResult('session-2'), text: '' },
    };
    const session = createSession(fake);
    await session.start();
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_SESSION_MISMATCH' });
    expect(session.active).toBe(false);
    expect(fake.runCalls).toBe(1);
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await session.shutdown();
  });

  it.each([
    ['repair session', { repairTurn: { ...turnResult('session-2'), turnId: 'turn-2' } }],
    ['repair thread', { repairTurn: { ...turnResult(), threadId: 'thread-2', turnId: 'turn-2' } }],
    ['current session', { current: { threadId: 'thread-1', sessionId: 'session-2' } }],
    ['current thread', { current: { threadId: 'thread-2', sessionId: 'session-1' } }],
  ] as const)('quarantines %s continuity corruption until cleanup and then restarts', async (_label, change) => {
    const fake = new FakeUseCase();
    fake.result = { ...resultOf('repaired'), ...('repairTurn' in change ? { repairTurn: change.repairTurn } : {}) };
    if ('current' in change) fake.managerSession = { ...change.current };
    const session = createSession(fake);
    await session.start();
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_SESSION_MISMATCH' });
    expect(session).toMatchObject({ started: false, active: false });
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
    fake.result = resultOf('valid');
    fake.managerSession = { threadId: 'thread-1', sessionId: 'session-1' };
    await session.start();
    await expect(session.runTurn(turnRequest())).resolves.toMatchObject({ directiveStatus: 'valid' });
    await session.shutdown();
  });

  it.each([
    ['valid with null directive', { ...resultOf('valid'), directive: null }],
    ['invalid without failure', { ...resultOf('invalid'), failure: undefined }],
  ])('quarantines impossible result: %s', async (_label, impossible) => {
    const fake = new FakeUseCase();
    fake.result = impossible as unknown as ManagerDirectiveTurnResult;
    const session = createSession(fake);
    await session.start();
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_RESULT_INVALID' });
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('keeps runtime-cleared session initial_turn_failed as a normal structured failure', async () => {
    const fake = new FakeUseCase();
    fake.managerSession = undefined;
    fake.result = { ...resultOf('invalid'), failure: { kind: 'initial_turn_failed', message: 'process exited' } };
    const session = createSession(fake);
    await session.start();
    fake.managerSession = undefined;
    await expect(session.runTurn(turnRequest())).resolves.toMatchObject({
      directiveStatus: 'invalid', failure: { kind: 'initial_turn_failed' },
    });
    await session.shutdown();
  });

  it('maps session identity only for the matching current thread, including after restart', async () => {
    const fake = new FakeUseCase();
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const session = new CodexAgentProvider({ createUseCase: () => fake }).createSession({ eventBus: bus, context: context() });
    await session.start();
    await session.shutdown();
    fake.managerSession = { threadId: 'thread-2', sessionId: 'session-2' };
    await session.start();
    fake.notification('turn/started', { threadId: 'thread-1', turn: { id: 'old' } });
    fake.notification('turn/started', { threadId: 'unknown', turn: { id: 'unknown' } });
    fake.notification('turn/started', { threadId: 'thread-2', turn: { id: 'current' } });
    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ threadId: 'thread-1', provider: 'codex' });
    expect(payloads[0]).not.toHaveProperty('sessionId');
    expect(payloads[1]).not.toHaveProperty('sessionId');
    expect(payloads[2]).toMatchObject({ threadId: 'thread-2', sessionId: 'session-2' });
    expect(events[2]).toMatchObject({ projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' });
    await session.shutdown();
  });

  it('keeps shutdown mapper failures dirty until an explicit successful cleanup retry', async () => {
    const fake = new FakeUseCase();
    fake.emitExitDuringShutdown = true;
    const failure = new Error('shutdown subscriber failed');
    const bus = new EventBus();
    bus.subscribe((event) => { if (event.eventType === 'ProviderProcessExited') throw failure; });
    const session = new CodexAgentProvider({ createUseCase: () => fake }).createSession({ eventBus: bus, context: context() });
    await session.start();
    await expect(session.shutdown()).rejects.toBe(failure);
    expect(session.started).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await expect(session.runTurn(turnRequest())).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    fake.emitExitDuringShutdown = false;
    await session.shutdown();
    await session.start();
    await session.shutdown();
  });

  it('returns a failed active shutdown promptly without waiting for the unresolved turn', async () => {
    const fake = new FakeUseCase();
    let release!: () => void;
    fake.turnWait = new Promise<void>((resolve) => { release = resolve; });
    const session = createSession(fake);
    await session.start();
    const turn = session.runTurn(turnRequest());
    fake.shutdownError = new Error('known shutdown failure');
    const shutdownOutcome = await Promise.race([
      session.shutdown().then(() => 'resolved', (error: unknown) => error),
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
    ]);
    expect(shutdownOutcome).toBe(fake.shutdownError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(true);
    release();
    await turn;
    expect(session.active).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    fake.shutdownError = undefined;
    await session.shutdown();
    await session.start();
    await session.shutdown();
  });

  it('rejects lower lifecycle false-success and requires cleanup', async () => {
    const fakeStart = new FakeUseCase();
    fakeStart.initializeStatus = CodexProviderStatus.STOPPED;
    const startSession = createSession(fakeStart);
    await expect(startSession.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_LOWER_STATE_INVALID' });
    await expect(startSession.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    await startSession.shutdown();

    const fakeStop = new FakeUseCase();
    const stopSession = createSession(fakeStop);
    await stopSession.start();
    fakeStop.shutdownStatus = CodexProviderStatus.READY;
    await expect(stopSession.shutdown()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_LOWER_STATE_INVALID' });
    await expect(stopSession.start()).rejects.toMatchObject({ code: 'CODEX_AGENT_PROVIDER_CLEANUP_REQUIRED' });
    fakeStop.shutdownStatus = CodexProviderStatus.STOPPED;
    await stopSession.shutdown();
    await stopSession.start();
    await stopSession.shutdown();
  });

  it('snapshots nested Codex config before lower construction', () => {
    const fake = new FakeUseCase();
    let capturedProvider: CodexProviderOptions | undefined;
    let capturedTurn: CodexManagerUseCaseOptions | undefined;
    const provider = new CodexAgentProvider({
      createUseCase: (providerOptions, turnOptions) => {
        capturedProvider = providerOptions;
        capturedTurn = turnOptions;
        return fake;
      },
    });
    const args = ['app-server-A'];
    const env = { TOKEN: 'A' };
    const providerOptions = { command: 'codex', args, env };
    const turnOptions = { turnTimeoutMs: 10 };
    const config = { providerOptions, turnOptions };
    provider.createSession(options(config));
    args[0] = 'app-server-B'; env.TOKEN = 'B'; providerOptions.command = 'changed'; turnOptions.turnTimeoutMs = 20;
    expect(capturedProvider).toMatchObject({ command: 'codex', args: ['app-server-A'], env: { TOKEN: 'A' } });
    expect(capturedTurn).toEqual({ turnTimeoutMs: 10 });
  });

  it('rejects wrong protocol and invalid config before provider dispatch or construction without leaking secrets', async () => {
    const fake = new FakeUseCase();
    let creates = 0;
    const provider = new CodexAgentProvider({ createUseCase: () => { creates += 1; return fake; } });
    const session = provider.createSession(options());
    await session.start();
    await expect(session.runTurn({ prompt: 'x', protocol: 'worker-result' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(fake.runCalls).toBe(0);
    const secret = 'secret-value';
    expect(() => provider.createSession(options({ providerOptions: { env: { TOKEN: 1 } } }))).toThrow(/field providerOptions.env is invalid/);
    try { provider.createSession(options({ secretKey: secret })); } catch (error) { expect(String(error)).not.toContain(secret); }
    expect(creates).toBe(1);
    await session.shutdown();
  });

  it('isolates mapper subscriber failure, releases active state, and never repeats the model call', async () => {
    const fake = new FakeUseCase();
    const bus = new EventBus();
    const failure = new Error('subscriber failed');
    bus.subscribe((event) => { if (event.eventType === 'AgentExecutionStarted') throw failure; });
    const session = new CodexAgentProvider({ createUseCase: () => fake }).createSession({ eventBus: bus, context: context() });
    await session.start();
    await expect(session.runTurn(turnRequest())).rejects.toBe(failure);
    expect(session.active).toBe(false);
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('attaches one mapper for the session and retains exact Factory context after restart', async () => {
    const fake = new FakeUseCase();
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const factory = new AgentProviderFactory();
    factory.register(new CodexAgentProvider({ createUseCase: () => fake }));
    const session = factory.createSession('codex', { eventBus: bus, context: { projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' } });
    await session.start(); await session.shutdown(); await session.start();
    fake.notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-x' } });
    const mapped = events.filter((event) => event.eventType === 'AgentExecutionStarted');
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' });
    await session.shutdown();
  });

  it.each(['directive-valid', 'directive-repair-success', 'directive-repair-invalid'])('uses the mature Codex directive pipeline for %s', async (scenario) => {
    const session = new CodexAgentProvider().createSession(options({
      providerOptions: { command: process.execPath, args: [fixturePath, scenario] },
      turnOptions: { turnTimeoutMs: 2_000 },
    }));
    await session.start();
    const result = await session.runTurn(turnRequest());
    expect(result).toMatchObject({
      providerId: 'codex', protocol: 'manager-directive', sessionId: 'manager-session-1',
      directiveStatus: scenario === 'directive-valid' ? 'valid' : scenario === 'directive-repair-success' ? 'repaired' : 'invalid',
    });
    await session.shutdown();
  });
});

function createSession(fake: FakeUseCase) {
  return new CodexAgentProvider({ createUseCase: () => fake }).createSession(options());
}

function options(config?: Readonly<Record<string, unknown>>) {
  return { eventBus: new EventBus(), context: context(), ...(config === undefined ? {} : { config }) };
}

function context() {
  return { provider: 'codex', projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' };
}

function factoryRequest() {
  return { eventBus: new EventBus(), context: { projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' } };
}

function turnRequest() {
  return { prompt: 'plan', protocol: 'manager-directive' as const };
}

function turnResult(sessionId = 'session-1') {
  return { threadId: 'thread-1', sessionId, turnId: 'turn-1', status: 'completed' as const, text: '', events: [] };
}

function resultOf(status: 'valid' | 'repaired' | 'invalid'): ManagerDirectiveTurnResult {
  return {
    initialTurn: turnResult(),
    ...(status === 'repaired' ? { repairTurn: { ...turnResult(), turnId: 'turn-2' } } : {}),
    directive: status === 'invalid' ? null : directive,
    directiveStatus: status,
    ...(status === 'invalid' ? { failure: { kind: 'missing_directive' as const, message: 'missing' } } : {}),
  };
}
