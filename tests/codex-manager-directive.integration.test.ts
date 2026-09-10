import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexManagerUseCase } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));

describe('Codex Manager Directive integration', () => {
  it('returns a first-pass valid directive without a repair turn', async () => {
    const provider = createFixtureProvider('directive-valid');
    await provider.initialize();
    const result = await provider.runDirectiveTurn({ prompt: 'Return a directive.' });

    expect(result).toMatchObject({
      directiveStatus: 'valid',
      directive: { action: 'INFORM', taskId: 'FIXTURE', summary: 'OK' },
      initialTurn: { threadId: 'manager-thread-1', sessionId: 'manager-session-1', turnId: 'manager-turn-1', status: 'completed' },
    });
    expect(result.repairTurn).toBeUndefined();
    expect(outboundMethodCount(provider, 'thread/start')).toBe(1);
    expect(outboundMethodCount(provider, 'turn/start')).toBe(1);
    assertNoPendingWork(provider);
    await provider.shutdown();
  });

  it('repairs an invalid directive once while reusing the Manager thread', async () => {
    const provider = createFixtureProvider('directive-repair-success');
    await provider.initialize();
    const result = await provider.runDirectiveTurn({ prompt: 'Return a directive.' });

    expect(result).toMatchObject({
      directiveStatus: 'repaired',
      directive: { action: 'INFORM', taskId: 'FIXTURE', summary: 'OK' },
      initialTurn: { threadId: 'manager-thread-1', turnId: 'manager-turn-1' },
      repairTurn: { threadId: 'manager-thread-1', turnId: 'manager-turn-2' },
    });
    expect(outboundMethodCount(provider, 'thread/start')).toBe(1);
    expect(outboundMethodCount(provider, 'turn/start')).toBe(2);
    const diagnosticTypes = provider.client.diagnostics.snapshot().map((event) => event.type);
    expect(diagnosticTypes).toContain('directive.repair.start');
    expect(diagnosticTypes).toContain('directive.repair.completed');
    assertNoPendingWork(provider);
    await provider.shutdown();
  });

  it('returns invalid after one exhausted repair attempt', async () => {
    const provider = createFixtureProvider('directive-repair-invalid');
    await provider.initialize();
    const result = await provider.runDirectiveTurn({ prompt: 'Return a directive.' });

    expect(result).toMatchObject({
      directiveStatus: 'invalid',
      directive: null,
      failure: { kind: 'missing_directive' },
      initialTurn: { threadId: 'manager-thread-1' },
      repairTurn: { threadId: 'manager-thread-1' },
    });
    expect(outboundMethodCount(provider, 'thread/start')).toBe(1);
    expect(outboundMethodCount(provider, 'turn/start')).toBe(2);
    assertNoPendingWork(provider);
    await provider.shutdown();
  });
});

function createFixtureProvider(scenario: string): CodexManagerUseCase {
  return CodexManagerUseCase.create({
    command: process.execPath,
    args: [fixturePath, scenario],
    debug: true,
  }, { turnTimeoutMs: 2_000 });
}

function outboundMethodCount(provider: CodexManagerUseCase, method: string): number {
  return provider.client.diagnostics.snapshot()
    .filter((event) => event.type === 'outbound' && event.details.method === method)
    .length;
}

function assertNoPendingWork(provider: CodexManagerUseCase): void {
  expect(provider.client.requestManager.pendingCount).toBe(0);
  expect(provider.pendingTurnCount).toBe(0);
}
