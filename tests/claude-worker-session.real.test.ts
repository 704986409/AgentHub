import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ClaudeCapabilityDetector,
  ClaudeWorkerSession,
  EventBus,
  type ClaudeCapabilityReport,
  type ClaudeWorkerTurnResult,
} from '../src/index.js';

const runRealClaude = process.env.RUN_REAL_CLAUDE_TESTS === '1';

describe.skipIf(!runRealClaude)('real Claude worker session', () => {
  it('runs an explicit NEEDS_INPUT revision in one Persistent Auto session', async () => {
    const capabilityReport = new ClaudeCapabilityDetector().detect();
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-worker-persistent-'));
    const marker = `AGENTHUB_WORKER_PERSISTENT_${randomUUID()}`;
    const session = createRealSession(capabilityReport, cwd);
    let processId: number | undefined;

    try {
      await session.start();
      expect(session.selectedTransport).toBe('persistent-stream');
      const first = await session.runTurn({
        prompt: firstTurnPrompt(marker),
        timeoutMs: 120_000,
      });
      assertWorkerOutcome(first, 'NEEDS_INPUT');
      processId = first.processId;

      const second = await session.runRevision({
        prompt: revisionPrompt(marker),
        timeoutMs: 120_000,
      });
      assertWorkerOutcome(second, 'COMPLETED');
      expect(second.transport).toBe('persistent-stream');
      expect(second.sessionId).toBe(first.sessionId);
      if (first.processId !== undefined && second.processId !== undefined) {
        expect(second.processId).toBe(first.processId);
      }
      expect(second.workerResult.summary).toContain(marker);
    } finally {
      await session.shutdown();
      if (processId !== undefined) await expectProcessExited(processId);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  it('runs an explicit NEEDS_INPUT revision through Resume Auto fallback', async () => {
    const detected = new ClaudeCapabilityDetector().detect();
    const capabilityReport = withInputStreamUnsupported(detected);
    const cwd = mkdtempSync(join(tmpdir(), 'agenthub-worker-resume-'));
    const marker = `AGENTHUB_WORKER_RESUME_${randomUUID()}`;
    const session = createRealSession(capabilityReport, cwd);
    const processIds: number[] = [];

    try {
      await session.start();
      expect(session.selectedTransport).toBe('resume-per-turn');
      const first = await session.runTurn({
        prompt: firstTurnPrompt(marker),
        timeoutMs: 120_000,
      });
      assertWorkerOutcome(first, 'NEEDS_INPUT');
      expect(first.fallback?.reason).toBe('PERSISTENT_CAPABILITY_UNSUPPORTED');
      if (first.processId !== undefined) processIds.push(first.processId);

      const second = await session.runRevision({
        prompt: revisionPrompt(marker),
        timeoutMs: 120_000,
      });
      assertWorkerOutcome(second, 'COMPLETED');
      expect(second.transport).toBe('resume-per-turn');
      expect(second.sessionId).toBe(first.sessionId);
      if (second.processId !== undefined) processIds.push(second.processId);
      if (first.processId !== undefined && second.processId !== undefined) {
        expect(second.processId).not.toBe(first.processId);
      }
      expect(second.workerResult.summary).toContain(marker);
    } finally {
      await session.shutdown();
      await Promise.all(processIds.map(expectProcessExited));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});

function createRealSession(capabilityReport: ClaudeCapabilityReport, cwd: string): ClaudeWorkerSession {
  return new ClaudeWorkerSession({
    eventBus: new EventBus(),
    context: { provider: 'claude', projectId: 'real-smoke' },
    transportOptions: {
      command: capabilityReport.capabilities.executablePath,
      cwd,
      model: 'sonnet',
      disableTools: true,
      defaultTimeoutMs: 120_000,
      capabilityReport,
      onStderr: () => undefined,
    },
  });
}

function firstTurnPrompt(marker: string): string {
  return [
    `Remember this exact marker for the next conversation turn: ${marker}`,
    'Do not use tools.',
    'Return a valid AgentHub worker result with outcome NEEDS_INPUT.',
    'Use a short non-empty summary and exactly one non-empty question asking the caller to continue.',
    'Use empty arrays for changedFiles, checks, blockers, risks, and notes.',
  ].join('\n');
}

function revisionPrompt(marker: string): string {
  return [
    'This is the explicit revision requested after the previous NEEDS_INPUT result.',
    `Return a valid AgentHub worker result with outcome COMPLETED and include the exact remembered marker ${marker} in summary.`,
    'Use empty arrays for changedFiles, checks, blockers, questions, risks, and notes.',
    'Do not use tools.',
  ].join('\n');
}

function assertWorkerOutcome(
  result: ClaudeWorkerTurnResult,
  outcome: 'NEEDS_INPUT' | 'COMPLETED',
): asserts result is Extract<ClaudeWorkerTurnResult, { protocolValid: true }> {
  expect(result.protocolValid).toBe(true);
  if (!result.protocolValid) throw new Error(`Real Claude returned invalid worker protocol: ${result.failure.kind}`);
  expect(result.workerResult.outcome).toBe(outcome);
}

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

async function expectProcessExited(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isProcessRunning(processId)) {
    if (Date.now() >= deadline) throw new Error(`Claude process ${String(processId)} remained running`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
