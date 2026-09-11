import {
  ClaudeCapabilityDetector,
  type ClaudeCapabilityName,
  type ClaudeCapabilityReport,
} from './ClaudeCapabilityDetector.js';
import type { ClaudeRawMessage } from './ClaudeJsonlParser.js';
import {
  ClaudePersistentStreamTransport,
  type ClaudePersistentStreamTransportOptions,
  type ClaudePersistentTurnResult,
} from './ClaudePersistentStreamTransport.js';
import {
  ClaudeResumePerTurnTransport,
  type ClaudeResumePerTurnTransportOptions,
  type ClaudeTurnResult,
} from './ClaudeResumePerTurnTransport.js';

export type ClaudeTransportMode = 'auto' | 'persistent-stream' | 'resume-per-turn';
export type ClaudeSelectedTransport = Exclude<ClaudeTransportMode, 'auto'>;

export type ClaudeAutoFallbackReason =
  | 'PERSISTENT_CAPABILITY_UNSUPPORTED'
  | 'PERSISTENT_CAPABILITY_UNKNOWN'
  | 'PERSISTENT_START_FAILED'
  | 'PERSISTENT_UNAVAILABLE_BEFORE_TURN'
  | 'PERSISTENT_FAILED_AFTER_DISPATCH';

export interface ClaudeAutoFallbackEvent {
  from: 'persistent-stream';
  to: 'resume-per-turn';
  reason: ClaudeAutoFallbackReason;
  sourceErrorCode?: string;
  sessionId?: string;
  currentPromptReplayed: false;
  occurredAt: string;
}

export interface ClaudeAutoTurnRequest {
  prompt: string;
  timeoutMs?: number;
}

export interface ClaudeAutoTurnResult {
  transport: ClaudeSelectedTransport;
  sessionId: string;
  resultText: string;
  messageTypes: string[];
  durationMs: number;
  processId?: number;
  resultSubtype?: string;
  isError: false;
  fallback?: ClaudeAutoFallbackEvent;
}

export type ClaudeAutoRetrySafety = 'safe' | 'ambiguous' | 'not-applicable';

export type ClaudeAutoErrorCode =
  | 'CLAUDE_AUTO_INVALID_REQUEST'
  | 'CLAUDE_AUTO_NOT_STARTED'
  | 'CLAUDE_AUTO_ALREADY_STARTED'
  | 'CLAUDE_AUTO_TURN_ALREADY_ACTIVE'
  | 'CLAUDE_AUTO_NO_USABLE_TRANSPORT'
  | 'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED'
  | 'CLAUDE_AUTO_TURN_FAILED'
  | 'CLAUDE_AUTO_SHUTDOWN_FAILED';

export class ClaudeAutoError extends Error {
  public constructor(
    public readonly code: ClaudeAutoErrorCode,
    message: string,
    public readonly transport?: ClaudeSelectedTransport,
    public readonly sessionId?: string,
    public readonly retrySafety: ClaudeAutoRetrySafety = 'not-applicable',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeAutoError';
  }
}

export interface ClaudeAutoTransportOptions {
  mode?: ClaudeTransportMode;
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  model?: string;
  initialSessionId?: string;
  defaultTimeoutMs?: number;
  stopTimeoutMs?: number;
  disableTools?: boolean;
  capabilityReport?: ClaudeCapabilityReport;
  capabilityDetector?: () => ClaudeCapabilityReport;
  onRawMessage?: (message: ClaudeRawMessage) => void;
  onStderr?: (chunk: Buffer) => void;
  onFallback?: (event: ClaudeAutoFallbackEvent) => void;
  persistentFactory?: (
    options: ClaudePersistentStreamTransportOptions,
  ) => ClaudePersistentStreamTransport;
  resumeFactory?: (options: ClaudeResumePerTurnTransportOptions) => ClaudeResumePerTurnTransport;
}

