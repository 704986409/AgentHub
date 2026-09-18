import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  AntigravityCapabilityDetector,
  AntigravityWorkerSession,
  CursorCapabilityDetector,
  CursorExecutableResolutionError,
  CursorStreamParser,
  CursorWorkerSession,
  parseAntigravityModelsOutput,
  parseCursorModelsOutput,
  type AgentRuntimeContext,
} from '../src/index.js';

const TIMEOUT = 5_000;

const cursorContext: AgentRuntimeContext = { agentId: 'agent-cursor-a', provider: 'cursor' };
const agyContext: AgentRuntimeContext = { agentId: 'agent-agy-a', provider: 'antigravity' };

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

function createMockChild(options: {
  stdoutChunks?: string[];
  exitCode?: number;
  delayMs?: number;
  persist?: boolean;
}): ChildProcessWithoutNullStreams & { killCount: number } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { killCount: number };
  child.killCount = 0;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    kill: () => {
      child.killCount += 1;
      (child as unknown as { exitCode: number }).exitCode = 1;
      child.emit('exit', 1, null);
      return true;
    },
  });

  setTimeout(() => {
    for (const chunk of options.stdoutChunks ?? []) {
      stdout.write(chunk);
    }
    if (options.persist !== true) {
      const exitCode = options.exitCode ?? 0;
      (child as unknown as { exitCode: number }).exitCode = exitCode;
      child.emit('exit', exitCode, null);
    }
  }, options.delayMs ?? 10);

  return child;
}

function cursorSession(
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams,
  extras: { streamParserOptions?: { maxLineBytes?: number; maxTotalBytes?: number } } = {},
): CursorWorkerSession {
  return new CursorWorkerSession({
    context: cursorContext,
    config: { command: process.execPath },
    spawnProcess,
    ...(extras.streamParserOptions !== undefined ? { streamParserOptions: extras.streamParserOptions } : {}),
  });
}

function agySession(
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams,
  extras: { streamParserOptions?: { maxLineBytes?: number; maxTotalBytes?: number } } = {},
): AntigravityWorkerSession {
  return new AntigravityWorkerSession({
    context: agyContext,
    config: { command: process.execPath },
    spawnProcess,
    ...(extras.streamParserOptions !== undefined ? { streamParserOptions: extras.streamParserOptions } : {}),
  });
}

