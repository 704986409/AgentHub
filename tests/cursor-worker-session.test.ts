import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  CursorWorkerSession,
  CursorStreamParser,
  parseCursorModelsOutput,
  CursorCapabilityDetector,
  type AgentRuntimeContext,
} from '../src/index.js';

function createMockChildProcess(options: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  delayMs?: number;
}): {
  child: ChildProcessWithoutNullStreams;
  stdinData: string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinData: string[] = [];

  stdin.on('data', (chunk: unknown) => {
    stdinData.push(String(chunk));
  });

  const childEmitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(childEmitter, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    exitCode: null,
    kill: () => true,
  });

  setTimeout(() => {
    for (const chunk of options.stdoutChunks ?? []) {
      stdout.write(chunk);
    }
    for (const chunk of options.stderrChunks ?? []) {
      stderr.write(chunk);
    }
    const exitCode = options.exitCode ?? 0;
    (childEmitter as unknown as { exitCode: number }).exitCode = exitCode;
    childEmitter.emit('exit', exitCode, null);
  }, options.delayMs ?? 10);

  return { child: childEmitter, stdinData };
}

const context: AgentRuntimeContext = {
  agentId: 'agent-cursor-test',
  provider: 'cursor',
};

const validWorkerResultBlock = `<AGENTHUB_RESULT>\n${JSON.stringify({
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'Completed cursor test task',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
})}\n</AGENTHUB_RESULT>`;

describe('Cursor worker session & components', () => {
  it('runs turns without --resume on first turn and captures sessionId, then passes --resume on subsequent turns', async () => {
    const spawnedCalls: { cmd: string; args: readonly string[] }[] = [];

    const session = new CursorWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: (cmd: string, args: readonly string[]) => {
        spawnedCalls.push({ cmd, args });
        const jsonLine = JSON.stringify({
          type: 'result',
          session_id: 'session-cursor-abc',
          text: validWorkerResultBlock,
        }) + '\n';
        return createMockChildProcess({ stdoutChunks: [jsonLine] }).child;
      },
    });

    await session.start();
    expect(session.sessionId).toBeUndefined();

    // First turn: no --resume
    const turn1 = await session.runTurn({ prompt: 'first prompt' });
    expect(turn1.protocolValid).toBe(true);
    expect(session.sessionId).toBe('session-cursor-abc');
    expect(spawnedCalls[0]?.args).not.toContain('--resume');

    // Second turn: with --resume session-cursor-abc
    const turn2 = await session.runTurn({ prompt: 'second prompt' });
    expect(turn2.protocolValid).toBe(true);
    expect(spawnedCalls[1]?.args).toContain('--resume');
    expect(spawnedCalls[1]?.args).toContain('session-cursor-abc');

    await session.shutdown();
  }, 5_000);

  it('fails closed when resumed session identity mismatches', async () => {
    let callCount = 0;
    const session = new CursorWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: () => {
        callCount += 1;
        const sessionId = callCount === 1 ? 'session-original' : 'session-different';
        const jsonLine = JSON.stringify({
          type: 'result',
          session_id: sessionId,
          text: validWorkerResultBlock,
        }) + '\n';
        return createMockChildProcess({ stdoutChunks: [jsonLine] }).child;
      },
    });

    await session.start();
    await session.runTurn({ prompt: 'turn 1' });
    expect(session.sessionId).toBe('session-original');

    await expect(session.runTurn({ prompt: 'turn 2' })).rejects.toThrow(
      /Cursor resumed session identity mismatch/u,
    );

    await session.shutdown();
  }, 5_000);

  it('writes prompt strictly to stdin and never exposes prompt text in command arguments', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedStdin = '';

    const session = new CursorWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: (_cmd: string, args: readonly string[]) => {
        capturedArgs = args;
        const jsonLine = JSON.stringify({
          type: 'result',
          session_id: 'session-xyz',
          text: validWorkerResultBlock,
        }) + '\n';
        const mock = createMockChildProcess({ stdoutChunks: [jsonLine] });
        mock.child.stdin.on('data', (d: unknown) => {
          capturedStdin += String(d);
        });
        return mock.child;
      },
    });

    await session.start();
    const secretPrompt = 'super-secret-user-prompt-12345';
    await session.runTurn({ prompt: secretPrompt });

    expect(capturedArgs.join(' ')).not.toContain(secretPrompt);
    expect(capturedStdin).toContain(secretPrompt);

    await session.shutdown();
  }, 5_000);

  it('CursorStreamParser enforces line and total buffer bounds', () => {
    const parser = new CursorStreamParser({ maxLineBytes: 50, maxTotalBytes: 150 });

    // Exceeding line bounds
    const longLine = 'A'.repeat(60) + '\n';
    expect(() => parser.feed(longLine)).toThrow(/limit of 50 bytes/u);

    const parser2 = new CursorStreamParser({ maxLineBytes: 100, maxTotalBytes: 50 });
    expect(() => parser2.feed('B'.repeat(60))).toThrow(/maximum allowed size of 50 bytes/u);
  }, 5_000);

  it('parseCursorModelsOutput handles JSON, object list, and newline separated formats', () => {
    // 1. JSON array format
    const jsonOutput = JSON.stringify([
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ]);
    const parsedJson = parseCursorModelsOutput(jsonOutput);
    expect(parsedJson.modelDiscovery).toBe('native');
    expect(parsedJson.models).toHaveLength(2);
    expect(parsedJson.models[0]?.modelId).toBe('claude-3-5-sonnet');
    expect(parsedJson.models[0]?.label).toBe('Claude 3.5 Sonnet');

    const textOutput = `cursor-small
cursor-fast
`;
    const parsedText = parseCursorModelsOutput(textOutput);
    expect(parsedText.modelDiscovery).toBe('native');
    expect(parsedText.models.map((m: { modelId: string }) => m.modelId)).toEqual(['cursor-small', 'cursor-fast']);
  }, 5_000);

  it('CursorCapabilityDetector returns structured report', () => {
    const detector = new CursorCapabilityDetector({
      resolver: () => 'C:\\mock\\agent.cmd',
      runner: (_executable, args) => {
        if (args[0] === '--version') {
          return { exitCode: 0, stdout: 'agent 1.2.3\n', stderr: '' };
        }
        if (args[0] === '--help') {
          return {
            exitCode: 0,
            stdout: 'Usage: agent --print --output-format stream-json --resume <id>\nCommands:\n  models\n',
            stderr: '',
          };
        }
        if (args[0] === 'models') {
          return { exitCode: 0, stdout: '[]\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const report = detector.detect();
    expect(report.providerId).toBe('cursor');
    expect(report.supported).toBe(true);
    expect(report.usable).toBe(true);
    expect(report.installed).toBe(true);
    expect(report.version).toContain('1.2.3');
  }, 5_000);
});
