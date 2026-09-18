import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { AntigravityWorkerSession, CursorWorkerSession, type AgentRuntimeContext } from '../src/index.js';
import {
  killProcessTreeAndWait,
  retryPendingKillerCleanup,
  type ProcessCleanupKiller,
} from '../src/providers/shared/ProcessCleanup.js';

const TIMEOUT = 5_000;
const CLEANUP_TIMEOUT = 8_000;

const cursorContext: AgentRuntimeContext = { agentId: 'agent-cursor-e', provider: 'cursor' };
const agyContext: AgentRuntimeContext = { agentId: 'agent-agy-e', provider: 'antigravity' };

type MockChild = ChildProcessWithoutNullStreams & {
  killCount: number;
  stdout: PassThrough;
};

type MockKiller = ProcessCleanupKiller & EventEmitter & {
  killCount: number;
};

function createCleanupChild(options: { hangOnKill?: boolean } = {}): MockChild {
  const stdout = new PassThrough();
  const child = new EventEmitter() as MockChild;
  child.killCount = 0;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => {
      child.killCount += 1;
      if (options.hangOnKill === true) return true;
      (child as unknown as { exitCode: number }).exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
      return true;
    },
  });
  return child;
}

function createMockKiller(options: { hangOnKill?: boolean } = {}): MockKiller {
  const killer = new EventEmitter() as MockKiller;
  killer.killCount = 0;
  Object.assign(killer, {
    exitCode: null,
    signalCode: null,
    kill: () => {
      killer.killCount += 1;
      if (options.hangOnKill === true) return true;
      (killer as unknown as { exitCode: number }).exitCode = 1;
      killer.emit('exit', 1, null);
      return true;
    },
  });
  return killer;
}

function createSessionChild(): MockChild {
  return createCleanupChild();
}

describe('ProcessCleanup pending helper ownership 0.7.2E', () => {
  it('retains hanging helper after SIGKILL as pendingKiller', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller({ hangOnKill: true });
    const result = await killProcessTreeAndWait(child, 60, {
      platform: 'win32',
      spawnKiller: () => killer,
    });
    expect(result.status).toBe('timed-out');
    expect(result.status === 'timed-out' ? result.pendingKiller : undefined).toBe(killer);
  }, CLEANUP_TIMEOUT);

  it('retains error-path helper when kill is unconfirmed', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller({ hangOnKill: true });
    const result = await killProcessTreeAndWait(child, 80, {
      platform: 'win32',
      spawnKiller: () => {
        queueMicrotask(() => {
          killer.emit('error', new Error('spawn failed'));
        });
        return killer;
      },
    });
    expect(result.status).toBe('timed-out');
    expect(result.status === 'timed-out' ? result.pendingKiller : undefined).toBe(killer);
    expect(killer.killCount).toBe(1);
  }, CLEANUP_TIMEOUT);

  it('confirms error-path helper cleanup and falls back to provider kill', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller();
    const result = await killProcessTreeAndWait(child, 200, {
      platform: 'win32',
      spawnKiller: () => {
        queueMicrotask(() => {
          killer.emit('error', new Error('spawn failed'));
        });
        return killer;
      },
    });
    expect(result.status).toBe('exited');
    expect(result.status === 'timed-out' ? result.pendingKiller : undefined).toBeUndefined();
    expect(killer.killCount).toBe(1);
    expect(child.killCount).toBe(1);
  }, TIMEOUT);

  it('retries pending helper cleanup until exit', async () => {
    const killer = createMockKiller();
    const first = await retryPendingKillerCleanup(killer, 200);
    expect(first).toBe('exited');
    expect(killer.killCount).toBe(1);
  }, TIMEOUT);
});

describe('Cursor 0.7.2E helper quarantine', () => {
  it('retains unresolved helper, denies next turn, then clears on shutdown exit', async () => {
    const killer = createMockKiller({ hangOnKill: true });
    let child: MockChild | undefined;
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      stopTimeoutMs: 50,
      processCleanupDeps: {
        platform: 'win32',
        spawnKiller: () => killer,
      },
      spawnProcess: () => {
        child = createSessionChild();
        queueMicrotask(() => {
          child?.stdout.write('{broken\n');
        });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(session.cleanupRequired).toBe(true);
    expect(session.pendingCleanupKiller).toBe(killer);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    (killer as unknown as { exitCode: number }).exitCode = 1;
    killer.emit('exit', 1, null);
    await session.shutdown();
    expect(session.pendingCleanupKiller).toBeNull();
    expect(session.cleanupRequired).toBe(false);
  }, CLEANUP_TIMEOUT);

  it('keeps pending helper when shutdown retry still hangs', async () => {
    const killer = createMockKiller({ hangOnKill: true });
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      stopTimeoutMs: 40,
      processCleanupDeps: {
        platform: 'win32',
        spawnKiller: () => killer,
      },
      spawnProcess: () => {
        const child = createSessionChild();
        queueMicrotask(() => {
          child.stdout.write('{broken\n');
        });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(session.pendingCleanupKiller).toBe(killer);
    await session.shutdown();
    expect(session.pendingCleanupKiller).toBe(killer);
    expect(session.cleanupRequired).toBe(true);
    expect(session.cleanupFailed).toBe(true);
  }, CLEANUP_TIMEOUT);
});

describe('Antigravity 0.7.2E helper quarantine', () => {
  it('retains unresolved helper, denies next turn, then clears on shutdown exit', async () => {
    const killer = createMockKiller({ hangOnKill: true });
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      stopTimeoutMs: 50,
      processCleanupDeps: {
        platform: 'win32',
        spawnKiller: () => killer,
      },
      spawnProcess: () => {
        const child = createSessionChild();
        queueMicrotask(() => {
          child.stdout.write('{broken\n');
        });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(session.cleanupRequired).toBe(true);
    expect(session.pendingCleanupKiller).toBe(killer);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    (killer as unknown as { exitCode: number }).exitCode = 1;
    killer.emit('exit', 1, null);
    await session.shutdown();
    expect(session.pendingCleanupKiller).toBeNull();
    expect(session.cleanupRequired).toBe(false);
  }, CLEANUP_TIMEOUT);
});
