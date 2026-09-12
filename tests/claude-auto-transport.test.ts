import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaudeAutoTransport,
  ClaudePersistentStreamTransport,
  ClaudeProcessError,
  ClaudeProcessManager,
  ClaudeResumePerTurnTransport,
  claudeCapabilityNames,
  type ClaudeCapabilityEvidence,
  type ClaudeCapabilityName,
  type ClaudeCapabilityReport,
  type ClaudePersistentStreamTransportOptions,
  type ClaudePersistentTurnResult,
  type ClaudeProcessManagerOptions,
  type ClaudeResumePerTurnTransportOptions,
  type ClaudeTurnRequest,
  type ClaudeTurnResult,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude/fake-claude-process.mjs', import.meta.url));

class PersistentStub {
  public running = false;
  public active = false;
  public lastSessionId: string | undefined;
  public readonly prompts: string[] = [];
  public startError: Error | undefined;
  public turnError: Error | undefined;
  public stopOnTurnError = false;
  public shutdownError: Error | undefined;
  public sessionIdForResult = 'session-A';
  public startCalls = 0;
  public shutdownCalls = 0;

  public start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.running = true;
    return Promise.resolve();
  }

  public runTurn(request: { prompt: string }): Promise<ClaudePersistentTurnResult> {
    this.prompts.push(request.prompt);
    if (this.turnError !== undefined) {
      if (this.stopOnTurnError) this.running = false;
      return Promise.reject(this.turnError);
    }
    this.lastSessionId = this.sessionIdForResult;
    return Promise.resolve(persistentResult(this.sessionIdForResult));
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    if (this.shutdownError !== undefined) return Promise.reject(this.shutdownError);
    this.running = false;
    return Promise.resolve();
  }
}

class ResumeStub {
  public active = false;
  public readonly requests: ClaudeTurnRequest[] = [];
  public resultSessionId = 'session-A';
  public turnError: Error | undefined;
  public shutdownCalls = 0;

  public runTurn(request: ClaudeTurnRequest): Promise<ClaudeTurnResult> {
    this.requests.push({ ...request });
    if (this.turnError !== undefined) return Promise.reject(this.turnError);
    return Promise.resolve(resumeResult(this.resultSessionId, request.sessionId !== undefined));
  }

  public shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }
}

