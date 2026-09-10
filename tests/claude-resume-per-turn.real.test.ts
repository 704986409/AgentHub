import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ClaudeCapabilityDetector,
  ClaudeResumePerTurnTransport,
  type ClaudeRawMessage,
} from '../src/index.js';

const runRealClaude = process.env.RUN_REAL_CLAUDE_TESTS === '1';

describe.skipIf(!runRealClaude)('real Claude resume-per-turn transport', () => {
  it('continues a random marker through two separate Claude processes', async () => {
    const report = new ClaudeCapabilityDetector().detect();
    expect(report.capabilities.installed).toBe(true);
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-claude-resume-'));
    const marker = `AGENTHUB_RESUME_${randomUUID()}`;
    const messagesByTurn: ClaudeRawMessage[][] = [[], []];
    let turnIndex = 0;
    const transport = new ClaudeResumePerTurnTransport({
      command: report.capabilities.executablePath,
      defaultCwd: cwd,
      defaultModel: 'sonnet',
      defaultTimeoutMs: 120_000,
      disableTools: true,
      onRawMessage: (message) => messagesByTurn[turnIndex]?.push(message),
      onStderr: () => undefined,
    });

    try {
      const fresh = await transport.runTurn({
        prompt: `Remember this exact marker: ${marker}\nReply only READY.`,
      });
      turnIndex = 1;
      const resumed = await transport.runTurn({
        prompt: 'What exact marker did I ask you to remember? Reply with only that marker.',
        sessionId: fresh.sessionId,
      });
      const firstMessages = messagesByTurn[0];
      const secondMessages = messagesByTurn[1];
      if (firstMessages === undefined || secondMessages === undefined) throw new Error('Missing real turn messages');

      expect(fresh.exitCode).toBe(0);
      expect(resumed.exitCode).toBe(0);
      expect(resumed.sessionId).toBe(fresh.sessionId);
      expect(resumed.resultText).toContain(marker);
      expect(fresh.processId).not.toBeUndefined();
      expect(resumed.processId).not.toBeUndefined();
      expect(resumed.processId).not.toBe(fresh.processId);
      expect(messageTypes(firstMessages)).toEqual(expect.arrayContaining(['system', 'assistant', 'result']));
      expect(messageTypes(secondMessages)).toEqual(expect.arrayContaining(['system', 'assistant', 'result']));
      expect(sessionIdFor(firstMessages, 'system')).toBe(fresh.sessionId);
      expect(sessionIdFor(firstMessages, 'result')).toBe(fresh.sessionId);
      expect(sessionIdFor(secondMessages, 'system')).toBe(fresh.sessionId);
      expect(sessionIdFor(secondMessages, 'result')).toBe(fresh.sessionId);
      expect(transport.active).toBe(false);
    } finally {
      await transport.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 250_000);
});

function messageTypes(messages: readonly ClaudeRawMessage[]): string[] {
  return messages.map((message) => message.type).filter((type): type is string => typeof type === 'string');
}

function sessionIdFor(messages: readonly ClaudeRawMessage[], type: string): string | undefined {
  const message = messages.find((candidate) => candidate.type === type);
  return typeof message?.session_id === 'string' ? message.session_id : undefined;
}
