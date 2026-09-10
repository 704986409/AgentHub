import { describe, expect, it } from 'vitest';

import {
  CodexManagerTurnController,
  type CodexManagerTransport,
} from '../src/index.js';

class MockManagerTransport implements CodexManagerTransport {
  readonly requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  threadResponse: unknown = { thread: { id: 'thread-1', sessionId: 'session-1' } };
  turnResponse: unknown = { turn: { id: 'turn-1', status: 'inProgress', items: [] } };

  public request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params, timeoutMs });
    return Promise.resolve(method === 'thread/start' ? this.threadResponse : this.turnResponse);
  }

  public count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }
}

describe('Codex Manager turn controller', () => {
  it('requires READY and validates the prompt before sending requests', async () => {
    const transport = new MockManagerTransport();
    let ready = false;
    const controller = new CodexManagerTurnController(transport, () => {
      if (!ready) throw new Error('not READY');
    });

    await expect(controller.createManagerThread()).rejects.toThrow('not READY');
    await expect(controller.runTurn({ prompt: 'hello' })).rejects.toThrow('not READY');
    ready = true;
    await expect(controller.runTurn({ prompt: '   ' })).rejects.toMatchObject({ code: 'EMPTY_PROMPT' });
    expect(transport.requests).toHaveLength(0);
  });

  it('creates one thread, reuses it, correlates turn events, and avoids delta/final duplication', async () => {
    const transport = new MockManagerTransport();
    const controller = new CodexManagerTurnController(transport, () => undefined);

    const firstPromise = controller.runTurn({ prompt: 'first' });
    await allowRequestResponseToSettle();
    controller.handleNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'O',
    });
    controller.handleNotification('custom/progress', { threadId: 'thread-1', turnId: 'turn-1', progress: 0.5 });
    controller.handleNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'K',
    });
    controller.handleNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'message-1', text: 'OK', phase: 'final_answer' },
    });
    controller.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const first = await firstPromise;

    expect(first).toMatchObject({ threadId: 'thread-1', sessionId: 'session-1', turnId: 'turn-1', status: 'completed', text: 'OK' });
    expect(first.events.some((event) => event.kind === 'unknown')).toBe(true);
    expect(transport.count('thread/start')).toBe(1);

    transport.turnResponse = { turn: { id: 'turn-2', status: 'inProgress', items: [] } };
    const secondPromise = controller.runTurn({ prompt: 'second' });
    await allowRequestResponseToSettle();
    controller.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-2',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-2', text: 'SECOND', phase: 'final_answer' }],
      },
    });
    const second = await secondPromise;
    expect(second.text).toBe('SECOND');
    expect(transport.count('thread/start')).toBe(1);
    expect(transport.count('turn/start')).toBe(2);
    expect(controller.managerThreadId).toBe('thread-1');
    expect(controller.managerSession).toEqual({ threadId: 'thread-1', sessionId: 'session-1' });
    expect(controller.pendingTurnCount).toBe(0);
  });

  it('rejects an invalid thread response as a protocol error', async () => {
    const transport = new MockManagerTransport();
    transport.threadResponse = { thread: {} };
    const controller = new CodexManagerTurnController(transport, () => undefined);
    await expect(controller.createManagerThread()).rejects.toMatchObject({
      kind: 'protocol_error',
      code: 'INVALID_THREAD_RESPONSE',
    });
  });

  it('classifies malformed protocol input and upstream capacity separately', async () => {
    const transport = new MockManagerTransport();
    const controller = new CodexManagerTurnController(transport, () => undefined);
    const malformedPromise = controller.runTurn({ prompt: 'malformed' });
    await allowRequestResponseToSettle();
    controller.handleProtocolError(new Error('invalid JSON'));
    await expect(malformedPromise).resolves.toMatchObject({
      status: 'failed',
      error: { kind: 'protocol_error' },
    });

    transport.turnResponse = { turn: { status: 'inProgress', items: [] } };
    await expect(controller.runTurn({ prompt: 'invalid response' })).resolves.toMatchObject({
      status: 'failed',
      error: { kind: 'protocol_error' },
    });

    transport.turnResponse = { turn: { id: 'turn-3', status: 'inProgress', items: [] } };
    const capacityPromise = controller.runTurn({ prompt: 'capacity' });
    await allowRequestResponseToSettle();
    controller.handleNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-3',
      willRetry: false,
      error: { message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded' },
    });
    await expect(capacityPromise).resolves.toMatchObject({
      status: 'upstream_unavailable',
      error: { kind: 'upstream_unavailable', code: 'serverOverloaded' },
    });

    transport.turnResponse = { turn: { id: 'turn-4', status: 'inProgress', items: [] } };
    const objectCapacityPromise = controller.runTurn({ prompt: 'capacity object' });
    await allowRequestResponseToSettle();
    controller.handleNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-4',
      willRetry: false,
      error: { message: 'Selected model is at capacity', codexErrorInfo: { serverOverloaded: {} } },
    });
    await expect(objectCapacityPromise).resolves.toMatchObject({
      status: 'upstream_unavailable',
      error: { kind: 'upstream_unavailable', code: 'serverOverloaded' },
    });
  });

  it('clears a timed-out turn and ignores events from other turns', async () => {
    const transport = new MockManagerTransport();
    const controller = new CodexManagerTurnController(transport, () => undefined, { turnTimeoutMs: 15 });
    const resultPromise = controller.runTurn({ prompt: 'wait' });
    await allowRequestResponseToSettle();
    controller.handleNotification('turn/completed', {
      threadId: 'thread-1', turn: { id: 'different-turn', status: 'completed', items: [] },
    });
    await expect(resultPromise).resolves.toMatchObject({ status: 'timeout', error: { kind: 'timeout' } });
    expect(controller.pendingTurnCount).toBe(0);
  });

  it('ends pending turns on process exit and provider stop without leaving active state', async () => {
    const transport = new MockManagerTransport();
    const controller = new CodexManagerTurnController(transport, () => undefined);
    const exitPromise = controller.runTurn({ prompt: 'exit' });
    await allowRequestResponseToSettle();
    controller.handleProcessExit(7, null);
    await expect(exitPromise).resolves.toMatchObject({ status: 'failed', error: { kind: 'process_exit', code: '7' } });

    transport.turnResponse = { turn: { id: 'turn-2', status: 'inProgress', items: [] } };
    const stopPromise = controller.runTurn({ prompt: 'stop' });
    await allowRequestResponseToSettle();
    controller.stop();
    await expect(stopPromise).resolves.toMatchObject({
      status: 'failed', error: { kind: 'provider_error', code: 'PROVIDER_STOPPED' },
    });
    expect(controller.pendingTurnCount).toBe(0);
  });

  it('fails fast when a second turn is started while one is active', async () => {
    const transport = new MockManagerTransport();
    const controller = new CodexManagerTurnController(transport, () => undefined);
    const first = controller.runTurn({ prompt: 'first' });
    await expect(controller.runTurn({ prompt: 'second' })).rejects.toMatchObject({ code: 'TURN_ALREADY_ACTIVE' });
    await allowRequestResponseToSettle();
    controller.stop();
    await first;
  });
});

async function allowRequestResponseToSettle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
