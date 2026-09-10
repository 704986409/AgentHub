import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaudeProcessManager,
  ClaudeResumePerTurnTransport,
  ClaudeTurnError,
  buildClaudeTurnArgs,
  type ClaudeProcessManagerOptions,
  type ClaudeRawMessage,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude/fake-claude-process.mjs', import.meta.url));

class FixtureHarness {
  readonly calls: ClaudeProcessManagerOptions[] = [];
  readonly managers: ClaudeProcessManager[] = [];

  public constructor(private readonly scenarios: string[]) {}

  public readonly createProcess = (options: ClaudeProcessManagerOptions): ClaudeProcessManager => {
    const scenario = this.scenarios[this.calls.length];
    if (scenario === undefined) throw new Error('No fixture scenario configured');
    this.calls.push(options);
    const manager = new ClaudeProcessManager({
      command: process.execPath,
      args: [fixturePath, scenario, ...(options.args ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stopTimeoutMs: 75,
    });
    this.managers.push(manager);
    return manager;
  };

  public allStopped(): boolean {
    return this.managers.every((manager) => !manager.running && manager.pid === undefined);
  }
}

describe('Claude resume-per-turn transport', () => {
  it('builds fresh and exact resume argv without continue, fork, or session-id', () => {
    const prompt = 'hello & echo HACKED | whoami ^ %PATH% "quotes"\nnext line';
    const fresh = buildClaudeTurnArgs({ prompt, model: 'sonnet' });
    const resumed = buildClaudeTurnArgs({ prompt, sessionId: 'session-A' });

    expect(fresh).toEqual(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet']);
    expect(resumed).toEqual(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--resume', 'session-A']);
    expect(resumed).not.toContain('--continue');
    expect(resumed).not.toContain('-c');
    expect(resumed).not.toContain('--fork-session');
    expect(resumed).not.toContain('--session-id');
  });

  it('runs fresh and resumed turns in distinct processes with the same exact session', async () => {
    const harness = new FixtureHarness(['turn-success', 'turn-success']);
    const rawPids: number[] = [];
    const transport = createTransport(harness, {
      onRawMessage: (message) => {
        if (message.type === 'system' && typeof message.pid === 'number') rawPids.push(message.pid);
      },
    });

    const fresh = await transport.runTurn({ prompt: 'turn 1' });
    const resumed = await transport.runTurn({ prompt: 'turn 2', sessionId: fresh.sessionId });

    expect(fresh).toMatchObject({ sessionId: 'session-A', resultText: 'first-ok', exitCode: 0, resumed: false });
    expect(resumed).toMatchObject({ sessionId: 'session-A', resultText: 'second-ok', exitCode: 0, resumed: true });
    expect(fresh.messageTypes).toEqual(['system', 'assistant', 'result']);
    expect(resumed.messageTypes).toEqual(['system', 'assistant', 'result']);
    expect(harness.calls).toHaveLength(2);
    expect(rawPids).toHaveLength(2);
    expect(rawPids[0]).not.toBe(rawPids[1]);
    expect(argsFor(harness, 0)).not.toContain('--resume');
    expect(readOption(argsFor(harness, 1), '--resume')).toBe('session-A');
    expect(harness.allStopped()).toBe(true);
  });

  it.each([
    ['missing-result', undefined, 'CLAUDE_RESULT_MISSING'],
    ['missing-session', undefined, 'CLAUDE_SESSION_ID_MISSING'],
    ['init-result-mismatch', undefined, 'CLAUDE_SESSION_ID_MISMATCH'],
    ['resume-return-mismatch', 'session-A', 'CLAUDE_SESSION_ID_MISMATCH'],
    ['duplicate-result', undefined, 'CLAUDE_DUPLICATE_RESULT'],
    ['error-result', undefined, 'CLAUDE_TURN_FAILED'],
    ['nonzero-result', undefined, 'CLAUDE_TURN_PROCESS_FAILED'],
  ])('rejects invalid terminal scenario %s and cleans up', async (scenario, sessionId, code) => {
    const harness = new FixtureHarness([scenario]);
    const transport = createTransport(harness);
    await expect(transport.runTurn({ prompt: 'test', ...(sessionId === undefined ? {} : { sessionId }) }))
      .rejects.toMatchObject({ code });
    expect(harness.allStopped()).toBe(true);
    expect(transport.active).toBe(false);
  });

  it('kills a hanging process after parser failure and releases the guard', async () => {
    const harness = new FixtureHarness(['parser-error-hang', 'turn-success']);
    const transport = createTransport(harness);

    const error = await captureFailure(transport.runTurn({ prompt: 'bad stream', timeoutMs: 2_000 }));
    expect(error).toBeInstanceOf(ClaudeTurnError);
    expect(error).toMatchObject({ code: 'CLAUDE_STREAM_PROTOCOL_ERROR' });
    if (!(error instanceof Error)) throw new Error('Expected ClaudeTurnError');
    expect(error.cause).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON' });
    expect(harness.allStopped()).toBe(true);
    await expect(transport.runTurn({ prompt: 'after failure' })).resolves.toMatchObject({ resultText: 'first-ok' });
    expect(harness.allStopped()).toBe(true);
  });

  it('times out result-without-exit, kills the child, and releases the guard', async () => {
    const harness = new FixtureHarness(['result-hang', 'turn-success']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'hang', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_TIMEOUT',
    });
    expect(harness.allStopped()).toBe(true);
    await expect(transport.runTurn({ prompt: 'after timeout' })).resolves.toMatchObject({ resultText: 'first-ok' });
    expect(harness.allStopped()).toBe(true);
  });

  it('fails fast for a concurrent turn without creating a second process', async () => {
    const harness = new FixtureHarness(['hang']);
    const transport = createTransport(harness);
    const first = transport.runTurn({ prompt: 'first', timeoutMs: 30 });

    await expect(transport.runTurn({ prompt: 'second' })).rejects.toMatchObject({ code: 'CLAUDE_TURN_ALREADY_ACTIVE' });
    expect(harness.calls).toHaveLength(1);
    await expect(first).rejects.toMatchObject({ code: 'CLAUDE_TURN_TIMEOUT' });
    expect(harness.allStopped()).toBe(true);
  });

  it('never falls back to a fresh process after exact resume failure', async () => {
    const harness = new FixtureHarness(['resume-fail']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'resume', sessionId: 'session-X' })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_PROCESS_FAILED',
    });
    expect(harness.calls).toHaveLength(1);
    expect(readOption(argsFor(harness, 0), '--resume')).toBe('session-X');
    expect(harness.allStopped()).toBe(true);
  });

  it('preserves a hostile-looking prompt as one argv element', async () => {
    const harness = new FixtureHarness(['prompt-args']);
    const transport = createTransport(harness);
    const prompt = 'hello & echo INJECTED | whoami ^ %PATH% "quotes"\nline two';
    const result = await transport.runTurn({ prompt });

    expect(result.resultText).toBe(prompt);
    expect(argsFor(harness, 0).filter((argument) => argument === prompt)).toHaveLength(1);
    expect(harness.allStopped()).toBe(true);
  });

  it('overlays child environment without modifying or dropping the parent environment', async () => {
    const harness = new FixtureHarness(['env-overlay']);
    const original = process.env.AGENTHUB_TEST_ENV;
    const transport = createTransport(harness, { env: { AGENTHUB_TEST_ENV: 'yes' } });
    const result = await transport.runTurn({ prompt: 'env' });

    expect(JSON.parse(result.resultText)).toEqual({ inheritedPath: true, custom: 'yes' });
    expect(process.env.AGENTHUB_TEST_ENV).toBe(original);
    expect(harness.allStopped()).toBe(true);
  });

  it.each([
    { request: { prompt: '' }, description: 'blank prompt' },
    { request: { prompt: 'ok', sessionId: ' ' }, description: 'blank session' },
    { request: { prompt: 'ok', model: '' }, description: 'blank model' },
    { request: { prompt: 'ok', timeoutMs: 0 }, description: 'zero timeout' },
    {
      request: { prompt: 'ok', timeoutMs: Number.POSITIVE_INFINITY },
      description: 'infinite timeout',
    },
  ])('rejects invalid requests before process creation: $description', async ({ request }) => {
    const harness = new FixtureHarness([]);
    const transport = createTransport(harness);
    await expect(transport.runTurn(request)).rejects.toMatchObject({ code: 'CLAUDE_INVALID_TURN_REQUEST' });
    expect(harness.calls).toEqual([]);
  });
});

function createTransport(
  harness: FixtureHarness,
  options: {
    env?: NodeJS.ProcessEnv;
    onRawMessage?: (message: ClaudeRawMessage) => void;
  } = {},
): ClaudeResumePerTurnTransport {
  return new ClaudeResumePerTurnTransport({
    command: 'fixture-claude',
    defaultTimeoutMs: 2_000,
    processFactory: harness.createProcess,
    ...options,
  });
}

function argsFor(harness: FixtureHarness, index: number): readonly string[] {
  return harness.calls[index]?.args ?? [];
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
