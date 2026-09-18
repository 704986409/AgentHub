import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { killProcessTreeAndWait, type ProcessCleanupKiller } from '../src/providers/shared/ProcessCleanup.js';

const TIMEOUT = 5_000;
const CLEANUP_TIMEOUT = 8_000;

type MockChild = ChildProcessWithoutNullStreams & {
  killCount: number;
};

type MockKiller = ProcessCleanupKiller & EventEmitter & {
  killCount: number;
};

function createCleanupChild(options: { hangOnKill?: boolean; pid?: number } = {}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.killCount = 0;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: options.pid ?? 4242,
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

describe('ProcessCleanup helper ownership 0.7.2D', () => {
  it('Case A: taskkill success does not kill helper or provider child', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller();
    const result = await killProcessTreeAndWait(child, 200, {
      platform: 'win32',
      spawnKiller: () => {
        queueMicrotask(() => {
          (killer as unknown as { exitCode: number }).exitCode = 0;
          killer.emit('exit', 0, null);
          queueMicrotask(() => {
            (child as unknown as { exitCode: number }).exitCode = 0;
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
        });
        return killer;
      },
    });
    expect(result.status).toBe('exited');
    expect(killer.killCount).toBe(0);
    expect(child.killCount).toBe(0);
  }, TIMEOUT);

  it('Case B: taskkill nonzero settles helper then falls back to provider kill', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller();
    const result = await killProcessTreeAndWait(child, 200, {
      platform: 'win32',
      spawnKiller: () => {
        queueMicrotask(() => {
          (killer as unknown as { exitCode: number }).exitCode = 1;
          killer.emit('exit', 1, null);
        });
        return killer;
      },
    });
    expect(result.status).toBe('exited');
    expect(killer.killCount).toBe(0);
    expect(child.killCount).toBe(1);
  }, TIMEOUT);

  it('Case C: hanging taskkill is itself killed before provider fallback', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller();
    const result = await killProcessTreeAndWait(child, 80, {
      platform: 'win32',
      spawnKiller: () => killer,
    });
    expect(result.status).toBe('exited');
    expect(killer.killCount).toBe(1);
    expect(child.killCount).toBe(1);
  }, CLEANUP_TIMEOUT);

  it('Case D: helper that ignores kill still times out without claiming exited', async () => {
    const child = createCleanupChild();
    const killer = createMockKiller({ hangOnKill: true });
    const started = Date.now();
    const result = await killProcessTreeAndWait(child, 60, {
      platform: 'win32',
      spawnKiller: () => killer,
    });
    const elapsed = Date.now() - started;
    expect(result.status).toBe('timed-out');
    expect(killer.killCount).toBe(1);
    expect(elapsed).toBeLessThan(500);
  }, CLEANUP_TIMEOUT);

  it('Case E: provider fallback hang remains bounded timed-out', async () => {
    const child = createCleanupChild({ hangOnKill: true });
    const killer = createMockKiller();
    const started = Date.now();
    const result = await killProcessTreeAndWait(child, 60, {
      platform: 'win32',
      spawnKiller: () => {
        queueMicrotask(() => {
          (killer as unknown as { exitCode: number }).exitCode = 1;
          killer.emit('exit', 1, null);
        });
        return killer;
      },
    });
    const elapsed = Date.now() - started;
    expect(result.status).toBe('timed-out');
    expect(child.killCount).toBe(1);
    expect(elapsed).toBeLessThan(500);
  }, CLEANUP_TIMEOUT);

  it('error without exit requests helper kill then falls back', async () => {
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
    expect(killer.killCount).toBe(1);
    expect(child.killCount).toBe(1);
  }, TIMEOUT);
});
