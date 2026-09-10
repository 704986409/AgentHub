import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AgentRuntimeEventType, CodexEventMapper, CodexManagerUseCase, EventBus, type DomainEvent } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));

describe('Codex event mapper integration', () => {
  it('publishes the semantic sequence while preserving the Manager turn lifecycle', async () => {
    const { manager, events, mapper } = createFixture('success');
    const rawMethods: string[] = [];
    manager.onNotification((method) => rawMethods.push(method));
    await manager.initialize();
    const result = await manager.runTurn({ prompt: 'Reply with exactly OK.' });

    expect(events.map((event) => event.eventType)).toEqual([
      AgentRuntimeEventType.AGENT_EXECUTION_STARTED,
      AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED,
      AgentRuntimeEventType.AGENT_MESSAGE_DELTA,
      AgentRuntimeEventType.AGENT_MESSAGE_DELTA,
      AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED,
      AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED,
    ]);
    expect(events[0]).toMatchObject({
      projectId: 'P1', agentId: 'A1', taskId: 'T1', assignmentId: 'AS1',
      payload: { threadId: 'manager-thread-1', turnId: 'manager-turn-1', sessionId: 'manager-session-1' },
    });
    expect(rawMethods).toContain('item/agentMessage/delta');
    expect(result.status).toBe('completed');
    expect(manager.client.requestManager.pendingCount).toBe(0);
    expect(manager.pendingTurnCount).toBe(0);
    mapper.dispose();
    await manager.shutdown();
  });

  it('keeps approval response handling intact and completes the turn', async () => {
    const { manager, events, mapper } = createFixture('server-request');
    manager.onServerRequest((request) => manager.provider.respondToServerRequest(request.id, { decision: 'accept' }));
    await manager.initialize();
    const result = await manager.runTurn({ prompt: 'Exercise approval.' });

    const approval = events.find((event) => event.eventType === 'AgentApprovalRequired');
    expect(approval?.payload).toMatchObject({ requestId: 'server-request-1', itemId: 'command-1' });
    expect(result.status).toBe('completed');
    expect(manager.client.requestManager.pendingCount).toBe(0);
    expect(manager.pendingTurnCount).toBe(0);
    mapper.dispose();
    await manager.shutdown();
  });

  it('publishes one ProviderError and one codex-start SystemError for initialization protocol failure', async () => {
    const bus = new EventBus();
    const events: DomainEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const manager = CodexManagerUseCase.create({
      command: process.execPath,
      args: [fixturePath, 'initialize-malformed'],
    }, {}, bus);
    const mapper = new CodexEventMapper({ eventBus: bus, source: manager, context: { provider: 'codex' } });
    mapper.attach();

    await expect(manager.initialize()).rejects.toThrow();
    const runtimeTypes = events.map((event) => event.eventType);
    expect(runtimeTypes.filter((type) => type === 'ProviderError')).toHaveLength(1);
    expect(runtimeTypes.filter((type) => type === 'SystemError')).toHaveLength(1);
    expect(runtimeTypes).not.toContain('CodexProviderError');
    expect(runtimeTypes).not.toContain('CodexNotificationReceived');
    await manager.shutdown();
    mapper.dispose();
    manager.dispose();
  });
});

function createFixture(scenario: string): { manager: CodexManagerUseCase; events: DomainEvent[]; mapper: CodexEventMapper } {
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => {
    if (Object.values(AgentRuntimeEventType).includes(event.eventType as AgentRuntimeEventType)) events.push(event);
  });
  const manager = CodexManagerUseCase.create({
    command: process.execPath,
    args: [fixturePath, scenario],
  }, { turnTimeoutMs: 2_000 });
  const mapper = new CodexEventMapper({
    eventBus: bus,
    source: manager,
    context: { provider: 'codex', projectId: 'P1', agentId: 'A1', taskId: 'T1', assignmentId: 'AS1' },
    resolveSessionId: (threadId) => manager.getManagerSession()?.threadId === threadId
      ? manager.getManagerSession()?.sessionId
      : undefined,
  });
  mapper.attach();
  return { manager, events, mapper };
}
