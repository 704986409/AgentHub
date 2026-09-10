import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeEventType,
  CodexEventMapper,
  type CodexEventSource,
  type CodexNotificationHandler,
  type CodexProcessErrorHandler,
  type CodexProcessExitHandler,
  type CodexProtocolErrorHandler,
  type CodexServerRequest,
  type CodexServerRequestHandler,
  CodexProvider,
  Database,
  EventBus,
  EventStore,
  type DomainEvent,
  SqliteEventRepository,
} from '../src/index.js';

class FakeCodexEventSource implements CodexEventSource {
  readonly notifications = new Set<CodexNotificationHandler>();
  readonly serverRequests = new Set<CodexServerRequestHandler>();
  readonly protocolErrors = new Set<CodexProtocolErrorHandler>();
  readonly processExits = new Set<CodexProcessExitHandler>();
  readonly processErrors = new Set<CodexProcessErrorHandler>();

  public onNotification(handler: CodexNotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }
  public onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequests.add(handler);
    return () => this.serverRequests.delete(handler);
  }
  public onProtocolError(handler: CodexProtocolErrorHandler): () => void {
    this.protocolErrors.add(handler);
    return () => this.protocolErrors.delete(handler);
  }
  public onProcessExit(handler: CodexProcessExitHandler): () => void {
    this.processExits.add(handler);
    return () => this.processExits.delete(handler);
  }
  public onProcessError(handler: CodexProcessErrorHandler): () => void {
    this.processErrors.add(handler);
    return () => this.processErrors.delete(handler);
  }

  public notification(method: string, params: unknown): void {
    for (const handler of this.notifications) handler(method, params);
  }
  public serverRequest(request: CodexServerRequest): void {
    for (const handler of this.serverRequests) handler(request);
  }
  public protocolError(error: Error): void {
    for (const handler of this.protocolErrors) handler(error);
  }
  public processExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const handler of this.processExits) handler(code, signal);
  }
  public processError(error: Error): void {
    for (const handler of this.processErrors) handler(error);
  }
}

