import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentHubWorkerResultParser,
  AgentRuntimeEventType,
  ClaudeAutoError,
  ClaudePersistentStreamTransport,
  ClaudeProcessManager,
  ClaudeResumePerTurnTransport,
  ClaudeWorkerSession,
  Database,
  EventBus,
  EventStore,
  SqliteEventRepository,
  agentHubResultOpenTag,
  agentHubWorkerResultLimits,
  buildAgentHubWorkerResultInstruction,
  claudeCapabilityNames,
  type AgentHubWorkerOutcome,
  type AgentHubWorkerResult,
  type AgentHubWorkerResultFailureKind,
  type ClaudeAutoTransport,
  type ClaudeAutoTransportOptions,
  type ClaudeAutoTurnResult,
  type ClaudeCapabilityEvidence,
  type ClaudeCapabilityName,
  type ClaudeCapabilityReport,
  type ClaudeProcessManagerOptions,
  type ClaudeRawMessage,
  type DomainEvent,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude/fake-claude-process.mjs', import.meta.url));

interface FakeTurn {
  result?: ClaudeAutoTurnResult;
  error?: Error;
  raw?: ClaudeRawMessage[];
  wait?: Promise<void>;
  requiresCleanupAfterError?: boolean;
}

class FakeAuto {
  public selectedTransport: 'persistent-stream' | 'resume-per-turn' | undefined = 'persistent-stream';
  public sessionId: string | undefined;
  public active = false;
  public requiresCleanup = false;
  public lastFallback = undefined;
  public startCalls = 0;
  public runCalls = 0;
  public shutdownCalls = 0;
  public readonly prompts: string[] = [];
  public readonly turns: FakeTurn[] = [];
  public startError: Error | undefined;
  public shutdownError: Error | undefined;

  public constructor(public readonly options: ClaudeAutoTransportOptions) {}

  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    return Promise.resolve();
  }

  public async runTurn(request: { prompt: string }): Promise<ClaudeAutoTurnResult> {
    this.runCalls += 1;
    this.prompts.push(request.prompt);
    this.active = true;
    try {
      const turn = this.turns.shift() ?? { result: autoResult(workerText('COMPLETED')) };
      for (const message of turn.raw ?? []) this.options.onRawMessage?.(message);
      if (turn.wait !== undefined) await turn.wait;
      if (turn.error !== undefined) {
        this.requiresCleanup = turn.requiresCleanupAfterError ?? this.requiresCleanup;
        throw turn.error;
      }
      const result = turn.result ?? autoResult(workerText('COMPLETED'));
      this.selectedTransport = result.transport;
      this.sessionId = result.sessionId;
      return result;
    } finally {
      this.active = false;
    }
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.shutdownError !== undefined) return Promise.reject(this.shutdownError);
    this.requiresCleanup = false;
    return Promise.resolve();
  }
}

