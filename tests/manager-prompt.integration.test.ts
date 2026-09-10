import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexProvider, type ManagerPromptEnvelope } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));

describe('Manager prompt integration', () => {
  it('builds the envelope and routes it through the existing directive turn', async () => {
    const provider = createFixtureProvider('manager-prompt-valid');
    await provider.initialize();
    const result = await provider.runManagerPlanningTurn(createEnvelope());

    expect(result).toMatchObject({
      directiveStatus: 'valid',
      directive: { action: 'INFORM', taskId: 'ENVELOPE', summary: 'PROMPT_CONTEXT_RECEIVED' },
      initialTurn: { threadId: 'manager-thread-1', turnId: 'manager-turn-1', status: 'completed' },
    });
    expect(outboundMethodCount(provider, 'thread/start')).toBe(1);
    expect(outboundMethodCount(provider, 'turn/start')).toBe(1);
    expect(provider.client.diagnostics.snapshot().map((event) => event.type)).toEqual(expect.arrayContaining([
      'manager_prompt.build.start',
      'manager_prompt.build.success',
      'directive.parse.success',
    ]));
    assertNoPendingWork(provider);
    await provider.shutdown();
  });

  it('retains the existing single repair behavior behind the planning entry point', async () => {
    const provider = createFixtureProvider('directive-repair-success');
    await provider.initialize();
    const result = await provider.runManagerPlanningTurn(createEnvelope());

    expect(result.directiveStatus).toBe('repaired');
    expect(result.directive?.action).toBe('INFORM');
    expect(result.initialTurn.threadId).toBe(result.repairTurn?.threadId);
    expect(outboundMethodCount(provider, 'thread/start')).toBe(1);
    expect(outboundMethodCount(provider, 'turn/start')).toBe(2);
    assertNoPendingWork(provider);
    await provider.shutdown();
  });
});

function createEnvelope(): ManagerPromptEnvelope {
  return {
    rolePrompt: 'Development Manager role',
    project: {
      workspacePath: 'D:\\Code\\Demo',
      targetBranch: 'main',
      repositoryRules: ['Use TypeScript', 'No destructive Git'],
    },
    userRequirement: 'Add save support',
    task: {
      taskId: 'TASK-0001',
      title: 'Save support',
      description: 'Plan the requested change.',
      acceptanceCriteria: ['Return a directive'],
      revision: 0,
    },
  };
}

function createFixtureProvider(scenario: string): CodexProvider {
  return new CodexProvider({
    command: process.execPath,
    args: [fixturePath, scenario],
    debug: true,
    managerTurnTimeoutMs: 2_000,
  });
}

function outboundMethodCount(provider: CodexProvider, method: string): number {
  return provider.client.diagnostics.snapshot()
    .filter((event) => event.type === 'outbound' && event.details.method === method)
    .length;
}

function assertNoPendingWork(provider: CodexProvider): void {
  expect(provider.client.requestManager.pendingCount).toBe(0);
  expect(provider.pendingTurnCount).toBe(0);
}
