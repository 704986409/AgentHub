import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeEventType,
  ClaudeEventMapper,
  Database,
  EventBus,
  EventStore,
  SqliteEventRepository,
  type AgentHubWorkerResult,
  type AgentHubWorkerResultFailureKind,
  type AgentRuntimeContext,
  type DomainEvent,
} from '../src/index.js';

const failureKinds: readonly AgentHubWorkerResultFailureKind[] = [
  'missing_result',
  'multiple_results',
  'result_too_large',
  'malformed_json',
  'schema_invalid',
  'semantic_invalid',
];

const privacySentinels = [
  'PRIVATE_PROMPT_SENTINEL',
  'PRIVATE_ASSISTANT_SENTINEL',
  'PRIVATE_THINKING_SENTINEL',
  'PRIVATE_TOOL_INPUT_SENTINEL',
  'PRIVATE_TOOL_OUTPUT_SENTINEL',
  'PRIVATE_RESULT_SENTINEL',
  'PRIVATE_ERROR_SENTINEL',
  'PRIVATE_CWD_SENTINEL',
  'PRIVATE_MCP_SENTINEL',
  'PRIVATE_APIKEY_SENTINEL',
  'PRIVATE_WORKER_SUMMARY_SENTINEL',
  'PRIVATE_WORKER_PATH_SENTINEL',
  'PRIVATE_WORKER_CHECK_SENTINEL',
] as const;