describe('Cursor 0.7.2A fail-closed runtime', () => {
  it('fails when first turn is missing session_id', async () => {
    const session = cursorSession(() => createMockChild({ stdoutChunks: [resultLine({})] }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/trusted session_id/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when first turn session_id is blank', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [`${JSON.stringify({ type: 'result', session_id: '   ', text: validWorkerResultBlock })}\n`],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/blank/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when resume turn is missing returned session_id', async () => {
    let n = 0;
    const session = cursorSession(() => {
      n += 1;
      return createMockChild({
        stdoutChunks: [n === 1 ? resultLine({ session_id: 'sid-a' }) : resultLine({})],
      });
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/without returning session_id/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when resume turn returns a different session_id', async () => {
    let n = 0;
    const session = cursorSession(() => {
      n += 1;
      return createMockChild({
        stdoutChunks: [resultLine({ session_id: n === 1 ? 'sid-a' : 'sid-b' })],
      });
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/identity mismatch/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when the same turn emits conflicting session IDs', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [
        `${JSON.stringify({ type: 'assistant', session_id: 'A', content: 'x' })}\n`,
        resultLine({ session_id: 'B' }),
      ],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/identity conflict/u);
    await session.shutdown();
  }, TIMEOUT);

  it('allows the same turn to repeat session ID A then A', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [
        `${JSON.stringify({ type: 'assistant', session_id: 'A', content: 'x' })}\n`,
        resultLine({ session_id: 'A' }),
      ],
    }));
    await session.start();
    const result = await session.runTurn({ prompt: 't', timeoutMs: 1000 });
    expect(result.protocolValid).toBe(true);
    expect(session.sessionId).toBe('A');
    await session.shutdown();
  }, TIMEOUT);

  it('fails closed on malformed stream JSON', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: ['{broken-json\n', resultLine({ session_id: 'A' })],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails closed on duplicate terminal frames', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [resultLine({ session_id: 'A' }), resultLine({ session_id: 'A' })],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/more than one terminal/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when the process exits 0 without a terminal frame', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [`${JSON.stringify({ type: 'assistant', session_id: 'A', content: 'partial' })}\n`],
      exitCode: 0,
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/without a terminal result/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when a valid terminal is followed by exit 1', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [resultLine({ session_id: 'A' })],
      exitCode: 1,
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/exitCode=1/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when a valid terminal is followed by exit 2', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [resultLine({ session_id: 'A' })],
      exitCode: 2,
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/exitCode=2/u);
    await session.shutdown();
  }, TIMEOUT);

  it('rejects line overflow through the real data listener', async () => {
    const session = cursorSession(
      () => createMockChild({ stdoutChunks: [`${'A'.repeat(80)}\n`] }),
      { streamParserOptions: { maxLineBytes: 40, maxTotalBytes: 10_000 } },
    );
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/exceeded limit/u);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    await session.shutdown();
  }, TIMEOUT);

  it('rejects total overflow through the real data listener', async () => {
    const session = cursorSession(
      () => createMockChild({ stdoutChunks: ['BBBBBBBBBB'] }),
      { streamParserOptions: { maxLineBytes: 100, maxTotalBytes: 8 } },
    );
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/maximum allowed size/u);
    await session.shutdown();
  }, TIMEOUT);

  it('cleans child ownership after a fatal parser error', async () => {
    const session = cursorSession(() => createMockChild({ stdoutChunks: ['{broken\n'] }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    await session.shutdown();
  }, TIMEOUT);

  it('settles once when shut down during an active turn', async () => {
    const session = cursorSession(() => createMockChild({
      stdoutChunks: [resultLine({ session_id: 'A' })],
      persist: true,
      delayMs: 80,
    }));
    await session.start();
    const turn = session.runTurn({ prompt: 't', timeoutMs: 1000 });
    const settled = expect(turn).rejects.toThrow(/shut down during active turn/u);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await session.shutdown();
    await settled;
  }, TIMEOUT);

  it('ignores a late exit from a previous generation', async () => {
    const children: Array<ReturnType<typeof createMockChild>> = [];
    const session = cursorSession(() => {
      const child = createMockChild({ stdoutChunks: [resultLine({ session_id: 'sid-a' })] });
      children.push(child);
      return child;
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    const second = session.runTurn({ prompt: 't2', timeoutMs: 1000 });
    children[0]?.emit('exit', 99, null);
    const result = await second;
    expect(result.protocolValid).toBe(true);
    expect(session.sessionId).toBe('sid-a');
    await session.shutdown();
  }, TIMEOUT);

  it('isolates session IDs across two concurrent Cursor agents', async () => {
    const sessionA = cursorSession(() => createMockChild({ stdoutChunks: [resultLine({ session_id: 'sid-a' })] }));
    const sessionB = new CursorWorkerSession({
      context: { agentId: 'agent-cursor-b', provider: 'cursor' },
      config: { command: process.execPath },
      spawnProcess: () => createMockChild({ stdoutChunks: [resultLine({ session_id: 'sid-b' })] }),
    });
    await sessionA.start();
    await sessionB.start();
    const [a, b] = await Promise.all([
      sessionA.runTurn({ prompt: 'a', timeoutMs: 1000 }),
      sessionB.runTurn({ prompt: 'b', timeoutMs: 1000 }),
    ]);
    expect(a.protocolValid && a.sessionId).toBe('sid-a');
    expect(b.protocolValid && b.sessionId).toBe('sid-b');
    expect(sessionA.sessionId).toBe('sid-a');
    expect(sessionB.sessionId).toBe('sid-b');
    await sessionA.shutdown();
    await sessionB.shutdown();
  }, TIMEOUT);

  it('never puts the prompt in argv and keeps shell false', async () => {
    let args: readonly string[] = [];
    let options: SpawnOptionsWithoutStdio | undefined;
    let stdin = '';
    const secret = 'cursor-secret-prompt';
    const session = cursorSession((_cmd, spawnArgs, spawnOptions) => {
      args = spawnArgs;
      options = spawnOptions;
      const child = createMockChild({ stdoutChunks: [resultLine({ session_id: 'sid-a' })] });
      child.stdin.on('data', (chunk: unknown) => {
        stdin += String(chunk);
      });
      return child;
    });
    await session.start();
    await session.runTurn({ prompt: secret, timeoutMs: 1000 });
    expect(args.join(' ')).not.toContain(secret);
    expect(options?.shell).toBe(false);
    expect(stdin).toContain(secret);
    await session.shutdown();
  }, TIMEOUT);
});

describe('Antigravity 0.7.2A fail-closed runtime', () => {
  it('captures the exact first conversation ID', async () => {
    const session = agySession(() => createMockChild({ stdoutChunks: [resultLine({ conversation_id: 'conv-a' })] }));
    await session.start();
    const result = await session.runTurn({ prompt: 't', timeoutMs: 1000 });
    expect(result.protocolValid).toBe(true);
    expect(session.sessionId).toBe('conv-a');
    await session.shutdown();
  }, TIMEOUT);

  it('fails when the first conversation ID is missing', async () => {
    const session = agySession(() => createMockChild({ stdoutChunks: [resultLine({})] }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/trusted conversation_id/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails on conflicting same-turn conversation IDs', async () => {
    const session = agySession(() => createMockChild({
      stdoutChunks: [
        `${JSON.stringify({ type: 'assistant', conversation_id: 'conv-a', content: 'x' })}\n`,
        resultLine({ conversation_id: 'conv-b' }),
      ],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/identity conflict/u);
    await session.shutdown();
  }, TIMEOUT);

  it('preserves conversation identity on a persistent second turn', async () => {
    const child = createMockChild({ persist: true, delayMs: 5, stdoutChunks: [] });
    const session = agySession(() => child);
    await session.start();
    setTimeout(() => {
      (child.stdout as PassThrough).write(resultLine({ conversation_id: 'conv-a' }));
    }, 8);
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    setTimeout(() => {
      (child.stdout as PassThrough).write(resultLine({ conversation_id: 'conv-a' }));
    }, 8);
    const second = await session.runTurn({ prompt: 't2', timeoutMs: 1000 });
    expect(second.protocolValid).toBe(true);
    expect(session.sessionId).toBe('conv-a');
    await session.shutdown();
  }, TIMEOUT);

  it('requires --conversation when the previous child is dead', async () => {
    const spawned: Array<{ args: readonly string[] }> = [];
    let n = 0;
    const session = agySession((_cmd, args) => {
      n += 1;
      spawned.push({ args });
      return createMockChild({ stdoutChunks: [resultLine({ conversation_id: 'conv-a' })] });
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await session.runTurn({ prompt: 't2', timeoutMs: 1000 });
    expect(spawned[0]?.args).not.toContain('--conversation');
    expect(spawned[1]?.args).toContain('--conversation');
    expect(spawned[1]?.args).toContain('conv-a');
    expect(n).toBe(2);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when a resumed process is missing conversation_id', async () => {
    let n = 0;
    const session = agySession(() => {
      n += 1;
      return createMockChild({
        stdoutChunks: [n === 1 ? resultLine({ conversation_id: 'conv-a' }) : resultLine({})],
      });
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/without returning conversation_id/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when a resumed process returns a different conversation_id', async () => {
    let n = 0;
    const session = agySession(() => {
      n += 1;
      return createMockChild({
        stdoutChunks: [resultLine({ conversation_id: n === 1 ? 'conv-a' : 'conv-b' })],
      });
    });
    await session.start();
    await session.runTurn({ prompt: 't1', timeoutMs: 1000 });
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/identity mismatch/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails closed on malformed stream JSON', async () => {
    const session = agySession(() => createMockChild({ stdoutChunks: ['{broken-json\n'] }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails closed on duplicate terminal frames', async () => {
    const session = agySession(() => createMockChild({
      stdoutChunks: [resultLine({ conversation_id: 'conv-a' }) + resultLine({ conversation_id: 'conv-a' })],
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/more than one terminal/u);
    await session.shutdown();
  }, TIMEOUT);

  it('fails when the process exits without a terminal frame', async () => {
    const session = agySession(() => createMockChild({
      stdoutChunks: [`${JSON.stringify({ type: 'assistant', conversation_id: 'conv-a', content: 'x' })}\n`],
      exitCode: 0,
    }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/without a terminal result/u);
    await session.shutdown();
  }, TIMEOUT);

  it('cleans the process after a fatal parser error', async () => {
    const session = agySession(() => createMockChild({ stdoutChunks: ['{broken\n'] }));
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/malformed JSON/u);
    await expect(session.runTurn({ prompt: 't2', timeoutMs: 1000 })).rejects.toThrow(/cleanup/u);
    await session.shutdown();
  }, TIMEOUT);

  it('rejects output overflow as a controlled failure', async () => {
    const session = agySession(
      () => createMockChild({ stdoutChunks: ['CCCCCCCCCC'] }),
      { streamParserOptions: { maxLineBytes: 100, maxTotalBytes: 8 } },
    );
    await session.start();
    await expect(session.runTurn({ prompt: 't', timeoutMs: 1000 })).rejects.toThrow(/exceeded limit/u);
    await session.shutdown();
  }, TIMEOUT);

  it('isolates conversation IDs across two concurrent Antigravity agents', async () => {
    const sessionA = agySession(() => createMockChild({ stdoutChunks: [resultLine({ conversation_id: 'conv-a' })] }));
    const sessionB = new AntigravityWorkerSession({
      context: { agentId: 'agent-agy-b', provider: 'antigravity' },
      config: { command: process.execPath },
      spawnProcess: () => createMockChild({ stdoutChunks: [resultLine({ conversation_id: 'conv-b' })] }),
    });
    await sessionA.start();
    await sessionB.start();
    const [a, b] = await Promise.all([
      sessionA.runTurn({ prompt: 'a', timeoutMs: 1000 }),
      sessionB.runTurn({ prompt: 'b', timeoutMs: 1000 }),
    ]);
    expect(a.protocolValid && a.conversationId).toBe('conv-a');
    expect(b.protocolValid && b.conversationId).toBe('conv-b');
    await sessionA.shutdown();
    await sessionB.shutdown();
  }, TIMEOUT);

  it('never puts the prompt in argv and keeps shell false', async () => {
    let args: readonly string[] = [];
    let options: SpawnOptionsWithoutStdio | undefined;
    let stdin = '';
    const secret = 'agy-secret-prompt';
    const session = agySession((_cmd, spawnArgs, spawnOptions) => {
      args = spawnArgs;
      options = spawnOptions;
      const child = createMockChild({ stdoutChunks: [resultLine({ conversation_id: 'conv-a' })] });
      child.stdin.on('data', (chunk: unknown) => {
        stdin += String(chunk);
      });
      return child;
    });
    await session.start();
    await session.runTurn({ prompt: secret, timeoutMs: 1000 });
    expect(args.join(' ')).not.toContain(secret);
    expect(options?.shell).toBe(false);
    expect(stdin).toContain(secret);
    await session.shutdown();
  }, TIMEOUT);
});

describe('Capability detector 0.7.2A', () => {
  it('returns EXECUTABLE_NOT_FOUND when Cursor executable is missing', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => {
        throw new CursorExecutableResolutionError('EXECUTABLE_NOT_FOUND', 'agent executable was not found');
      },
    });
    expect(detector.detect().status).toBe('EXECUTABLE_NOT_FOUND');
  }, TIMEOUT);

  it('returns PROBE_TIMEOUT when the Cursor version probe times out', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: () => ({ exitCode: null, stdout: '', stderr: '', error: 'spawnSync timeout' }),
    });
    expect(detector.detect().status).toBe('PROBE_TIMEOUT');
  }, TIMEOUT);

  it('does not mark Cursor READY when required runtime flags are missing', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 0, stdout: 'Usage: agent\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).not.toBe('READY');
    expect(report.usable).toBe(false);
  }, TIMEOUT);

  it('does not mark Cursor READY when resume capability is unavailable', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') {
          return { exitCode: 0, stdout: 'Usage: agent --print --output-format stream-json\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).not.toBe('READY');
    expect(report.capabilities.sessionContinuation).toBe(false);
  }, TIMEOUT);

  it('marks Cursor modelDiscovery unavailable when native discovery is not advertised', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0', stderr: '' };
        if (args[0] === '--help') {
          return { exitCode: 0, stdout: 'Usage: agent --print --output-format stream-json --resume id\n', stderr: '' };
        }
        if (args[0] === 'models') return { exitCode: 0, stdout: JSON.stringify(['should-not-run']), stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).toBe('READY');
    expect(report.modelDiscovery).toBe('unavailable');
    expect(report.models).toEqual([]);
  }, TIMEOUT);

  it('returns EXECUTABLE_NOT_FOUND when Antigravity executable is missing', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => {
        throw new Error('agy executable was not found');
      },
    });
    expect(detector.detect().status).toBe('EXECUTABLE_NOT_FOUND');
  }, TIMEOUT);

  it('does not mark Antigravity READY without stream-json capability', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') return { exitCode: 0, stdout: 'Usage: agy --headless --conversation id\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(detector.detect().status).not.toBe('READY');
  }, TIMEOUT);

  it('does not mark Antigravity READY without exact conversation continuation', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') {
          return { exitCode: 0, stdout: 'Usage: agy --input-format stream-json --output-format stream-json --headless\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const report = detector.detect();
    expect(report.status).not.toBe('READY');
    expect(report.capabilities.sessionContinuation).toBe(false);
  }, TIMEOUT);

  it('does not mark Antigravity READY without required headless mode', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_exe, args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: '0.9.0', stderr: '' };
        if (args[0] === '--help') {
          return { exitCode: 0, stdout: 'Usage: agy --input-format stream-json --output-format stream-json --conversation id\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(detector.detect().status).not.toBe('READY');
  }, TIMEOUT);

  it('returns PROBE_TIMEOUT when the Antigravity probe times out', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: () => ({ exitCode: null, stdout: '', stderr: '', error: 'ETIMEDOUT timeout' }),
    });
    expect(detector.detect().status).toBe('PROBE_TIMEOUT');
  }, TIMEOUT);
});