describe('Codex event mapper', () => {
  it('maps execution, message, operation, error, and unknown notifications once', () => {
    const { source, events } = createAttachedMapper();
    source.notification('turn/started', { threadId: 'th-1', turn: { id: 'tu-1' } });
    source.notification('turn/completed', { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } });
    source.notification('turn/completed', { threadId: 'th-1', turn: { id: 'tu-2', status: 'failed' } });
    source.notification('turn/completed', { threadId: 'th-1', turn: { id: 'tu-3', status: 'interrupted' } });
    source.notification('item/agentMessage/delta', {
      threadId: 'th-1', turnId: 'tu-1', itemId: 'msg-1', delta: 'private output', raw: { token: 'secret' },
    });
    source.notification('item/completed', {
      threadId: 'th-1', turnId: 'tu-1', item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'private output' },
    });
    source.notification('item/started', {
      threadId: 'th-1', turnId: 'tu-1', item: { id: 'op-1', type: 'commandExecution', command: 'private command' },
    });
    source.notification('item/completed', {
      threadId: 'th-1', turnId: 'tu-1', item: { id: 'op-1', type: 'commandExecution', status: 'completed', stdout: 'private stdout' },
    });
    source.notification('item/started', {
      threadId: 'th-1', turnId: 'tu-1', item: { id: 'reason-1', type: 'reasoning', content: ['private reasoning'] },
    });
    source.notification('item/completed', {
      threadId: 'th-1', turnId: 'tu-1', item: { id: 'future-item-1', type: 'futureItem', payload: 'private future payload' },
    });
    source.notification('error', {
      threadId: 'th-1', turnId: 'tu-1', willRetry: true, error: { codexErrorInfo: 'serverOverloaded', message: 'private error' },
    });
    source.notification('error', {
      threadId: 'th-1', turnId: 'tu-2', willRetry: false, error: { codexErrorInfo: { serverOverloaded: {} }, message: 'private error object' },
    });
    source.notification('future/newEvent', {
      threadId: 'th-1', turnId: 'tu-1', itemId: 'future-1', prompt: 'private prompt', nested: { apiKey: 'secret' },
    });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_STARTED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
      AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
      AgentRuntimeEventType.AGENT_MESSAGE_DELTA,
      AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED,
      AgentRuntimeEventType.AGENT_OPERATION_STARTED,
      AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
      AgentRuntimeEventType.AGENT_RUNTIME_ERROR,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
    ]);
    expect(events[0]).toMatchObject({
      projectId: 'P1', agentId: 'A1', taskId: 'T1', assignmentId: 'AS1', actor: 'A1',
      payload: { provider: 'codex', sourceMethod: 'turn/started', threadId: 'th-1', turnId: 'tu-1', sessionId: 'session-1' },
    });
    expect(events[4]?.payload).toEqual({
      provider: 'codex', sourceMethod: 'item/agentMessage/delta', threadId: 'th-1', turnId: 'tu-1', itemId: 'msg-1', sessionId: 'session-1', textLength: 14,
    });
    expect(events[5]?.payload).toMatchObject({ itemId: 'msg-1', phase: 'final_answer', textLength: 14 });
    expect(events[6]?.payload).toMatchObject({ itemId: 'op-1', operationType: 'commandExecution' });
    expect(events[8]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      payload: { itemId: 'reason-1', itemType: 'reasoning' },
    });
    expect(events[9]).toMatchObject({
      eventType: AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      payload: { itemId: 'future-item-1', itemType: 'futureItem' },
    });
    expect(events[10]?.payload).toMatchObject({ errorCode: 'serverOverloaded', willRetry: true });
    expect(events[11]?.payload).toMatchObject({ errorCode: 'serverOverloaded', willRetry: false });
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it.each([
    ['item/commandExecution/requestApproval', AgentRuntimeEventType.AGENT_APPROVAL_REQUIRED],
    ['item/fileChange/requestApproval', AgentRuntimeEventType.AGENT_APPROVAL_REQUIRED],
    ['item/permissions/requestApproval', AgentRuntimeEventType.AGENT_APPROVAL_REQUIRED],
    ['item/tool/requestUserInput', AgentRuntimeEventType.AGENT_INPUT_REQUIRED],
    ['mcpServer/elicitation/request', AgentRuntimeEventType.AGENT_INPUT_REQUIRED],
  ])('maps server request %s without consuming or mutating it', (method, expectedType) => {
    const { source, events } = createAttachedMapper();
    const request = {
      id: 'req-1', method, params: { threadId: 'th-1', turnId: 'tu-1', itemId: 'op-1', command: 'private' },
    } satisfies CodexServerRequest;
    let rawRequest: CodexServerRequest | undefined;
    source.onServerRequest((observed) => { rawRequest = observed; });
    source.serverRequest(request);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: expectedType,
      payload: { provider: 'codex', sourceMethod: method, requestId: 'req-1', threadId: 'th-1', turnId: 'tu-1', itemId: 'op-1' },
    });
    expect(rawRequest).toBe(request);
    expect(request.params).toHaveProperty('command', 'private');
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it.each(['commandExecution', 'fileChange', 'mcpToolCall', 'toolCall', 'dynamicToolCall', 'collabAgentToolCall'])(
    'maps the explicit operation item type %s',
    (itemType) => {
      const { source, events } = createAttachedMapper();
      source.notification('item/started', {
        threadId: 'th-1', turnId: 'tu-1', item: { id: 'op-1', type: itemType, arguments: 'private' },
      });
      source.notification('item/completed', {
        threadId: 'th-1', turnId: 'tu-1', item: { id: 'op-1', type: itemType, status: 'completed', result: 'private' },
      });
      expect(events.map((event) => event.eventType)).toEqual([
        AgentRuntimeEventType.AGENT_OPERATION_STARTED,
        AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
      ]);
      expect(events[0]?.payload).toMatchObject({ operationType: itemType });
      expect(JSON.stringify(events)).not.toContain('private');
    },
  );

  it('maps protocol/process failures and process exit to provider-neutral events', () => {
    const { source, events } = createAttachedMapper();
    source.protocolError(new Error('bad protocol'));
    source.processError(new Error('bad process'));
    source.processExit(7, 'SIGTERM');
    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.PROVIDER_ERROR,
      AgentRuntimeEventType.PROVIDER_ERROR,
      AgentRuntimeEventType.PROVIDER_PROCESS_EXITED,
    ]);
    expect(events[0]?.payload).toEqual({ provider: 'codex', kind: 'protocol', message: 'bad protocol' });
    expect(events[1]?.payload).toEqual({ provider: 'codex', kind: 'process', message: 'bad process' });
    expect(events[2]?.payload).toEqual({ provider: 'codex', exitCode: 7, signal: 'SIGTERM' });
  });

  it('persists only semantic metadata and classifies by the most specific context', () => {
    const database = new Database(':memory:');
    database.initialize();
    const bus = new EventBus();
    const store = new EventStore(new SqliteEventRepository(database), bus);
    const source = new FakeCodexEventSource();
    const mapper = new CodexEventMapper({
      eventBus: bus,
      source,
      context: { provider: 'codex' },
    });
    mapper.attach();
    source.notification('item/completed', {
      threadId: 'th-1',
      turnId: 'tu-1',
      item: {
        id: 'op-1', type: 'fileChange', status: 'completed', diff: 'PRIVATE DIFF',
        arguments: { authorization: 'Bearer persistent-secret' },
      },
    });

    const stored = store.list();
    const sqlitePayload = (database.connection.prepare('SELECT payload FROM events').get() as { payload: string }).payload;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      eventType: AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
      entityType: 'system',
      entityId: null,
      payload: { operationType: 'fileChange', status: 'completed' },
    });
    expect(sqlitePayload).not.toContain('PRIVATE DIFF');
    expect(sqlitePayload).not.toContain('persistent-secret');
    mapper.dispose();
    store.close();
    database.close();
  });

  it('uses only the semantic EventBus path when Provider and Mapper share an EventStore', () => {
    const database = new Database(':memory:');
    database.initialize();
    const bus = new EventBus();
    const store = new EventStore(new SqliteEventRepository(database), bus);
    const provider = new CodexProvider({}, bus);
    const mapper = new CodexEventMapper({ eventBus: bus, source: provider, context: { provider: 'codex' } });
    let rawCount = 0;
    provider.onNotification(() => { rawCount += 1; });
    mapper.attach();

    provider.client.processManager.emit('stdout', Buffer.from(
      '{"method":"turn/started","params":{"threadId":"th-1","turn":{"id":"tu-1"}}}\n',
    ));
    provider.client.processManager.emit('stdout', Buffer.from(
      '{"id":"req-1","method":"item/fileChange/requestApproval","params":{"threadId":"th-1","turnId":"tu-1","itemId":"op-1"}}\n',
    ));
    provider.client.processManager.emit('stdout', Buffer.from('{malformed}\n'));
    provider.client.processManager.emit('error', new Error('process failed'));

    expect(rawCount).toBe(1);
    const storedTypes = store.list().map((event) => event.eventType);
    expect(storedTypes).toHaveLength(4);
    expect(storedTypes.filter((type) => type === 'AgentExecutionStarted')).toHaveLength(1);
    expect(storedTypes.filter((type) => type === 'AgentApprovalRequired')).toHaveLength(1);
    expect(storedTypes.filter((type) => type === 'ProviderError')).toHaveLength(2);
    expect(storedTypes.some((type) => type.startsWith('Codex'))).toBe(false);
    mapper.dispose();
    store.close();
    database.close();
  });

  it('keeps stderr in diagnostics without publishing a false ProviderError', () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const provider = new CodexProvider({ debug: true }, bus);

    provider.client.processManager.emit('stderr', Buffer.from('INFO normal diagnostic\n'));

    expect(events.filter((event) => event.eventType === 'ProviderError' || event.eventType === 'CodexProviderError')).toHaveLength(0);
    expect(provider.client.diagnostics.snapshot()).toContainEqual(expect.objectContaining({
      type: 'stderr',
      details: { raw: 'INFO normal diagnostic' },
    }));
  });

  it('is idempotent when attached and cleans every subscription through repeated lifecycle cycles', () => {
    const source = new FakeCodexEventSource();
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((event) => events.push(event));
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const mapper = new CodexEventMapper({ eventBus: bus, source, context: { provider: 'codex' } });
      mapper.attach();
      mapper.attach();
      source.notification('turn/started', { threadId: 'th-1', turnId: `tu-${String(cycle)}` });
      expect(events).toHaveLength(cycle + 1);
      mapper.dispose();
      source.notification('turn/started', { threadId: 'th-1', turnId: 'disposed' });
      expect(events).toHaveLength(cycle + 1);
    }
    expect(source.notifications.size).toBe(0);
    expect(source.serverRequests.size).toBe(0);
    expect(source.protocolErrors.size).toBe(0);
    expect(source.processExits.size).toBe(0);
    expect(source.processErrors.size).toBe(0);
  });
});

function createAttachedMapper(): { source: FakeCodexEventSource; events: DomainEvent[]; mapper: CodexEventMapper } {
  const source = new FakeCodexEventSource();
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const mapper = new CodexEventMapper({
    eventBus: bus,
    source,
    context: { provider: 'codex', projectId: 'P1', agentId: 'A1', taskId: 'T1', assignmentId: 'AS1' },
    resolveSessionId: (threadId) => threadId === 'th-1' ? 'session-1' : undefined,
  });
  mapper.attach();
  return { source, events, mapper };
}
