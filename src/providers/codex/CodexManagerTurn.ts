import type { CodexDiagnostics } from './CodexDiagnostics.js';

export interface CodexManagerSession {
  threadId: string;
  sessionId: string;
}

export interface CodexTurnRequest {
  prompt: string;
  timeoutMs?: number;
}

export type CodexTurnResultStatus = 'completed' | 'failed' | 'timeout' | 'upstream_unavailable';

export type CodexTurnFailureKind =
  | 'protocol_error'
  | 'process_exit'
  | 'timeout'
  | 'upstream_unavailable'
  | 'provider_error';

export type CodexTurnEventKind = 'started' | 'text_delta' | 'text_final' | 'completed' | 'failed' | 'unknown';

export interface CodexTurnEvent {
  kind: CodexTurnEventKind;
  threadId: string;
  turnId?: string;
  elapsedMs: number;
  textLength?: number;
  errorCode?: string;
}

export interface CodexTurnResult {
  threadId: string;
  sessionId: string;
  turnId?: string;
  status: CodexTurnResultStatus;
  text: string;
  events: readonly CodexTurnEvent[];
  error?: {
    kind: CodexTurnFailureKind;
    code?: string;
    message: string;
  };
}

export class CodexManagerError extends Error {
  public constructor(
    public readonly kind: CodexTurnFailureKind,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CodexManagerError';
  }
}

export interface CodexManagerTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexManagerTurnOptions {
  threadRequestTimeoutMs?: number;
  turnTimeoutMs?: number;
  diagnostics?: CodexDiagnostics;
}

interface TextItemState {
  delta: string;
  finalText: string | undefined;
  phase: string | null;
}

interface BufferedNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingTurn {
  threadId: string;
  sessionId: string;
  turnId: string | undefined;
  startedAt: number;
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
  resolve: (result: CodexTurnResult) => void;
  promise: Promise<CodexTurnResult>;
  events: CodexTurnEvent[];
  itemOrder: string[];
  textItems: Map<string, TextItemState>;
  buffered: BufferedNotification[];
  lastError: NormalizedTurnError | undefined;
}

interface NormalizedTurnError {
  kind: CodexTurnFailureKind;
  code: string | undefined;
  message: string;
}

const relevantBufferedMethods = new Set([
  'turn/started',
  'turn/completed',
  'item/agentMessage/delta',
  'item/completed',
  'error',
]);

export class CodexManagerTurnController {
  readonly #threadRequestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #diagnostics: CodexDiagnostics | undefined;
  #managerSession: CodexManagerSession | undefined;
  #threadCreation: Promise<CodexManagerSession> | undefined;
  #pendingTurn: PendingTurn | undefined;
  #lastSettledTurn: { threadId: string; turnId: string | undefined } | undefined;
  #active = false;

  public constructor(
    private readonly transport: CodexManagerTransport,
    private readonly ensureReady: () => void,
    options: CodexManagerTurnOptions = {},
  ) {
    this.#threadRequestTimeoutMs = options.threadRequestTimeoutMs ?? 30_000;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.#diagnostics = options.diagnostics;
  }

  public get managerThreadId(): string | undefined {
    return this.#managerSession?.threadId;
  }

  public get managerSession(): CodexManagerSession | undefined {
    return this.#managerSession === undefined ? undefined : { ...this.#managerSession };
  }

  public get pendingTurnCount(): number {
    return this.#pendingTurn !== undefined && !this.#pendingTurn.settled ? 1 : 0;
  }

