import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaudePersistentError,
  ClaudePersistentStreamTransport,
  ClaudeProcessError,
  ClaudeProcessManager,
  buildClaudePersistentArgs,
  encodeClaudeUserInput,
  type ClaudePersistentStreamTransportOptions,
  type ClaudeProcessManagerOptions,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude/fake-claude-process.mjs', import.meta.url));

class PersistentHarness {
  readonly calls: ClaudeProcessManagerOptions[] = [];
  readonly managers: ClaudeProcessManager[] = [];
  readonly liveStopManagers: NonStoppingProcessManager[] = [];

  public constructor(private readonly scenarios: string[]) {}

  public readonly createProcess = (options: ClaudeProcessManagerOptions): ClaudeProcessManager => {
    const requestedScenario = this.scenarios[this.calls.length];
    if (requestedScenario === undefined) throw new Error('No persistent fixture scenario configured');
    this.calls.push(options);
    if (requestedScenario === 'factory-failure') throw new Error('simulated process factory failure');
    const liveStopFailure = requestedScenario.endsWith('-live-stop-failure');
    const stopFailure = !liveStopFailure && requestedScenario.endsWith('-stop-failure');
    const scenario = liveStopFailure
      ? requestedScenario.replace(/-live-stop-failure$/u, '')
      : stopFailure ? requestedScenario.replace(/-stop-failure$/u, '') : requestedScenario;
    const managerOptions: ClaudeProcessManagerOptions = requestedScenario === 'spawn-failure'
      ? { command: 'agenthub-definitely-missing-claude-command' }
      : {
        command: process.execPath,
        args: [fixturePath, scenario, ...(options.args ?? [])],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        stopTimeoutMs: 100,
      };
    const manager = liveStopFailure
      ? new NonStoppingProcessManager(managerOptions)
      : stopFailure ? new StopFailureProcessManager(managerOptions) : new ClaudeProcessManager(managerOptions);
    if (manager instanceof NonStoppingProcessManager) this.liveStopManagers.push(manager);
    this.managers.push(manager);
    return manager;
  };

  public allStopped(): boolean {
    return this.managers.every((manager) => !manager.running && manager.pid === undefined);
  }
}

