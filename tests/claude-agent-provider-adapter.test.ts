import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  ClaudeAgentProvider,
  ClaudeWorkerSession,
  EventBus,
  type AgentHubWorkerResult,
  type ClaudeAutoTransport,
  type ClaudeAutoTransportOptions,
  type ClaudeCapabilityReport,
  type ClaudeWorkerSessionLike,
  type ClaudeWorkerSessionOptions,
  type ClaudeWorkerTurnResult,
} from '../src/index.js';

const workerResult: AgentHubWorkerResult = {
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'done',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
};

class FakeWorker implements ClaudeWorkerSessionLike {
  public started = false;
  public active = false;
  public sessionId: string | undefined = 'claude-session';
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public result: ClaudeWorkerTurnResult = {
    protocolValid: true,
    workerResult,
    transport: 'persistent-stream',
    sessionId: 'claude-session',
    durationMs: 7,
  };
  public runError: Error | undefined;

  public start(): Promise<void> {
    this.startCalls += 1;
    this.started = true;
    return Promise.resolve();
  }

  public runTurn(): Promise<ClaudeWorkerTurnResult> {
    this.runCalls += 1;
    return this.runError === undefined ? Promise.resolve(this.result) : Promise.reject(this.runError);
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    this.started = false;
    return Promise.resolve();
  }
}

