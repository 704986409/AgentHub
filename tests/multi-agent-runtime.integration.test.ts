import { describe, expect, it } from 'vitest';

import {
  AgentPool,
  AgentProviderFactory,
  ClaudeAgentProvider,
  ClaudeWorkerSession,
  CodexAgentProvider,
  CodexProviderStatus,
  EventBus,
  type AgentHubWorkerOutcome,
  type AgentHubWorkerResult,
  type ClaudeAutoTransport,
  type ClaudeAutoTransportOptions,
  type ClaudeWorkerSessionOptions,
  type CodexManagerUseCaseLike,
  type CodexManagerUseCaseOptions,
  type CodexNotificationHandler,
  type CodexProcessErrorHandler,
  type CodexProcessExitHandler,
  type CodexProtocolErrorHandler,
  type CodexProviderOptions,
  type CodexServerRequestHandler,
  type DomainEvent,
  type ManagerDirective,
  type ManagerDirectiveTurnFailureKind,
  type ManagerDirectiveTurnResult,
} from '../src/index.js';

const directive: ManagerDirective = {
  action: 'INFORM', taskId: 'task-result', title: '', instructions: '',
  acceptanceCriteria: [], issues: [], requestedChecks: [], summary: 'done',
};

interface CodexFixtureOptions {
  readonly providerOptions: CodexProviderOptions;
  readonly turnOptions: CodexManagerUseCaseOptions;
}

class FakeCodexUseCase implements CodexManagerUseCaseLike {
  public status = CodexProviderStatus.STOPPED;
  public readonly threadId: string;
  public readonly sessionId: string;
  public initializeCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public initializeError: Error | undefined;
  public runError: Error | undefined;
  public shutdownError: Error | undefined;
  public runBarrier: Promise<void> | undefined;
  public shutdownBarrier: Promise<void> | undefined;
  public onShutdown: (() => void) | undefined;
  public result: ManagerDirectiveTurnResult;
  public terminalTurn = false;
  readonly #notifications = new Set<CodexNotificationHandler>();
  readonly #serverRequests = new Set<CodexServerRequestHandler>();
  readonly #protocolErrors = new Set<CodexProtocolErrorHandler>();
  readonly #processExits = new Set<CodexProcessExitHandler>();
  readonly #processErrors = new Set<CodexProcessErrorHandler>();

  public constructor(public readonly generation: number, public readonly config: CodexFixtureOptions) {
    this.threadId = `codex-thread-${String(generation)}`;
    this.sessionId = `codex-session-${String(generation)}`;
    this.result = codexResult(this, 'valid');
  }

