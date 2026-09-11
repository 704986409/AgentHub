import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaudeProcessManager,
  ClaudeProcessError,
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
  readonly liveStopManagers: NonStoppingProcessManager[] = [];

  public constructor(private readonly scenarios: string[]) {}

  public readonly createProcess = (options: ClaudeProcessManagerOptions): ClaudeProcessManager => {
    const scenario = this.scenarios[this.calls.length];
    if (scenario === undefined) throw new Error('No fixture scenario configured');
    this.calls.push(options);
    const liveStopFailure = scenario.endsWith('-live-stop-failure');
    const fixtureScenario = liveStopFailure ? scenario.replace(/-live-stop-failure$/u, '') : scenario;
    const managerOptions: ClaudeProcessManagerOptions = {
      command: process.execPath,
      args: [fixturePath, fixtureScenario, ...(options.args ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stopTimeoutMs: 75,
    };
    const manager = liveStopFailure
      ? new NonStoppingProcessManager(managerOptions)
      : scenario === 'stop-failure'
      ? new StopFailureClaudeProcessManager(managerOptions)
      : new ClaudeProcessManager(managerOptions);
    if (manager instanceof NonStoppingProcessManager) this.liveStopManagers.push(manager);
    this.managers.push(manager);
    return manager;
  };

  public allStopped(): boolean {
    return this.managers.every((manager) => !manager.running && manager.pid === undefined);
  }
}

class NonStoppingProcessManager extends ClaudeProcessManager {
  public allowStop = false;

  public override async stop(): Promise<void> {
    if (!this.allowStop) {
      throw new ClaudeProcessError(
        'CLAUDE_PROCESS_STOP_TIMEOUT',
        'simulated live process stop timeout',
      );
    }
    await super.stop();
  }
}

class StopFailureClaudeProcessManager extends ClaudeProcessManager {
  #stopFailed = false;

  public override async stop(): Promise<void> {
    await super.stop();
    if (this.#stopFailed) return;
    this.#stopFailed = true;
    throw new Error('simulated stop failure');
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

  it('reconstructs fragmented same-ID assistant text instead of a truncated terminal result', async () => {
    const harness = new FixtureHarness(['turn-fragmented-assistant-result']);
    const transport = createTransport(harness);

    const result = await transport.runTurn({ prompt: 'fragmented' });

    expect(result.resultText).toBe('<AGENTHUB_RESULT>{"outcome":"COMPLETED"}</AGENTHUB_RESULT>');
    expect(result.messageTypes).toEqual(['system', 'assistant', 'assistant', 'assistant', 'result']);
    expect(harness.allStopped()).toBe(true);
  });

  it('selects only the final logical assistant message and ignores non-text content', async () => {
    const harness = new FixtureHarness(['turn-intermediate-final-fragmented']);
    const transport = createTransport(harness);

    const result = await transport.runTurn({ prompt: 'tool then final' });

    expect(result.resultText).toBe('RESULT_FINAL');
    expect(result.resultText).not.toContain('I will inspect.');
    expect(result.resultText).not.toContain('ignored');
    expect(harness.allStopped()).toBe(true);
  });

  it('falls back to result.result and keeps reconstruction state local to each call', async () => {
    const harness = new FixtureHarness(['turn-fragmented-assistant-result', 'turn-success']);
    const transport = createTransport(harness);

    const first = await transport.runTurn({ prompt: 'first' });
    const second = await transport.runTurn({ prompt: 'second', sessionId: first.sessionId });

    expect(first.resultText).toContain('AGENTHUB_RESULT');
    expect(second.resultText).toBe('second-ok');
    expect(second.resultText).not.toContain('AGENTHUB_RESULT');
    expect(harness.allStopped()).toBe(true);
  });

  it('fails with the existing protocol error when reconstructed assistant text exceeds the bound', async () => {
    const harness = new FixtureHarness(['turn-assistant-over-limit']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'too large' })).rejects.toMatchObject({
      code: 'CLAUDE_STREAM_PROTOCOL_ERROR',
    });
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

  it('ignores stdout after a parser failure without an uncaught EventEmitter exception', async () => {
    const harness = new FixtureHarness(['parser-error-extra-output']);
    const transport = createTransport(harness);

    const error = await captureFailure(transport.runTurn({ prompt: 'bad stream', timeoutMs: 2_000 }));
    expect(error).toBeInstanceOf(ClaudeTurnError);
    expect(error).toMatchObject({ code: 'CLAUDE_STREAM_PROTOCOL_ERROR' });
    if (!(error instanceof Error)) throw new Error('Expected ClaudeTurnError');
    expect(error.cause).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON' });
    expect(harness.allStopped()).toBe(true);
    expect(transport.active).toBe(false);
  });

  it('releases the turn guard when process stop cleanup fails', async () => {
    const harness = new FixtureHarness(['stop-failure', 'turn-success']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'stop fails' })).rejects.toThrow('simulated stop failure');
    expect(transport.active).toBe(false);
    await expect(transport.runTurn({ prompt: 'after stop failure' })).resolves.toMatchObject({
      resultText: 'first-ok',
    });
    expect(harness.allStopped()).toBe(true);
  });

  it('isolates raw message observer failures from a successful turn', async () => {
    const harness = new FixtureHarness(['turn-success']);
    const transport = createTransport(harness, {
      onRawMessage: () => {
        throw new Error('observer failed');
      },
    });

    await expect(transport.runTurn({ prompt: 'observer failure' })).resolves.toMatchObject({
      sessionId: 'session-A',
      resultText: 'first-ok',
      exitCode: 0,
    });
    expect(harness.allStopped()).toBe(true);
  });

  it('isolates stderr observer failures from a successful turn', async () => {
    const harness = new FixtureHarness(['turn-success-with-stderr']);
    const transport = createTransport(harness, {
      onStderr: () => {
        throw new Error('stderr observer failed');
      },
    });

    await expect(transport.runTurn({ prompt: 'stderr observer failure' })).resolves.toMatchObject({
      sessionId: 'session-A',
      resultText: 'first-ok',
      exitCode: 0,
    });
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

  it('preserves timeout and retains a live child until shutdown retries the same manager', async () => {
    const harness = new FixtureHarness(['hang-live-stop-failure']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'timeout', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_TIMEOUT',
    });
    expect(transport.active).toBe(false);
    expect(transport.running).toBe(true);
    await expect(transport.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_PROCESS_OWNERSHIP_UNRESOLVED',
    });
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    await expect(transport.shutdown()).rejects.toMatchObject({ code: 'CLAUDE_PROCESS_STOP_TIMEOUT' });
    manager.allowStop = true;
    await transport.shutdown();
    expect(harness.calls).toHaveLength(1);
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
    expect(manager.listenerCount('stdout')).toBe(0);
    expect(manager.listenerCount('stderr')).toBe(0);
    expect(manager.listenerCount('exit')).toBe(0);
  });

  it('preserves parser failure while retaining a live child and ignores later output', async () => {
    const harness = new FixtureHarness(['parser-error-hang-live-stop-failure']);
    const transport = createTransport(harness);

    const error = await captureFailure(transport.runTurn({ prompt: 'bad stream', timeoutMs: 2_000 }));
    expect(error).toMatchObject({ code: 'CLAUDE_STREAM_PROTOCOL_ERROR' });
    if (!(error instanceof Error)) throw new Error('Expected parser error');
    expect(error.cause).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON' });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    await expect(transport.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_PROCESS_OWNERSHIP_UNRESOLVED',
    });
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    manager.allowStop = true;
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('releases retained ownership on natural exit and permits a new turn', async () => {
    const harness = new FixtureHarness(['natural-exit-hang-live-stop-failure', 'turn-success']);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'natural exit', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_TURN_TIMEOUT',
    });
    expect(transport.running).toBe(true);
    await waitFor(() => !transport.running);
    const oldManager = harness.managers[0];
    if (oldManager === undefined) throw new Error('Missing first manager');
    expect(oldManager.listenerCount('stdout')).toBe(0);
    expect(oldManager.listenerCount('stderr')).toBe(0);
    expect(oldManager.listenerCount('exit')).toBe(0);

    await expect(transport.runTurn({ prompt: 'after natural exit' })).resolves.toMatchObject({ resultText: 'first-ok' });
    expect(harness.calls).toHaveLength(2);
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
    onStderr?: (chunk: Buffer) => void;
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
