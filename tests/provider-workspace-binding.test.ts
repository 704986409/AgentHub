import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentProviderFactory,
  ClaudeAgentProvider,
  CodexAgentProvider,
  EventBus,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnResult,
  type ClaudeWorkerSessionOptions,
  type CodexManagerUseCaseLike,
  type CodexManagerUseCaseOptions,
  type CodexProviderOptions,
} from '../src/index.js';

const context = { agentId: 'agent', taskId: 'task', assignmentId: 'assignment' };

describe('provider workspace binding', () => {
  it('validates and snapshots workspacePath in AgentProviderFactory', () => {
    const provider = new CaptureProvider();
    const factory = new AgentProviderFactory();
    factory.register(provider);
    const path = resolve('worktree');
    const request = { eventBus: new EventBus(), context, workspacePath: path };
    factory.createSession('capture', request);
    request.workspacePath = resolve('mutated');
    expect(provider.options?.workspacePath).toBe(path);
    for (const invalid of ['', 'relative', `C:\\bad\0path`, 'x'.repeat(33 * 1024)]) {
      expect(() => factory.createSession('capture', { ...request, workspacePath: invalid })).toThrow();
    }
  });

  it.each([
    ['conflicting static cwd', { cwd: resolve('primary') }],
    ['no static cwd', {}],
  ])('makes task workspace authoritative for Codex with %s', (_name, configured) => {
    let captured: CodexProviderOptions | undefined;
    const provider = new CodexAgentProvider({
      createUseCase: (...args: [CodexProviderOptions, CodexManagerUseCaseOptions]) => {
        captured = args[0];
        return new FakeCodexUseCase();
      },
    });
    const workspacePath = resolve('task-worktree');
    provider.createSession({
      eventBus: new EventBus(), context: { ...context, provider: 'codex' }, workspacePath,
      config: { providerOptions: configured },
    });
    expect(captured?.cwd).toBe(workspacePath);
  });

  it.each([
    ['conflicting static cwd', { cwd: resolve('primary') }],
    ['no static config', undefined],
  ])('makes task workspace authoritative for Claude with %s', (_name, config) => {
    let captured: ClaudeWorkerSessionOptions | undefined;
    const provider = new ClaudeAgentProvider({
      createWorkerSession: (options) => { captured = options; return new FakeClaudeWorker(); },
    });
    const workspacePath = resolve('task-worktree');
    provider.createSession({
      eventBus: new EventBus(), context: { ...context, provider: 'claude' }, workspacePath,
      ...(config === undefined ? {} : { config }),
    });
    expect(captured?.transportOptions?.cwd).toBe(workspacePath);
  });
});

const capabilities: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const), sessionContinuation: true,
});
class CaptureProvider implements AgentProvider {
  public readonly id = 'capture';
  public readonly capabilities = capabilities;
  public readonly session = new FakeClaudeSession();
  public options: AgentProviderSessionCreateOptions | undefined;
  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    this.options = options;
    return this.session;
  }
}
class FakeClaudeSession implements AgentProviderSession {
  public readonly providerId = 'capture';
  public readonly capabilities = capabilities;
  public started = false;
  public active = false;
  public readonly sessionId = 'session';
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public runTurn(): Promise<AgentProviderTurnResult> { throw new Error('unused'); }
  public shutdown(): Promise<void> { this.started = false; return Promise.resolve(); }
}
class FakeClaudeWorker {
  public started = false;
  public active = false;
  public readonly sessionId = 'session';
  public start(): Promise<void> { this.started = true; return Promise.resolve(); }
  public runTurn(): Promise<never> { throw new Error('unused'); }
  public shutdown(): Promise<void> { this.started = false; return Promise.resolve(); }
}
class FakeCodexUseCase implements CodexManagerUseCaseLike {
  public initialize(): Promise<void> { return Promise.resolve(); }
  public shutdown(): Promise<void> { return Promise.resolve(); }
  public runDirectiveTurn(): Promise<never> { throw new Error('unused'); }
  public getManagerSession(): undefined { return undefined; }
  public getStatus(): never { throw new Error('unused'); }
  public onNotification(): () => void { return () => undefined; }
  public onServerRequest(): () => void { return () => undefined; }
  public onProtocolError(): () => void { return () => undefined; }
  public onProcessExit(): () => void { return () => undefined; }
  public onProcessError(): () => void { return () => undefined; }
}