  public async createManagerThread(): Promise<CodexManagerSession> {
    this.ensureReady();
    if (this.#managerSession !== undefined) return { ...this.#managerSession };
    if (this.#threadCreation !== undefined) return this.#threadCreation;

    this.#threadCreation = this.createManagerThreadRequest();
    try {
      return await this.#threadCreation;
    } finally {
      this.#threadCreation = undefined;
    }
  }

  public async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    this.ensureReady();
    if (request.prompt.trim().length === 0) {
      throw new CodexManagerError('provider_error', 'Turn prompt must not be blank', 'EMPTY_PROMPT');
    }
    if (this.#active) {
      throw new CodexManagerError('provider_error', 'A Manager turn is already active', 'TURN_ALREADY_ACTIVE');
    }

    this.#active = true;
    try {
      const session = await this.createManagerThread();
      const timeoutMs = request.timeoutMs ?? this.#turnTimeoutMs;
      const pending = this.createPendingTurn(session);
      this.#pendingTurn = pending;

      let response: unknown;
      try {
        response = await this.transport.request('turn/start', {
          threadId: session.threadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        }, timeoutMs);
      } catch (error) {
        if (!pending.settled) this.finishFailure(pending, classifyRequestFailure(error));
        return await pending.promise;
      }

      if (pending.settled) return await pending.promise;
      const turn = readRecordField(response, 'turn');
      const turnId = readNonEmptyString(turn, 'id');
      if (turnId === undefined) {
        this.finishFailure(pending, protocolFailure('turn/start response is missing turn.id'));
        return await pending.promise;
      }
      if (pending.turnId !== undefined && pending.turnId !== turnId) {
        this.finishFailure(pending, protocolFailure('turn/start response turn.id does not match buffered events'));
        return await pending.promise;
      }
      pending.turnId = turnId;
      this.armTurnTimeout(pending, timeoutMs);
      this.recordDiagnostic('started', pending, { requestMethod: 'turn/start' });
      this.flushBufferedNotifications(pending);
      this.collectItemsFromTurn(pending, turn);
      this.handleTurnRecordIfTerminal(pending, turn);
      return await pending.promise;
    } finally {
      this.#active = false;
      if (this.#pendingTurn?.settled === true) this.#pendingTurn = undefined;
    }
  }

  public handleNotification(method: string, params: unknown): void {
    const pending = this.#pendingTurn;
    if (!isRecord(params)) return;
    if (pending === undefined || pending.settled) {
      const threadId = readNonEmptyString(params, 'threadId');
      const turnId = extractTurnId(params);
      if (threadId !== undefined && threadId === this.#lastSettledTurn?.threadId && turnId === this.#lastSettledTurn.turnId) {
        this.#diagnostics?.record('late-turn-event', { method, threadId, turnId });
      }
      return;
    }
    const threadId = readNonEmptyString(params, 'threadId');
    if (threadId !== pending.threadId) return;

    if (pending.turnId === undefined) {
      if (relevantBufferedMethods.has(method) && pending.buffered.length < 100) {
        pending.buffered.push({ method, params });
      }
      return;
    }
    this.processNotification(pending, method, params);
  }

  public handleProtocolError(error: Error): void {
    const pending = this.#pendingTurn;
    if (pending !== undefined && !pending.settled) this.finishFailure(pending, protocolFailure(error.message));
  }

  public handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const pending = this.#pendingTurn;
    if (pending !== undefined && !pending.settled) {
      this.finishFailure(pending, {
        kind: 'process_exit',
        code: code === null ? signal ?? undefined : String(code),
        message: `Codex app-server exited during turn (code=${String(code)}, signal=${String(signal)})`,
      });
    }
    this.#managerSession = undefined;
  }

  public stop(): void {
    const pending = this.#pendingTurn;
    if (pending !== undefined && !pending.settled) {
      this.finishFailure(pending, {
        kind: 'provider_error',
        code: 'PROVIDER_STOPPED',
        message: 'Codex provider stopped during turn',
      });
    }
    this.#managerSession = undefined;
  }

  private async createManagerThreadRequest(): Promise<CodexManagerSession> {
    let response: unknown;
    try {
      response = await this.transport.request('thread/start', {}, this.#threadRequestTimeoutMs);
    } catch (error) {
      const failure = classifyRequestFailure(error);
      throw new CodexManagerError(failure.kind, failure.message, failure.code);
    }
    const thread = readRecordField(response, 'thread');
    const threadId = readNonEmptyString(thread, 'id');
    const sessionId = readNonEmptyString(thread, 'sessionId');
    if (threadId === undefined || sessionId === undefined) {
      throw new CodexManagerError(
        'protocol_error',
        'thread/start response is missing thread.id or thread.sessionId',
        'INVALID_THREAD_RESPONSE',
      );
    }
    this.#managerSession = { threadId, sessionId };
    return { ...this.#managerSession };
  }

  private createPendingTurn(session: CodexManagerSession): PendingTurn {
    let resolveTurn: ((result: CodexTurnResult) => void) | undefined;
    const promise = new Promise<CodexTurnResult>((resolve) => {
      resolveTurn = resolve;
    });
    if (resolveTurn === undefined) throw new Error('Unable to create turn result promise');
    const pending: PendingTurn = {
      threadId: session.threadId,
      sessionId: session.sessionId,
      turnId: undefined,
      startedAt: Date.now(),
      settled: false,
      timer: undefined,
      resolve: resolveTurn,
      promise,
      events: [],
      itemOrder: [],
      textItems: new Map(),
      buffered: [],
      lastError: undefined,
    };
    return pending;
  }

  private armTurnTimeout(pending: PendingTurn, timeoutMs: number): void {
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - pending.startedAt));
    pending.timer = setTimeout(() => {
      this.finishFailure(pending, {
        kind: 'timeout',
        code: 'TURN_TIMEOUT',
        message: `Codex turn timed out after ${String(timeoutMs)}ms`,
      });
    }, remainingMs);
  }

  private flushBufferedNotifications(pending: PendingTurn): void {
    const buffered = pending.buffered.splice(0);
    for (const notification of buffered) {
      if (pending.settled) break;
      this.processNotification(pending, notification.method, notification.params);
    }
  }

  private processNotification(pending: PendingTurn, method: string, params: Record<string, unknown>): void {
    const notificationTurnId = extractTurnId(params);
    if (notificationTurnId !== pending.turnId) {
      this.#diagnostics?.record('late-turn-event', {
        method,
        threadId: pending.threadId,
        turnId: notificationTurnId,
      });
      return;
    }

