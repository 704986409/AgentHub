import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  AntigravityCapabilityDetector,
  AntigravityWorkerSession,
  CursorCapabilityDetector,
  CursorWorkerSession,
  parseAntigravityModelsOutput,
  parseCursorModelsOutput,
  type AgentRuntimeContext,
} from '../src/index.js';

const TIMEOUT = 5_000;

const cursorContext: AgentRuntimeContext = { agentId: 'agent-cursor-b', provider: 'cursor' };
const agyContext: AgentRuntimeContext = { agentId: 'agent-agy-b', provider: 'antigravity' };

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

function resultLine(identity: Record<string, string>): string {
  return `${JSON.stringify({ type: 'result', text: validWorkerResultBlock, ...identity })}\n`;
}

const CURSOR_HELP = 'Usage: agent --print --output-format stream-json --resume <id>\nCommands:\n  models\n';
const AGY_HELP = 'Usage: agy --input-format stream-json --output-format stream-json --conversation <id> --headless\nCommands:\n  models\n';

type MockChild = ChildProcessWithoutNullStreams & {
  killCount: number;
  exitObserved: boolean;
};

function createMockChild(options: {
  stdoutChunks?: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  delayMs?: number;
  persist?: boolean;
  hangOnKill?: boolean;
}): MockChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as MockChild;
  child.killCount = 0;
  child.exitObserved = false;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => {
      child.killCount += 1;
      if (options.hangOnKill === true) return true;
      child.exitObserved = true;
      (child as unknown as { exitCode: number }).exitCode = 1;
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
      return true;
    },
  });

  setTimeout(() => {
    for (const chunk of options.stdoutChunks ?? []) {
      stdout.write(chunk);
    }
    if (options.persist === true) return;
    const exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    const signal = options.signal ?? null;
    (child as unknown as { exitCode: number | null }).exitCode = exitCode;
    (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = signal;
    child.exitObserved = true;
    child.emit('exit', exitCode, signal);
    child.emit('close', exitCode, signal);
  }, options.delayMs ?? 10);

  return child;
}

describe('Cursor 0.7.2B process cleanup and signal exit', () => {
  it('rejects malformed JSON only after kill and child exit/close', async () => {
    let child: MockChild | undefined;
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['{broken\n'], persist: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(child?.exitObserved).toBe(true);
    expect(session.ownsChildProcess).toBe(false);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    await session.shutdown();
  }, TIMEOUT);

  it('confirms overflow cleanup before releasing ownership', async () => {
    let child: MockChild | undefined;
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      streamParserOptions: { maxLineBytes: 100, maxTotalBytes: 8 },
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['CCCCCCCCCC'], persist: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/maximum allowed size/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(child?.exitObserved).toBe(true);
    expect(session.ownsChildProcess).toBe(false);
    await session.shutdown();
  }, TIMEOUT);

  it('quarantines on cleanup timeout and lets shutdown retry', async () => {
    let child: MockChild | undefined;
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      stopTimeoutMs: 40,
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['{broken\n'], persist: true, hangOnKill: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(session.ownsChildProcess).toBe(true);
    expect(session.cleanupFailed).toBe(true);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    (child as unknown as { exitCode: number }).exitCode = 1;
    child?.emit('exit', 1, null);
    child?.emit('close', 1, null);
    await session.shutdown();
    expect(session.ownsChildProcess).toBe(false);
  }, TIMEOUT);

  it('fails a valid terminal when the process is SIGKILL terminated', async () => {
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      spawnProcess: () => createMockChild({
        stdoutChunks: [resultLine({ session_id: 'sid-a' })],
        exitCode: null,
        signal: 'SIGKILL',
      }),
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/signal=SIGKILL/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails a valid terminal when the process is SIGTERM terminated', async () => {
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      spawnProcess: () => createMockChild({
        stdoutChunks: [resultLine({ session_id: 'sid-a' })],
        exitCode: null,
        signal: 'SIGTERM',
      }),
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/signal=SIGTERM/u);
    await session.shutdown();
  }, TIMEOUT);

  it('succeeds only when exitCode is 0 and signal is null', async () => {
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      spawnProcess: () => createMockChild({
        stdoutChunks: [resultLine({ session_id: 'sid-a' })],
        exitCode: 0,
        signal: null,
      }),
    });
    await session.start();
    const result = await session.runTurn({ prompt: 't', timeoutMs: 1000 });
    expect(result.protocolValid).toBe(true);
    expect(session.sessionId).toBe('sid-a');
    await session.shutdown();
  }, TIMEOUT);

  it('still requires exact resume session identity', async () => {
    let n = 0;
    const session = new CursorWorkerSession({
      context: cursorContext,
      config: { command: process.execPath },
      spawnProcess: () => {
        n += 1;
        return createMockChild({
          stdoutChunks: [resultLine({ session_id: n === 1 ? 'sid-a' : 'sid-b' })],
        });
      },
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/identity mismatch/u);
    await session.shutdown();
  }, TIMEOUT);
});