type AutoState = 'STOPPED' | 'STARTING' | 'READY' | 'BUSY' | 'STOPPING' | 'FAILED';
type CapabilityState = 'supported' | 'unsupported' | 'unknown';

const persistentCapabilities: readonly ClaudeCapabilityName[] = [
  'printMode',
  'inputStreamJson',
  'outputStreamJson',
];
const resumeCapabilities: readonly ClaudeCapabilityName[] = ['printMode', 'outputStreamJson', 'resume'];

export class ClaudeAutoTransport {
  readonly #requestedMode: ClaudeTransportMode;
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #cwd: string | undefined;
  readonly #model: string | undefined;
  readonly #defaultTimeoutMs: number;
  readonly #stopTimeoutMs: number | undefined;
  readonly #disableTools: boolean;
  readonly #providedCapabilityReport: ClaudeCapabilityReport | undefined;
  readonly #capabilityDetector: () => ClaudeCapabilityReport;
  readonly #onRawMessage: ((message: ClaudeRawMessage) => void) | undefined;
  readonly #onStderr: ((chunk: Buffer) => void) | undefined;
  readonly #onFallback: ((event: ClaudeAutoFallbackEvent) => void) | undefined;
  readonly #persistentFactory: (
    options: ClaudePersistentStreamTransportOptions,
  ) => ClaudePersistentStreamTransport;
  readonly #resumeFactory: (options: ClaudeResumePerTurnTransportOptions) => ClaudeResumePerTurnTransport;
  #state: AutoState = 'STOPPED';
  #selectedTransport: ClaudeSelectedTransport | undefined;
  #persistent: ClaudePersistentStreamTransport | undefined;
  #resume: ClaudeResumePerTurnTransport | undefined;
  #capabilityReport: ClaudeCapabilityReport | undefined;
  #sessionId: string | undefined;
  #lastFallback: ClaudeAutoFallbackEvent | undefined;
  #active = false;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: ClaudeAutoTransportOptions = {}) {
    this.#requestedMode = options.mode ?? 'auto';
    validateMode(this.#requestedMode);
    validateOptionalText(options.initialSessionId, 'initialSessionId');
    validateOptionalText(options.model, 'model');
    this.#command = options.command ?? 'claude';
    this.#env = options.env;
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    validateTimeout(this.#defaultTimeoutMs);
    if (options.stopTimeoutMs !== undefined) validateTimeout(options.stopTimeoutMs);
    this.#stopTimeoutMs = options.stopTimeoutMs;
    this.#disableTools = options.disableTools ?? false;
    this.#providedCapabilityReport = options.capabilityReport;
    this.#capabilityDetector = options.capabilityDetector ?? (() => new ClaudeCapabilityDetector({
      command: this.#command,
      ...(this.#env === undefined ? {} : { env: { ...process.env, ...this.#env } }),
    }).detect());
    this.#onRawMessage = options.onRawMessage;
    this.#onStderr = options.onStderr;
    this.#onFallback = options.onFallback;
    this.#persistentFactory = options.persistentFactory ?? ((transportOptions) =>
      new ClaudePersistentStreamTransport(transportOptions));
    this.#resumeFactory = options.resumeFactory ?? ((transportOptions) =>
      new ClaudeResumePerTurnTransport(transportOptions));
    this.#sessionId = options.initialSessionId;
  }

  public get requestedMode(): ClaudeTransportMode {
    return this.#requestedMode;
  }

  public get selectedTransport(): ClaudeSelectedTransport | undefined {
    return this.#selectedTransport;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public get lastFallback(): ClaudeAutoFallbackEvent | undefined {
    return this.#lastFallback === undefined ? undefined : { ...this.#lastFallback };
  }

  public async start(): Promise<void> {
    if (this.#state !== 'STOPPED') {
      throw new ClaudeAutoError('CLAUDE_AUTO_ALREADY_STARTED', 'Claude Auto transport is already started');
    }
    this.#state = 'STARTING';
    try {
      if (this.#selectedTransport === 'resume-per-turn' || this.#requestedMode === 'resume-per-turn') {
        this.ensureResume();
        this.#selectedTransport = 'resume-per-turn';
        this.#state = 'READY';
        return;
      }
      if (this.#requestedMode === 'persistent-stream' || this.#selectedTransport === 'persistent-stream') {
        await this.startPersistent(false);
        return;
      }

      const report = this.getCapabilityReport();
      const persistentState = classifyCapabilities(report, persistentCapabilities);
      const resumeState = classifyCapabilities(report, resumeCapabilities);
      if (persistentState !== 'supported') {
        if (resumeState !== 'supported') throw noUsableTransport();
        this.switchToResume(
          persistentState === 'unsupported'
            ? 'PERSISTENT_CAPABILITY_UNSUPPORTED'
            : 'PERSISTENT_CAPABILITY_UNKNOWN',
        );
        this.#state = 'READY';
        return;
      }
      await this.startPersistent(true, resumeState === 'supported');
    } catch (cause) {
      if (this.#state === 'READY') return;
      this.#state = this.#persistent?.running === true ? 'FAILED' : 'STOPPED';
      if (cause instanceof ClaudeAutoError) throw cause;
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_NO_USABLE_TRANSPORT',
        'Claude Auto transport selection failed',
        this.#selectedTransport,
        this.#sessionId,
        'not-applicable',
        { cause },
      );
    }
  }

  public async runTurn(request: ClaudeAutoTurnRequest): Promise<ClaudeAutoTurnResult> {
    validatePrompt(request.prompt);
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    validateTimeout(timeoutMs);
    if (this.#active) {
      throw new ClaudeAutoError('CLAUDE_AUTO_TURN_ALREADY_ACTIVE', 'A Claude Auto turn is already active');
    }
    if (this.#state === 'FAILED' && this.#selectedTransport === 'persistent-stream' &&
      this.#persistent?.running === true) {
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
        'Claude Auto transport still owns a live persistent child',
        'persistent-stream',
        this.#sessionId,
        'not-applicable',
      );
    }
    if (this.#state !== 'READY' || this.#selectedTransport === undefined) {
      throw new ClaudeAutoError('CLAUDE_AUTO_NOT_STARTED', 'Claude Auto transport is not ready');
    }
    this.#active = true;
    this.#state = 'BUSY';
    try {
      if (this.#selectedTransport === 'resume-per-turn') {
        return await this.runResumeTurn(request, timeoutMs);
      }
      return await this.runPersistentTurn(request, timeoutMs);
    } finally {
      this.#active = false;
      if (this.currentState() === 'BUSY') this.#state = 'READY';
    }
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    if (this.#state === 'STOPPED' && this.#persistent === undefined && this.#resume === undefined) {
      return Promise.resolve();
    }
    this.#state = 'STOPPING';
    this.#shutdownPromise = (async () => {
      try {
        if (this.#persistent !== undefined) {
          try {
            await this.#persistent.shutdown();
          } catch (cause) {
            this.capturePersistentSession();
            this.#state = this.#persistent.running ? 'FAILED' : 'STOPPED';
            if (!this.#persistent.running) this.#persistent = undefined;
            throw new ClaudeAutoError(
              'CLAUDE_AUTO_SHUTDOWN_FAILED',
              'Claude Auto persistent shutdown failed',
              'persistent-stream',
              this.#sessionId,
              'not-applicable',
              { cause },
            );
          }
          this.capturePersistentSession();
          this.#persistent = undefined;
        }
        await this.#resume?.shutdown();
        this.#resume = undefined;
        this.#state = 'STOPPED';
      } catch (cause) {
        if (cause instanceof ClaudeAutoError) throw cause;
        this.#state = 'FAILED';
        throw new ClaudeAutoError(
          'CLAUDE_AUTO_SHUTDOWN_FAILED',
          'Claude Auto transport shutdown failed',
          this.#selectedTransport,
          this.#sessionId,
          'not-applicable',
          { cause },
        );
      } finally {
        this.#shutdownPromise = undefined;
      }
    })();
    return this.#shutdownPromise;
  }

  private getCapabilityReport(): ClaudeCapabilityReport {
    if (this.#capabilityReport !== undefined) return this.#capabilityReport;
    try {
      this.#capabilityReport = this.#providedCapabilityReport ?? this.#capabilityDetector();
      return this.#capabilityReport;
    } catch (cause) {
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_NO_USABLE_TRANSPORT',
        'Claude capability detection failed',
        undefined,
        this.#sessionId,
        'not-applicable',
        { cause },
      );
    }
  }

  private async startPersistent(allowFallback: boolean, resumeAvailable = false): Promise<void> {
    const persistent = this.#persistent ?? this.#persistentFactory(this.persistentOptions());
    this.#persistent = persistent;
    this.#selectedTransport = 'persistent-stream';
    try {
      await persistent.start();
      this.#state = 'READY';
    } catch (cause) {
      this.capturePersistentSession();
      if (isPersistentRunning(persistent)) {
        this.#state = 'FAILED';
        throw new ClaudeAutoError(
          'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
          'Claude persistent start failed while a child remains owned',
          'persistent-stream',
          this.#sessionId,
          'not-applicable',
          { cause },
        );
      }
      if (!allowFallback || !resumeAvailable) {
        this.#state = 'STOPPED';
        if (allowFallback && !resumeAvailable) throw noUsableTransport(cause);
        throw new ClaudeAutoError(
          'CLAUDE_AUTO_TURN_FAILED',
          'Claude persistent transport failed to start',
          'persistent-stream',
          this.#sessionId,
          'not-applicable',
          { cause },
        );
      }
      this.switchToResume('PERSISTENT_START_FAILED', cause);
      this.#state = 'READY';
    }
  }

  private async runPersistentTurn(
    request: ClaudeAutoTurnRequest,
    timeoutMs: number,
  ): Promise<ClaudeAutoTurnResult> {
    const persistent = this.#persistent;
    if (persistent === undefined) {
      this.#state = 'FAILED';
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_TURN_FAILED',
        'Selected Claude persistent transport is unavailable',
        'persistent-stream',
        this.#sessionId,
        'safe',
      );
    }
    if (!persistent.running) {
      if (this.#requestedMode !== 'auto' || !this.resumeIsSupported()) {
        this.#state = 'FAILED';
        throw new ClaudeAutoError(
          'CLAUDE_AUTO_TURN_FAILED',
          'Claude persistent transport is unavailable before turn dispatch',
          'persistent-stream',
          this.#sessionId,
          'safe',
        );
      }
      this.switchToResume('PERSISTENT_UNAVAILABLE_BEFORE_TURN');
      return this.runResumeTurn(request, timeoutMs);
    }

    try {
      const result = await persistent.runTurn({ prompt: request.prompt, timeoutMs });
      this.acceptSession(result.sessionId, 'persistent-stream', true);
      return normalizePersistentResult(result);
    } catch (cause) {
      this.capturePersistentSession();
      if (isPersistentRunning(persistent)) {
        this.#state = 'FAILED';
        throw new ClaudeAutoError(
          'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
          'Claude persistent turn failed while a child remains owned',
          'persistent-stream',
          this.#sessionId,
          'ambiguous',
          { cause },
        );
      }
      if (this.#requestedMode === 'auto' && this.#sessionId !== undefined && this.resumeIsSupported()) {
        this.switchToResume('PERSISTENT_FAILED_AFTER_DISPATCH', cause);
        this.#state = 'READY';
      } else {
        this.#state = 'FAILED';
      }
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_TURN_FAILED',
        'Claude persistent turn failed after prompt dispatch',
        'persistent-stream',
        this.#sessionId,
        'ambiguous',
        { cause },
      );
    }
  }

  private async runResumeTurn(
    request: ClaudeAutoTurnRequest,
    timeoutMs: number,
  ): Promise<ClaudeAutoTurnResult> {
    const resume = this.ensureResume();
    try {
      const result = await resume.runTurn({
        prompt: request.prompt,
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        timeoutMs,
      });
      this.acceptSession(result.sessionId, 'resume-per-turn', false);
      return normalizeResumeResult(result, this.#lastFallback);
    } catch (cause) {
      if (cause instanceof ClaudeAutoError) throw cause;
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_TURN_FAILED',
        'Claude resume-per-turn turn failed',
        'resume-per-turn',
        this.#sessionId,
        'ambiguous',
        { cause },
      );
    }
  }

  private acceptSession(
    sessionId: string,
    transport: ClaudeSelectedTransport,
    persistentMayRemainLive: boolean,
  ): void {
    if (this.#sessionId !== undefined && this.#sessionId !== sessionId) {
      if (persistentMayRemainLive) this.#state = 'FAILED';
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_TURN_FAILED',
        'Claude transport returned a conflicting session identity',
        transport,
        this.#sessionId,
        'ambiguous',
      );
    }
    this.#sessionId = sessionId;
  }

  private switchToResume(reason: ClaudeAutoFallbackReason, sourceError?: unknown): void {
    const persistent = this.#persistent;
    if (persistent?.running === true) {
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_PERSISTENT_OWNERSHIP_UNRESOLVED',
        'Cannot switch transports while a persistent child remains owned',
        'persistent-stream',
        this.#sessionId,
        'not-applicable',
        sourceError === undefined ? undefined : { cause: sourceError },
      );
    }
    const confirmedSession = persistent?.lastSessionId;
    if (confirmedSession !== undefined && this.#sessionId !== undefined && confirmedSession !== this.#sessionId) {
      throw new ClaudeAutoError(
        'CLAUDE_AUTO_TURN_FAILED',
        'Claude persistent handoff session conflicts with Auto session state',
        'persistent-stream',
        this.#sessionId,
        'not-applicable',
      );
    }
    this.#sessionId = confirmedSession ?? this.#sessionId;
    this.ensureResume();
    this.#persistent = undefined;
    this.#selectedTransport = 'resume-per-turn';
    const sourceErrorCode = readErrorCode(sourceError);
    const event: ClaudeAutoFallbackEvent = {
      from: 'persistent-stream',
      to: 'resume-per-turn',
      reason,
      ...(sourceErrorCode === undefined ? {} : { sourceErrorCode }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      currentPromptReplayed: false,
      occurredAt: new Date().toISOString(),
    };
    this.#lastFallback = event;
    notifyObserver(this.#onFallback, { ...event });
  }

  private capturePersistentSession(): void {
    const confirmed = this.#persistent?.lastSessionId;
    if (confirmed === undefined) return;
    if (this.#sessionId !== undefined && this.#sessionId !== confirmed) return;
    this.#sessionId = confirmed;
  }

  private resumeIsSupported(): boolean {
    return classifyCapabilities(this.getCapabilityReport(), resumeCapabilities) === 'supported';
  }

  private ensureResume(): ClaudeResumePerTurnTransport {
    this.#resume ??= this.#resumeFactory(this.resumeOptions());
    return this.#resume;
  }

  private persistentOptions(): ClaudePersistentStreamTransportOptions {
    return {
      command: this.#command,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#sessionId === undefined ? {} : { initialSessionId: this.#sessionId }),
      turnTimeoutMs: this.#defaultTimeoutMs,
      ...(this.#stopTimeoutMs === undefined ? {} : { stopTimeoutMs: this.#stopTimeoutMs }),
      disableTools: this.#disableTools,
      ...(this.#onRawMessage === undefined ? {} : { onRawMessage: this.#onRawMessage }),
      ...(this.#onStderr === undefined ? {} : { onStderr: this.#onStderr }),
    };
  }

  private resumeOptions(): ClaudeResumePerTurnTransportOptions {
    return {
      command: this.#command,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      ...(this.#cwd === undefined ? {} : { defaultCwd: this.#cwd }),
      ...(this.#model === undefined ? {} : { defaultModel: this.#model }),
      defaultTimeoutMs: this.#defaultTimeoutMs,
      disableTools: this.#disableTools,
      ...(this.#onRawMessage === undefined ? {} : { onRawMessage: this.#onRawMessage }),
      ...(this.#onStderr === undefined ? {} : { onStderr: this.#onStderr }),
    };
  }

  private currentState(): AutoState {
    return this.#state;
  }
}

function normalizePersistentResult(result: ClaudePersistentTurnResult): ClaudeAutoTurnResult {
  return {
    transport: 'persistent-stream',
    sessionId: result.sessionId,
    resultText: result.resultText,
    messageTypes: [...result.messageTypes],
    durationMs: result.durationMs,
    processId: result.processId,
    ...(result.resultSubtype === undefined ? {} : { resultSubtype: result.resultSubtype }),
    isError: false,
  };
}

function normalizeResumeResult(
  result: ClaudeTurnResult,
  fallback: ClaudeAutoFallbackEvent | undefined,
): ClaudeAutoTurnResult {
  return {
    transport: 'resume-per-turn',
    sessionId: result.sessionId,
    resultText: result.resultText,
    messageTypes: [...result.messageTypes],
    durationMs: result.durationMs,
    ...(result.processId === undefined ? {} : { processId: result.processId }),
    ...(result.resultSubtype === undefined ? {} : { resultSubtype: result.resultSubtype }),
    isError: false,
    ...(fallback === undefined ? {} : { fallback: { ...fallback } }),
  };
}

function classifyCapabilities(
  report: ClaudeCapabilityReport,
  required: readonly ClaudeCapabilityName[],
): CapabilityState {
  let unknown = false;
  for (const capability of required) {
    const check = report.checks.find((candidate) => candidate.capability === capability);
    if (check?.supported === true && (check.evidence === 'help' || check.evidence === 'probe')) continue;
    if (check?.evidence === 'unsupported' || report.unsupportedCapabilities.includes(capability)) return 'unsupported';
    unknown = true;
  }
  return unknown ? 'unknown' : 'supported';
}

function noUsableTransport(cause?: unknown): ClaudeAutoError {
  return new ClaudeAutoError(
    'CLAUDE_AUTO_NO_USABLE_TRANSPORT',
    'No Claude transport with confirmed multi-turn continuity is available',
    undefined,
    undefined,
    'not-applicable',
    cause === undefined ? undefined : { cause },
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function validateMode(mode: string): asserts mode is ClaudeTransportMode {
  if (mode !== 'auto' && mode !== 'persistent-stream' && mode !== 'resume-per-turn') {
    throw new ClaudeAutoError('CLAUDE_AUTO_INVALID_REQUEST', 'Unknown Claude transport mode');
  }
}

function validatePrompt(prompt: string): void {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ClaudeAutoError('CLAUDE_AUTO_INVALID_REQUEST', 'Claude Auto prompt must not be blank');
  }
}

function validateOptionalText(value: string | undefined, name: string): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new ClaudeAutoError('CLAUDE_AUTO_INVALID_REQUEST', `${name} must not be blank`);
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ClaudeAutoError('CLAUDE_AUTO_INVALID_REQUEST', 'Claude Auto timeout must be a positive safe integer');
  }
}

function notifyObserver<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Fallback observers are diagnostics only and cannot change transport state.
  }
}

function isPersistentRunning(transport: ClaudePersistentStreamTransport): boolean {
  return transport.running;
}
