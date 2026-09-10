import { describe, expect, it } from 'vitest';

import {
  CodexDiagnostics,
  CodexManagerTurnController,
  CodexManagerUseCase,
  type CodexManagerTransport,
  type CodexProvider,
  type CodexSession,
  type CodexSessionRecord,
  type CodexSessionStore,
} from '../src/index.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class ControlledTransport implements CodexManagerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  handler: (method: string, params: unknown) => Promise<unknown> = (method, params) =>
    Promise.resolve(responseFor(method, params));

  public request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handler(method, params);
  }

  public count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }
}

class MemorySessionStore implements CodexSessionStore {
  readonly records = new Map<string, CodexSessionRecord>();

  public get(sessionKey: string): CodexSessionRecord | undefined {
    const record = this.records.get(sessionKey);
    return record === undefined ? undefined : { ...record };
  }

  public save(sessionKey: string, session: CodexSession): CodexSessionRecord {
    const now = new Date().toISOString();
    const current = this.records.get(sessionKey);
    const record = {
      sessionKey,
      ...session,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(sessionKey, record);
    return { ...record };
  }

  public delete(sessionKey: string): void {
    this.records.delete(sessionKey);
  }
}

describe('Codex concurrent session change guard', () => {
  it('continues to coalesce concurrent lazy Manager thread creation', async () => {
    const transport = new ControlledTransport();
    const pendingStart = deferred<unknown>();
    transport.handler = async () => await pendingStart.promise;
    const controller = createController(transport);

    const first = controller.createManagerThread();
    const second = controller.createManagerThread();
    expect(transport.count('thread/start')).toBe(1);

    pendingStart.resolve(threadResponse('thread-lazy', 'session-lazy'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { threadId: 'thread-lazy', sessionId: 'session-lazy' },
      { threadId: 'thread-lazy', sessionId: 'session-lazy' },
    ]);
  });

  it('isolates concurrent fresh starts and releases the guard after success', async () => {
    const transport = new ControlledTransport();
    const pendingStart = deferred<unknown>();
    transport.handler = async () => await pendingStart.promise;
    const store = new MemorySessionStore();
    const manager = createUseCase(transport, store);

    const first = manager.startSession('agent-A');
    await expect(manager.startSession('agent-B')).rejects.toMatchObject({ code: 'SESSION_CHANGE_IN_PROGRESS' });
    expect(transport.count('thread/start')).toBe(1);
    expect(store.get('agent-B')).toBeUndefined();

    pendingStart.resolve(threadResponse('thread-A', 'session-A'));
    await expect(first).resolves.toEqual({ threadId: 'thread-A', sessionId: 'session-A' });
    expect(store.get('agent-A')).toMatchObject({ threadId: 'thread-A', sessionId: 'session-A' });

    transport.handler = (method, params) =>
      Promise.resolve(responseFor(method, params, 'thread-B', 'session-B'));
    await expect(manager.startSession('agent-B')).resolves.toEqual({ threadId: 'thread-B', sessionId: 'session-B' });
    expect(transport.count('thread/start')).toBe(2);
  });

  it('blocks resume while a fresh start is pending without changing the stored session', async () => {
    const transport = new ControlledTransport();
    const pendingStart = deferred<unknown>();
    transport.handler = async () => await pendingStart.promise;
    const store = new MemorySessionStore();
    const original = store.save('agent-B', { threadId: 'thread-B', sessionId: 'stored-B' });
    const manager = createUseCase(transport, store);

    const fresh = manager.startSession('agent-A');
    await expect(manager.resumeSession('agent-B')).rejects.toMatchObject({ code: 'SESSION_CHANGE_IN_PROGRESS' });
    expect(transport.count('thread/resume')).toBe(0);
    expect(store.get('agent-B')).toEqual(original);

    pendingStart.resolve(threadResponse('thread-A', 'session-A'));
    await fresh;
  });

  it('isolates concurrent resumes and releases the guard after a failed request', async () => {
    const transport = new ControlledTransport();
    const pendingResume = deferred<unknown>();
    transport.handler = async () => await pendingResume.promise;
    const store = new MemorySessionStore();
    store.save('agent-A', { threadId: 'thread-A', sessionId: 'stored-A' });
    const originalB = store.save('agent-B', { threadId: 'thread-B', sessionId: 'stored-B' });
    const manager = createUseCase(transport, store);

    const first = manager.resumeSession('agent-A');
    await expect(manager.resumeSession('agent-B')).rejects.toMatchObject({ code: 'SESSION_CHANGE_IN_PROGRESS' });
    expect(transport.requests.filter(({ method }) => method === 'thread/resume')).toEqual([
      { method: 'thread/resume', params: { threadId: 'thread-A' } },
    ]);
    expect(store.get('agent-B')).toEqual(originalB);

    pendingResume.reject(new Error('resume failed'));
    await expect(first).rejects.toMatchObject({ message: 'thread/resume failed: resume failed' });

    transport.handler = (method, params) =>
      Promise.resolve(responseFor(method, params, 'thread-B', 'resumed-B'));
    await expect(manager.resumeSession('agent-B')).resolves.toEqual({ threadId: 'thread-B', sessionId: 'resumed-B' });
    expect(transport.count('thread/resume')).toBe(2);
  });

  it('blocks turns and lazy creation while an explicit session change is pending', async () => {
    const transport = new ControlledTransport();
    const pendingResume = deferred<unknown>();
    transport.handler = async () => await pendingResume.promise;
    const controller = createController(transport);

    const resume = controller.resumeThread('thread-A');
    await expect(controller.runTurn({ prompt: 'must wait' })).rejects.toMatchObject({
      code: 'SESSION_CHANGE_IN_PROGRESS',
    });
    await expect(controller.createManagerThread()).rejects.toMatchObject({
      code: 'SESSION_CHANGE_IN_PROGRESS',
    });
    expect(transport.count('thread/start')).toBe(0);
    expect(transport.count('turn/start')).toBe(0);

    pendingResume.resolve(threadResponse('thread-A', 'session-A'));
    await resume;
    expect(controller.pendingTurnCount).toBe(0);
  });

  it('preserves the active-turn rule for fresh and resume requests', async () => {
    const transport = new ControlledTransport();
    const pendingTurn = deferred<unknown>();
    transport.handler = async (method, params) =>
      method === 'turn/start' ? await pendingTurn.promise : responseFor(method, params);
    const controller = createController(transport);

    const turn = controller.runTurn({ prompt: 'active turn' });
    await expect(controller.startFreshThread()).rejects.toMatchObject({ code: 'TURN_ALREADY_ACTIVE' });
    await expect(controller.resumeThread('thread-B')).rejects.toMatchObject({ code: 'TURN_ALREADY_ACTIVE' });
    expect(transport.count('thread/start')).toBe(1);
    expect(transport.count('thread/resume')).toBe(0);

    pendingTurn.reject(new Error('stop test turn'));
    await expect(turn).resolves.toMatchObject({ status: 'failed' });
    expect(controller.pendingTurnCount).toBe(0);
  });

  it('blocks an explicit session change while lazy creation is pending', async () => {
    const transport = new ControlledTransport();
    const pendingStart = deferred<unknown>();
    transport.handler = async () => await pendingStart.promise;
    const controller = createController(transport);

    const lazy = controller.createManagerThread();
    await expect(controller.startFreshThread()).rejects.toMatchObject({ code: 'SESSION_CHANGE_IN_PROGRESS' });
    expect(transport.count('thread/start')).toBe(1);

    pendingStart.resolve(threadResponse('thread-lazy', 'session-lazy'));
    await lazy;
  });
});

function createController(transport: CodexManagerTransport): CodexManagerTurnController {
  return new CodexManagerTurnController(transport, () => undefined);
}

function createUseCase(transport: ControlledTransport, store: CodexSessionStore): CodexManagerUseCase {
  const client = Object.assign(transport, { diagnostics: new CodexDiagnostics(false) });
  const unsubscribe = (): void => undefined;
  const provider = {
    client,
    assertReady: (): void => undefined,
    onNotification: () => unsubscribe,
    onServerRequest: () => unsubscribe,
    onProtocolError: () => unsubscribe,
    onProcessExit: () => unsubscribe,
    onProcessError: () => unsubscribe,
  } as unknown as CodexProvider;
  return new CodexManagerUseCase(provider, { sessionStore: store });
}

function responseFor(
  method: string,
  params: unknown,
  threadId = 'thread-1',
  sessionId = 'session-1',
): unknown {
  if (method === 'thread/start') return threadResponse(threadId, sessionId);
  if (method === 'thread/resume') {
    const requestedThreadId = readThreadId(params);
    return threadResponse(requestedThreadId, sessionId);
  }
  return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
}

function threadResponse(threadId: string, sessionId: string): unknown {
  return { thread: { id: threadId, sessionId } };
}

function readThreadId(params: unknown): string {
  if (typeof params === 'object' && params !== null && 'threadId' in params && typeof params.threadId === 'string') {
    return params.threadId;
  }
  throw new Error('Missing threadId');
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) throw new Error('Unable to create deferred promise');
  return { promise, resolve, reject };
}