describe('Claude Auto transport', () => {
  it('exposes cleanup readiness without exposing mutable lifecycle state', async () => {
    const persistent = new PersistentStub();
    const auto = createAuto(persistent, new ResumeStub());
    expect(auto.requiresCleanup).toBe(false);
    await auto.start();
    expect(auto.requiresCleanup).toBe(false);
    await auto.shutdown();
    expect(auto.requiresCleanup).toBe(false);
  });

  it.each([
    ['supported', 'persistent-stream', undefined],
    ['unsupported', 'resume-per-turn', 'PERSISTENT_CAPABILITY_UNSUPPORTED'],
    ['unknown', 'resume-per-turn', 'PERSISTENT_CAPABILITY_UNKNOWN'],
  ] as const)('selects from positive capability evidence: %s', async (state, selected, reason) => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume, { capabilityReport: report(state) });

    await auto.start();

    expect(auto.selectedTransport).toBe(selected);
    expect(auto.lastFallback?.reason).toBe(reason);
    expect(persistent.startCalls).toBe(state === 'supported' ? 1 : 0);
    expect(resume.requests).toHaveLength(0);
    await auto.shutdown();
  });

  it('honors forced modes without capability detection or cross-transport fallback', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    let detections = 0;
    const forcedPersistent = createAuto(persistent, resume, {
      mode: 'persistent-stream', capabilityDetector: () => { detections += 1; return report('unknown'); },
    });
    await forcedPersistent.start();
    expect(forcedPersistent.selectedTransport).toBe('persistent-stream');
    expect(detections).toBe(0);
    await forcedPersistent.shutdown();

    const forcedResume = createAuto(new PersistentStub(), resume, {
      mode: 'resume-per-turn', capabilityDetector: () => { detections += 1; return report('supported'); },
      initialSessionId: 'initial-A',
    });
    resume.resultSessionId = 'initial-A';
    await forcedResume.start();
    const result = await forcedResume.runTurn({ prompt: 'resume only' });
    expect(result.transport).toBe('resume-per-turn');
    expect(resume.requests.at(-1)?.sessionId).toBe('initial-A');
    expect(detections).toBe(0);
    await forcedResume.shutdown();
    expect(resume.shutdownCalls).toBe(1);
  });

  it('propagates configuration and the initial session through Persistent, Resume, and safe fallback', async () => {
    const persistent = new PersistentStub();
    persistent.sessionIdForResult = 'initial-A';
    const resume = new ResumeStub();
    resume.resultSessionId = 'initial-A';
    let persistentOptions: ClaudePersistentStreamTransportOptions | undefined;
    let resumeOptions: ClaudeResumePerTurnTransportOptions | undefined;
    const auto = new ClaudeAutoTransport({
      capabilityReport: report('supported'),
      initialSessionId: 'initial-A', command: 'claude-custom', cwd: 'workspace-A', model: 'sonnet',
      env: { AGENTHUB_AUTO_TEST: 'yes' }, defaultTimeoutMs: 456, stopTimeoutMs: 123, disableTools: true,
      persistentFactory: (options) => {
        persistentOptions = options;
        return persistent as unknown as ClaudePersistentStreamTransport;
      },
      resumeFactory: (options) => {
        resumeOptions = options;
        return resume as unknown as ClaudeResumePerTurnTransport;
      },
    });
    await auto.start();
    await auto.runTurn({ prompt: 'persistent initial' });
    expect(auto.sessionId).toBe('initial-A');
    expect(persistentOptions).toMatchObject({
      command: 'claude-custom', cwd: 'workspace-A', model: 'sonnet', initialSessionId: 'initial-A',
      env: { AGENTHUB_AUTO_TEST: 'yes' }, turnTimeoutMs: 456, stopTimeoutMs: 123, disableTools: true,
    });
    await auto.shutdown();

    const failedPersistent = new PersistentStub();
    failedPersistent.startError = new Error('dead start');
    const fallbackResume = new ResumeStub();
    fallbackResume.resultSessionId = 'initial-A';
    const fallback = createAuto(failedPersistent, fallbackResume, { initialSessionId: 'initial-A' });
    await fallback.start();
    await fallback.runTurn({ prompt: 'fallback initial' });
    expect(fallbackResume.requests[0]?.sessionId).toBe('initial-A');
    expect(fallback.sessionId).toBe('initial-A');
    await fallback.shutdown();

    const forcedResume = new ClaudeAutoTransport({
      mode: 'resume-per-turn', initialSessionId: 'initial-A', cwd: 'workspace-A', model: 'sonnet',
      resumeFactory: (options) => {
        resumeOptions = options;
        return resume as unknown as ClaudeResumePerTurnTransport;
      },
    });
    await forcedResume.start();
    await forcedResume.runTurn({ prompt: 'resume initial' });
    expect(resumeOptions).toMatchObject({ defaultCwd: 'workspace-A', defaultModel: 'sonnet' });
    expect(resume.requests.at(-1)?.sessionId).toBe('initial-A');
    await forcedResume.shutdown();
  });

  it('detects once, does no model work in start, and rejects when continuity is unavailable', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    let detections = 0;
    const auto = createAuto(persistent, resume, {
      capabilityDetector: () => { detections += 1; return report('unsupported', 'unknown'); },
    });

    await expect(auto.start()).rejects.toMatchObject({ code: 'CLAUDE_AUTO_NO_USABLE_TRANSPORT' });
    expect(detections).toBe(1);
    expect(persistent.prompts).toEqual([]);
    expect(resume.requests).toEqual([]);
  });

  it('falls back safely after a dead-child start failure and sends the first prompt once', async () => {
    const persistent = new PersistentStub();
    persistent.startError = codedError('CLAUDE_PERSISTENT_PROCESS_FAILED');
    const resume = new ResumeStub();
    const events: string[] = [];
    const auto = createAuto(persistent, resume, {
      onFallback: (event) => { events.push(event.reason); throw new Error('observer failure'); },
    });

    await auto.start();
    const result = await auto.runTurn({ prompt: 'first prompt' });

    expect(result).toMatchObject({ transport: 'resume-per-turn', sessionId: 'session-A' });
    expect(result.fallback).toMatchObject({ reason: 'PERSISTENT_START_FAILED', currentPromptReplayed: false });
    expect(events).toEqual(['PERSISTENT_START_FAILED']);
    expect(persistent.prompts).toEqual([]);
    expect(resume.requests.map((request) => request.prompt)).toEqual(['first prompt']);
    await auto.shutdown();
  });

  it('blocks fallback while a live child remains and retries cleanup through the same owner', async () => {
    const persistent = new PersistentStub();
    persistent.running = true;
    persistent.startError = new Error('start failed after spawn');
    persistent.shutdownError = new Error('still live');
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);

    await expect(auto.start()).rejects.toMatchObject({ code: 'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED' });
    expect(auto.requiresCleanup).toBe(true);
    await expect(auto.shutdown()).rejects.toMatchObject({ code: 'CLAUDE_AUTO_SHUTDOWN_FAILED' });
    expect(persistent.shutdownCalls).toBe(1);
    expect(persistent.running).toBe(true);
    expect(resume.requests).toEqual([]);

    persistent.shutdownError = undefined;
    await auto.shutdown();
    expect(persistent.shutdownCalls).toBe(2);
    expect(persistent.running).toBe(false);
    expect(auto.requiresCleanup).toBe(false);
  });

  it('enforces explicit lifecycle and can restart the selected transport after shutdown', async () => {
    const persistent = new PersistentStub();
    const auto = createAuto(persistent, new ResumeStub(), { mode: 'persistent-stream' });

    await expect(auto.runTurn({ prompt: 'too early' })).rejects.toMatchObject({ code: 'CLAUDE_AUTO_NOT_STARTED' });
    await auto.start();
    await expect(auto.start()).rejects.toMatchObject({ code: 'CLAUDE_AUTO_ALREADY_STARTED' });
    await Promise.all([auto.shutdown(), auto.shutdown()]);
    expect(persistent.shutdownCalls).toBe(1);
    await auto.start();
    expect(persistent.startCalls).toBe(2);
    await auto.shutdown();
  });

  it('hands a confirmed idle-loss session to Resume exactly and stays degraded', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);
    await auto.start();
    await auto.runTurn({ prompt: 'persistent prompt' });
    persistent.running = false;

    const second = await auto.runTurn({ prompt: 'new resume prompt' });
    await auto.runTurn({ prompt: 'sticky resume prompt' });

    expect(second.fallback).toMatchObject({ reason: 'PERSISTENT_UNAVAILABLE_BEFORE_TURN', sessionId: 'session-A' });
    expect(persistent.prompts).toEqual(['persistent prompt']);
    expect(resume.requests).toEqual([
      expect.objectContaining({ prompt: 'new resume prompt', sessionId: 'session-A' }),
      expect.objectContaining({ prompt: 'sticky resume prompt', sessionId: 'session-A' }),
    ]);
    expect(auto.selectedTransport).toBe('resume-per-turn');
    expect(persistent.startCalls).toBe(1);
    await auto.shutdown();
  });

  it.each([
    'CLAUDE_PERSISTENT_TURN_TIMEOUT',
    'CLAUDE_PERSISTENT_STREAM_PROTOCOL_ERROR',
    'CLAUDE_PERSISTENT_PROCESS_EXITED',
  ])('never replays an ambiguous %s prompt and permits only the next prompt to Resume', async (code) => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);
    await auto.start();
    persistent.lastSessionId = 'session-A';
    persistent.turnError = codedError(code);
    persistent.stopOnTurnError = true;

    await expect(auto.runTurn({ prompt: 'ambiguous prompt' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED', retrySafety: 'ambiguous',
    });
    expect(auto.requiresCleanup).toBe(false);
    expect(persistent.prompts).toEqual(['ambiguous prompt']);
    expect(resume.requests).toEqual([]);
    expect(auto.lastFallback).toMatchObject({ reason: 'PERSISTENT_FAILED_AFTER_DISPATCH' });

    await auto.runTurn({ prompt: 'next prompt' });
    expect(resume.requests.map((request) => request.prompt)).toEqual(['next prompt']);
    expect(resume.requests[0]?.sessionId).toBe('session-A');
    await auto.shutdown();
  });

  it('does not create a fresh fallback without a confirmed session', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);
    await auto.start();
    persistent.turnError = new Error('lost before identity');
    persistent.stopOnTurnError = true;

    await expect(auto.runTurn({ prompt: 'unknown session' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED', retrySafety: 'ambiguous',
    });
    expect(auto.requiresCleanup).toBe(true);
    expect(auto.selectedTransport).toBe('persistent-stream');
    expect(resume.requests).toEqual([]);
    await expect(auto.runTurn({ prompt: 'must not start fresh' })).rejects.toMatchObject({ code: 'CLAUDE_AUTO_NOT_STARTED' });
    await auto.shutdown();
  });

  it('blocks Resume when an ambiguous failure leaves the Persistent child live', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);
    await auto.start();
    persistent.lastSessionId = 'session-A';
    persistent.turnError = new Error('ambiguous');

    await expect(auto.runTurn({ prompt: 'only once' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED', retrySafety: 'ambiguous',
    });
    expect(auto.requiresCleanup).toBe(true);
    await expect(auto.runTurn({ prompt: 'blocked while owned' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
    });
    expect(resume.requests).toEqual([]);
    await auto.shutdown();
  });

  it('detects Resume live ownership, blocks every new child, and retries cleanup through Auto', async () => {
    const calls: ClaudeProcessManagerOptions[] = [];
    let manager: AutoNonStoppingProcessManager | undefined;
    let persistentFactoryCalls = 0;
    const resume = new ClaudeResumePerTurnTransport({
      command: 'fixture-claude',
      defaultTimeoutMs: 30,
      processFactory: (options) => {
        calls.push(options);
        manager = new AutoNonStoppingProcessManager({
          command: process.execPath,
          args: [fixturePath, 'hang', ...(options.args ?? [])],
          stopTimeoutMs: 75,
        });
        return manager;
      },
    });
    const auto = new ClaudeAutoTransport({
      mode: 'resume-per-turn',
      resumeFactory: () => resume,
      persistentFactory: () => {
        persistentFactoryCalls += 1;
        return new ClaudePersistentStreamTransport();
      },
    });
    await auto.start();

    await expect(auto.runTurn({ prompt: 'timeout', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED',
      transport: 'resume-per-turn',
      retrySafety: 'ambiguous',
      cause: { code: 'CLAUDE_TURN_TIMEOUT' },
    });
    expect(auto.requiresCleanup).toBe(true);
    expect(resume.running).toBe(true);
    await expect(auto.runTurn({ prompt: 'blocked' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_RESUME_OWNERSHIP_UNRESOLVED',
    });
    expect(calls).toHaveLength(1);
    expect(persistentFactoryCalls).toBe(0);
    await expect(auto.shutdown()).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_SHUTDOWN_FAILED',
      cause: { code: 'CLAUDE_PROCESS_STOP_TIMEOUT' },
    });

    if (manager === undefined) throw new Error('Missing Auto live-stop manager');
    manager.allowStop = true;
    await auto.shutdown();
    expect(calls).toHaveLength(1);
    expect(manager.running).toBe(false);
    expect(resume.running).toBe(false);
    expect(auto.requiresCleanup).toBe(false);
  });

  it('treats Persistent session mismatch as terminal without current or future Resume execution', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    const auto = createAuto(persistent, resume);
    await auto.start();
    await auto.runTurn({ prompt: 'establish session A' });
    persistent.turnError = codedError('CLAUDE_PERSISTENT_SESSION_ID_MISMATCH');
    persistent.stopOnTurnError = true;

    await expect(auto.runTurn({ prompt: 'identity mismatch X' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED',
      transport: 'persistent-stream',
      retrySafety: 'ambiguous',
      cause: { code: 'CLAUDE_PERSISTENT_SESSION_ID_MISMATCH' },
    });
    expect(auto.requiresCleanup).toBe(true);
    expect(persistent.prompts).toEqual(['establish session A', 'identity mismatch X']);
    expect(resume.requests).toEqual([]);
    expect(auto.selectedTransport).toBe('persistent-stream');
    expect(auto.lastFallback).toBeUndefined();
    await expect(auto.runTurn({ prompt: 'future Y' })).rejects.toMatchObject({ code: 'CLAUDE_AUTO_NOT_STARTED' });
    expect(resume.requests).toEqual([]);
    await auto.shutdown();
  });

  it('guards concurrent turns and releases the guard after success and failure', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    let release!: (result: ClaudePersistentTurnResult) => void;
    persistent.runTurn = async (request) => {
      persistent.prompts.push(request.prompt);
      return new Promise<ClaudePersistentTurnResult>((resolve) => { release = resolve; });
    };
    const auto = createAuto(persistent, resume);
    await auto.start();
    const first = auto.runTurn({ prompt: 'first' });
    await expect(auto.runTurn({ prompt: 'second' })).rejects.toMatchObject({ code: 'CLAUDE_AUTO_TURN_ALREADY_ACTIVE' });
    release(persistentResult('session-A'));
    await first;
    expect(auto.active).toBe(false);

    persistent.turnError = new Error('later failure');
    persistent.stopOnTurnError = true;
    persistent.runTurn = PersistentStub.prototype.runTurn.bind(persistent);
    persistent.running = true;
    persistent.lastSessionId = undefined;
    await expect(auto.runTurn({ prompt: 'failure' })).rejects.toMatchObject({ code: 'CLAUDE_AUTO_TURN_FAILED' });
    expect(auto.active).toBe(false);
    await auto.shutdown();
  });

  it('rejects a conflicting Resume session as terminal and does not try Persistent again', async () => {
    const persistent = new PersistentStub();
    const resume = new ResumeStub();
    resume.resultSessionId = 'session-B';
    const auto = createAuto(persistent, resume, {
      mode: 'resume-per-turn', initialSessionId: 'session-A',
    });
    await auto.start();

    await expect(auto.runTurn({ prompt: 'conflict' })).rejects.toMatchObject({
      code: 'CLAUDE_AUTO_TURN_FAILED', transport: 'resume-per-turn', sessionId: 'session-A',
    });
    expect(persistent.startCalls).toBe(0);
    expect(auto.active).toBe(false);
    await auto.shutdown();
  });

  it('composes the real transports for Persistent idle loss and exact Resume handoff', async () => {
    const persistentCalls: ClaudeProcessManagerOptions[] = [];
    const resumeCalls: ClaudeProcessManagerOptions[] = [];
    const auto = new ClaudeAutoTransport({
      capabilityReport: report('supported'),
      defaultTimeoutMs: 2_000,
      stopTimeoutMs: 100,
      persistentFactory: (options) => new ClaudePersistentStreamTransport({
        ...options,
        processFactory: fixtureFactory('persistent-exit-after-result', persistentCalls),
      }),
      resumeFactory: (options) => new ClaudeResumePerTurnTransport({
        ...options,
        processFactory: fixtureFactory('turn-success', resumeCalls),
      }),
    });

    await auto.start();
    const first = await auto.runTurn({ prompt: 'persistent once' });
    await waitUntil(() => auto.selectedTransport === 'persistent-stream' && !auto.active && persistentCalls.length === 1, 100);
    await waitUntilManagerExit(persistentCalls, 1_000);
    const second = await auto.runTurn({ prompt: 'resume once' });

    expect(first).toMatchObject({ transport: 'persistent-stream', sessionId: 'persistent-session-A' });
    expect(second).toMatchObject({ transport: 'resume-per-turn', sessionId: 'persistent-session-A' });
    expect(readOption(resumeCalls[0]?.args ?? [], '--resume')).toBe('persistent-session-A');
    expect(readOption(resumeCalls[0]?.args ?? [], '-p')).toBe('resume once');
    expect(persistentCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(1);
    await auto.shutdown();
  });
});