describe('Claude worker session', () => {
  it('starts without a model call and exposes selected lifecycle state', async () => {
    const { session, fake, events } = createFakeSession();
    await session.start();
    expect(session.started).toBe(true);
    expect(session.selectedTransport).toBe('persistent-stream');
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('rejects run before start, concurrent start, and double start with session errors', async () => {
    let releaseStart!: () => void;
    const startWait = new Promise<void>((resolve) => { releaseStart = resolve; });
    const { session, fake } = createFakeSession();
    fake.start = async () => { fake.startCalls += 1; await startWait; };

    await expect(session.runTurn({ prompt: 'x' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_NOT_STARTED' });
    const starting = session.start();
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_ALREADY_STARTED' });
    releaseStart();
    await starting;
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_ALREADY_STARTED' });
    expect(fake.startCalls).toBe(1);
  });

  it.each(['', '   ', '\r\n'])('rejects blank prompt %j before events or model calls', async (prompt) => {
    const { session, fake, events } = createFakeSession();
    await session.start();
    await expect(session.runTurn({ prompt })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_INVALID_REQUEST' });
    expect(fake.runCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeout %s locally', async (timeoutMs) => {
    const { session, fake, events } = createFakeSession();
    await session.start();
    await expect(session.runTurn({ prompt: 'x', timeoutMs })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_INVALID_REQUEST' });
    expect(fake.runCalls).toBe(0);
    expect(events).toEqual([]);
  });

  it('preserves the caller prompt and appends the standard instruction exactly once per turn', async () => {
    const { session, fake } = createFakeSession();
    await session.start();
    await session.runTurn({ prompt: 'caller text   \n' });
    await session.runRevision({ prompt: `revision mentions ${agentHubResultOpenTag}` });
    const instruction = buildAgentHubWorkerResultInstruction();
    expect(fake.prompts[0]).toBe(`caller text\n\n${instruction}`);
    expect(count(fake.prompts[0] ?? '', instruction)).toBe(1);
    expect(count(fake.prompts[1] ?? '', instruction)).toBe(1);
    expect(fake.runCalls).toBe(2);
  });

  it('leaves the Session unstarted after a start failure and permits an explicit retry', async () => {
    const { session, fake } = createFakeSession();
    const error = new ClaudeAutoError('CLAUDE_AUTO_NO_USABLE_TRANSPORT', 'unavailable');
    fake.startError = error;
    await expect(session.start()).rejects.toBe(error);
    expect(session.started).toBe(false);
    fake.startError = undefined;
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(2);
  });

  it.each([
    'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
    'CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED',
  ] as const)('requires cleanup after lower start reports %s', async (code) => {
    const ownershipError = new ClaudeAutoError(code, 'ownership unresolved');
    const { session, fake, events } = createFakeSession();
    fake.startError = ownershipError;
    fake.requiresCleanup = true;

    await expect(session.start()).rejects.toBe(ownershipError);
    expect(session.started).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);
    expect(fake.prompts).toEqual([]);
    expect(events).toEqual([]);

    fake.startError = undefined;
    await session.shutdown();
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.shutdownCalls).toBe(1);
    expect(fake.startCalls).toBe(2);
  });

  it('atomically cleans up and permits retry when raw mapping fails after lower start', async () => {
    const mapperError = new Error('start raw mapper failed');
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.start = () => {
      fake.startCalls += 1;
      if (fake.startCalls === 1) fake.options.onRawMessage?.(rawInit());
      return Promise.resolve();
    };

    await expect(session.start()).rejects.toBe(mapperError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    expect(fake.shutdownCalls).toBe(1);
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(2);
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(2);
  });

  it('blocks use until same-Auto cleanup succeeds after atomic start cleanup fails', async () => {
    const mapperError = new Error('start raw mapper failed');
    const cleanupError = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'start cleanup failed');
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake, events } = createFakeSession({ eventBus });
    fake.start = () => {
      fake.startCalls += 1;
      fake.options.onRawMessage?.(rawInit());
      return Promise.resolve();
    };
    fake.shutdownError = cleanupError;

    await expect(session.start()).rejects.toBe(cleanupError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    expect(fake.startCalls).toBe(1);
    expect(fake.shutdownCalls).toBe(1);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(0);
    expect(fake.prompts).toEqual([]);
    expect(events.filter((event) => event.eventType === executionStartedType)).toEqual([]);

    await expect(session.shutdown()).rejects.toBe(cleanupError);
    expect(session.started).toBe(false);
    expect(fake.shutdownCalls).toBe(2);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'still dirty' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'still dirty' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);

    fake.shutdownError = undefined;
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(3);
    expect(session.started).toBe(false);
    await session.start();
    await expect(session.runTurn({ prompt: 'after cleanup' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.startCalls).toBe(2);
    expect(fake.runCalls).toBe(1);
    expect(events.filter((event) => event.eventType === executionStartedType)).toHaveLength(1);
  });

  it('preserves lower start failure and clears raw mapping state before retry', async () => {
    const mapperError = new Error('raw mapper failed during rejected start');
    const startError = new ClaudeAutoError('CLAUDE_AUTO_NO_USABLE_TRANSPORT', 'unavailable');
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType) throw mapperError;
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.start = () => {
      fake.startCalls += 1;
      if (fake.startCalls === 1) {
        fake.options.onRawMessage?.(rawInit());
        return Promise.reject(startError);
      }
      return Promise.resolve();
    };

    await expect(session.start()).rejects.toBe(startError);
    expect(session.started).toBe(false);
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(2);
  });

  it('preserves transport failure over raw mapping failure without leaking into the next turn', async () => {
    const mapperError = new Error('raw mapper failed');
    const transportError = new ClaudeAutoError(
      'CLAUDE_AUTO_TURN_FAILED', 'transport failed', 'persistent-stream', 'session-A', 'ambiguous',
    );
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake, events } = createFakeSession({ eventBus });
    fake.turns.push(
      { raw: [rawInit()], error: transportError },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();

    await expect(session.runTurn({ prompt: 'first' })).rejects.toBe(transportError);
    expect(session.active).toBe(false);
    await expect(session.runTurn({ prompt: 'second' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.runCalls).toBe(2);
    expect(events.map((event) => event.eventType).filter(isExecutionTerminal)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
    ]);
  });

  it('does not leak a dual-failure raw mapping error across shutdown and restart', async () => {
    const mapperError = new Error('old raw mapper failed');
    const transportError = new Error('old transport failed');
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push(
      { raw: [rawInit()], error: transportError },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    await expect(session.runTurn({ prompt: 'first generation' })).rejects.toBe(transportError);
    await session.shutdown();

    await session.start();
    await expect(session.runTurn({ prompt: 'second generation' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.startCalls).toBe(2);
    expect(fake.runCalls).toBe(2);
    expect(fake.shutdownCalls).toBe(1);
  });

  it('clears raw mapping errors emitted during successful shutdown before restart', async () => {
    const mapperError = new Error('shutdown raw mapper failed');
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.shutdown = () => {
      fake.shutdownCalls += 1;
      if (fake.shutdownCalls === 1) fake.options.onRawMessage?.(rawInit());
      return Promise.resolve();
    };
    await session.start();
    await session.shutdown();

    await session.start();
    await expect(session.runTurn({ prompt: 'clean generation' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.startCalls).toBe(2);
    expect(fake.runCalls).toBe(1);
  });

  it('clears active-turn raw mapping state when shutdown terminates the generation', async () => {
    const mapperError = new Error('active raw mapper failed');
    const transportError = new Error('stopped by shutdown');
    const turnBarrier = deferred();
    const eventBus = new EventBus();
    let failMapping = true;
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType && failMapping) {
        failMapping = false;
        throw mapperError;
      }
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push(
      { raw: [rawInit()], wait: turnBarrier.promise },
      { result: autoResult(workerText('COMPLETED')) },
    );
    fake.shutdown = () => {
      fake.shutdownCalls += 1;
      turnBarrier.reject(transportError);
      return Promise.resolve();
    };
    await session.start();
    const turn = session.runTurn({ prompt: 'active generation' });
    await Promise.resolve();

    await session.shutdown();
    await expect(turn).rejects.toBe(transportError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);

    await session.start();
    await expect(session.runTurn({ prompt: 'clean generation' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.startCalls).toBe(2);
    expect(fake.runCalls).toBe(2);
    expect(fake.shutdownCalls).toBe(1);
  });

  it('rejects revision before start without constructing a prompt', async () => {
    const { session, fake } = createFakeSession();
    await expect(session.runRevision({ prompt: 'revision' })).rejects.toMatchObject({
      code: 'CLAUDE_WORKER_SESSION_NOT_STARTED',
    });
    expect(fake.prompts).toEqual([]);
  });

  it.each(['COMPLETED', 'FAILED', 'BLOCKED', 'NEEDS_INPUT'] as const)(
    'parses %s and maps the authoritative terminal semantics',
    async (outcome) => {
      const { session, fake, events } = createFakeSession();
      fake.turns.push({
        raw: [rawInit(), rawResult('PRIVATE_RAW_RESULT')],
        result: autoResult(workerText(outcome)),
      });
      await session.start();
      const result = await session.runTurn({ prompt: 'work' });
      expect(result).toMatchObject({ protocolValid: true, transport: 'persistent-stream', sessionId: 'session-A' });
      if (result.protocolValid) expect(result.workerResult.outcome).toBe(outcome);
      const types = events.map((event) => event.eventType);
      expect(types[0]).toBe(AgentRuntimeEventType.AGENT_EXECUTION_STARTED);
      expect(types.filter(isExecutionTerminal)).toEqual([
        outcome === 'FAILED' ? AgentRuntimeEventType.AGENT_EXECUTION_FAILED : AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
      ]);
      if (outcome === 'NEEDS_INPUT') expect(types.at(-1)).toBe(AgentRuntimeEventType.AGENT_INPUT_REQUIRED);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_RAW_RESULT');
    },
  );

  it.each(protocolFailures())('returns $kind without throwing or retrying', async ({ kind, text }) => {
    const { session, fake, events } = createFakeSession();
    fake.turns.push({ raw: [rawResult('PRIVATE_RAW_RESULT')], result: autoResult(text) });
    await session.start();
    const result = await session.runTurn({ prompt: 'work' });
    expect(result).toMatchObject({ protocolValid: false, kind: 'worker_result_protocol', failure: { kind } });
    expect(fake.runCalls).toBe(1);
    expect(session.sessionId).toBe('session-A');
    expect(events.map((event) => event.eventType).slice(-2)).toEqual([
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW_RESULT');
  });

  it('keeps the same session usable for explicit revision after malformed protocol', async () => {
    const { session, fake, events } = createFakeSession();
    fake.turns.push(
      { result: autoResult(`${agentHubResultOpenTag}{bad}</AGENTHUB_RESULT>`, { processId: 41 }) },
      { result: autoResult(workerText('COMPLETED'), { processId: 41 }) },
    );
    await session.start();
    const first = await session.runTurn({ prompt: 'first' });
    const second = await session.runRevision({ prompt: 'fix it' });
    expect(first.protocolValid).toBe(false);
    expect(second).toMatchObject({ protocolValid: true, sessionId: 'session-A', processId: 41 });
    expect(fake.runCalls).toBe(2);
    expect(events.map((event) => event.eventType).filter(isExecutionTerminal)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
    ]);
  });

  it('releases the Session guard after a returned protocol failure', async () => {
    const { session, fake } = createFakeSession();
    fake.turns.push(
      { result: autoResult('missing') },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    expect((await session.runTurn({ prompt: 'one' })).protocolValid).toBe(false);
    expect(session.active).toBe(false);
    await expect(session.runTurn({ prompt: 'two' })).resolves.toMatchObject({ protocolValid: true });
    await session.shutdown();
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
  });

  it('does not retain or feed prior malformed output into an explicit revision prompt', async () => {
    const { session, fake } = createFakeSession();
    fake.turns.push(
      { result: autoResult('<AGENTHUB_RESULT>PRIVATE_MALFORMED{</AGENTHUB_RESULT>') },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    await session.runTurn({ prompt: 'first request' });
    await session.runRevision({ prompt: 'caller revision only' });
    expect(fake.prompts[1]).toContain('caller revision only');
    expect(fake.prompts[1]).not.toContain('PRIVATE_MALFORMED');
    expect(fake.runCalls).toBe(2);
  });

  it('keeps valid NEEDS_INPUT and FAILED outcomes technically revisable', async () => {
    const { session, fake } = createFakeSession();
    fake.turns.push(
      { result: autoResult(workerText('NEEDS_INPUT')) },
      { result: autoResult(workerText('FAILED')) },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    expect((await session.runTurn({ prompt: 'one' })).protocolValid).toBe(true);
    expect((await session.runRevision({ prompt: 'two' })).protocolValid).toBe(true);
    expect((await session.runRevision({ prompt: 'three' })).protocolValid).toBe(true);
    expect(fake.runCalls).toBe(3);
  });

  it('routes raw messages to the mapper before a best-effort external observer', async () => {
    const order: string[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType) order.push('mapper');
    });
    const { session, fake } = createFakeSession({
      eventBus,
      onRawMessage: () => { order.push('observer'); throw new Error('diagnostic'); },
    });
    fake.turns.push({ raw: [rawInit()], result: autoResult(workerText('COMPLETED')) });
    await session.start();
    await expect(session.runTurn({ prompt: 'x' })).resolves.toMatchObject({ protocolValid: true });
    expect(order).toEqual(['mapper', 'observer']);
  });

  it('surfaces raw mapper failures even when the lower observer boundary swallows callbacks', async () => {
    const mapperError = new Error('raw mapper failed');
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType) throw mapperError;
    });
    const calls: ClaudeProcessManagerOptions[] = [];
    const session = createActualSession('persistent-worker-valid', report('supported'), calls, eventBus);
    try {
      await session.start();
      await expect(session.runTurn({ prompt: 'x' })).rejects.toBe(mapperError);
      expect(session.active).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      await session.shutdown();
    }
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
  });

  it('preserves transport error identity, maps safe metadata, and never replays', async () => {
    const error = new ClaudeAutoError(
      'CLAUDE_AUTO_TURN_FAILED', 'safe transport message', 'persistent-stream', 'session-A', 'ambiguous',
    );
    const { session, fake, events } = createFakeSession();
    fake.sessionId = 'session-A';
    fake.turns.push(
      { error },
      { result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    let caught: unknown;
    try { await session.runTurn({ prompt: 'PRIVATE_PROMPT' }); } catch (value) { caught = value; }
    expect(caught).toBe(error);
    expect(fake.runCalls).toBe(1);
    expect(session.active).toBe(false);
    expect(session.started).toBe(true);
    expect(fake.requiresCleanup).toBe(false);
    expect(events.map((event) => event.eventType).filter(isExecutionTerminal)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_PROMPT');
    await expect(session.runRevision({ prompt: 'safe retry' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.runCalls).toBe(2);
    await session.shutdown();
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
  });

  it('quarantines a generic TURN_FAILED when Auto reports FAILED lifecycle state', async () => {
    const error = new ClaudeAutoError(
      'CLAUDE_AUTO_TURN_FAILED', 'fatal generic failure', 'persistent-stream', undefined, 'ambiguous',
    );
    const { session, fake, events } = createFakeSession();
    fake.turns.push({ error, requiresCleanupAfterError: true });
    await session.start();

    await expect(session.runTurn({ prompt: 'fatal' })).rejects.toBe(error);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    expect(fake.runCalls).toBe(1);
    expect(events.filter((event) => event.eventType === executionStartedType)).toHaveLength(1);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(1);

    await session.shutdown();
    expect(fake.requiresCleanup).toBe(false);
    await session.start();
    expect(session.started).toBe(true);
    await session.shutdown();
  });

  it('commits fatal generic dirty state before failure mapping throws', async () => {
    const transportError = new ClaudeAutoError('CLAUDE_AUTO_TURN_FAILED', 'fatal generic failure');
    const mapperError = new Error('fatal failure mapper failed');
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === executionFailedType) throw mapperError;
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({ error: transportError, requiresCleanupAfterError: true });
    await session.start();

    await expect(session.runTurn({ prompt: 'fatal' })).rejects.toBe(mapperError);
    expect(session.started).toBe(false);
    await expect(session.runRevision({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED',
    });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('preserves fatal transport semantics when raw mapping also fails and quarantines reuse', async () => {
    const rawMapperError = new Error('fatal raw mapper failed');
    const transportError = new ClaudeAutoError('CLAUDE_AUTO_TURN_FAILED', 'fatal generic failure');
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType) throw rawMapperError;
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({ raw: [rawInit()], error: transportError, requiresCleanupAfterError: true });
    await session.start();

    await expect(session.runTurn({ prompt: 'fatal' })).rejects.toBe(transportError);
    expect(session.started).toBe(false);
    await expect(session.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED',
    });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('uses actual Auto FAILED state to quarantine Session before a second execution starts', async () => {
    const persistent = new LifecyclePersistentStub();
    const resume = new LifecycleResumeStub();
    const { session, events } = createLifecycleSession(persistent, resume);
    await session.start();

    await expect(session.runTurn({ prompt: 'fatal actual Auto' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED', retrySafety: 'ambiguous',
    });
    expect(session.started).toBe(false);
    expect(persistent.prompts).toHaveLength(1);
    const startedCount = events.filter((event) => event.eventType === executionStartedType).length;
    await expect(session.runTurn({ prompt: 'must stay local' })).rejects.toMatchObject({
      code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED',
    });
    expect(events.filter((event) => event.eventType === executionStartedType)).toHaveLength(startedCount);
    expect(persistent.prompts).toHaveLength(1);
    expect(resume.requests).toHaveLength(0);

    await session.shutdown();
    await session.start();
    expect(session.started).toBe(true);
    await session.shutdown();
  });

  it('uses actual Auto READY fallback state to permit an explicit Resume revision without replay', async () => {
    const persistent = new LifecyclePersistentStub('session-A');
    const resume = new LifecycleResumeStub();
    const { session } = createLifecycleSession(persistent, resume);
    await session.start();

    await expect(session.runTurn({ prompt: 'ambiguous actual Auto' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED', retrySafety: 'ambiguous',
    });
    expect(session.started).toBe(true);
    expect(persistent.prompts).toHaveLength(1);
    expect(resume.requests).toHaveLength(0);

    await expect(session.runRevision({ prompt: 'explicit revision' })).resolves.toMatchObject({
      protocolValid: true, transport: 'resume-per-turn', sessionId: 'session-A',
    });
    expect(persistent.prompts).toHaveLength(1);
    expect(resume.requests).toHaveLength(1);
    await session.shutdown();
  });

  it.each([
    ['CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED', 'persistent-stream'],
    ['CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED', 'resume-per-turn'],
  ] as const)('quarantines turn-time %s until same-Auto cleanup succeeds', async (code, transport) => {
    const ownershipError = new ClaudeAutoError(code, 'owned', transport, 'session-A', 'ambiguous');
    const cleanupError = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'cleanup failed');
    const { session, fake, events } = createFakeSession();
    fake.selectedTransport = transport;
    fake.sessionId = 'session-A';
    fake.turns.push(
      { error: ownershipError, requiresCleanupAfterError: true },
      { result: autoResult(workerText('COMPLETED'), { transport }) },
    );
    await session.start();

    await expect(session.runTurn({ prompt: 'owned turn' })).rejects.toBe(ownershipError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    expect(fake.runCalls).toBe(1);
    expect(events.map((event) => event.eventType).filter((type) => type === executionStartedType)).toHaveLength(1);
    expect(events.map((event) => event.eventType).filter(isExecutionTerminal)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
    ]);
    const eventCount = events.length;

    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(1);
    expect(fake.prompts).toHaveLength(1);
    expect(events).toHaveLength(eventCount);

    fake.shutdownError = cleanupError;
    await expect(session.shutdown()).rejects.toBe(cleanupError);
    await expect(session.shutdown()).rejects.toBe(cleanupError);
    expect(session.started).toBe(false);
    expect(fake.shutdownCalls).toBe(2);
    await expect(session.runTurn({ prompt: 'still blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });

    fake.shutdownError = undefined;
    await session.shutdown();
    await session.start();
    await expect(session.runRevision({ prompt: 'after cleanup' })).resolves.toMatchObject({ protocolValid: true });
    expect(fake.shutdownCalls).toBe(3);
    expect(fake.startCalls).toBe(2);
    expect(fake.runCalls).toBe(2);
    expect(session.started).toBe(true);
  });

  it('uses Auto lifecycle truth for a generic start failure', async () => {
    const error = new ClaudeAutoError('CLAUDE_AUTO_TURN_FAILED', 'fatal start failure');
    const { session, fake } = createFakeSession();
    fake.startError = error;
    fake.requiresCleanup = true;

    await expect(session.start()).rejects.toBe(error);
    expect(session.started).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED',
    });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);

    fake.startError = undefined;
    await session.shutdown();
    await session.start();
    expect(session.started).toBe(true);
    await session.shutdown();
  });

  it('sets turn ownership dirty state before failure-event mapping can throw', async () => {
    const ownershipError = new ClaudeAutoError(
      'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED', 'owned', 'persistent-stream', 'session-A', 'ambiguous',
    );
    const mapperError = new Error('failure mapper failed');
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === executionFailedType) throw mapperError;
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({ error: ownershipError, requiresCleanupAfterError: true });
    await session.start();

    await expect(session.runTurn({ prompt: 'owned turn' })).rejects.toBe(mapperError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('keeps ownership dirty when raw mapping and an ownership-unresolved turn fail together', async () => {
    const rawMapperError = new Error('raw mapper failed');
    const ownershipError = new ClaudeAutoError(
      'CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED', 'owned', 'resume-per-turn', 'session-A', 'ambiguous',
    );
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.eventType === providerObservedType) throw rawMapperError;
    });
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({ raw: [rawInit()], error: ownershipError, requiresCleanupAfterError: true });
    await session.start();

    await expect(session.runTurn({ prompt: 'owned turn' })).rejects.toBe(ownershipError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    await expect(session.runRevision({ prompt: 'blocked' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.runCalls).toBe(1);
    await session.shutdown();
  });

  it('reflects Auto session identity after transport failure without synthesizing one', async () => {
    const error = new ClaudeAutoError(
      'CLAUDE_AUTO_TURN_FAILED', 'failed', 'resume-per-turn', 'confirmed-session', 'ambiguous',
    );
    const { session, fake, events } = createFakeSession();
    fake.selectedTransport = 'resume-per-turn';
    fake.sessionId = 'confirmed-session';
    fake.turns.push({ error });
    await session.start();
    await expect(session.runTurn({ prompt: 'x' })).rejects.toBe(error);
    expect(session.sessionId).toBe('confirmed-session');
    expect(events.at(-1)?.payload).toMatchObject({ transport: 'resume-per-turn', sessionId: 'confirmed-session' });
  });

  it('does not parse after a transport failure', async () => {
    const parser = new AgentHubWorkerResultParser();
    let parseCalls = 0;
    parser.parse = (text) => { parseCalls += 1; return new AgentHubWorkerResultParser().parse(text); };
    const { session, fake } = createFakeSession({ resultParser: parser });
    fake.turns.push({ error: new Error('transport') });
    await session.start();
    await expect(session.runTurn({ prompt: 'x' })).rejects.toThrow('transport');
    expect(parseCalls).toBe(0);
  });

  it('passes the exact transport result text once to an injected parser', async () => {
    const parser = new AgentHubWorkerResultParser();
    const seen: string[] = [];
    const originalParse = parser.parse.bind(parser);
    parser.parse = (text) => { seen.push(text); return originalParse(text); };
    const { session, fake } = createFakeSession({ resultParser: parser });
    const text = workerText('COMPLETED');
    fake.turns.push({ result: autoResult(text) });
    await session.start();
    await session.runTurn({ prompt: 'x' });
    expect(seen).toEqual([text]);
  });

  it('guards the whole integration pipeline and releases after transport, parser, and mapper failures', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { session, fake } = createFakeSession();
    fake.turns.push({ wait, result: autoResult(workerText('COMPLETED')) });
    await session.start();
    const first = session.runTurn({ prompt: 'one' });
    await expect(session.runRevision({ prompt: 'two' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_TURN_ALREADY_ACTIVE' });
    release();
    await first;
    expect(session.active).toBe(false);

    const transportError = new Error('transport');
    fake.turns.push({ error: transportError });
    await expect(session.runTurn({ prompt: 'three' })).rejects.toBe(transportError);
    expect(session.active).toBe(false);

    const parserError = new Error('parser');
    const parser = new AgentHubWorkerResultParser();
    parser.parse = () => { throw parserError; };
    const parsed = createFakeSession({ resultParser: parser });
    await parsed.session.start();
    await expect(parsed.session.runTurn({ prompt: 'four' })).rejects.toBe(parserError);
    expect(parsed.session.active).toBe(false);
    await parsed.session.shutdown();
    expect(parsed.session.started).toBe(false);
    expect(parsed.session.active).toBe(false);

    const bus = new EventBus();
    let publishCount = 0;
    bus.subscribe(() => { publishCount += 1; if (publishCount === 2) throw new Error('mapper'); });
    const mapped = createFakeSession({ eventBus: bus });
    await mapped.session.start();
    await expect(mapped.session.runTurn({ prompt: 'five' })).rejects.toThrow('mapper');
    expect(mapped.session.active).toBe(false);
    await mapped.session.shutdown();
    expect(mapped.session.started).toBe(false);
    expect(mapped.session.active).toBe(false);
  });

  it('quarantines an idle Session after lower shutdown failure until an explicit retry succeeds', async () => {
    const { session, fake, events } = createFakeSession();
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(1);
    expect(events).toEqual([]);
    await session.start();
    const error = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'shutdown failed');
    fake.shutdownError = error;
    await expect(session.shutdown()).rejects.toBe(error);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    expect(fake.requiresCleanup).toBe(false);
    const startCalls = fake.startCalls;
    const runCalls = fake.runCalls;
    const eventCount = events.length;
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(startCalls);
    expect(fake.runCalls).toBe(runCalls);
    expect(events).toHaveLength(eventCount);
    expect(events.filter((event) => event.eventType === executionStartedType)).toEqual([]);

    fake.shutdownError = undefined;
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(3);
    expect(session.started).toBe(false);
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(startCalls + 1);
  });

  it('quarantines a failed shutdown when the lower Auto also reports cleanup ownership', async () => {
    const { session, fake } = createFakeSession();
    await session.start();
    const error = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'live child remains');
    fake.requiresCleanup = true;
    fake.shutdownError = error;

    await expect(session.shutdown()).rejects.toBe(error);
    expect(session.started).toBe(false);
    expect(fake.requiresCleanup).toBe(true);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });

    fake.shutdownError = undefined;
    await session.shutdown();
    expect(fake.requiresCleanup).toBe(false);
    await session.start();
    expect(session.started).toBe(true);
  });

  it('serializes shutdown behind a successful start without resurrecting session state', async () => {
    const startBarrier = deferred();
    const { session, fake } = createFakeSession();
    fake.start = async () => {
      fake.startCalls += 1;
      await startBarrier.promise;
    };

    const start = session.start();
    const shutdown = session.shutdown();
    await Promise.resolve();
    expect(fake.startCalls).toBe(1);
    expect(fake.shutdownCalls).toBe(0);
    startBarrier.resolve();
    await start;
    await shutdown;

    expect(fake.shutdownCalls).toBe(1);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
  });

  it('continues shutdown after a concurrent start failure and permits a clean restart', async () => {
    const startBarrier = deferred();
    const startError = new Error('start failed');
    const { session, fake } = createFakeSession();
    fake.start = async () => {
      fake.startCalls += 1;
      await startBarrier.promise;
      throw startError;
    };

    const start = session.start();
    const shutdown = session.shutdown();
    startBarrier.resolve();
    await expect(start).rejects.toBe(startError);
    await shutdown;
    expect(fake.shutdownCalls).toBe(1);
    expect(session.started).toBe(false);

    fake.start = FakeAuto.prototype.start.bind(fake);
    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(2);
  });

  it('shares one concurrent shutdown operation and clears ownership for a later idle shutdown', async () => {
    const shutdownBarrier = deferred();
    const { session, fake } = createFakeSession();
    fake.shutdown = async () => {
      fake.shutdownCalls += 1;
      await shutdownBarrier.promise;
    };
    await session.start();

    const first = session.shutdown();
    const second = session.shutdown();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fake.shutdownCalls).toBe(1);
    shutdownBarrier.resolve();
    await Promise.all([first, second]);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);

    fake.shutdown = FakeAuto.prototype.shutdown.bind(fake);
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(2);

    await session.start();
    expect(session.started).toBe(true);
    expect(fake.startCalls).toBe(2);
    await session.shutdown();
  });

  it('shares a concurrent shutdown failure, quarantines locally, and retries the same Auto once', async () => {
    const shutdownBarrier = deferred();
    const shutdownError = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'shutdown failed');
    const { session, fake, events } = createFakeSession();
    fake.shutdown = async () => {
      fake.shutdownCalls += 1;
      await shutdownBarrier.promise;
      throw shutdownError;
    };
    await session.start();

    const first = session.shutdown();
    const second = session.shutdown();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fake.shutdownCalls).toBe(1);
    shutdownBarrier.resolve();
    await expect(first).rejects.toBe(shutdownError);
    await expect(second).rejects.toBe(shutdownError);
    expect(session.started).toBe(false);
    expect(fake.requiresCleanup).toBe(false);
    const eventCount = events.length;
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);
    expect(events).toHaveLength(eventCount);

    fake.shutdown = FakeAuto.prototype.shutdown.bind(fake);
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(2);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    await session.start();
    expect(fake.startCalls).toBe(2);
  });

  it('blocks start, turn, and revision locally while shutdown is in progress', async () => {
    const shutdownBarrier = deferred();
    const { session, fake, events } = createFakeSession();
    fake.shutdown = async () => {
      fake.shutdownCalls += 1;
      await shutdownBarrier.promise;
    };
    await session.start();
    const eventCount = events.length;
    const shutdown = session.shutdown();

    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY' });
    await expect(session.runTurn({ prompt: 'blocked turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY' });
    await expect(session.runRevision({ prompt: 'blocked revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_LIFECYCLE_BUSY' });
    await Promise.resolve();
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(0);
    expect(events).toHaveLength(eventCount);

    shutdownBarrier.resolve();
    await shutdown;
  });

  it('waits for the complete Session turn pipeline before successful shutdown resolves', async () => {
    const turnBarrier = deferred();
    const { session, fake, events } = createFakeSession();
    fake.turns.push({ wait: turnBarrier.promise, result: autoResult(workerText('COMPLETED')) });
    await session.start();
    const turn = session.runTurn({ prompt: 'active' });
    const shutdown = session.shutdown();
    let shutdownSettled = false;
    void shutdown.finally(() => { shutdownSettled = true; });

    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(session.active).toBe(true);
    turnBarrier.resolve();
    await expect(turn).resolves.toMatchObject({ protocolValid: true });
    await shutdown;
    const eventCountAtShutdown = events.length;

    expect(session.active).toBe(false);
    expect(session.started).toBe(false);
    await Promise.resolve();
    expect(events).toHaveLength(eventCountAtShutdown);
  });

  it('quarantines immediately when active-turn shutdown fails and keeps dirty state after turn settles', async () => {
    const turnBarrier = deferred();
    const shutdownError = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'shutdown failed');
    const { session, fake, events } = createFakeSession();
    fake.turns.push({ wait: turnBarrier.promise, error: new Error('stopped on retry') });
    await session.start();
    const turn = session.runTurn({ prompt: 'active' });
    fake.shutdownError = shutdownError;

    await expect(session.shutdown()).rejects.toBe(shutdownError);
    expect(session.started).toBe(false);
    expect(session.active).toBe(true);
    expect(fake.shutdownCalls).toBe(1);
    const eventCount = events.length;
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runTurn({ prompt: 'blocked turn' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    await expect(session.runRevision({ prompt: 'blocked revision' })).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });
    expect(fake.startCalls).toBe(1);
    expect(fake.runCalls).toBe(1);
    expect(events).toHaveLength(eventCount);

    turnBarrier.resolve();
    await expect(turn).rejects.toThrow('stopped on retry');
    expect(session.active).toBe(false);
    await expect(session.start()).rejects.toMatchObject({ code: 'CLAUDE_WORKER_SESSION_CLEANUP_REQUIRED' });

    fake.shutdownError = undefined;
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(2);
    expect(session.started).toBe(false);
    expect(session.active).toBe(false);
    await session.start();
    expect(session.started).toBe(true);
  });

  it('registers the active turn before synchronous execution-start observers can request shutdown', async () => {
    const turnBarrier = deferred();
    const eventBus = new EventBus();
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({ wait: turnBarrier.promise, error: new Error('observer shutdown') });
    let shutdown: Promise<void> | undefined;
    eventBus.subscribe((event) => {
      if (event.eventType === executionStartedType) shutdown = session.shutdown();
    });
    await session.start();

    const turn = session.runTurn({ prompt: 'active' });
    await Promise.resolve();
    expect(shutdown).toBeDefined();
    let shutdownSettled = false;
    void shutdown?.finally(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    turnBarrier.resolve();

    await expect(turn).rejects.toThrow('observer shutdown');
    await shutdown;
    expect(session.active).toBe(false);
    expect(session.started).toBe(false);
    expect(fake.shutdownCalls).toBe(1);
  });

  it('delegates shutdown during an active turn to the same Auto instance and releases the guard', async () => {
    let rejectTurn!: (error: Error) => void;
    const turnWait = new Promise<void>((_resolve, reject) => { rejectTurn = reject; });
    const { session, fake } = createFakeSession();
    fake.turns.push({ wait: turnWait });
    fake.shutdown = () => {
      fake.shutdownCalls += 1;
      rejectTurn(new Error('stopped by shutdown'));
      return Promise.resolve();
    };
    await session.start();
    const turn = session.runTurn({ prompt: 'active' });
    await session.shutdown();
    await expect(turn).rejects.toThrow('stopped by shutdown');
    expect(fake.shutdownCalls).toBe(1);
    expect(session.active).toBe(false);
    expect(session.started).toBe(false);
  });

  it('does not persist prompt, raw result, or WorkerResult claims through EventStore/SQLite', async () => {
    const database = new Database(':memory:');
    database.initialize();
    const eventBus = new EventBus();
    const store = new EventStore(new SqliteEventRepository(database), eventBus);
    const sentinels = [
      'PRIVATE_TASK_PROMPT_SENTINEL', 'PRIVATE_RAW_RESULT_SENTINEL', 'PRIVATE_SUMMARY_SENTINEL',
      'PRIVATE_PATH_SENTINEL', 'PRIVATE_CHECK_SENTINEL', 'PRIVATE_QUESTION_SENTINEL',
    ];
    const { session, fake } = createFakeSession({ eventBus });
    fake.turns.push({
      raw: [rawResult('PRIVATE_RAW_RESULT_SENTINEL')],
      result: autoResult(workerText('NEEDS_INPUT', {
        summary: 'PRIVATE_SUMMARY_SENTINEL', changedFiles: ['PRIVATE_PATH_SENTINEL'],
        checks: [{ name: 'PRIVATE_CHECK_SENTINEL', status: 'PASSED', detail: 'private' }],
        questions: ['PRIVATE_QUESTION_SENTINEL'],
      })),
    });
    try {
      await session.start();
      const result = await session.runTurn({ prompt: 'PRIVATE_TASK_PROMPT_SENTINEL' });
      expect(result.protocolValid).toBe(true);
      const persisted = JSON.stringify(store.list()) + JSON.stringify(database.connection.prepare('SELECT * FROM events').all());
      for (const sentinel of sentinels) expect(persisted).not.toContain(sentinel);
      expect(store.list().some((event) => event.eventType === inputRequiredType)).toBe(true);
    } finally {
      store.close();
      database.close();
    }
  });

  it('freezes context and exposes only safe result metadata, including fallback', async () => {
    const context = { provider: 'wrong', projectId: 'P1', agentId: 'A1', taskId: 'T1', assignmentId: 'AS1' };
    const fallback = {
      from: 'persistent-stream' as const, to: 'resume-per-turn' as const,
      reason: 'PERSISTENT_CAPABILITY_UNSUPPORTED' as const, currentPromptReplayed: false as const,
      occurredAt: '2026-09-12T00:00:00.000Z',
    };
    const { session, fake, events } = createFakeSession({ context });
    context.projectId = 'P2';
    fake.turns.push({ result: autoResult(workerText('COMPLETED'), { transport: 'resume-per-turn', fallback }) });
    await session.start();
    const result = await session.runTurn({ prompt: 'x' });
    expect(result).toMatchObject({ protocolValid: true, fallback, durationMs: 3, resultSubtype: 'success' });
    expect(result).not.toHaveProperty('resultText');
    expect(result).not.toHaveProperty('messageTypes');
    expect(events.every((event) => event.projectId === 'P1')).toBe(true);
  });

  it('uses a known initial session only as start-event metadata and never accepts per-turn identity', async () => {
    const { session, fake, events } = createFakeSession();
    fake.sessionId = 'initial-session';
    fake.turns.push({ result: autoResult(workerText('COMPLETED'), { sessionId: 'initial-session' }) });
    await session.start();
    await session.runTurn({ prompt: 'x' });
    expect(events[0]?.payload).toEqual({ provider: 'claude', sessionId: 'initial-session' });
    expect(fake.prompts).toHaveLength(1);
  });

  it('returns a cloned fallback metadata object that cannot mutate the lower result', async () => {
    const fallback = {
      from: 'persistent-stream' as const, to: 'resume-per-turn' as const,
      reason: 'PERSISTENT_START_FAILED' as const, currentPromptReplayed: false as const,
      occurredAt: '2026-09-12T00:00:00.000Z',
    };
    const lower = autoResult(workerText('COMPLETED'), { transport: 'resume-per-turn', fallback });
    const { session, fake } = createFakeSession();
    fake.turns.push({ result: lower });
    await session.start();
    const result = await session.runTurn({ prompt: 'x' });
    expect(result.fallback).not.toBe(lower.fallback);
    if (result.fallback !== undefined) result.fallback.occurredAt = 'changed';
    expect(lower.fallback?.occurredAt).toBe('2026-09-12T00:00:00.000Z');
  });

  it('emits strict two-turn chronology without a late first-turn terminal', async () => {
    const { session, fake, events } = createFakeSession();
    fake.turns.push(
      { raw: [rawResult('one')], result: autoResult(workerText('NEEDS_INPUT')) },
      { raw: [rawResult('two')], result: autoResult(workerText('COMPLETED')) },
    );
    await session.start();
    await session.runTurn({ prompt: 'one' });
    await session.runRevision({ prompt: 'two' });
    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_STARTED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
      AgentRuntimeEventType.AGENT_INPUT_REQUIRED,
      AgentRuntimeEventType.AGENT_EXECUTION_STARTED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
    ]);
  });
});

describe('Claude worker session actual-stack fixtures', () => {
  it('runs Auto Persistent with valid WorkerResult on one session and PID', async () => {
    const calls: ClaudeProcessManagerOptions[] = [];
    const session = createActualSession('persistent-worker-valid', report('supported'), calls);
    try {
      await session.start();
      const first = await session.runTurn({ prompt: 'first persistent' });
      const second = await session.runRevision({ prompt: 'second persistent' });
      expect(first).toMatchObject({ protocolValid: true, transport: 'persistent-stream', sessionId: 'persistent-session-A' });
      expect(second).toMatchObject({ protocolValid: true, transport: 'persistent-stream', sessionId: 'persistent-session-A' });
      expect(second.processId).toBe(first.processId);
      expect(calls).toHaveLength(1);
    } finally { await session.shutdown(); }
  });

  it('runs Auto Resume with valid WorkerResult and exact --resume continuity', async () => {
    const calls: ClaudeProcessManagerOptions[] = [];
    const session = createActualSession('worker-valid', report('unsupported'), calls);
    try {
      await session.start();
      const first = await session.runTurn({ prompt: 'first resume' });
      const second = await session.runRevision({ prompt: 'second resume' });
      expect(first).toMatchObject({ protocolValid: true, transport: 'resume-per-turn', sessionId: 'session-A' });
      expect(second).toMatchObject({ protocolValid: true, transport: 'resume-per-turn', sessionId: 'session-A' });
      expect(second.processId).not.toBe(first.processId);
      expect(readOption(calls[1]?.args ?? [], '--resume')).toBe('session-A');
      expect(calls).toHaveLength(2);
    } finally { await session.shutdown(); }
  });

  it('keeps actual Persistent alive after malformed output for explicit revision', async () => {
    const calls: ClaudeProcessManagerOptions[] = [];
    const session = createActualSession('persistent-worker-malformed-then-valid', report('supported'), calls);
    try {
      await session.start();
      const first = await session.runTurn({ prompt: 'malformed' });
      const second = await session.runRevision({ prompt: 'correct it' });
      expect(first).toMatchObject({ protocolValid: false, failure: { kind: 'malformed_json' }, sessionId: 'persistent-session-A' });
      expect(second).toMatchObject({ protocolValid: true, sessionId: 'persistent-session-A' });
      expect(second.processId).toBe(first.processId);
      expect(calls).toHaveLength(1);
    } finally { await session.shutdown(); }
  });

  it('keeps actual Resume continuity from NEEDS_INPUT to explicit completed revision', async () => {
    const calls: ClaudeProcessManagerOptions[] = [];
    const session = createActualSession('worker-needs-input-then-valid', report('unsupported'), calls);
    try {
      await session.start();
      const first = await session.runTurn({ prompt: 'need input' });
      const second = await session.runRevision({ prompt: 'answer supplied' });
      expect(first.protocolValid && first.workerResult.outcome).toBe('NEEDS_INPUT');
      expect(second.protocolValid && second.workerResult.outcome).toBe('COMPLETED');
      expect(second.sessionId).toBe(first.sessionId);
      expect(readOption(calls[1]?.args ?? [], '--resume')).toBe(first.sessionId);
      expect(calls).toHaveLength(2);
    } finally { await session.shutdown(); }
  });
});

function createFakeSession(options: {
  eventBus?: EventBus;
  context?: { provider: string; projectId?: string; agentId?: string; taskId?: string; assignmentId?: string };
  onRawMessage?: (message: ClaudeRawMessage) => void;
  resultParser?: AgentHubWorkerResultParser;
} = {}): { session: ClaudeWorkerSession; fake: FakeAuto; events: DomainEvent[] } {
  const eventBus = options.eventBus ?? new EventBus();
  const events: DomainEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  let fake!: FakeAuto;
  const session = new ClaudeWorkerSession({
    eventBus,
    context: options.context ?? { provider: 'claude' },
    ...(options.onRawMessage === undefined ? {} : { onRawMessage: options.onRawMessage }),
    ...(options.resultParser === undefined ? {} : { resultParser: options.resultParser }),
    transportFactory: (transportOptions) => {
      fake = new FakeAuto(transportOptions);
      return fake as unknown as ClaudeAutoTransport;
    },
  });
  return { session, fake, events };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function autoResult(resultText: string, overrides: Partial<ClaudeAutoTurnResult> = {}): ClaudeAutoTurnResult {
  return {
    transport: 'persistent-stream', sessionId: 'session-A', resultText,
    messageTypes: ['system', 'assistant', 'result'], durationMs: 3, processId: 41,
    resultSubtype: 'success', isError: false, ...overrides,
  };
}

function workerText(outcome: AgentHubWorkerOutcome, overrides: Partial<AgentHubWorkerResult> = {}): string {
  const result: AgentHubWorkerResult = {
    protocolVersion: 1, outcome, summary: `summary-${outcome}`, changedFiles: [], checks: [],
    blockers: outcome === 'BLOCKED' ? ['blocked'] : [],
    questions: outcome === 'NEEDS_INPUT' ? ['question'] : [], risks: [], notes: [], ...overrides,
  };
  return `<AGENTHUB_RESULT>${JSON.stringify(result)}</AGENTHUB_RESULT>`;
}

function protocolFailures(): { kind: AgentHubWorkerResultFailureKind; text: string }[] {
  return [
    { kind: 'missing_result', text: 'none' },
    { kind: 'multiple_results', text: `${workerText('COMPLETED')}${workerText('COMPLETED')}` },
    { kind: 'result_too_large', text: 'x'.repeat(agentHubWorkerResultLimits.maxResponseChars + 1) },
    { kind: 'malformed_json', text: '<AGENTHUB_RESULT>{bad}</AGENTHUB_RESULT>' },
    { kind: 'schema_invalid', text: '<AGENTHUB_RESULT>{"protocolVersion":1}</AGENTHUB_RESULT>' },
    { kind: 'semantic_invalid', text: workerText('COMPLETED', { blockers: ['not allowed'] }) },
  ];
}

function rawInit(): ClaudeRawMessage {
  return { type: 'system', subtype: 'init', session_id: 'session-A' };
}

function rawResult(result: string): ClaudeRawMessage {
  return { type: 'result', subtype: 'success', session_id: 'session-A', result };
}

function isExecutionTerminal(type: string): boolean {
  return executionTerminalTypes.has(type);
}

const executionTerminalTypes = new Set<string>([
  AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
  AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
]);
const executionStartedType: string = AgentRuntimeEventType.AGENT_EXECUTION_STARTED;
const executionFailedType: string = AgentRuntimeEventType.AGENT_EXECUTION_FAILED;
const providerObservedType: string = AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED;
const inputRequiredType: string = AgentRuntimeEventType.AGENT_INPUT_REQUIRED;

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

function createActualSession(
  scenario: string,
  capabilityReport: ClaudeCapabilityReport,
  calls: ClaudeProcessManagerOptions[],
  eventBus = new EventBus(),
): ClaudeWorkerSession {
  return new ClaudeWorkerSession({
    eventBus, context: { provider: 'claude' },
    transportOptions: {
      capabilityReport, defaultTimeoutMs: 2_000, stopTimeoutMs: 2_000,
      persistentFactory: (options) => new ClaudePersistentStreamTransport({
        ...options, processFactory: fixtureFactory(scenario, calls),
      }),
      resumeFactory: (options) => new ClaudeResumePerTurnTransport({
        ...options, processFactory: fixtureFactory(scenario, calls),
      }),
    },
  });
}

function fixtureFactory(scenario: string, calls: ClaudeProcessManagerOptions[]) {
  return (options: ClaudeProcessManagerOptions): ClaudeProcessManager => {
    calls.push(options);
    return new ClaudeProcessManager({
      command: process.execPath, args: [fixturePath, scenario, ...(options.args ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }), stopTimeoutMs: 2_000,
    });
  };
}

function report(persistentState: 'supported' | 'unsupported'): ClaudeCapabilityReport {
  const checks = claudeCapabilityNames.map((capability) => {
    const unsupported = capability === 'inputStreamJson' && persistentState === 'unsupported';
    const evidence: ClaudeCapabilityEvidence = unsupported ? 'unsupported' : 'help';
    return { capability, supported: !unsupported, evidence };
  });
  const capabilities = Object.fromEntries(checks.map((check) => [check.capability, check.supported])) as Record<ClaudeCapabilityName, boolean>;
  return {
    ok: true,
    capabilities: { ...capabilities, executablePath: 'claude', executableResolved: true, executableExists: true, installed: true, platform: process.platform, authStatusAvailable: false },
    missingRequiredCapabilities: [], unknownCapabilities: [],
    unsupportedCapabilities: checks.filter((check) => !check.supported).map((check) => check.capability),
    checks, diagnostics: [],
  };
}

class LifecyclePersistentStub {
  public running = false;
  public active = false;
  public readonly prompts: string[] = [];
  public constructor(public lastSessionId?: string) {}

  public start(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }

  public runTurn(request: { prompt: string }): Promise<never> {
    this.prompts.push(request.prompt);
    this.running = false;
    return Promise.reject(Object.assign(new Error('persistent turn failed'), {
      code: 'CLAUDE_PERSISTENT_TURN_TIMEOUT',
    }));
  }

  public shutdown(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }
}

class LifecycleResumeStub {
  public running = false;
  public active = false;
  public readonly requests: { prompt: string; sessionId?: string }[] = [];

  public runTurn(request: { prompt: string; sessionId?: string }): Promise<ClaudeAutoTurnResult> {
    this.requests.push({ ...request });
    return Promise.resolve(autoResult(workerText('COMPLETED'), {
      transport: 'resume-per-turn',
      sessionId: request.sessionId ?? 'session-A',
    }));
  }

  public shutdown(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }
}

function createLifecycleSession(
  persistent: LifecyclePersistentStub,
  resume: LifecycleResumeStub,
): { session: ClaudeWorkerSession; events: DomainEvent[] } {
  const eventBus = new EventBus();
  const events: DomainEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const session = new ClaudeWorkerSession({
    eventBus,
    context: { provider: 'claude' },
    transportOptions: {
      capabilityReport: report('supported'),
      persistentFactory: () => persistent as unknown as ClaudePersistentStreamTransport,
      resumeFactory: () => resume as unknown as ClaudeResumePerTurnTransport,
    },
  });
  return { session, events };
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