    switch (method) {
      case 'turn/started':
        this.addEvent(pending, { kind: 'started', method });
        break;
      case 'item/agentMessage/delta':
        this.handleTextDelta(pending, params, method);
        break;
      case 'item/completed':
        this.handleItemCompleted(pending, params, method);
        break;
      case 'error':
        this.handleErrorNotification(pending, params, method);
        break;
      case 'turn/completed': {
        const turn = readRecordField(params, 'turn');
        this.collectItemsFromTurn(pending, turn);
        this.handleTurnRecordIfTerminal(pending, turn);
        break;
      }
      default:
        this.addEvent(pending, { kind: 'unknown', method });
        break;
    }
  }

  private handleTextDelta(pending: PendingTurn, params: Record<string, unknown>, method: string): void {
    const itemId = readNonEmptyString(params, 'itemId');
    const delta = typeof params.delta === 'string' ? params.delta : undefined;
    if (itemId === undefined || delta === undefined) {
      this.finishFailure(pending, protocolFailure('Agent message delta is missing itemId or delta'));
      return;
    }
    const item = this.ensureTextItem(pending, itemId);
    item.delta += delta;
    this.addEvent(pending, { kind: 'text_delta', method, textLength: delta.length });
  }

  private handleItemCompleted(pending: PendingTurn, params: Record<string, unknown>, method: string): void {
    const item = readRecordField(params, 'item');
    if (item.type !== 'agentMessage') return;
    const itemId = readNonEmptyString(item, 'id');
    if (itemId === undefined || typeof item.text !== 'string') {
      this.finishFailure(pending, protocolFailure('Completed agent message is missing id or text'));
      return;
    }
    const state = this.ensureTextItem(pending, itemId);
    state.finalText = item.text;
    state.phase = typeof item.phase === 'string' ? item.phase : null;
    this.addEvent(pending, { kind: 'text_final', method, textLength: item.text.length });
  }

  private handleErrorNotification(pending: PendingTurn, params: Record<string, unknown>, method: string): void {
    const error = normalizeTurnError(params.error);
    pending.lastError = error;
    this.recordDiagnostic('failed', pending, { method, errorCode: error.code, willRetry: params.willRetry });
    if (params.willRetry === false) this.finishFailure(pending, error);
  }

  private handleTurnRecordIfTerminal(pending: PendingTurn, turn: Record<string, unknown>): void {
    if (pending.settled) return;
    if (turn.status === 'completed') {
      this.finishCompleted(pending);
    } else if (turn.status === 'failed' || turn.status === 'interrupted') {
      this.finishFailure(pending, pending.lastError ?? normalizeTurnError(turn.error));
    }
  }

  private collectItemsFromTurn(pending: PendingTurn, turn: Record<string, unknown>): void {
    if (!Array.isArray(turn.items)) return;
    for (const value of turn.items) {
      if (!isRecord(value) || value.type !== 'agentMessage') continue;
      const itemId = readNonEmptyString(value, 'id');
      if (itemId === undefined || typeof value.text !== 'string') continue;
      const state = this.ensureTextItem(pending, itemId);
      state.finalText = value.text;
      state.phase = typeof value.phase === 'string' ? value.phase : null;
    }
  }

  private ensureTextItem(pending: PendingTurn, itemId: string): TextItemState {
    let item = pending.textItems.get(itemId);
    if (item === undefined) {
      item = { delta: '', finalText: undefined, phase: null };
      pending.textItems.set(itemId, item);
      pending.itemOrder.push(itemId);
    }
    return item;
  }

  private finishCompleted(pending: PendingTurn): void {
    if (pending.settled) return;
    this.addEvent(pending, { kind: 'completed', method: 'turn/completed' });
    this.finish(pending, {
      threadId: pending.threadId,
      sessionId: pending.sessionId,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
      status: 'completed',
      text: collectText(pending),
      events: [...pending.events],
    });
  }

  private finishFailure(pending: PendingTurn, error: NormalizedTurnError): void {
    if (pending.settled) {
      this.#diagnostics?.record('late-turn-event', {
        threadId: pending.threadId,
        turnId: pending.turnId,
        errorCode: error.code,
      });
      return;
    }
    this.addEvent(pending, { kind: 'failed', ...(error.code === undefined ? {} : { errorCode: error.code }) });
    const status: CodexTurnResultStatus =
      error.kind === 'timeout' ? 'timeout' : error.kind === 'upstream_unavailable' ? 'upstream_unavailable' : 'failed';
    this.finish(pending, {
      threadId: pending.threadId,
      sessionId: pending.sessionId,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
      status,
      text: collectText(pending),
      events: [...pending.events],
      error: {
        kind: error.kind,
        ...(error.code === undefined ? {} : { code: error.code }),
        message: error.message,
      },
    });
  }

  private finish(pending: PendingTurn, result: CodexTurnResult): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.buffered.length = 0;
    this.#lastSettledTurn = { threadId: pending.threadId, turnId: pending.turnId };
    pending.resolve(result);
  }

  private addEvent(
    pending: PendingTurn,
    event: {
      kind: CodexTurnEventKind;
      method?: string;
      textLength?: number;
      errorCode?: string;
    },
  ): void {
    const mapped: CodexTurnEvent = {
      kind: event.kind,
      threadId: pending.threadId,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
      elapsedMs: Date.now() - pending.startedAt,
      ...(event.textLength === undefined ? {} : { textLength: event.textLength }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    };
    pending.events.push(mapped);
    this.recordDiagnostic(mapped.kind, pending, {
      ...mapped,
      ...(event.method === undefined ? {} : { method: event.method }),
    });
  }

  private recordDiagnostic(kind: CodexTurnEventKind, pending: PendingTurn, details: Record<string, unknown>): void {
    this.#diagnostics?.record('turn-event', {
      kind,
      threadId: pending.threadId,
      turnId: pending.turnId,
      elapsedMs: Date.now() - pending.startedAt,
      ...details,
    });
  }
}

