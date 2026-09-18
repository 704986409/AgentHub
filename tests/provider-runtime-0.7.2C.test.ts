import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  AntigravityCapabilityDetector,
  AntigravityWorkerSession,
  CursorCapabilityDetector,
  type AgentRuntimeContext,
} from '../src/index.js';
import { killProcessTreeAndWait, type ProcessCleanupKiller } from '../src/providers/shared/ProcessCleanup.js';

const TIMEOUT = 5_000;
const CLEANUP_TIMEOUT = 8_000;

const agyContext: AgentRuntimeContext = { agentId: 'agent-agy-c', provider: 'antigravity' };

const validWorkerResultBlock = `<AGENTHUB_RESULT>\n${JSON.stringify({
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'ok',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
})}\n</AGENTHUB_RESULT>`;

function resultLine(conversationId: string): string {
  return `${JSON.stringify({ type: 'result', text: validWorkerResultBlock, conversation_id: conversationId })}\n`;
}

type MockChild = ChildProcessWithoutNullStreams & {
  killCount: number;
  stdout: PassThrough;
};

function createCleanupChild(options: { hangOnKill?: boolean; pid?: number } = {}): MockChild {
  const stdout = new PassThrough();
  const child = new EventEmitter() as MockChild;
  child.killCount = 0;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
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

function createKiller(): ProcessCleanupKiller & EventEmitter {
  return new EventEmitter() as ProcessCleanupKiller & EventEmitter;
}

function createPersistentChild(): MockChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as MockChild;
  child.killCount = 0;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 7777,
    exitCode: null,
    signalCode: null,
    kill: () => {
      child.killCount += 1;
      (child as unknown as { exitCode: number }).exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
      return true;
    },
  });
  return child;
}

describe('Windows process-tree cleanup 0.7.2C', () => {
  it('uses taskkill first and does not call child.kill on success', async () => {
    const child = createCleanupChild();
    let killerPid: number | undefined;
    const result = await killProcessTreeAndWait(child, 200, {
      platform: 'win32',
      spawnKiller: (pid) => {
        killerPid = pid;
        const killer = createKiller();
        queueMicrotask(() => {
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
    expect(killerPid).toBe(4242);
    expect(result.status).toBe('exited');
    expect(child.killCount).toBe(0);
  }, CLEANUP_TIMEOUT);

  it('falls back to child.kill when taskkill errors or exits nonzero', async () => {
    const child = createCleanupChild();
    const result = await killProcessTreeAndWait(child, 200, {
      platform: 'win32',
      spawnKiller: () => {
        const killer = createKiller();
        queueMicrotask(() => {
          killer.emit('exit', 1, null);
        });
        return killer;
      },
    });
    expect(result.status).toBe('exited');
    expect(child.killCount).toBe(1);
  }, CLEANUP_TIMEOUT);

  it('bounds wait when taskkill hangs and then falls back', async () => {
    const child = createCleanupChild({ hangOnKill: true });
    const started = Date.now();
    const result = await killProcessTreeAndWait(child, 40, {
      platform: 'win32',
      spawnKiller: () => createKiller(),
    });
    const elapsed = Date.now() - started;
    expect(result.status).toBe('timed-out');
    expect(child.killCount).toBe(1);
    expect(elapsed).toBeLessThan(400);
  }, CLEANUP_TIMEOUT);
});

describe('CapabilityDetector 0.7.2C help runner throw', () => {
  it('does not throw when Cursor --help runner throws after version succeeds', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') throw new Error('spawn failed');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
    expect(report.installed).toBe(true);
    expect(report.version).toBe('1.0.0');
  }, TIMEOUT);

  it('does not throw when Antigravity --help runner throws after version succeeds', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') throw new Error('spawn failed');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
    expect(report.installed).toBe(true);
    expect(report.version).toBe('0.9.0');
  }, TIMEOUT);
});

describe('Antigravity 0.7.2C signal-dead child and listener leak', () => {
  it('spawns a fresh resume process after SIGKILL signal-dead child', async () => {
    const spawned: { args: readonly string[]; child: MockChild }[] = [];
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      spawnProcess: (_cmd, args) => {
        const child = createPersistentChild();
        spawned.push({ args: [...args], child });
        queueMicrotask(() => {
          child.stdout.write(resultLine('conv-a'));
        });
        return child;
      },
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    const first = spawned[0]?.child;
    expect(first).toBeDefined();
    (first as unknown as { signalCode: NodeJS.Signals }).signalCode = 'SIGKILL';
    await session.runTurn({ prompt: 't2', timeoutMs: 1000 });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.child).not.toBe(first);
    expect(spawned[1]?.args).toContain('--conversation');
    expect(spawned[1]?.args).toContain('conv-a');
    await session.shutdown();
  }, TIMEOUT);

  it('spawns a fresh resume process after SIGTERM signal-dead child', async () => {
    const spawned: { args: readonly string[]; child: MockChild }[] = [];
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      spawnProcess: (_cmd, args) => {
        const child = createPersistentChild();
        spawned.push({ args: [...args], child });
        queueMicrotask(() => {
          child.stdout.write(resultLine('conv-term'));
        });
        return child;
      },
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    const first = spawned[0]?.child;
    (first as unknown as { signalCode: NodeJS.Signals }).signalCode = 'SIGTERM';
    await session.runTurn({ prompt: 't2', timeoutMs: 1000 });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args).toEqual(expect.arrayContaining(['--conversation', 'conv-term']));
    await session.shutdown();
  }, TIMEOUT);

  it('does not accumulate error/exit listeners across 20 persistent turns', async () => {
    let child: MockChild | undefined;
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      spawnProcess: () => {
        child = createPersistentChild();
        return child;
      },
    });
    await session.start();
    for (let i = 0; i < 20; i += 1) {
      const turn = session.runTurn({ prompt: `t${String(i)}`, timeoutMs: 1000 });
      await Promise.resolve();
      child?.stdout.write(resultLine('conv-persist'));
      await turn;
      expect(child?.listenerCount('error') ?? -1).toBeLessThanOrEqual(1);
      expect(child?.listenerCount('exit') ?? -1).toBeLessThanOrEqual(1);
    }
    expect(child?.listenerCount('error')).toBe(0);
    expect(child?.listenerCount('exit')).toBe(0);
    await session.shutdown();
  }, TIMEOUT);
});