function createAuto(
  persistent: PersistentStub,
  resume: ResumeStub,
  options: Partial<ConstructorParameters<typeof ClaudeAutoTransport>[0]> = {},
): ClaudeAutoTransport {
  const capabilityOptions = options.capabilityReport === undefined && options.capabilityDetector !== undefined
    ? {}
    : { capabilityReport: report('supported') };
  return new ClaudeAutoTransport({
    ...capabilityOptions,
    persistentFactory: () => persistent as unknown as ClaudePersistentStreamTransport,
    resumeFactory: () => resume as unknown as ClaudeResumePerTurnTransport,
    ...options,
  });
}

function report(
  persistentState: 'supported' | 'unsupported' | 'unknown',
  resumeState: 'supported' | 'unsupported' | 'unknown' = 'supported',
): ClaudeCapabilityReport {
  const persistentNames: readonly ClaudeCapabilityName[] = ['printMode', 'inputStreamJson', 'outputStreamJson'];
  const resumeNames: readonly ClaudeCapabilityName[] = ['printMode', 'outputStreamJson', 'resume'];
  const stateFor = (name: ClaudeCapabilityName): 'supported' | 'unsupported' | 'unknown' => {
    if (name === 'inputStreamJson') return persistentState;
    if (resumeNames.includes(name)) return resumeState;
    if (persistentNames.includes(name)) return persistentState;
    return 'unknown';
  };
  const checks = claudeCapabilityNames.map((capability) => {
    const state = stateFor(capability);
    const evidence: ClaudeCapabilityEvidence = state === 'supported' ? 'help' : state;
    return { capability, supported: state === 'supported', evidence };
  });
  const unknownCapabilities = checks.filter((check) => check.evidence === 'unknown').map((check) => check.capability);
  const unsupportedCapabilities = checks.filter((check) => check.evidence === 'unsupported').map((check) => check.capability);
  const capabilities = Object.fromEntries(checks.map((check) => [check.capability, check.supported])) as Record<ClaudeCapabilityName, boolean>;
  return {
    ok: true,
    capabilities: {
      ...capabilities,
      executablePath: 'claude', executableResolved: true, executableExists: true,
      installed: true, platform: process.platform, authStatusAvailable: false,
    },
    missingRequiredCapabilities: [], unknownCapabilities, unsupportedCapabilities, checks, diagnostics: [],
  };
}