class StopFailureProcessManager extends ClaudeProcessManager {
  public override async stop(): Promise<void> {
    await super.stop();
    throw new Error('simulated persistent stop failure');
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

describe('Claude persistent-stream transport', () => {
  it('builds persistent argv with exact optional resume and no continuation shortcuts', () => {
    const fresh = buildClaudePersistentArgs({ model: 'sonnet', disableTools: true });
    const resumed = buildClaudePersistentArgs({ initialSessionId: 'session-X' });

    expect(fresh).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', 'sonnet', '--tools', '',
    ]);
    expect(resumed).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--resume', 'session-X',
    ]);
    expect(resumed).not.toContain('--continue');
    expect(resumed).not.toContain('-c');
    expect(resumed).not.toContain('--fork-session');
  });

  it('encodes one safe NDJSON user frame with exact hostile Unicode content', () => {
    const prompt = '你好 👋 "quoted" \\ newline\n& echo INJECTED | whoami %PATH%';
    const encoded = encodeClaudeUserInput(prompt);
    const lines = encoded.toString('utf8').split('\n');

    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      type: 'user',
      message: { role: 'user', content: prompt },
    });
  });

  it('requires explicit start and validates requests before writing', async () => {
    const harness = new PersistentHarness([]);
    const transport = createTransport(harness);

    await expect(transport.runTurn({ prompt: 'valid' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_NOT_STARTED',
    });
    await expect(transport.runTurn({ prompt: '' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_INVALID_REQUEST',
    });
    expect(() => encodeClaudeUserInput(' ')).toThrow(ClaudePersistentError);
  });

  it('starts once, stays running, and shuts down idempotently', async () => {
    const harness = new PersistentHarness(['persistent-success']);
    const transport = createTransport(harness);

    await transport.shutdown();
    await transport.start();
    expect(transport.running).toBe(true);
    expect(transport.processId).toBeTypeOf('number');
    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_ALREADY_RUNNING' });
    await Promise.all([transport.shutdown(), transport.shutdown()]);
    await transport.shutdown();
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
  });

  it('runs sequential turns in one process with one stable session and turn-local messages', async () => {
    const harness = new PersistentHarness(['persistent-success']);
    const transport = createTransport(harness);
    await transport.start();

    const first = await transport.runTurn({ prompt: 'one' });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    const second = await transport.runTurn({ prompt: 'two' });
    const third = await transport.runTurn({ prompt: 'three' });

    expect([first.processId, second.processId, third.processId]).toEqual([first.processId, first.processId, first.processId]);
    expect([first.sessionId, second.sessionId, third.sessionId]).toEqual([
      'persistent-session-A', 'persistent-session-A', 'persistent-session-A',
    ]);
    expect(first.messageTypes).toEqual(['system', 'assistant', 'result']);
    expect(second.messageTypes).toEqual(['assistant', 'result']);
    expect(third.resultText).toBe('turn-3');
    expect(harness.calls).toHaveLength(1);
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('reconstructs fragmented same-ID assistant text for every turn without leakage', async () => {
    const harness = new PersistentHarness(['persistent-fragmented-assistant-result']);
    const transport = createTransport(harness);
    await transport.start();

    const first = await transport.runTurn({ prompt: 'one' });
    const second = await transport.runTurn({ prompt: 'two' });

    expect(first.resultText).toBe('RESULT_PERSISTENT_1');
    expect(second.resultText).toBe('RESULT_PERSISTENT_2');
    expect(second.resultText).not.toContain('RESULT_PERSISTENT_1');
    expect(first.processId).toBe(second.processId);
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('selects the final logical assistant message and ignores tool and thinking content', async () => {
    const harness = new PersistentHarness(['persistent-intermediate-final-fragmented']);
    const transport = createTransport(harness);
    await transport.start();

    const result = await transport.runTurn({ prompt: 'tool then final' });

    expect(result.resultText).toBe('FINAL_1');
    expect(result.resultText).not.toContain('I will inspect.');
    expect(result.resultText).not.toContain('ignored');
    await transport.shutdown();
  });

  it('separates reused assistant IDs at user boundaries without cross-turn leakage', async () => {
    const harness = new PersistentHarness(['persistent-same-id-collision']);
    const transport = createTransport(harness);
    await transport.start();

    const first = await transport.runTurn({ prompt: 'one' });
    const second = await transport.runTurn({ prompt: 'two' });

    expect(first.resultText).toBe('FINAL_1');
    expect(second.resultText).toBe('FINAL_2');
    expect(first.resultText).not.toContain('INTERMEDIATE_1');
    expect(second.resultText).not.toContain('INTERMEDIATE_2');
    expect(second.resultText).not.toContain('FINAL_1');
    expect(first.messageTypes).toEqual([
      'system', 'assistant', 'user', 'assistant', 'user', 'assistant', 'assistant', 'result',
    ]);
    expect(second.messageTypes).toEqual([
      'assistant', 'user', 'assistant', 'user', 'assistant', 'assistant', 'result',
    ]);
    expect(first.processId).toBe(second.processId);
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('resets the per-turn reconstruction size counter at a user boundary', async () => {
    const harness = new PersistentHarness(['persistent-assistant-limit-reset']);
    const transport = createTransport(harness);
    await transport.start();

    const first = await transport.runTurn({ prompt: 'one' });
    const second = await transport.runTurn({ prompt: 'two' });

    expect(first.resultText).toBe('FINAL_AFTER_RESET_1');
    expect(second.resultText).toBe('FINAL_AFTER_RESET_2');
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('falls back to terminal result when no valid assistant message ID can be reconstructed', async () => {
    const harness = new PersistentHarness(['persistent-success']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'fallback' })).resolves.toMatchObject({ resultText: 'turn-1' });
    await transport.shutdown();
  });

  it('fails with the existing protocol error when reconstructed assistant text exceeds the bound', async () => {
    const harness = new PersistentHarness(['persistent-assistant-over-limit']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'too large' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR',
    });
    expect(transport.running).toBe(false);
  });

  it('retains in-process context across turns', async () => {
    const harness = new PersistentHarness(['persistent-context']);
    const transport = createTransport(harness);
    await transport.start();
    const marker = 'AGENTHUB_PERSISTENT_fixture-marker-123';

    await transport.runTurn({ prompt: `Remember ${marker}` });
    const recalled = await transport.runTurn({ prompt: 'Return the marker' });

    expect(recalled.resultText).toBe(marker);
    await transport.shutdown();
  });

  it('uses exact initial resume identity only at process startup', async () => {
    const harness = new PersistentHarness(['persistent-success']);
    const transport = createTransport(harness, { initialSessionId: 'session-X' });
    await transport.start();
    expect(transport.sessionId).toBe('session-X');
    expect(transport.lastSessionId).toBeUndefined();
    const first = await transport.runTurn({ prompt: 'one' });
    const second = await transport.runTurn({ prompt: 'two' });

    expect(first.sessionId).toBe('session-X');
    expect(second.sessionId).toBe('session-X');
    expect(transport.lastSessionId).toBe('session-X');
    expect(readOption(argsFor(harness, 0), '--resume')).toBe('session-X');
    expect(harness.calls).toHaveLength(1);
    await transport.shutdown();
    expect(transport.sessionId).toBeUndefined();
    expect(transport.lastSessionId).toBe('session-X');
  });

  it('separates the current generation session from the last confirmed session', async () => {
    const harness = new PersistentHarness(['persistent-success', 'persistent-session-B']);
    const transport = createTransport(harness);

    await transport.start();
    await transport.runTurn({ prompt: 'generation A' });
    expect(transport.sessionId).toBe('persistent-session-A');
    expect(transport.lastSessionId).toBe('persistent-session-A');
    await transport.shutdown();
    expect(transport.sessionId).toBeUndefined();
    expect(transport.lastSessionId).toBe('persistent-session-A');

    await transport.start();
    expect(transport.sessionId).toBeUndefined();
    expect(transport.lastSessionId).toBe('persistent-session-A');
    await transport.runTurn({ prompt: 'generation B' });
    expect(transport.sessionId).toBe('persistent-session-B');
    expect(transport.lastSessionId).toBe('persistent-session-B');
    await transport.shutdown();
  });

  it('reuses the configured initial resume identity after a clean restart', async () => {
    const harness = new PersistentHarness(['persistent-success', 'persistent-success']);
    const transport = createTransport(harness, { initialSessionId: 'session-X' });

    await transport.start();
    await transport.runTurn({ prompt: 'first generation' });
    await transport.shutdown();
    await transport.start();
    await transport.runTurn({ prompt: 'second generation' });

    expect(readOption(argsFor(harness, 0), '--resume')).toBe('session-X');
    expect(readOption(argsFor(harness, 1), '--resume')).toBe('session-X');
    await transport.shutdown();
  });

  it('rejects an initial resume identity mismatch without a fresh fallback', async () => {
    const harness = new PersistentHarness(['persistent-initial-resume-mismatch']);
    const transport = createTransport(harness, { initialSessionId: 'session-X' });
    await transport.start();

    await expect(transport.runTurn({ prompt: 'resume' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH',
    });
    expect(harness.calls).toHaveLength(1);
    expect(readOption(argsFor(harness, 0), '--resume')).toBe('session-X');
    expect(harness.allStopped()).toBe(true);
  });

  it('fails a concurrent turn immediately without writing a second frame', async () => {
    const harness = new PersistentHarness(['persistent-hang']);
    const transport = createTransport(harness);
    await transport.start();
    const first = transport.runTurn({ prompt: 'first', timeoutMs: 50 });

    await expect(transport.runTurn({ prompt: 'second' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_TURN_ALREADY_ACTIVE',
    });
    await expect(first).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_TURN_TIMEOUT' });
    expect(harness.allStopped()).toBe(true);
  });

  it('kills the process on timeout and permits an explicit restart', async () => {
    const harness = new PersistentHarness(['persistent-hang', 'persistent-success']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'hang', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_TURN_TIMEOUT',
    });
    expect(transport.active).toBe(false);
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
    await transport.start();
    await expect(transport.runTurn({ prompt: 'after restart' })).resolves.toMatchObject({ resultText: 'turn-1' });
    await transport.shutdown();
  });

  it('preserves parser failure over cleanup failure and ignores late stdout', async () => {
    const harness = new PersistentHarness(['persistent-parser-error-stop-failure']);
    const transport = createTransport(harness);
    await transport.start();

    const error = await captureFailure(transport.runTurn({ prompt: 'bad stream' }));
    expect(error).toMatchObject({ code: 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR' });
    if (!(error instanceof Error)) throw new Error('Expected persistent parser error');
    expect(error.cause).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON' });
    expect(transport.active).toBe(false);
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
  });

  it.each([
    ['persistent-duplicate-result', 'CLAUDE_PERSISTENT_DUPLICATE_RESULT'],
    ['persistent-conflicting-session', 'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH'],
    ['persistent-missing-session', 'CLAUDE_PERSISTENT_SESSION_ID_MISSING'],
    ['persistent-error-result', 'CLAUDE_PERSISTENT_TURN_FAILED'],
    ['persistent-exit-busy', 'CLAUDE_PERSISTENT_PROCESS_EXITED'],
  ])('poisons the process for terminal scenario %s', async (scenario, code) => {
    const harness = new PersistentHarness([scenario]);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'terminal' })).rejects.toMatchObject({ code });
    expect(transport.active).toBe(false);
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
  });

  it('notices an idle exit after a completed result and rejects the next turn', async () => {
    const harness = new PersistentHarness(['persistent-exit-after-result']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'complete then exit' })).resolves.toMatchObject({
      resultText: 'turn-1',
      sessionId: 'persistent-session-A',
    });
    await waitFor(() => !transport.running);
    await expect(transport.runTurn({ prompt: 'must not hang' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_NOT_STARTED',
    });
    expect(harness.allStopped()).toBe(true);
  });

  it('accepts repeated init with the same session identity', async () => {
    const harness = new PersistentHarness(['persistent-repeated-init']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'one' })).resolves.toMatchObject({ sessionId: 'persistent-session-A' });
    await expect(transport.runTurn({ prompt: 'two' })).resolves.toMatchObject({ sessionId: 'persistent-session-A' });
    await transport.shutdown();
  });

  it('rejects a conflicting repeated init', async () => {
    const harness = new PersistentHarness(['persistent-conflicting-init']);
    const transport = createTransport(harness);
    await transport.start();
    await transport.runTurn({ prompt: 'one' });

    await expect(transport.runTurn({ prompt: 'two' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH',
    });
    expect(harness.allStopped()).toBe(true);
  });

  it.each([
    ['persistent-unexpected-idle-result', 'CLAUDE_PERSISTENT_UNEXPECTED_RESULT'],
    ['persistent-idle-parser-error', 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR'],
    ['persistent-idle-assistant', 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR'],
  ])('stops after idle protocol violation %s', async (scenario) => {
    const harness = new PersistentHarness([scenario]);
    const transport = createTransport(harness);
    await transport.start();

    await waitFor(() => !transport.running);
    await expect(transport.runTurn({ prompt: 'must not hang' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_NOT_STARTED',
    });
    expect(harness.allStopped()).toBe(true);
  });

  it('treats stderr as diagnostics and isolates both observers', async () => {
    const harness = new PersistentHarness(['persistent-stderr']);
    const rawTypes: string[] = [];
    const transport = createTransport(harness, {
      onRawMessage: (message) => {
        if (typeof message.type === 'string') rawTypes.push(message.type);
        throw new Error('raw observer failed');
      },
      onStderr: () => {
        throw new Error('stderr observer failed');
      },
    });
    await transport.start();

    await expect(transport.runTurn({ prompt: 'diagnostics' })).resolves.toMatchObject({
      resultText: 'turn-1',
      sessionId: 'persistent-session-A',
    });
    expect(rawTypes).toEqual(['system', 'assistant', 'result']);
    await transport.shutdown();
  });

  it('round-trips a hostile Unicode prompt as one input frame', async () => {
    const harness = new PersistentHarness(['persistent-input-roundtrip']);
    const transport = createTransport(harness);
    const prompt = '你好 🌏\n{"fake":true} & echo HACKED | %PATH% \\ "quoted"';
    await transport.start();

    await expect(transport.runTurn({ prompt })).resolves.toMatchObject({ resultText: prompt });
    await transport.shutdown();
  });

  it('shutdown while busy rejects the turn and leaves no child', async () => {
    const harness = new PersistentHarness(['persistent-hang']);
    const transport = createTransport(harness);
    await transport.start();
    const turn = transport.runTurn({ prompt: 'busy' });

    await transport.shutdown();
    await expect(turn).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_SHUTDOWN' });
    expect(transport.active).toBe(false);
    expect(transport.running).toBe(false);
    expect(harness.allStopped()).toBe(true);
  });

  it('restarts the same transport without listener or turn-state leakage', async () => {
    const harness = new PersistentHarness(['persistent-success', 'persistent-success']);
    const transport = createTransport(harness);

    await transport.start();
    const first = await transport.runTurn({ prompt: 'first generation' });
    await transport.shutdown();
    await transport.start();
    const second = await transport.runTurn({ prompt: 'second generation' });

    expect(first.processId).not.toBe(second.processId);
    expect(harness.managers.every((manager) => manager.listenerCount('stdout') === 0)).toBe(false);
    await transport.shutdown();
    expect(harness.managers.every((manager) => manager.listenerCount('stdout') === 0)).toBe(true);
  });

  it('recovers from a start failure only through a later explicit start', async () => {
    const harness = new PersistentHarness(['spawn-failure', 'persistent-success']);
    const transport = createTransport(harness);

    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_PROCESS_FAILED' });
    expect(transport.running).toBe(false);
    await transport.start();
    await expect(transport.runTurn({ prompt: 'recovered' })).resolves.toMatchObject({ resultText: 'turn-1' });
    await transport.shutdown();
  }, 15_000);

  it('recovers when process construction fails before a runtime exists', async () => {
    const harness = new PersistentHarness(['factory-failure', 'persistent-success']);
    const transport = createTransport(harness);

    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_PROCESS_FAILED' });
    expect(transport.running).toBe(false);
    await transport.start();
    await expect(transport.runTurn({ prompt: 'recovered' })).resolves.toMatchObject({ resultText: 'turn-1' });
    await transport.shutdown();
  });

  it('clears runtime state when shutdown cleanup reports a stop failure', async () => {
    const harness = new PersistentHarness(['persistent-success-stop-failure', 'persistent-success']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.shutdown()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_PROCESS_FAILED' });
    expect(transport.running).toBe(false);
    expect(transport.active).toBe(false);
    await transport.start();
    await expect(transport.runTurn({ prompt: 'after stop failure' })).resolves.toMatchObject({ resultText: 'turn-1' });
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('retains an idle live child after stop failure and retries the same runtime', async () => {
    const harness = new PersistentHarness(['persistent-success-live-stop-failure']);
    const transport = createTransport(harness);
    await transport.start();
    await transport.runTurn({ prompt: 'confirm session' });

    const error = await captureFailure(transport.shutdown());
    expect(error).toMatchObject({
      code: 'CLAUDE_PERSISTENT_PROCESS_FAILED',
      cause: { code: 'CLAUDE_PROCESS_STOP_TIMEOUT' },
    });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    expect(transport.sessionId).toBe('persistent-session-A');
    expect(transport.lastSessionId).toBe('persistent-session-A');
    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_ALREADY_RUNNING' });
    await expect(transport.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_NOT_STARTED',
    });
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    expect(manager.listenerCount('exit')).toBe(1);
    manager.allowStop = true;
    await transport.shutdown();
    expect(transport.running).toBe(false);
    expect(transport.sessionId).toBeUndefined();
    expect(transport.lastSessionId).toBe('persistent-session-A');
    expect(manager.listenerCount('exit')).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.allStopped()).toBe(true);
  });

  it('settles a busy turn separately from a live-child shutdown failure', async () => {
    const harness = new PersistentHarness(['persistent-hang-live-stop-failure']);
    const transport = createTransport(harness);
    await transport.start();
    const turn = captureFailure(transport.runTurn({ prompt: 'busy' }));
    const shutdown = captureFailure(transport.shutdown());

    await expect(turn).resolves.toMatchObject({ code: 'CLAUDE_PERSISTENT_SHUTDOWN' });
    await expect(shutdown).resolves.toMatchObject({
      code: 'CLAUDE_PERSISTENT_PROCESS_FAILED',
      cause: { code: 'CLAUDE_PROCESS_STOP_TIMEOUT' },
    });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_ALREADY_RUNNING' });
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    manager.allowStop = true;
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('preserves timeout as primary while retaining a child that failed to stop', async () => {
    const harness = new PersistentHarness(['persistent-hang-live-stop-failure']);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.runTurn({ prompt: 'timeout', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_PERSISTENT_TURN_TIMEOUT',
    });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    await expect(transport.start()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_ALREADY_RUNNING' });
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    manager.allowStop = true;
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('preserves parser failure while retaining a child that failed to stop', async () => {
    const harness = new PersistentHarness(['persistent-parser-error-live-stop-failure']);
    const transport = createTransport(harness);
    await transport.start();

    const error = await captureFailure(transport.runTurn({ prompt: 'bad stream' }));
    expect(error).toMatchObject({ code: 'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR' });
    if (!(error instanceof Error)) throw new Error('Expected persistent parser error');
    expect(error.cause).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON' });
    expect(transport.running).toBe(true);
    expect(transport.active).toBe(false);
    expect(harness.calls).toHaveLength(1);

    const manager = harness.liveStopManagers[0];
    if (manager === undefined) throw new Error('Missing live-stop manager');
    manager.allowStop = true;
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });

  it('finalizes retained ownership when a child exits after stop failure', async () => {
    const harness = new PersistentHarness([
      'persistent-natural-exit-live-stop-failure',
      'persistent-success',
    ]);
    const transport = createTransport(harness);
    await transport.start();

    await expect(transport.shutdown()).rejects.toMatchObject({ code: 'CLAUDE_PERSISTENT_PROCESS_FAILED' });
    expect(transport.running).toBe(true);
    await waitFor(() => !transport.running);
    expect(harness.allStopped()).toBe(true);

    await transport.start();
    await expect(transport.runTurn({ prompt: 'new generation' })).resolves.toMatchObject({ resultText: 'turn-1' });
    expect(harness.calls).toHaveLength(2);
    await transport.shutdown();
  });

  it('runs 25 turns with one process, one session, and no listener growth', async () => {
    const harness = new PersistentHarness(['persistent-success']);
    const transport = createTransport(harness);
    await transport.start();
    const expectedPid = transport.processId;

    for (let index = 1; index <= 25; index += 1) {
      const result = await transport.runTurn({ prompt: `turn ${String(index)}` });
      expect(result.processId).toBe(expectedPid);
      expect(result.sessionId).toBe('persistent-session-A');
      expect(result.resultText).toBe(`turn-${String(index)}`);
      expect(harness.managers[0]?.listenerCount('stdout')).toBe(1);
    }
    expect(harness.calls).toHaveLength(1);
    await transport.shutdown();
    expect(harness.allStopped()).toBe(true);
  });
});

function createTransport(
  harness: PersistentHarness,
  options: Omit<ClaudePersistentStreamTransportOptions, 'command' | 'processFactory'> = {},
): ClaudePersistentStreamTransport {
  return new ClaudePersistentStreamTransport({
    command: 'fixture-claude',
    turnTimeoutMs: 2_000,
    processFactory: harness.createProcess,
    ...options,
  });
}

function argsFor(harness: PersistentHarness, index: number): readonly string[] {
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
    if (Date.now() >= deadline) throw new Error('Timed out waiting for persistent fixture state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