describe('Claude AgentProvider adapter', () => {
  it('has frozen role-neutral identity and capabilities and Factory creation has no lifecycle side effects', () => {
    const fake = new FakeWorker();
    let createCalls = 0;
    const provider = new ClaudeAgentProvider({ createWorkerSession: () => { createCalls += 1; return fake; } });
    const factory = new AgentProviderFactory();
    factory.register(provider);
    const session = factory.createSession('claude', request());

    expect(factory.list()).toEqual([{ id: 'claude', capabilities: { outputProtocols: ['worker-result'], sessionContinuation: true } }]);
    expect(Object.isFrozen(provider.capabilities)).toBe(true);
    expect(Object.isFrozen(provider.capabilities.outputProtocols)).toBe(true);
    expect(provider).not.toHaveProperty('role');
    expect(provider).not.toHaveProperty('isWorker');
    expect(createCalls).toBe(1);
    expect(fake.startCalls).toBe(0);
    expect(session.providerId).toBe('claude');
  });

  it('delegates lifecycle and maps success without leaking transport details', async () => {
    const fake = new FakeWorker();
    const session = createSession(fake);
    await session.start();
    const result = await session.runTurn({ prompt: 'work', protocol: 'worker-result' });
    expect(result).toEqual({
      providerId: 'claude', protocol: 'worker-result', protocolValid: true,
      workerResult, sessionId: 'claude-session', durationMs: 7,
    });
    expect(result).not.toHaveProperty('transport');
    expect(result).not.toHaveProperty('processId');
    expect(session.sessionId).toBe('claude-session');
    await session.shutdown();
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(1);
    expect(fake.shutdownCalls).toBe(1);
  });

  it('maps structured protocol failure and propagates transport errors unchanged without replay', async () => {
    const fake = new FakeWorker();
    const session = createSession(fake);
    await session.start();
    fake.result = {
      protocolValid: false,
      kind: 'worker_result_protocol',
      failure: { kind: 'missing_result', message: 'missing' },
      transport: 'resume-per-turn',
      sessionId: 'claude-session',
      durationMs: 9,
    };
    await expect(session.runTurn({ prompt: 'work', protocol: 'worker-result' })).resolves.toEqual({
      providerId: 'claude', protocol: 'worker-result', protocolValid: false,
      failure: { kind: 'missing_result', message: 'missing' }, sessionId: 'claude-session', durationMs: 9,
    });
    const transportError = new Error('transport failed');
    fake.runError = transportError;
    await expect(session.runTurn({ prompt: 'again', protocol: 'worker-result' })).rejects.toBe(transportError);
    expect(fake.runCalls).toBe(2);
  });

  it('rejects invalid requests before dispatch and never reroutes protocols', async () => {
    const fake = new FakeWorker();
    const session = createSession(fake);
    await session.start();
    await expect(session.runTurn({ prompt: 'x', protocol: 'manager-directive' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL' });
    await expect(session.runTurn({ prompt: ' ', protocol: 'worker-result' })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONTRACT_VIOLATION' });
    await expect(session.runTurn({ prompt: 'x', protocol: 'worker-result', timeoutMs: 0 })).rejects.toMatchObject({ code: 'AGENT_PROVIDER_CONTRACT_VIOLATION' });
    expect(fake.runCalls).toBe(0);
  });

  it('validates config before constructing a worker and does not disclose config values', () => {
    let creates = 0;
    const secret = 'top-secret-token';
    const provider = new ClaudeAgentProvider({ createWorkerSession: () => { creates += 1; return new FakeWorker(); } });
    expect(() => provider.createSession(baseOptions({ unknown: secret }))).toThrow(/unsupported key unknown/);
    expect(() => provider.createSession(baseOptions({ env: { TOKEN: 3 } }))).toThrow(/field env is invalid/);
    expect(() => provider.createSession(baseOptions({ capabilityReport: {} }))).toThrow(/field capabilityReport is invalid/);
    try {
      provider.createSession(baseOptions({ model: '' }));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(creates).toBe(0);
  });

  it('uses the mature ClaudeWorkerSession with controlled lower transport and preserves context events', async () => {
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((event) => events.push(event));
    const fakeAuto = new FakeAuto();
    const provider = new ClaudeAgentProvider({
      createWorkerSession: (options) => new ClaudeWorkerSession({
        ...options,
        transportFactory: (transportOptions) => {
          fakeAuto.options = transportOptions;
          return fakeAuto as unknown as ClaudeAutoTransport;
        },
      }),
    });
    const session = provider.createSession({ eventBus: bus, context: context() });
    await session.start();
    const result = await session.runTurn({ prompt: 'work', protocol: 'worker-result' });
    expect(result).toMatchObject({ protocolValid: true, providerId: 'claude' });
    expect(events).toContainEqual(expect.objectContaining({
      projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS',
    }));
    expect(fakeAuto.runCalls).toBe(1);
    await session.shutdown();
  });

  it('snapshots nested config and forces direct context attribution without mutating callers', () => {
    let captured: ClaudeWorkerSessionOptions | undefined;
    const provider = new ClaudeAgentProvider({ createWorkerSession: (options) => { captured = options; return new FakeWorker(); } });
    const env = { TOKEN: 'A' };
    const report = capabilityReport();
    const config: { mode: string; env: Record<string, string>; capabilityReport: ClaudeCapabilityReport } = {
      mode: 'auto', env, capabilityReport: report,
    };
    const callerContext = { ...context(), provider: 'spoofed-provider' };
    provider.createSession({ eventBus: new EventBus(), context: callerContext, config });

    env.TOKEN = 'B';
    report.capabilities.resume = !report.capabilities.resume;
    report.missingRequiredCapabilities.push('resume');
    report.checks.push({ capability: 'resume', supported: false, evidence: 'unsupported' });
    report.diagnostics.push('mutated');
    config.mode = 'resume-per-turn';

    expect(captured?.context.provider).toBe('claude');
    expect(callerContext.provider).toBe('spoofed-provider');
    expect(captured?.transportOptions?.mode).toBe('auto');
    expect(captured?.transportOptions?.env).toEqual({ TOKEN: 'A' });
    expect(captured?.transportOptions?.capabilityReport?.capabilities.resume).toBe(true);
    expect(captured?.transportOptions?.capabilityReport?.missingRequiredCapabilities).toEqual([]);
    expect(captured?.transportOptions?.capabilityReport?.checks).toHaveLength(0);
    expect(captured?.transportOptions?.capabilityReport?.diagnostics).toEqual([]);
  });
});

class FakeAuto {
  public options: ClaudeAutoTransportOptions | undefined;
  public sessionId: string | undefined = 'real-wrapper-session';
  public selectedTransport = 'persistent-stream' as const;
  public active = false;
  public requiresCleanup = false;
  public runCalls = 0;

  public start(): Promise<void> { return Promise.resolve(); }
  public runTurn(): Promise<{
    transport: 'persistent-stream'; sessionId: string; resultText: string;
    messageTypes: string[]; durationMs: number; isError: false;
  }> {
    this.runCalls += 1;
    return Promise.resolve({
      transport: 'persistent-stream', sessionId: 'real-wrapper-session',
      resultText: `<AGENTHUB_RESULT>\n${JSON.stringify(workerResult)}\n</AGENTHUB_RESULT>`,
      messageTypes: ['result'], durationMs: 2, isError: false,
    });
  }
  public shutdown(): Promise<void> { return Promise.resolve(); }
}

function createSession(fake: FakeWorker) {
  return new ClaudeAgentProvider({ createWorkerSession: () => fake }).createSession(baseOptions());
}

function context() {
  return { provider: 'claude', projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' };
}

function baseOptions(config?: Readonly<Record<string, unknown>>) {
  return { eventBus: new EventBus(), context: context(), ...(config === undefined ? {} : { config }) };
}

function request() {
  return { eventBus: new EventBus(), context: { projectId: 'P', agentId: 'A', taskId: 'T', assignmentId: 'AS' } };
}

function capabilityReport(): ClaudeCapabilityReport {
  const booleans = Object.fromEntries([
    'printMode', 'inputText', 'inputStreamJson', 'outputText', 'outputJson', 'outputStreamJson',
    'resume', 'sessionId', 'continueSession', 'forkSession', 'modelSelection', 'effortSelection',
    'systemPrompt', 'systemPromptFile', 'appendSystemPrompt', 'appendSystemPromptFile', 'mcpConfig',
    'strictMcpConfig', 'toolsRestriction', 'allowedTools', 'disallowedTools', 'permissionMode',
    'workingDirectorySupport',
  ].map((name) => [name, true]));
  return {
    ok: true,
    capabilities: {
      ...booleans,
      executablePath: 'claude', executableResolved: true, executableExists: true,
      installed: true, platform: process.platform, authStatusAvailable: true,
    } as ClaudeCapabilityReport['capabilities'],
    missingRequiredCapabilities: [], unknownCapabilities: [], unsupportedCapabilities: [],
    checks: [], diagnostics: [],
  };
}