function collectText(pending: PendingTurn): string {
  const states = pending.itemOrder.map((itemId) => pending.textItems.get(itemId)).filter(isDefined);
  const finalAnswerStates = states.filter((state) => state.phase === 'final_answer');
  const selected = finalAnswerStates.length > 0 ? finalAnswerStates : states;
  return selected.map((state) => state.finalText ?? state.delta).join('');
}

function normalizeTurnError(value: unknown): NormalizedTurnError {
  if (!isRecord(value)) return { kind: 'provider_error', code: undefined, message: 'Codex turn failed' };
  const message = typeof value.message === 'string' ? value.message : 'Codex turn failed';
  const code = normalizeErrorCode(value.codexErrorInfo);
  const upstream =
    code === 'serverOverloaded' ||
    code === 'rateLimitExceeded' ||
    /at capacity|temporar(?:y|ily) unavailable|server overloaded|service unavailable/i.test(message);
  return { kind: upstream ? 'upstream_unavailable' : 'provider_error', code, message };
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return Object.keys(value)[0];
  return undefined;
}

function classifyRequestFailure(error: unknown): NormalizedTurnError {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return { kind: 'timeout', code: 'REQUEST_TIMEOUT', message };
  if (/serverOverloaded|at capacity|temporar(?:y|ily) unavailable/i.test(message)) {
    return { kind: 'upstream_unavailable', code: 'serverOverloaded', message };
  }
  return { kind: 'provider_error', code: undefined, message };
}

function protocolFailure(message: string): NormalizedTurnError {
  return { kind: 'protocol_error', code: 'PROTOCOL_ERROR', message };
}

function extractTurnId(params: Record<string, unknown>): string | undefined {
  return readNonEmptyString(params, 'turnId') ?? readNonEmptyString(readRecordField(params, 'turn'), 'id');
}

function readRecordField(record: unknown, key: string): Record<string, unknown> {
  if (!isRecord(record)) return {};
  const value = record[key];
  return isRecord(value) ? value : {};
}

function readNonEmptyString(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
