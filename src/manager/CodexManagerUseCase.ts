import type { EventBus } from '../events/event-bus.js';
import type { ManagerPromptEnvelope } from '../protocol/PromptEnvelope.js';
import { CodexManagerDirectiveRunner, type ManagerDirectiveTurnResult } from '../providers/codex/CodexManagerDirective.js';
import type {
  CodexSession,
  CodexSessionRecord,
  CodexSessionStore,
} from '../providers/codex/session/CodexSessionStore.js';
import {
  CodexManagerError,
  CodexManagerTurnController,
  type CodexManagerSession,
  type CodexTurnRequest,
  type CodexTurnResult,
} from '../providers/codex/CodexManagerTurn.js';
import {
  CodexProvider,
  type CodexNotificationHandler,
  type CodexProcessErrorHandler,
  type CodexProcessExitHandler,
  type CodexProtocolErrorHandler,
  type CodexProviderOptions,
  type CodexServerRequestHandler,
} from '../providers/codex/CodexProvider.js';
import { ManagerPromptBuilder } from './ManagerPromptBuilder.js';

export interface CodexManagerUseCaseOptions {
  threadRequestTimeoutMs?: number;
  turnTimeoutMs?: number;
  sessionStore?: CodexSessionStore;
}

export interface StartCodexSessionOptions {
  replaceExisting?: boolean;
}

export class CodexManagerUseCase {
  readonly turns: CodexManagerTurnController;
  readonly directives: CodexManagerDirectiveRunner;
  readonly promptBuilder: ManagerPromptBuilder;
  readonly #notificationHandlers = new Set<CodexNotificationHandler>();
  readonly #serverRequestHandlers = new Set<CodexServerRequestHandler>();
  readonly #protocolErrorHandlers = new Set<CodexProtocolErrorHandler>();
  readonly #processExitHandlers = new Set<CodexProcessExitHandler>();
  readonly #processErrorHandlers = new Set<CodexProcessErrorHandler>();
  readonly #unsubscribe: Array<() => void>;
  readonly #sessionStore: CodexSessionStore | undefined;

  public constructor(
    readonly provider: CodexProvider,
    options: CodexManagerUseCaseOptions = {},
  ) {
    this.turns = new CodexManagerTurnController(provider.client, () => provider.assertReady(), {
      ...(options.threadRequestTimeoutMs === undefined ? {} : { threadRequestTimeoutMs: options.threadRequestTimeoutMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      diagnostics: provider.client.diagnostics,
    });
    this.directives = new CodexManagerDirectiveRunner(this.turns, provider.client.diagnostics);
    this.promptBuilder = new ManagerPromptBuilder(provider.client.diagnostics);
    this.#sessionStore = options.sessionStore;
    this.#unsubscribe = [
      provider.onNotification((method, params) => {
        this.turns.handleNotification(method, params);
        for (const handler of this.#notificationHandlers) handler(method, params);
      }),
      provider.onServerRequest((request) => {
        for (const handler of this.#serverRequestHandlers) handler(request);
      }),
      provider.onProtocolError((error) => {
        this.turns.handleProtocolError(error);
        for (const handler of this.#protocolErrorHandlers) handler(error);
      }),
      provider.onProcessExit((code, signal) => {
        this.turns.handleProcessExit(code, signal);
        for (const handler of this.#processExitHandlers) handler(code, signal);
      }),
      provider.onProcessError((error) => {
        this.turns.handleProtocolError(error);
        for (const handler of this.#processErrorHandlers) handler(error);
      }),
    ];
  }

  public static create(
    providerOptions: CodexProviderOptions = {},
    useCaseOptions: CodexManagerUseCaseOptions = {},
    eventBus?: EventBus,
  ): CodexManagerUseCase {
    return new CodexManagerUseCase(new CodexProvider(providerOptions, eventBus), useCaseOptions);
  }

  public get client(): CodexProvider['client'] {
    return this.provider.client;
  }

  public initialize(): Promise<unknown> {
    return this.provider.initialize();
  }

  public getStatus(): ReturnType<CodexProvider['getStatus']> {
    return this.provider.getStatus();
  }

  public async shutdown(): Promise<void> {
    this.turns.stop();
    await this.provider.shutdown();
  }

  public dispose(): void {
    this.turns.stop();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#notificationHandlers.clear();
    this.#serverRequestHandlers.clear();
    this.#protocolErrorHandlers.clear();
    this.#processExitHandlers.clear();
    this.#processErrorHandlers.clear();
  }

  public onNotification(handler: CodexNotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  public onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.#serverRequestHandlers.add(handler);
    return () => this.#serverRequestHandlers.delete(handler);
  }

  public onProtocolError(handler: CodexProtocolErrorHandler): () => void {
    this.#protocolErrorHandlers.add(handler);
    return () => this.#protocolErrorHandlers.delete(handler);
  }

  public onProcessExit(handler: CodexProcessExitHandler): () => void {
    this.#processExitHandlers.add(handler);
    return () => this.#processExitHandlers.delete(handler);
  }

  public onProcessError(handler: CodexProcessErrorHandler): () => void {
    this.#processErrorHandlers.add(handler);
    return () => this.#processErrorHandlers.delete(handler);
  }

  public createManagerThread(): Promise<CodexManagerSession> {
    return this.turns.createManagerThread();
  }

  public async startSession(sessionKey: string, options: StartCodexSessionOptions = {}): Promise<CodexSession> {
    const store = this.requireSessionStore();
    if (store.get(sessionKey) !== undefined && options.replaceExisting !== true) {
      throw new CodexManagerError('provider_error', `Codex session already exists: ${sessionKey}`, 'SESSION_EXISTS');
    }
    const session = await this.turns.startFreshThread();
    store.save(sessionKey, session);
    return session;
  }

  public async resumeSession(sessionKey: string): Promise<CodexSession> {
    const store = this.requireSessionStore();
    const persisted = store.get(sessionKey);
    if (persisted === undefined) {
      throw new CodexManagerError('provider_error', `Codex session was not found: ${sessionKey}`, 'SESSION_NOT_FOUND');
    }
    const session = await this.turns.resumeThread(persisted.threadId);
    store.save(sessionKey, session);
    return session;
  }

  public getPersistedSession(sessionKey: string): CodexSessionRecord | undefined {
    return this.requireSessionStore().get(sessionKey);
  }

  public deletePersistedSession(sessionKey: string): void {
    this.requireSessionStore().delete(sessionKey);
  }

  public runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    return this.turns.runTurn(request);
  }

  public runDirectiveTurn(request: CodexTurnRequest): Promise<ManagerDirectiveTurnResult> {
    return this.directives.run(request);
  }

  public async runManagerPlanningTurn(envelope: ManagerPromptEnvelope): Promise<ManagerDirectiveTurnResult> {
    const prompt = this.promptBuilder.build(envelope);
    return await this.runDirectiveTurn({ prompt });
  }

  public getManagerSession(): CodexManagerSession | undefined {
    return this.turns.managerSession;
  }

  public get pendingTurnCount(): number {
    return this.turns.pendingTurnCount;
  }

  private requireSessionStore(): CodexSessionStore {
    if (this.#sessionStore === undefined) {
      throw new CodexManagerError('provider_error', 'Codex session store is not configured', 'SESSION_STORE_REQUIRED');
    }
    return this.#sessionStore;
  }
}