describe('Antigravity 0.7.2B process cleanup', () => {
  it('rejects malformed JSON only after kill and child exit/close', async () => {
    let child: MockChild | undefined;
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['{broken\n'], persist: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(child?.exitObserved).toBe(true);
    expect(session.ownsChildProcess).toBe(false);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    await session.shutdown();
  }, TIMEOUT);

  it('confirms overflow cleanup before releasing ownership', async () => {
    let child: MockChild | undefined;
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      streamParserOptions: { maxLineBytes: 100, maxTotalBytes: 8 },
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['CCCCCCCCCC'], persist: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/exceeded limit/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(child?.exitObserved).toBe(true);
    expect(session.ownsChildProcess).toBe(false);
    await session.shutdown();
  }, TIMEOUT);

  it('quarantines on cleanup timeout and lets shutdown retry', async () => {
    let child: MockChild | undefined;
    const session = new AntigravityWorkerSession({
      context: agyContext,
      config: { command: process.execPath },
      stopTimeoutMs: 40,
      spawnProcess: () => {
        child = createMockChild({ stdoutChunks: ['{broken\n'], persist: true, hangOnKill: true });
        return child;
      },
    });
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    expect(child?.killCount).toBeGreaterThan(0);
    expect(session.ownsChildProcess).toBe(true);
    expect(session.cleanupFailed).toBe(true);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    (child as unknown as { exitCode: number }).exitCode = 1;
    child?.emit('exit', 1, null);
    child?.emit('close', 1, null);
    await session.shutdown();
    expect(session.ownsChildProcess).toBe(false);
  }, TIMEOUT);
});

describe('Capability detector 0.7.2B help probe fail-closed', () => {
  it('does not mark Cursor READY when --help exits 1 even if stderr has required tokens', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 1, stdout: '', stderr: CURSOR_HELP };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).not.toBe('READY');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('marks Cursor PROBE_FAILED when --help reports a spawn error despite token stdout', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 0, stdout: CURSOR_HELP, stderr: '', error: 'spawn failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('marks Cursor PROBE_FAILED when --help exitCode is null without timeout', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: null, stdout: CURSOR_HELP, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('does not mark Antigravity READY when --help exits 1 even if stderr has required tokens', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 1, stdout: '', stderr: AGY_HELP };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).not.toBe('READY');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('marks Antigravity PROBE_FAILED when --help reports a spawn error despite token stdout', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 0, stdout: AGY_HELP, stderr: '', error: 'spawn failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('marks Antigravity PROBE_FAILED when --help exitCode is null without timeout', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: null, stdout: AGY_HELP, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('PROBE_FAILED');
    expect(report.usable).toBe(false);
  }, TIMEOUT);
});

describe('Native model discovery 0.7.2B JSON-only grammar', () => {
  it('does not guess plain text as models', () => {
    expect(parseCursorModelsOutput('Cursor Agent 1.2.3')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseCursorModelsOutput('Available models:')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseCursorModelsOutput('Logged in as user@example.com')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseCursorModelsOutput('model-a\nmodel-b')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseAntigravityModelsOutput('Cursor Agent 1.2.3')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseAntigravityModelsOutput('Available models:')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseAntigravityModelsOutput('Logged in as user@example.com')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseAntigravityModelsOutput('model-a\nmodel-b')).toEqual({ modelDiscovery: 'unavailable', models: [] });
  }, TIMEOUT);

  it('keeps JSON 0/1/512 native and 513/conflict unavailable', () => {
    expect(parseCursorModelsOutput('[]')).toEqual({ modelDiscovery: 'native', models: [] });
    expect(parseCursorModelsOutput(JSON.stringify(['model-a'])).models).toHaveLength(1);
    const models = Array.from({ length: 512 }, (_, i) => `model-${String(i)}`);
    expect(parseCursorModelsOutput(JSON.stringify(models)).modelDiscovery).toBe('native');
    expect(parseCursorModelsOutput(JSON.stringify([...models, 'extra'])).modelDiscovery).toBe('unavailable');
    expect(parseCursorModelsOutput(JSON.stringify([
      { modelId: 'dup', label: 'A' },
      { modelId: 'dup', label: 'B' },
    ])).modelDiscovery).toBe('unavailable');
    expect(parseAntigravityModelsOutput('[]')).toEqual({ modelDiscovery: 'native', models: [] });
    expect(parseAntigravityModelsOutput(JSON.stringify(['model-a'])).models).toHaveLength(1);
  }, TIMEOUT);
});