function persistentResult(sessionId: string): ClaudePersistentTurnResult {
  return {
    sessionId, resultText: 'persistent-ok', messageTypes: ['assistant', 'result'],
    processId: 101, durationMs: 1, resultSubtype: 'success', isError: false,
  };
}

function resumeResult(sessionId: string, resumed: boolean): ClaudeTurnResult {
  return {
    sessionId, resultText: 'resume-ok', exitCode: 0, messageTypes: ['system', 'assistant', 'result'],
    resumed, processId: 202, durationMs: 1, resultSubtype: 'success', isError: false,
  };
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fixtureFactory(scenario: string, calls: ClaudeProcessManagerOptions[]) {
  return (options: ClaudeProcessManagerOptions): ClaudeProcessManager => {
    calls.push(options);
    return new ClaudeProcessManager({
      command: process.execPath,
      args: [fixturePath, scenario, ...(options.args ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stopTimeoutMs: 100,
    });
  };
}

async function waitUntilManagerExit(calls: ClaudeProcessManagerOptions[], timeoutMs: number): Promise<void> {
  await waitUntil(() => calls.length > 0, timeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

class AutoNonStoppingProcessManager extends ClaudeProcessManager {
  public allowStop = false;

  public override async stop(): Promise<void> {
    if (!this.allowStop) {
      throw new ClaudeProcessError('CLAUDE_PROCESS_STOP_TIMEOUT', 'simulated Auto live stop timeout');
    }
    await super.stop();
  }
}
