import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ClaudeAutoTransport,
  ClaudeCapabilityDetector,
  type ClaudeCapabilityReport,
} from '../src/index.js';

const runRealClaude = process.env.RUN_REAL_CLAUDE_TESTS === '1';

describe.skipIf(!runRealClaude)('real Claude Auto transport', () => {
  it('prefers Persistent and retains context in one process', async () => {
    const report = new ClaudeCapabilityDetector().detect();
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-claude-auto-persistent-'));
    const marker = `AGENTHUB_AUTO_PERSISTENT_${randomUUID()}`;
    const fallbacks: string[] = [];
    const auto = new ClaudeAutoTransport({
      command: report.capabilities.executablePath,
      cwd,
      model: 'sonnet',
      disableTools: true,
      defaultTimeoutMs: 120_000,
      capabilityReport: report,
      onFallback: (event) => fallbacks.push(event.reason),
      onStderr: () => undefined,
    });

    try {
      await auto.start();
      expect(auto.selectedTransport).toBe('persistent-stream');
      const first = await auto.runTurn({ prompt: `Remember this exact marker: ${marker}\nReply only READY.` });
      const second = await auto.runTurn({
        prompt: 'What exact marker did I ask you to remember? Reply with only that marker.',
      });

      expect(first.transport).toBe('persistent-stream');
      expect(second.transport).toBe('persistent-stream');
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.processId).toBe(first.processId);
      expect(second.resultText).toContain(marker);
      expect(fallbacks).toEqual([]);
      expect(auto.lastFallback).toBeUndefined();
    } finally {
      await auto.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 250_000);

  it('selects Resume from explicit capability evidence and retains context across processes', async () => {
    const detected = new ClaudeCapabilityDetector().detect();
    const report = withInputStreamUnsupported(detected);
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-claude-auto-resume-'));
    const marker = `AGENTHUB_AUTO_RESUME_${randomUUID()}`;
    const fallbacks: string[] = [];
    const auto = new ClaudeAutoTransport({
      command: detected.capabilities.executablePath,
      cwd,
      model: 'sonnet',
      disableTools: true,
      defaultTimeoutMs: 120_000,
      capabilityReport: report,
      onFallback: (event) => fallbacks.push(event.reason),
      onStderr: () => undefined,
    });

    try {
      await auto.start();
      expect(auto.selectedTransport).toBe('resume-per-turn');
      expect(auto.lastFallback?.reason).toBe('PERSISTENT_CAPABILITY_UNSUPPORTED');
      const first = await auto.runTurn({ prompt: `Remember this exact marker: ${marker}\nReply only READY.` });
      const second = await auto.runTurn({
        prompt: 'What exact marker did I ask you to remember? Reply with only that marker.',
      });

      expect(first.transport).toBe('resume-per-turn');
      expect(second.transport).toBe('resume-per-turn');
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.processId).not.toBe(first.processId);
      expect(second.resultText).toContain(marker);
      expect(fallbacks).toEqual(['PERSISTENT_CAPABILITY_UNSUPPORTED']);
    } finally {
      await auto.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 250_000);
});

function withInputStreamUnsupported(report: ClaudeCapabilityReport): ClaudeCapabilityReport {
  const checks = report.checks.map((check) => check.capability === 'inputStreamJson'
    ? { ...check, supported: false, evidence: 'unsupported' as const }
    : { ...check });
  return {
    ...report,
    capabilities: { ...report.capabilities, inputStreamJson: false },
    checks,
    unknownCapabilities: report.unknownCapabilities.filter((name) => name !== 'inputStreamJson'),
    unsupportedCapabilities: [...new Set([...report.unsupportedCapabilities, 'inputStreamJson' as const])],
  };
}