  public initialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.initializeError !== undefined) return Promise.reject(this.initializeError);
    this.status = CodexProviderStatus.READY;
    return Promise.resolve();
  }

  public async runDirectiveTurn(): Promise<ManagerDirectiveTurnResult> {
    this.runCalls += 1;
    this.notification('turn/started', {
      threadId: this.threadId, turn: { id: `codex-turn-${String(this.runCalls)}` },
    });
    if (this.runBarrier !== undefined) await this.runBarrier;
    if (this.terminalTurn) {
      this.status = CodexProviderStatus.ERROR;
      for (const handler of this.#processErrors) handler(new Error('codex terminal failure'));
    }
    if (this.runError !== undefined) throw this.runError;
    this.notification('turn/completed', {
      threadId: this.threadId,
      turn: { id: `codex-turn-${String(this.runCalls)}`, status: 'completed' },
    });
    return this.result;
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.onShutdown?.();
    this.status = CodexProviderStatus.STOPPING;
    if (this.shutdownBarrier !== undefined) await this.shutdownBarrier;
    if (this.shutdownError !== undefined) {
      this.status = CodexProviderStatus.ERROR;
      throw this.shutdownError;
    }
    this.status = CodexProviderStatus.STOPPED;
  }

  public getManagerSession(): { threadId: string; sessionId: string } | undefined {
    return this.status === CodexProviderStatus.STOPPED
      ? undefined
      : { threadId: this.threadId, sessionId: this.sessionId };
  }

  public getStatus(): CodexProviderStatus { return this.status; }
  public onNotification(handler: CodexNotificationHandler): () => void { this.#notifications.add(handler); return () => this.#notifications.delete(handler); }
  public onServerRequest(handler: CodexServerRequestHandler): () => void { this.#serverRequests.add(handler); return () => this.#serverRequests.delete(handler); }
  public onProtocolError(handler: CodexProtocolErrorHandler): () => void { this.#protocolErrors.add(handler); return () => this.#protocolErrors.delete(handler); }
  public onProcessExit(handler: CodexProcessExitHandler): () => void { this.#processExits.add(handler); return () => this.#processExits.delete(handler); }
  public onProcessError(handler: CodexProcessErrorHandler): () => void { this.#processErrors.add(handler); return () => this.#processErrors.delete(handler); }
  public notification(method: string, params: unknown): void { for (const handler of this.#notifications) handler(method, params); }
  public processError(error: Error): void { this.status = CodexProviderStatus.ERROR; for (const handler of this.#processErrors) handler(error); }
}

class FakeClaudeAuto {
  public sessionId: string | undefined;
  public selectedTransport = 'persistent-stream' as const;
  public active = false;
  public requiresCleanup = false;
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public startError: Error | undefined;
  public runError: Error | undefined;
  public shutdownError: Error | undefined;
  public runBarrier: Promise<void> | undefined;
  public shutdownBarrier: Promise<void> | undefined;
  public onShutdown: (() => void) | undefined;
  public terminalTurn = false;
  public resultText: string;

  public constructor(
    public readonly generation: number,
    public readonly options: ClaudeAutoTransportOptions,
    public readonly workerOptions: ClaudeWorkerSessionOptions,
  ) {
    this.sessionId = `claude-session-${String(generation)}`;
    this.resultText = workerBlock('COMPLETED');
  }

  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) {
      this.requiresCleanup = true;
      return Promise.reject(this.startError);
    }
    return Promise.resolve();
  }

  public async runTurn(): Promise<{
    transport: 'persistent-stream'; sessionId: string; resultText: string;
    messageTypes: string[]; durationMs: number; isError: false;
  }> {
    this.runCalls += 1;
    this.active = true;
    if (this.runBarrier !== undefined) await this.runBarrier;
    this.active = false;
    if (this.terminalTurn) this.requiresCleanup = true;
    if (this.runError !== undefined) throw this.runError;
    return {
      transport: 'persistent-stream', sessionId: this.sessionId ?? `claude-session-${String(this.generation)}`,
      resultText: this.resultText, messageTypes: ['result'], durationMs: 3, isError: false,
    };
  }

  public async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.onShutdown?.();
    if (this.shutdownBarrier !== undefined) await this.shutdownBarrier;
    if (this.shutdownError !== undefined) {
      this.requiresCleanup = true;
      throw this.shutdownError;
    }
    this.active = false;
    this.requiresCleanup = false;
  }
}

interface IntegrationHarness {
  readonly pool: AgentPool;
  readonly eventBus: EventBus;
  readonly events: DomainEvent[];
  readonly codex: FakeCodexUseCase[];
  readonly claude: FakeClaudeAuto[];
  failCodexConstruction: Error | undefined;
}

function integrationHarness(): IntegrationHarness {
  const eventBus = new EventBus();
  const events: DomainEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const codex: FakeCodexUseCase[] = [];
  const claude: FakeClaudeAuto[] = [];
  const factory = new AgentProviderFactory();
  factory.register(new CodexAgentProvider({
    createUseCase: (providerOptions, turnOptions) => {
      if (harness.failCodexConstruction !== undefined) throw harness.failCodexConstruction;
      const useCase = new FakeCodexUseCase(codex.length + 1, { providerOptions, turnOptions });
      codex.push(useCase);
      return useCase;
    },
  }));
  factory.register(new ClaudeAgentProvider({
    createWorkerSession: (workerOptions) => new ClaudeWorkerSession({
      ...workerOptions,
      transportFactory: (options) => {
        const transport = new FakeClaudeAuto(claude.length + 1, options, workerOptions);
        claude.push(transport);
        return transport as unknown as ClaudeAutoTransport;
      },
    }),
  }));
  const pool = new AgentPool({ providerFactory: factory, eventBus });
  const harness: IntegrationHarness = {
    pool, eventBus, events, codex, claude, failCodexConstruction: undefined,
  };
  return harness;
}

function registerFour(harness: IntegrationHarness): void {
  harness.pool.register({ agentId: 'codex-agent-A', projectId: 'project-codex-A', providerId: 'codex' });
  harness.pool.register({ agentId: 'codex-agent-B', projectId: 'project-codex-B', providerId: 'codex' });
  harness.pool.register({ agentId: 'claude-agent-A', projectId: 'project-claude-A', providerId: 'claude' });
  harness.pool.register({ agentId: 'claude-agent-B', projectId: 'project-claude-B', providerId: 'claude' });
}

describe('V0.4 multi-agent runtime integration', () => {
  it('composes four real V0.4 layers with isolated sessions, contexts, events, and parallel turns', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A', 'shared-task')),
      harness.pool.start('claude-agent-A', binding('claude-A', 'shared-task')),
      harness.pool.start('codex-agent-B', binding('codex-B')),
      harness.pool.start('claude-agent-B', binding('claude-B')),
    ]);
    expect(harness.codex).toHaveLength(2);
    expect(harness.claude).toHaveLength(2);
    expect(new Set(harness.codex.map(({ sessionId }) => sessionId)).size).toBe(2);
    expect(new Set(harness.claude.map(({ sessionId }) => sessionId)).size).toBe(2);

    await harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('codex A first'));
    await harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('claude A first'));
    const gates = [deferred(), deferred(), deferred(), deferred()];
    required(harness.codex, 0).runBarrier = required(gates, 0).promise;
    required(harness.codex, 1).runBarrier = required(gates, 1).promise;
    required(harness.claude, 0).runBarrier = required(gates, 2).promise;
    required(harness.claude, 1).runBarrier = required(gates, 3).promise;
    const turns = [
      harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('codex A second')),
      harness.pool.runTurn('codex-agent-B', 'assignment-codex-B', managerRequest('codex B')),
      harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('claude A second')),
      harness.pool.runTurn('claude-agent-B', 'assignment-claude-B', workerRequest('claude B')),
    ];
    expect(harness.pool.list().every(({ active }) => active)).toBe(true);
    gates.forEach(({ resolve }) => resolve());
    const [codexA, codexB, claudeA, claudeB] = await Promise.all(turns);
    expect(codexA).toMatchObject({ providerId: 'codex', protocol: 'manager-directive', directiveStatus: 'valid' });
    expect(codexB).toMatchObject({ providerId: 'codex', protocol: 'manager-directive' });
    expect(claudeA).toMatchObject({ providerId: 'claude', protocol: 'worker-result', protocolValid: true });
    expect(claudeB).toMatchObject({ providerId: 'claude', protocol: 'worker-result', protocolValid: true });
    for (const result of [codexA, codexB, claudeA, claudeB]) {
      expect(result).not.toHaveProperty('transport');
      expect(result).not.toHaveProperty('raw');
    }
    expect(harness.codex.map(({ runCalls }) => runCalls)).toEqual([2, 1]);
    expect(harness.claude.map(({ runCalls }) => runCalls)).toEqual([2, 1]);

    for (const agentId of ['codex-agent-A', 'codex-agent-B', 'claude-agent-A', 'claude-agent-B']) {
      const agentEvents = harness.events.filter((event) => event.agentId === agentId);
      expect(agentEvents.length).toBeGreaterThan(0);
      expect(agentEvents.every((event) => event.assignmentId === `assignment-${agentId.replace('-agent', '')}`)).toBe(true);
      expect(agentEvents.every((event) => event.projectId === `project-${agentId.replace('-agent', '')}`)).toBe(true);
    }
    expect(harness.events.every((event) => event.agentId?.startsWith('codex')
      ? (event.payload as { provider?: string }).provider === 'codex'
      : (event.payload as { provider?: string }).provider === 'claude')).toBe(true);
    expect('getRuntime' in harness.pool).toBe(false);
    expect('runtimes' in harness.pool).toBe(false);

    await harness.pool.shutdownAll();
    expect(harness.pool.list().every(({ state, busy, active }) => state === 'IDLE' && !busy && !active)).toBe(true);
    expect(harness.codex.every(({ shutdownCalls }) => shutdownCalls === 1)).toBe(true);
    expect(harness.claude.every(({ shutdownCalls, active }) => shutdownCalls === 1 && !active)).toBe(true);
  });

  it('enforces assignment uniqueness across providers and allows one task with distinct assignments', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await harness.pool.start('codex-agent-A', binding('shared', 'task-X'));
    await expect(harness.pool.start('claude-agent-A', binding('shared', 'task-X'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    expect(harness.claude).toHaveLength(0);
    await harness.pool.start('claude-agent-A', binding('claude', 'task-X'));
    expect(harness.pool.getSnapshot('codex-agent-A').taskId).toBe('task-X');
    expect(harness.pool.getSnapshot('claude-agent-A').taskId).toBe('task-X');
    await harness.pool.shutdownAll();

    await harness.pool.start('claude-agent-B', binding('reverse'));
    await expect(harness.pool.start('codex-agent-B', binding('reverse'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    expect(harness.codex).toHaveLength(1);
    await harness.pool.shutdownAll();
  });

  it('rejects cross-protocol requests before either lower provider turn', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex')),
      harness.pool.start('claude-agent-A', binding('claude')),
    ]);
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex', workerRequest('wrong')))
      .rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    await expect(harness.pool.runTurn('claude-agent-A', 'assignment-claude', managerRequest('wrong')))
      .rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    expect(harness.codex[0]?.runCalls).toBe(0);
    expect(harness.claude[0]?.runCalls).toBe(0);
    await harness.pool.shutdownAll();
  });

  it.each([
    ['valid', undefined],
    ['repaired', undefined],
    ['invalid', 'missing_directive'],
    ['invalid', 'initial_turn_failed'],
    ['invalid', 'repair_turn_failed'],
  ] as const)('preserves Codex manager result status %s / %s', async (status, failureKind) => {
    const harness = integrationHarness();
    harness.pool.register({ agentId: 'codex-agent-A', providerId: 'codex' });
    await harness.pool.start('codex-agent-A', binding('A'));
    const useCase = required(harness.codex, 0);
    useCase.result = codexResult(useCase, status, failureKind);
    const result = await harness.pool.runTurn('codex-agent-A', 'assignment-A', managerRequest('plan'));
    expect(result).toMatchObject({ providerId: 'codex', protocol: 'manager-directive', directiveStatus: status });
    if (failureKind !== undefined) expect(result).toMatchObject({ failure: { kind: failureKind } });
    await harness.pool.shutdownAll();
  });

  it.each([
    ['COMPLETED', true],
    ['BLOCKED', true],
    ['NEEDS_INPUT', true],
    ['FAILED', false],
  ] as const)('preserves Claude worker result outcome %s with protocolValid=%s', async (outcome, valid) => {
    const harness = integrationHarness();
    harness.pool.register({ agentId: 'claude-agent-A', providerId: 'claude' });
    await harness.pool.start('claude-agent-A', binding('A'));
    required(harness.claude, 0).resultText = valid ? workerBlock(outcome) : 'missing worker result block';
    const result = await harness.pool.runTurn('claude-agent-A', 'assignment-A', workerRequest('work'));
    expect(result).toMatchObject({ providerId: 'claude', protocol: 'worker-result', protocolValid: valid });
    if (valid) expect(result).toMatchObject({ workerResult: { outcome } });
    else expect(result).toHaveProperty('failure');
    expect(result).not.toHaveProperty('resultText');
    await harness.pool.shutdownAll();
  });

  it.each(['codex', 'claude'] as const)('continues and cleanly replaces %s session generations with stale fences', async (provider) => {
    const harness = integrationHarness();
    const agentA = `${provider}-agent-A`;
    const agentB = `${provider}-agent-B`;
    harness.pool.register({ agentId: agentA, providerId: provider });
    harness.pool.register({ agentId: agentB, providerId: provider });
    await harness.pool.start(agentA, binding('old'));
    const firstSession = harness.pool.getSnapshot(agentA).sessionId;
    await harness.pool.runTurn(agentA, 'assignment-old', requestFor(provider, 'one'));
    await harness.pool.runTurn(agentA, 'assignment-old', requestFor(provider, 'two'));
    expect(provider === 'codex' ? harness.codex[0]?.runCalls : harness.claude[0]?.runCalls).toBe(2);
    await harness.pool.shutdown(agentA, 'assignment-old');
    await harness.pool.start(agentB, binding('old'));
    await expect(harness.pool.runTurn(agentA, 'assignment-old', requestFor(provider, 'stale')))
      .rejects.toMatchObject({ code: 'AGENT_POOL_ASSIGNMENT_MISMATCH' });
    await expect(harness.pool.shutdown(agentA, 'assignment-old'))
      .rejects.toMatchObject({ code: 'AGENT_POOL_ASSIGNMENT_MISMATCH' });
    await harness.pool.shutdown(agentB, 'assignment-old');
    await harness.pool.start(agentA, binding('new'));
    expect(harness.pool.getSnapshot(agentA).sessionId).not.toBe(firstSession);
    await expect(harness.pool.runTurn(agentA, 'assignment-old', requestFor(provider, 'stale generation')))
      .rejects.toMatchObject({ code: 'AGENT_POOL_ASSIGNMENT_MISMATCH' });
    expect(harness.pool.getSnapshot(agentA)).toMatchObject({ assignmentId: 'assignment-new', state: 'OWNED' });
    await harness.pool.shutdownAll();
  });

  it('isolates reusable and terminal Codex failures from other agents and providers', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A')),
      harness.pool.start('codex-agent-B', binding('codex-B')),
      harness.pool.start('claude-agent-A', binding('claude-A')),
    ]);
    const codexA = required(harness.codex, 0);
    codexA.runError = new Error('reusable turn failure');
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('fail once')))
      .rejects.toBe(codexA.runError);
    expect(harness.pool.getSnapshot('codex-agent-A').state).toBe('OWNED');
    codexA.runError = undefined;
    await harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('reuse'));
    codexA.terminalTurn = true;
    codexA.runError = new Error('terminal turn failure');
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('terminal')))
      .rejects.toBe(codexA.runError);
    expect(harness.pool.getSnapshot('codex-agent-A').state).toBe('FAILED');
    await expect(harness.pool.start('claude-agent-B', binding('codex-A'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    await expect(harness.pool.runTurn('codex-agent-B', 'assignment-codex-B', managerRequest('healthy'))).resolves.toBeDefined();
    await expect(harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('healthy'))).resolves.toBeDefined();
    expect(harness.codex[1]?.runCalls).toBe(1);
    expect(harness.claude[0]?.runCalls).toBe(1);
    await harness.pool.shutdownAll();
  });

  it('isolates reusable and terminal Claude failures from Codex and another Claude agent', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('claude-agent-A', binding('claude-A')),
      harness.pool.start('claude-agent-B', binding('claude-B')),
      harness.pool.start('codex-agent-A', binding('codex-A')),
    ]);
    const claudeA = required(harness.claude, 0);
    claudeA.runError = new Error('reusable worker failure');
    await expect(harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('fail once')))
      .rejects.toBe(claudeA.runError);
    expect(harness.pool.getSnapshot('claude-agent-A').state).toBe('OWNED');
    claudeA.terminalTurn = true;
    claudeA.runError = new Error('terminal worker failure');
    await expect(harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('terminal')))
      .rejects.toBe(claudeA.runError);
    expect(harness.pool.getSnapshot('claude-agent-A').state).toBe('FAILED');
    await expect(harness.pool.runTurn('claude-agent-B', 'assignment-claude-B', workerRequest('healthy'))).resolves.toBeDefined();
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('healthy'))).resolves.toBeDefined();
    expect(harness.claude[1]?.runCalls).toBe(1);
    expect(harness.codex[0]?.runCalls).toBe(1);
    await harness.pool.shutdownAll();
  });

  it('contains an event subscriber failure to its Codex runtime while Claude remains healthy', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    const subscriberFailure = new Error('subscriber failed');
    harness.eventBus.subscribe((event) => {
      if (event.agentId === 'codex-agent-A' && event.eventType === 'ProviderError') throw subscriberFailure;
    });
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A')),
      harness.pool.start('claude-agent-A', binding('claude-A')),
    ]);
    required(harness.codex, 0).processError(new Error('process failed'));
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('blocked')))
      .rejects.toMatchObject({ code: 'AGENT_RUNTIME_PROVIDER_CONTRACT_VIOLATION' });
    expect(harness.pool.getSnapshot('codex-agent-A').state).toBe('FAILED');
    expect(harness.codex[0]?.runCalls).toBe(0);
    await expect(harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('healthy'))).resolves.toBeDefined();
    await expect(harness.pool.shutdownAll()).rejects.toMatchObject({
      code: 'AGENT_POOL_SHUTDOWN_FAILED', failedAgentIds: ['codex-agent-A'],
    });
    expect(harness.pool.getSnapshot('claude-agent-A').state).toBe('IDLE');
    await harness.pool.shutdownAll();
  });

  it('isolates mixed shutdownAll failures, active turns, ownership, and explicit retry', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A')),
      harness.pool.start('codex-agent-B', binding('codex-B')),
      harness.pool.start('claude-agent-A', binding('claude-A')),
      harness.pool.start('claude-agent-B', binding('claude-B')),
    ]);
    const activeGate = deferred();
    const shutdownGateA = deferred();
    const shutdownGateB = deferred();
    const codexShutdownStarted = deferred();
    const claudeShutdownStarted = deferred();
    required(harness.claude, 1).runBarrier = activeGate.promise;
    required(harness.codex, 0).shutdownBarrier = shutdownGateA.promise;
    required(harness.claude, 0).shutdownBarrier = shutdownGateB.promise;
    required(harness.codex, 0).onShutdown = codexShutdownStarted.resolve;
    required(harness.claude, 0).onShutdown = claudeShutdownStarted.resolve;
    required(harness.codex, 1).shutdownError = new Error('codex B cleanup failed');
    const activeTurn = harness.pool.runTurn('claude-agent-B', 'assignment-claude-B', workerRequest('active'));
    const drain = harness.pool.shutdownAll();
    await Promise.all([codexShutdownStarted.promise, claudeShutdownStarted.promise]);
    expect(harness.codex[0]?.shutdownCalls).toBe(1);
    expect(harness.claude[0]?.shutdownCalls).toBe(1);
    shutdownGateA.resolve();
    shutdownGateB.resolve();
    activeGate.resolve();
    await activeTurn;
    await expect(drain).rejects.toMatchObject({
      code: 'AGENT_POOL_SHUTDOWN_FAILED', failedAgentIds: ['codex-agent-B'],
    });
    expect(harness.pool.draining).toBe(false);
    expect(harness.pool.getSnapshot('codex-agent-B').state).toBe('FAILED');
    expect(harness.pool.list().filter(({ state }) => state !== 'IDLE').map(({ agentId }) => agentId))
      .toEqual(['codex-agent-B']);
    await expect(harness.pool.start('claude-agent-A', binding('codex-B'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    required(harness.codex, 1).shutdownError = undefined;
    await harness.pool.shutdownAll();
    expect(harness.codex[1]?.shutdownCalls).toBe(2);
    await harness.pool.start('claude-agent-A', binding('codex-B'));
    await harness.pool.shutdownAll();
  });

  it('cleans a terminal Codex failure while retaining only a failed Claude cleanup', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A')),
      harness.pool.start('codex-agent-B', binding('codex-B')),
      harness.pool.start('claude-agent-A', binding('claude-A')),
      harness.pool.start('claude-agent-B', binding('claude-B')),
    ]);
    const codexA = required(harness.codex, 0);
    codexA.terminalTurn = true;
    codexA.runError = new Error('codex terminal');
    await expect(harness.pool.runTurn('codex-agent-A', 'assignment-codex-A', managerRequest('terminal')))
      .rejects.toBe(codexA.runError);
    expect(harness.pool.getSnapshot('codex-agent-A').state).toBe('FAILED');

    const activeGate = deferred();
    const claudeA = required(harness.claude, 0);
    const claudeB = required(harness.claude, 1);
    claudeA.runBarrier = activeGate.promise;
    claudeB.shutdownError = new Error('claude B cleanup failed');
    const activeTurn = harness.pool.runTurn('claude-agent-A', 'assignment-claude-A', workerRequest('active'));
    const drain = harness.pool.shutdownAll();
    activeGate.resolve();
    await activeTurn;
    await expect(drain).rejects.toMatchObject({
      code: 'AGENT_POOL_SHUTDOWN_FAILED', failedAgentIds: ['claude-agent-B'],
    });
    expect(harness.pool.list().filter(({ state }) => state !== 'IDLE').map(({ agentId }) => agentId))
      .toEqual(['claude-agent-B']);
    expect(required(harness.codex, 0).shutdownCalls).toBe(1);
    expect(required(harness.codex, 1).shutdownCalls).toBe(1);
    expect(claudeA.shutdownCalls).toBe(1);
    expect(claudeB.shutdownCalls).toBe(1);

    claudeB.shutdownError = undefined;
    await harness.pool.shutdownAll();
    expect(claudeB.shutdownCalls).toBe(2);
    expect(harness.pool.list().every(({ state }) => state === 'IDLE')).toBe(true);
  });

  it('releases clean construction failure but retains dirty adapter start failure until cleanup', async () => {
    const harness = integrationHarness();
    registerFour(harness);
    harness.failCodexConstruction = new Error('clean construction failure');
    await expect(harness.pool.start('codex-agent-A', binding('shared'))).rejects.toBe(harness.failCodexConstruction);
    harness.failCodexConstruction = undefined;
    await harness.pool.start('claude-agent-A', binding('shared'));
    await harness.pool.shutdown('claude-agent-A', 'assignment-shared');

    const dirtyStart = harness.pool.start('claude-agent-A', binding('dirty'));
    required(harness.claude, harness.claude.length - 1).startError = new Error('dirty start failure');
    await expect(dirtyStart).rejects.toThrow('dirty start failure');
    expect(harness.pool.getSnapshot('claude-agent-A').state).toBe('FAILED');
    await expect(harness.pool.start('codex-agent-B', binding('dirty'))).rejects.toMatchObject({
      code: 'AGENT_POOL_ASSIGNMENT_ALREADY_OWNED',
    });
    await harness.pool.shutdown('claude-agent-A', 'assignment-dirty');
    await harness.pool.start('codex-agent-B', binding('dirty'));
    await harness.pool.shutdownAll();
  });

  it('keeps same-provider config and public snapshots isolated without secret exposure', async () => {
    const harness = integrationHarness();
    const codexConfigA = { providerOptions: { command: 'codex-A', env: { TOKEN: 'secret-A' } } };
    const codexConfigB = { providerOptions: { command: 'codex-B', env: { TOKEN: 'secret-B' } } };
    const claudeConfigA = { mode: 'persistent-stream', model: 'model-A', env: { TOKEN: 'secret-C' } };
    const claudeConfigB = { mode: 'resume-per-turn', model: 'model-B', env: { TOKEN: 'secret-D' } };
    harness.pool.register({ agentId: 'codex-agent-A', providerId: 'codex', providerConfig: codexConfigA });
    harness.pool.register({ agentId: 'codex-agent-B', providerId: 'codex', providerConfig: codexConfigB });
    harness.pool.register({ agentId: 'claude-agent-A', providerId: 'claude', providerConfig: claudeConfigA });
    harness.pool.register({ agentId: 'claude-agent-B', providerId: 'claude', providerConfig: claudeConfigB });
    codexConfigA.providerOptions = { command: 'mutated', env: { TOKEN: 'mutated' } };
    claudeConfigA.mode = 'auto';
    await Promise.all([
      harness.pool.start('codex-agent-A', binding('codex-A')),
      harness.pool.start('codex-agent-B', binding('codex-B')),
      harness.pool.start('claude-agent-A', binding('claude-A')),
      harness.pool.start('claude-agent-B', binding('claude-B')),
    ]);
    expect(harness.codex.map(({ config }) => config.providerOptions.command)).toEqual(['codex-A', 'codex-B']);
    expect(harness.claude.map(({ options }) => options.mode)).toEqual(['persistent-stream', 'resume-per-turn']);
    expect(harness.claude.map(({ options }) => options.model)).toEqual(['model-A', 'model-B']);
    for (const snapshot of harness.pool.list()) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot).not.toHaveProperty('providerConfig');
      expect(snapshot).not.toHaveProperty('runtime');
      expect(JSON.stringify(snapshot)).not.toContain('secret-');
    }
    await harness.pool.shutdownAll();
  });
});

