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
}

class FakeAuto {
  public selectedTransport: 'persistent-stream' | 'resume-per-turn' | undefined = 'persistent-stream';
  public sessionId: string | undefined;
  public active = false;
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
      if (turn.error !== undefined) throw turn.error;
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
  });

  it('preserves transport error identity, maps safe metadata, and never replays', async () => {
    const error = new ClaudeAutoError(
      'CLAUDE_AUTO_TURN_FAILED', 'safe transport message', 'persistent-stream', 'session-A', 'ambiguous',
    );
    const { session, fake, events } = createFakeSession();
    fake.sessionId = 'session-A';
    fake.turns.push({ error });
    await session.start();
    let caught: unknown;
    try { await session.runTurn({ prompt: 'PRIVATE_PROMPT' }); } catch (value) { caught = value; }
    expect(caught).toBe(error);
    expect(fake.runCalls).toBe(1);
    expect(session.active).toBe(false);
    expect(events.map((event) => event.eventType).filter(isExecutionTerminal)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_PROMPT');
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

    const bus = new EventBus();
    let publishCount = 0;
    bus.subscribe(() => { publishCount += 1; if (publishCount === 2) throw new Error('mapper'); });
    const mapped = createFakeSession({ eventBus: bus });
    await mapped.session.start();
    await expect(mapped.session.runTurn({ prompt: 'five' })).rejects.toThrow('mapper');
    expect(mapped.session.active).toBe(false);
  });

  it('delegates idle shutdown idempotently and preserves retry on lower failure', async () => {
    const { session, fake, events } = createFakeSession();
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(1);
    expect(events).toEqual([]);
    await session.start();
    const error = new ClaudeAutoError('CLAUDE_AUTO_SHUTDOWN_FAILED', 'shutdown failed');
    fake.shutdownError = error;
    await expect(session.shutdown()).rejects.toBe(error);
    expect(session.started).toBe(true);
    fake.shutdownError = undefined;
    await session.shutdown();
    expect(fake.shutdownCalls).toBe(3);
    expect(session.started).toBe(false);
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

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
