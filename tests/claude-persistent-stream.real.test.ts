import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ClaudeCapabilityDetector,
  ClaudePersistentStreamTransport,
  type ClaudeRawMessage,
} from '../src/index.js';

const runRealClaude = process.env.RUN_REAL_CLAUDE_TESTS === '1';

describe.skipIf(!runRealClaude)('real Claude persistent-stream transport', () => {
  it('retains a random marker across two turns in one process', async () => {
    const report = new ClaudeCapabilityDetector().detect();
    expect(report.capabilities.installed).toBe(true);
    expect(report.capabilities.inputStreamJson).toBe(true);
    expect(report.capabilities.outputStreamJson).toBe(true);
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-claude-persistent-'));
    const marker = `AGENTHUB_PERSISTENT_${randomUUID()}`;
    const messagesByTurn: ClaudeRawMessage[][] = [[], []];
    let turnIndex = 0;
    const transport = new ClaudePersistentStreamTransport({
      command: report.capabilities.executablePath,
      cwd,
      model: 'sonnet',
      turnTimeoutMs: 120_000,
      disableTools: true,
      onRawMessage: (message) => messagesByTurn[turnIndex]?.push(message),
      onStderr: () => undefined,
    });

    try {
      await transport.start();
      const startedProcessId = transport.processId;
      const first = await transport.runTurn({
        prompt: `Remember this exact marker: ${marker}\nReply only READY.`,
      });
      expect(transport.running).toBe(true);
      turnIndex = 1;
      const second = await transport.runTurn({
        prompt: 'What exact marker did I ask you to remember? Reply with only that marker.',
      });
      const firstMessages = messagesByTurn[0];
      const secondMessages = messagesByTurn[1];
      if (firstMessages === undefined || secondMessages === undefined) throw new Error('Missing real turn messages');

      expect(first.processId).toBe(startedProcessId);
      expect(second.processId).toBe(startedProcessId);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.resultText).toContain(marker);
      expect(first.messageTypes).toEqual(expect.arrayContaining(['assistant', 'result']));
      expect(second.messageTypes).toEqual(expect.arrayContaining(['assistant', 'result']));
      expect(messageTypes(firstMessages)).toEqual(expect.arrayContaining(['system', 'assistant', 'result']));
      expect(messageTypes(secondMessages)).toEqual(expect.arrayContaining(['assistant', 'result']));
      expect(sessionIds(firstMessages)).toContain(first.sessionId);
      expect(sessionIds(secondMessages)).toContain(first.sessionId);
      expect(transport.running).toBe(true);
      expect(transport.active).toBe(false);
    } finally {
      await transport.shutdown();
      expect(transport.running).toBe(false);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 250_000);
});

function messageTypes(messages: readonly ClaudeRawMessage[]): string[] {
  return messages.map((message) => message.type).filter((type): type is string => typeof type === 'string');
}

function sessionIds(messages: readonly ClaudeRawMessage[]): string[] {
  return messages
    .map((message) => message.session_id)
    .filter((sessionId): sessionId is string => typeof sessionId === 'string');
}
