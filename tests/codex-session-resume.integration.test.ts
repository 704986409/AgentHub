import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexManagerUseCase,
  Database,
  SqliteCodexSessionStore,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Codex persisted session resume', () => {
  it('resumes the same thread through a new Provider process and uses the returned sessionId', async () => {
    const { database, store } = createStore();
    const firstManager = createManager('success', store);
    await firstManager.initialize();
    const firstSession = await firstManager.startSession('test-manager');
    const firstTurn = await firstManager.runTurn({ prompt: 'First turn.' });
    expect(firstTurn.status).toBe('completed');
    await firstManager.shutdown();
    firstManager.dispose();

    const secondManager = createManager('resume-success', store);
    await secondManager.initialize();
    const resumed = await secondManager.resumeSession('test-manager');
    const secondTurn = await secondManager.runTurn({ prompt: 'Second turn.' });

    expect(resumed).toEqual({
      threadId: firstSession.threadId,
      sessionId: 'manager-session-resumed-different',
    });
    expect(resumed.sessionId).not.toBe(resumed.threadId);
    expect(secondTurn).toMatchObject({
      status: 'completed',
      threadId: firstSession.threadId,
      sessionId: 'manager-session-resumed-different',
    });
    expect(store.get('test-manager')).toMatchObject(resumed);
    expect(outboundMethods(secondManager)).toContain('thread/resume');
    expect(outboundMethods(secondManager)).not.toContain('thread/start');
    expect(secondManager.client.requestManager.pendingCount).toBe(0);
    expect(secondManager.pendingTurnCount).toBe(0);
    await secondManager.shutdown();
    secondManager.dispose();
    database.close();
  });

  it('reports a missing persisted session without starting a new thread', async () => {
    const { database, store } = createStore();
    const manager = createManager('resume-success', store);
    await manager.initialize();
    await expect(manager.resumeSession('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(outboundMethods(manager)).not.toContain('thread/start');
    expect(outboundMethods(manager)).not.toContain('thread/resume');
    await manager.shutdown();
    manager.dispose();
    database.close();
  });

  it.each([
    ['resume-not-found', 'THREAD_RESUME_FAILED'],
    ['resume-mismatched-thread', 'RESUME_THREAD_MISMATCH'],
    ['resume-missing-session', 'INVALID_RESUME_RESPONSE'],
  ])('preserves the record and never silently starts fresh after %s', async (scenario, expectedCode) => {
    const { database, store } = createStore();
    const original = store.save('test-manager', { threadId: 'manager-thread-1', sessionId: 'stored-session' });
    const manager = createManager(scenario, store);
    await manager.initialize();

    await expect(manager.resumeSession('test-manager')).rejects.toMatchObject({ code: expectedCode });
    expect(store.get('test-manager')).toEqual(original);
    expect(outboundMethods(manager).filter((method) => method === 'thread/resume')).toHaveLength(1);
    expect(outboundMethods(manager)).not.toContain('thread/start');
    expect(manager.client.requestManager.pendingCount).toBe(0);
    expect(manager.pendingTurnCount).toBe(0);
    await manager.shutdown();
    manager.dispose();
    database.close();
  });

  it('requires explicit replacement before overwriting an existing session', async () => {
    const { database, store } = createStore();
    const original = store.save('test-manager', { threadId: 'old-thread', sessionId: 'old-session' });
    const manager = createManager('success', store);
    await manager.initialize();
    await expect(manager.startSession('test-manager')).rejects.toMatchObject({ code: 'SESSION_EXISTS' });
    expect(store.get('test-manager')).toEqual(original);

    const fresh = await manager.startSession('test-manager', { replaceExisting: true });
    expect(store.get('test-manager')).toMatchObject(fresh);
    expect(fresh.threadId).toBe('manager-thread-1');
    await manager.shutdown();
    manager.dispose();
    database.close();
  });

  it('preserves an existing record when explicit fresh replacement fails', async () => {
    const { database, store } = createStore();
    const original = store.save('test-manager', { threadId: 'old-thread', sessionId: 'old-session' });
    const manager = createManager('start-missing-session', store);
    await manager.initialize();

    await expect(manager.startSession('test-manager', { replaceExisting: true }))
      .rejects.toMatchObject({ code: 'INVALID_THREAD_RESPONSE' });
    expect(store.get('test-manager')).toEqual(original);
    expect(outboundMethods(manager).filter((method) => method === 'thread/start')).toHaveLength(1);
    await manager.shutdown();
    manager.dispose();
    database.close();
  });
});

function createStore(): { database: Database; store: SqliteCodexSessionStore } {
  const directory = mkdtempSync(join(tmpdir(), 'agenthub-resume-'));
  directories.push(directory);
  const database = new Database(join(directory, 'agenthub.db'));
  database.initialize();
  return { database, store: new SqliteCodexSessionStore(database) };
}

function createManager(scenario: string, sessionStore: SqliteCodexSessionStore): CodexManagerUseCase {
  return CodexManagerUseCase.create({
    command: process.execPath,
    args: [fixturePath, scenario],
    debug: true,
  }, { turnTimeoutMs: 2_000, sessionStore });
}

function outboundMethods(manager: CodexManagerUseCase): unknown[] {
  return manager.client.diagnostics.snapshot()
    .filter((event) => event.type === 'outbound')
    .map((event) => event.details.method);
}