function binding(id: string, taskId = `task-${id}`) {
  return { taskId, assignmentId: `assignment-${id}`, specVersion: `spec-${id}`, profileHash: `profile-${id}` };
}

function managerRequest(prompt: string) { return { prompt, protocol: 'manager-directive' as const }; }
function workerRequest(prompt: string) { return { prompt, protocol: 'worker-result' as const }; }
function requestFor(provider: 'codex' | 'claude', prompt: string) {
  return provider === 'codex' ? managerRequest(prompt) : workerRequest(prompt);
}

function codexResult(
  fake: FakeCodexUseCase,
  status: 'valid' | 'repaired' | 'invalid',
  failureKind: ManagerDirectiveTurnFailureKind = 'missing_directive',
): ManagerDirectiveTurnResult {
  const turn = (turnId: string) => ({
    threadId: fake.threadId, sessionId: fake.sessionId, turnId, status: 'completed' as const, text: '', events: [],
  });
  return {
    initialTurn: turn('initial'),
    ...(status === 'repaired' || failureKind === 'repair_turn_failed' ? { repairTurn: turn('repair') } : {}),
    directive: status === 'invalid' ? null : directive,
    directiveStatus: status,
    ...(status === 'invalid' ? { failure: { kind: failureKind, message: failureKind } } : {}),
  };
}

function workerResult(outcome: AgentHubWorkerOutcome): AgentHubWorkerResult {
  return {
    protocolVersion: 1, outcome, summary: `worker ${outcome}`, changedFiles: [], checks: [],
    blockers: outcome === 'BLOCKED' ? ['blocked'] : [],
    questions: outcome === 'NEEDS_INPUT' ? ['question'] : [], risks: [], notes: [],
  };
}

function workerBlock(outcome: AgentHubWorkerOutcome): string {
  return `<AGENTHUB_RESULT>\n${JSON.stringify(workerResult(outcome))}\n</AGENTHUB_RESULT>`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function required<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing test fixture at index ${String(index)}`);
  return value;
}
