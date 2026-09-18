import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  AntigravityWorkerSession,
  AntigravityStreamParser,
  parseAntigravityModelsOutput,
  AntigravityCapabilityDetector,
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
    pid: 23456,
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
  agentId: 'agent-agy-test',
  provider: 'antigravity',
};

const validWorkerResultBlock = `<AGENTHUB_RESULT>\n${JSON.stringify({
  protocolVersion: 1,
  outcome: 'COMPLETED',
  summary: 'Completed antigravity test task',
  changedFiles: [],
  checks: [],
  blockers: [],
  questions: [],
  risks: [],
  notes: [],
})}\n</AGENTHUB_RESULT>`;

describe('Antigravity worker session & components', () => {
  it('runs turn and captures conversationId from stream frames', async () => {
    const spawnedCalls: { cmd: string; args: readonly string[] }[] = [];

    const session = new AntigravityWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: (cmd: string, args: readonly string[]) => {
        spawnedCalls.push({ cmd, args });
        const jsonLine = JSON.stringify({
          type: 'result',
          conversation_id: 'conv-antigravity-999',
          text: validWorkerResultBlock,
        }) + '\n';
        return createMockChildProcess({ stdoutChunks: [jsonLine] }).child;
      },
    });

    await session.start();
    expect(session.sessionId).toBeUndefined();

    const turnResult = await session.runTurn({ prompt: 'hello antigravity' });
    expect(turnResult.protocolValid).toBe(true);
    expect(session.sessionId).toBe('conv-antigravity-999');
    expect(turnResult.conversationId).toBe('conv-antigravity-999');

    await session.shutdown();
  }, 5_000);

  it('fails closed when conversation identity mismatches', async () => {
    let callCount = 0;
    const session = new AntigravityWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: () => {
        callCount += 1;
        const cid = callCount === 1 ? 'conv-first' : 'conv-second';
        const jsonLine = JSON.stringify({
          type: 'result',
          conversation_id: cid,
          text: validWorkerResultBlock,
        }) + '\n';
        return createMockChildProcess({ stdoutChunks: [jsonLine] }).child;
      },
    });

    await session.start();
    await session.runTurn({ prompt: 'turn 1' });
    expect(session.sessionId).toBe('conv-first');

    await expect(session.runTurn({ prompt: 'turn 2' })).rejects.toThrow(
      /Antigravity conversation identity mismatch/u,
    );

    await session.shutdown();
  }, 5_000);

  it('writes structured JSON frame strictly to stdin and never exposes prompt in command arguments', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedStdin = '';

    const session = new AntigravityWorkerSession({
      context,
      config: { command: process.execPath },
      spawnProcess: (_cmd: string, args: readonly string[]) => {
        capturedArgs = args;
        const jsonLine = JSON.stringify({
          type: 'result',
          conversation_id: 'conv-secret',
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
    const promptText = 'secret-antigravity-instructions';
    await session.runTurn({ prompt: promptText });

    expect(capturedArgs.join(' ')).not.toContain(promptText);
    expect(capturedStdin).toContain(promptText);
    expect(capturedStdin).toContain('"type":"user_message"');

    await session.shutdown();
  }, 5_000);

  it('AntigravityStreamParser enforces line and total buffer bounds', () => {
    const parser = new AntigravityStreamParser({ maxLineBytes: 40, maxTotalBytes: 120 });

    const longLine = 'Z'.repeat(50) + '\n';
    expect(() => parser.feed(longLine)).toThrow(/limit of 40 bytes/u);

    const parser2 = new AntigravityStreamParser({ maxLineBytes: 100, maxTotalBytes: 40 });
    expect(() => parser2.feed('Y'.repeat(50))).toThrow(/limit of 40 bytes/u);
  }, 5_000);

  it('parseAntigravityModelsOutput handles JSON, object list, and newline separated formats', () => {
    // 1. JSON format
    const jsonOutput = JSON.stringify([
      { modelId: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      { modelId: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    ]);
    const parsedJson = parseAntigravityModelsOutput(jsonOutput);
    expect(parsedJson.modelDiscovery).toBe('native');
    expect(parsedJson.models).toHaveLength(2);
    expect(parsedJson.models[0]?.modelId).toBe('gemini-1.5-pro');

    const textOutput = `gemini-2.0-flash
gemini-1.5-pro
`;
    const parsedText = parseAntigravityModelsOutput(textOutput);
    expect(parsedText.modelDiscovery).toBe('unavailable');
    expect(parsedText.models).toEqual([]);
  }, 5_000);

  it('AntigravityCapabilityDetector returns structured report', () => {
    const detector = new AntigravityCapabilityDetector({
      resolver: () => 'C:\\mock\\agy.cmd',
      runner: (_executable, args) => {
        if (args[0] === '--version') {
          return { exitCode: 0, stdout: 'agy 0.9.0\n', stderr: '' };
        }
        if (args[0] === '--help') {
          return {
            exitCode: 0,
            stdout: 'Usage: agy --input-format stream-json --output-format stream-json --conversation <id> --headless\nCommands:\n  models\n',
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
    expect(report.providerId).toBe('antigravity');
    expect(report.supported).toBe(true);
    expect(report.usable).toBe(true);
    expect(report.installed).toBe(true);
    expect(report.version).toContain('0.9.0');
  }, 5_000);
});