describe('Native model discovery 0.7.2A', () => {
  it('treats 0 native models as an authoritative empty native list', () => {
    expect(parseCursorModelsOutput('[]')).toEqual({ modelDiscovery: 'native', models: [] });
    expect(parseAntigravityModelsOutput('{"models":[]}')).toEqual({ modelDiscovery: 'native', models: [] });
  }, TIMEOUT);

  it('accepts exactly 1 and exactly 512 native models', () => {
    const one = parseCursorModelsOutput(JSON.stringify(['only-one']));
    expect(one.modelDiscovery).toBe('native');
    expect(one.models).toHaveLength(1);

    const models = Array.from({ length: 512 }, (_, i) => `model-${String(i)}`);
    const full = parseCursorModelsOutput(JSON.stringify(models));
    expect(full.modelDiscovery).toBe('native');
    expect(full.models).toHaveLength(512);

    const agyFull = parseAntigravityModelsOutput(JSON.stringify(models));
    expect(agyFull.modelDiscovery).toBe('native');
    expect(agyFull.models).toHaveLength(512);
  }, TIMEOUT);

  it('fails closed for 513 native models', () => {
    const models = Array.from({ length: 513 }, (_, i) => `model-${String(i)}`);
    expect(parseCursorModelsOutput(JSON.stringify(models)).modelDiscovery).toBe('unavailable');
    expect(parseAntigravityModelsOutput(JSON.stringify(models)).modelDiscovery).toBe('unavailable');
  }, TIMEOUT);

  it('fails closed for blank, NUL, oversize, malformed, unknown, and conflicting rows', () => {
    expect(parseCursorModelsOutput(JSON.stringify(['']))).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseCursorModelsOutput(JSON.stringify([`ok\0bad`])).modelDiscovery).toBe('unavailable');
    expect(parseCursorModelsOutput(JSON.stringify(['x'.repeat(300)])).modelDiscovery).toBe('unavailable');
    expect(parseCursorModelsOutput('{broken')).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseCursorModelsOutput(JSON.stringify({ unexpected: true })).modelDiscovery).toBe('unavailable');
    expect(parseCursorModelsOutput(JSON.stringify([
      { modelId: 'dup', label: 'A' },
      { modelId: 'dup', label: 'B' },
    ])).modelDiscovery).toBe('unavailable');

    expect(parseAntigravityModelsOutput(JSON.stringify(['']))).toEqual({ modelDiscovery: 'unavailable', models: [] });
    expect(parseAntigravityModelsOutput(JSON.stringify([`ok\0bad`])).modelDiscovery).toBe('unavailable');
    expect(parseAntigravityModelsOutput('{broken')).toEqual({ modelDiscovery: 'unavailable', models: [] });
  }, TIMEOUT);

  it('does not guess help or banner text as models', () => {
    expect(parseCursorModelsOutput('Usage: agent models\n# Available models\ncursor-fast').modelDiscovery).toBe('unavailable');
    expect(parseAntigravityModelsOutput('Warning: login required\ngemini-pro').modelDiscovery).toBe('unavailable');
  }, TIMEOUT);

  it('does not construct a Cursor parser success from leftover text after malformed JSON', () => {
    const parser = new CursorStreamParser();
    expect(() => parser.feed('{broken-json\n')).toThrow(/malformed JSON/u);
  }, TIMEOUT);
});