describe('Claude event mapper', () => {
  it('maps explicit execution start with a frozen Claude context', () => {
    const context: AgentRuntimeContext = {
      provider: 'wrong-provider',
      projectId: 'P1',
      agentId: 'A1',
      taskId: 'T1',
      assignmentId: 'AS1',
    };
    const { mapper, events } = createMapper(context);
    context.provider = 'mutated';
    context.projectId = 'P2';
    context.agentId = 'A2';

    mapper.observeExecutionStarted({ transport: 'persistent-stream', sessionId: 'session-1', processId: 42 });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: AgentRuntimeEventType.AGENT_EXECUTION_STARTED,
      projectId: 'P1',
      agentId: 'A1',
      taskId: 'T1',
      assignmentId: 'AS1',
      actor: 'A1',
      payload: { provider: 'claude', transport: 'persistent-stream', sessionId: 'session-1', processId: 42 },
    });
  });

  it('maps system init through a strict safe metadata allowlist', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      model: 'claude-test',
      claude_code_version: '1.2.3',
      permissionMode: 'default',
      cwd: 'PRIVATE_CWD_SENTINEL',
      tools: [{ input: 'PRIVATE_TOOL_INPUT_SENTINEL' }],
      mcp_servers: [{ name: 'PRIVATE_MCP_SENTINEL' }],
      apiKeySource: 'PRIVATE_APIKEY_SENTINEL',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      payload: {
        provider: 'claude', sourceType: 'system', subtype: 'init', sessionId: 'session-1',
        model: 'claude-test', claudeCodeVersion: '1.2.3', permissionMode: 'default',
      },
    });
    expectSerialized(events).not.toContainAny(['PRIVATE_CWD_SENTINEL', 'PRIVATE_TOOL_INPUT_SENTINEL', 'PRIVATE_MCP_SENTINEL', 'PRIVATE_APIKEY_SENTINEL']);
  });

  it('maps api retries to runtime errors and other system frames to observations', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({ type: 'system', subtype: 'api_retry', session_id: 's1', attempt: 2, retry_count: 1, error: 'PRIVATE_ERROR_SENTINEL' });
    mapper.observeRawMessage({ type: 'system', subtype: 'status', session_id: 's1', message: 'PRIVATE_ASSISTANT_SENTINEL' });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
    ]);
    expect(events[0]?.payload).toEqual({ provider: 'claude', sourceType: 'system', subtype: 'api_retry', sessionId: 's1', willRetry: true, attempt: 2, retryCount: 1 });
    expectSerialized(events).not.toContainAny(['PRIVATE_ERROR_SENTINEL', 'PRIVATE_ASSISTANT_SENTINEL']);
  });

  it('maps assistant text and tool use in deterministic content order without private content', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({
      type: 'assistant',
      session_id: 's1',
      message: {
        id: 'm1',
        model: 'claude-test',
        content: [
          { type: 'text', text: 'PRIVATE_ASSISTANT_SENTINEL' },
          { type: 'thinking', thinking: 'PRIVATE_THINKING_SENTINEL', signature: 'secret-signature' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { command: 'PRIVATE_TOOL_INPUT_SENTINEL' } },
          { type: 'text', text: 'okay' },
          { type: 'future_block', content: 'future-private' },
          { type: 'tool_use', id: 'tool-2', name: 'Write', input: { token: 'private-token' } },
        ],
      },
    });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_OPERATION_STARTED,
      AgentRuntimeEventType.AGENT_OPERATION_STARTED,
      AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED,
    ]);
    expect(events[0]?.payload).toMatchObject({ provider: 'claude', sourceType: 'assistant', messageId: 'm1', operationType: 'tool_use', toolUseId: 'tool-1', toolName: 'Read' });
    expect(events[1]?.payload).toMatchObject({ toolUseId: 'tool-2', toolName: 'Write' });
    expect(events[2]?.payload).toMatchObject({ textLength: 'PRIVATE_ASSISTANT_SENTINEL'.length + 4, textBlockCount: 2, contentBlockCount: 6, unknownBlockCount: 2 });
    expectSerialized(events).not.toContainAny(['PRIVATE_ASSISTANT_SENTINEL', 'PRIVATE_THINKING_SENTINEL', 'PRIVATE_TOOL_INPUT_SENTINEL', 'secret-signature', 'future-private', 'private-token']);
  });

  it('maps thinking-only frames to safe observations and API-error assistant frames to runtime errors', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING_SENTINEL' }] } });
    mapper.observeRawMessage({ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-test', content: [{ type: 'text', text: 'PRIVATE_ERROR_SENTINEL' }] } });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
    ]);
    expect(events[0]?.payload).toMatchObject({ contentBlockCount: 1, unknownBlockCount: 1 });
    expect(events[1]?.payload).toMatchObject({ kind: 'api_error_message', model: 'claude-test' });
    expect(events.map((event) => event.eventType)).not.toContain(AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED);
    expectSerialized(events).not.toContainAny(['PRIVATE_THINKING_SENTINEL', 'PRIVATE_ERROR_SENTINEL']);
  });

  it('maps user tool results to completion events without tool output', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({
      type: 'user',
      session_id: 's1',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'PRIVATE_TOOL_OUTPUT_SENTINEL' },
        { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: [{ text: 'private-file-data' }] },
      ] },
    });
    mapper.observeRawMessage({ type: 'user', session_id: 's1', message: { content: [{ type: 'text', text: 'PRIVATE_PROMPT_SENTINEL' }] } });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
      AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
    ]);
    expect(events[0]?.payload).toMatchObject({ toolUseId: 'tool-1', status: 'completed' });
    expect(events[1]?.payload).toMatchObject({ toolUseId: 'tool-2', status: 'failed' });
    expectSerialized(events).not.toContainAny(['PRIVATE_TOOL_OUTPUT_SENTINEL', 'private-file-data', 'PRIVATE_PROMPT_SENTINEL']);
  });

  it('maps text deltas by JavaScript string length and leaves partial tool JSON as an observation', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '🔒x' } } });
    mapper.observeRawMessage({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: 'PRIVATE_TOOL_INPUT_SENTINEL' } } });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_MESSAGE_DELTA,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
    ]);
    expect(events[0]?.payload).toMatchObject({ textLength: '🔒x'.length, contentBlockIndex: 3 });
    expect(events[1]?.payload).toMatchObject({ streamEventType: 'content_block_delta' });
    expectSerialized(events).not.toContain('PRIVATE_TOOL_INPUT_SENTINEL');
  });

  it('maps raw result frames to observations only with safe scalar metrics', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({
      type: 'result', subtype: 'success', session_id: 's1', is_error: false,
      duration_ms: 100, duration_api_ms: 80, num_turns: 2, total_cost_usd: 0.25, stop_reason: 'end_turn',
      result: 'PRIVATE_RESULT_SENTINEL', error: 'PRIVATE_ERROR_SENTINEL',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      permission_denials: [{ tool_name: 'Read', tool_input: 'PRIVATE_TOOL_INPUT_SENTINEL' }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      payload: {
        provider: 'claude', sourceType: 'result', subtype: 'success', sessionId: 's1', isError: false,
        durationMs: 100, durationApiMs: 80, numTurns: 2, totalCostUsd: 0.25, stopReason: 'end_turn',
        inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
        permissionDenialCount: 1,
      },
    });
    expect(events.map((event) => event.eventType)).not.toEqual(expect.arrayContaining([
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
      AgentRuntimeEventType.AGENT_APPROVAL_REQUIRED,
    ]));
    expectSerialized(events).not.toContainAny(['PRIVATE_RESULT_SENTINEL', 'PRIVATE_ERROR_SENTINEL', 'PRIVATE_TOOL_INPUT_SENTINEL']);
  });

  it('keeps an error-shaped raw result provider-observed and non-terminal', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'PRIVATE_RESULT_SENTINEL',
      error: 'PRIVATE_ERROR_SENTINEL',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      payload: { provider: 'claude', sourceType: 'result', subtype: 'error_during_execution', isError: true },
    });
    expectSerialized(events).not.toContainAny(['PRIVATE_RESULT_SENTINEL', 'PRIVATE_ERROR_SENTINEL']);
  });
  it('maps rate-limit metadata and excludes malformed numeric values', () => {
    const { mapper, events } = createMapper();
    mapper.observeRawMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', type: 'tokens', resets_at: 123, is_using_overage: true, secret: 'PRIVATE_ERROR_SENTINEL' } });
    mapper.observeRawMessage({ type: 'result', duration_ms: Number.NaN, duration_api_ms: Number.POSITIVE_INFINITY, num_turns: 1.5, total_cost_usd: Number.NEGATIVE_INFINITY, usage: { input_tokens: Number.NaN } });

    expect(events[0]?.payload).toEqual({ provider: 'claude', sourceType: 'rate_limit_event', rateLimitStatus: 'allowed', rateLimitType: 'tokens', resetsAt: 123, isUsingOverage: true });
    expect(events[1]?.payload).toEqual({ provider: 'claude', sourceType: 'result' });
    expectSerialized(events).not.toContain('PRIVATE_ERROR_SENTINEL');
  });

  it('handles unknown, missing, wrong, and malformed shapes without throwing or leaking', () => {
    const { mapper, events } = createMapper();
    const messages = [
      { type: 'future_event', subtype: 'future_subtype', session_id: 's1', prompt: 'PRIVATE_PROMPT_SENTINEL', nested: { token: 'PRIVATE_ERROR_SENTINEL' } },
      {}, { type: null }, { type: 123 }, { type: [] },
      { type: 'assistant', message: null },
      { type: 'assistant', message: [] },
      { type: 'assistant', message: { content: null } },
      { type: 'assistant', message: { content: [null, 1, 'x'] } },
      { type: 'user', message: { content: {} } },
      { type: 'result', usage: 'bad' },
      { type: 'stream_event', event: null },
      { type: 'rate_limit_event', rate_limit_info: 'bad' },
    ];

    for (const message of messages) expect(() => mapper.observeRawMessage(message)).not.toThrow();
    expect(events).toHaveLength(messages.length);
    expect(events[0]?.payload).toEqual({ provider: 'claude', sourceType: 'future_event', subtype: 'future_subtype', sessionId: 's1' });
    expectSerialized(events).not.toContainAny(['PRIVATE_PROMPT_SENTINEL', 'PRIVATE_ERROR_SENTINEL']);
  });

  it('bounds provider-controlled metadata strings to 256 characters', () => {
    const { mapper, events } = createMapper();
    const long = 'x'.repeat(1_000);
    mapper.observeRawMessage({ type: 'assistant', session_id: long, message: { id: long, model: long, content: [{ type: 'tool_use', id: long, name: long, input: {} }] } });
    mapper.observeRawMessage({ type: long, subtype: long, session_id: long });

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      for (const value of Object.values(payload)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(256);
      }
    }
  });

  it.each([
    ['COMPLETED', AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED],
    ['FAILED', AgentRuntimeEventType.AGENT_EXECUTION_FAILED],
    ['BLOCKED', AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED],
  ] as const)('maps worker outcome %s to one terminal event', (outcome, eventType) => {
    const { mapper, events } = createMapper();
    mapper.observeWorkerResult(createWorkerResult(outcome), { transport: 'resume-per-turn', sessionId: 's1', processId: 8 });

    expect(events.map((event) => event.eventType)).toEqual([eventType]);
    expect(events[0]?.payload).toMatchObject({ provider: 'claude', workerOutcome: outcome, changedFileClaimCount: 1, checkClaimCount: 3, blockerCount: outcome === 'BLOCKED' ? 1 : 0 });
  });

  it('maps NEEDS_INPUT in exact completion-then-input order using aggregate claims only', () => {
    const { mapper, events } = createMapper();
    const result = createWorkerResult('NEEDS_INPUT');
    const original = structuredClone(result);
    mapper.observeWorkerResult(result, { sessionId: 's1' });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
      AgentRuntimeEventType.AGENT_INPUT_REQUIRED,
    ]);
    expect(events[0]?.payload).toMatchObject({ workerOutcome: 'NEEDS_INPUT', summaryLength: result.summary.length, questionCount: 1, passedCheckClaimCount: 1, failedCheckClaimCount: 1, notRunCheckClaimCount: 1 });
    expect(result).toEqual(original);
    expectSerialized(events).not.toContainAny(['PRIVATE_WORKER_SUMMARY_SENTINEL', 'PRIVATE_WORKER_PATH_SENTINEL', 'PRIVATE_WORKER_CHECK_SENTINEL', 'private-detail', 'private-question', 'private-risk', 'private-note']);
  });

  it.each(failureKinds)('maps worker protocol failure %s without its message', (kind) => {
    const { mapper, events } = createMapper();
    mapper.observeWorkerResultFailure({ kind, message: 'PRIVATE_ERROR_SENTINEL' }, { transport: 'persistent-stream', sessionId: 's1', processId: 7 });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
    ]);
    expect(events[0]?.payload).toEqual({ provider: 'claude', kind: 'worker_result_protocol', failureKind: kind, transport: 'persistent-stream', sessionId: 's1', processId: 7 });
    expectSerialized(events).not.toContain('PRIVATE_ERROR_SENTINEL');
  });

  it('maps execution and provider errors structurally without message, stack, or cause', () => {
    const { mapper, events } = createMapper();
    const error = Object.assign(new Error('PRIVATE_ERROR_SENTINEL'), {
      code: 'CLAUDE_PRIVATE_CODE',
      retrySafety: 'safe',
      cause: new Error('private-cause'),
    });
    mapper.observeExecutionFailure(error, { transport: 'resume-per-turn', processId: 9 });
    mapper.observeProviderError(error, 'protocol', { sessionId: 's1' });
    mapper.observeExecutionFailure('PRIVATE_ERROR_SENTINEL');

    expect(events[0]?.payload).toEqual({ provider: 'claude', transport: 'resume-per-turn', processId: 9, errorCode: 'CLAUDE_PRIVATE_CODE', errorName: 'Error', retrySafety: 'safe' });
    expect(events[1]?.payload).toEqual({ provider: 'claude', kind: 'protocol', sessionId: 's1', errorCode: 'CLAUDE_PRIVATE_CODE', errorName: 'Error' });
    expect(events[2]?.payload).toEqual({ provider: 'claude' });
    expectSerialized(events).not.toContainAny(['PRIVATE_ERROR_SENTINEL', 'private-cause']);
  });

  it('maps process exits with safe metadata only', () => {
    const { mapper, events } = createMapper();
    mapper.observeProcessExit({ transport: 'persistent-stream', sessionId: 's1', processId: 10, exitCode: 1, signal: 'SIGTERM', expected: false });

    expect(events[0]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_PROCESS_EXITED,
      payload: { provider: 'claude', transport: 'persistent-stream', sessionId: 's1', processId: 10, exitCode: 1, signal: 'SIGTERM', expected: false },
    });
  });

  it('persists only privacy-safe allowlisted metadata through EventStore and SQLite', () => {
    const database = new Database(':memory:');
    database.initialize();
    const eventBus = new EventBus();
    const eventStore = new EventStore(new SqliteEventRepository(database), eventBus);
    const mapper = new ClaudeEventMapper({ eventBus, context: { provider: 'claude' } });

    try {
      mapper.observeRawMessage({
        type: 'system', subtype: 'init', cwd: 'PRIVATE_CWD_SENTINEL',
        tools: ['PRIVATE_TOOL_INPUT_SENTINEL'], mcp_servers: ['PRIVATE_MCP_SENTINEL'],
        apiKeySource: 'PRIVATE_APIKEY_SENTINEL',
      });
      mapper.observeRawMessage({
        type: 'assistant',
        message: { content: [
          { type: 'text', text: 'PRIVATE_ASSISTANT_SENTINEL' },
          { type: 'thinking', thinking: 'PRIVATE_THINKING_SENTINEL' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { prompt: 'PRIVATE_PROMPT_SENTINEL' } },
        ] },
      });
      mapper.observeRawMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'PRIVATE_TOOL_OUTPUT_SENTINEL' }] },
      });
      mapper.observeRawMessage({
        type: 'result', result: 'PRIVATE_RESULT_SENTINEL', error: 'PRIVATE_ERROR_SENTINEL',
        permission_denials: [{ tool_input: 'PRIVATE_TOOL_INPUT_SENTINEL' }],
      });
      mapper.observeWorkerResult(createWorkerResult('NEEDS_INPUT'));
      mapper.observeExecutionFailure(new Error('PRIVATE_ERROR_SENTINEL'));

      const storedEvents = JSON.stringify(eventStore.list());
      const rawRows = database.connection.prepare('SELECT payload FROM events ORDER BY created_at, id').all();
      const rawPayloads = JSON.stringify(rawRows);
      for (const sentinel of privacySentinels) {
        expect(storedEvents, sentinel).not.toContain(sentinel);
        expect(rawPayloads, sentinel).not.toContain(sentinel);
      }
    } finally {
      eventStore.close();
      database.close();
    }
  });
  it('does not mutate raw messages', () => {
    const { mapper } = createMapper();
    const message = {
      type: 'assistant', session_id: 's1',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { secret: 'PRIVATE_TOOL_INPUT_SENTINEL' } }] },
    };
    const before = structuredClone(message);
    mapper.observeRawMessage(message);
    expect(message).toEqual(before);
  });
});

