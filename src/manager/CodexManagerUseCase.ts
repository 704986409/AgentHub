import type { EventBus } from '../events/event-bus.js';
import type { ManagerPromptEnvelope } from '../protocol/PromptEnvelope.js';
import { CodexManagerDirectiveRunner, type ManagerDirectiveTurnResult } from '../providers/codex/CodexManagerDirective.js';
import {
  CodexManagerTurnController,
  type CodexManagerSession,
  type CodexTurnRequest,
  type CodexTurnResult,
} from '../providers/codex/CodexManagerTurn.js';
import { CodexProvider, type CodexProviderOptions } from '../providers/codex/CodexProvider.js';
import { ManagerPromptBuilder } from './ManagerPromptBuilder.js';

export interface CodexManagerUseCaseOptions {
  threadRequestTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export class CodexManagerUseCase {
  readonly turns: CodexManagerTurnController;
  readonly directives: CodexManagerDirectiveRunner;
  readonly promptBuilder: ManagerPromptBuilder;
  readonly #unsubscribe: Array<() => void>;

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
    this.#unsubscribe = [
      provider.onNotification((method, params) => this.turns.handleNotification(method, params)),
      provider.onProtocolError((error) => this.turns.handleProtocolError(error)),
      provider.onProcessExit((code, signal) => this.turns.handleProcessExit(code, signal)),
      provider.onProcessError((error) => this.turns.handleProtocolError(error)),
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
  }

  public createManagerThread(): Promise<CodexManagerSession> {
    return this.turns.createManagerThread();
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
}
