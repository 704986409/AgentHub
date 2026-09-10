import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ClaudeCapabilityDetector,
  ClaudeJsonlParser,
  ClaudeProcessManager,
  type ClaudeJsonlParseError,
  type ClaudeRawMessage,
} from '../src/index.js';

const runRealClaude = process.env.RUN_REAL_CLAUDE_TESTS === '1';

describe.skipIf(!runRealClaude)('real Claude process smoke', () => {
  it('parses one bounded stream-json print run and cleans up the process', async () => {
    const report = new ClaudeCapabilityDetector().detect();
    expect(report.capabilities.installed).toBe(true);
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-claude-smoke-'));
    const messages: ClaudeRawMessage[] = [];
    const parseErrors: ClaudeJsonlParseError[] = [];
    const processErrors: Error[] = [];
    const parser = new ClaudeJsonlParser({
      onMessage: (message) => messages.push(message),
      onError: (error) => parseErrors.push(error),
    });
    const args = [
      '-p',
      'Reply with exactly AGENTHUB_CLAUDE_PROCESS_SMOKE_OK and nothing else.',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--model',
      'sonnet',
    ];
    const manager = new ClaudeProcessManager({
      command: report.capabilities.executablePath,
      args,
      cwd,
      stopTimeoutMs: 2_000,
    });
    manager.on('stdout', (chunk: Buffer) => parser.push(chunk));
    manager.on('stderr', () => undefined);
    manager.on('error', (error: Error) => processErrors.push(error));

    try {
      await manager.start();
      const exit = await withTimeout(manager.waitForExit(), 120_000, async () => await manager.stop());
      parser.end();
      const types = messages.map((message) => message.type).filter((type): type is string => typeof type === 'string');
      const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
      const result = messages.find((message) => message.type === 'result');

      expect(exit).toEqual({ code: 0, signal: null });
      expect(types).toContain('system');
      expect(types).toContain('assistant');
      expect(types).toContain('result');
      expect(typeof init?.session_id).toBe('string');
      expect(JSON.stringify(result)).toContain('AGENTHUB_CLAUDE_PROCESS_SMOKE_OK');
      expect(parseErrors).toEqual([]);
      expect(processErrors).toEqual([]);
      expect(manager.running).toBe(false);
      expect(manager.pid).toBeUndefined();
    } finally {
      await manager.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 135_000);
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new Error(`Real Claude smoke timed out after ${String(timeoutMs)}ms`)));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