function createMapper(context: AgentRuntimeContext = { provider: 'claude' }): { mapper: ClaudeEventMapper; events: DomainEvent[] } {
  const eventBus = new EventBus();
  const events: DomainEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  return { mapper: new ClaudeEventMapper({ eventBus, context }), events };
}

function createWorkerResult(outcome: AgentHubWorkerResult['outcome']): AgentHubWorkerResult {
  return {
    protocolVersion: 1,
    outcome,
    summary: 'PRIVATE_WORKER_SUMMARY_SENTINEL',
    changedFiles: ['PRIVATE_WORKER_PATH_SENTINEL'],
    checks: [
      { name: 'PRIVATE_WORKER_CHECK_SENTINEL', status: 'PASSED', detail: 'private-detail' },
      { name: 'failed-check', status: 'FAILED', detail: 'private-detail' },
      { name: 'not-run-check', status: 'NOT_RUN', detail: 'private-detail' },
    ],
    blockers: outcome === 'BLOCKED' ? ['private-blocker'] : [],
    questions: outcome === 'NEEDS_INPUT' ? ['private-question'] : [],
    risks: ['private-risk'],
    notes: ['private-note'],
  };
}

function expectSerialized(value: unknown): ReturnType<typeof expect<string>> {
  const serialized = JSON.stringify(value);
  return expect(serialized);
}

declare module 'vitest' {
  interface Assertion<T> {
    toContainAny(values: readonly string[]): T;
  }
}

expect.extend({
  toContainAny(received: string, values: readonly string[]) {
    const found = values.filter((value) => received.includes(value));
    return {
      pass: found.length > 0,
      message: () => found.length > 0
        ? `Expected serialized value not to contain any sentinel, but found: ${found.join(', ')}`
        : 'Expected serialized value to contain at least one sentinel',
    };
  },
});
