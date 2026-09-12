import type { ClaudeAutoTransportOptions } from '../../../providers/claude/ClaudeAutoTransport.js';
import {
  claudeCapabilityNames,
  type ClaudeCapabilityReport,
} from '../../../providers/claude/ClaudeCapabilityDetector.js';
import {
  ClaudeWorkerSession,
  type ClaudeWorkerSessionOptions,
  type ClaudeWorkerTurnResult,
} from '../../../providers/claude/ClaudeWorkerSession.js';
import {
  validateAgentProviderTurnRequest,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
} from '../AgentProvider.js';

export const CLAUDE_AGENT_PROVIDER_ID = 'claude';

export const CLAUDE_AGENT_PROVIDER_CAPABILITIES: AgentProviderCapabilities = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

export interface ClaudeAgentProviderDependencies {
  readonly createWorkerSession?: (options: ClaudeWorkerSessionOptions) => ClaudeWorkerSessionLike;
}

export interface ClaudeWorkerSessionLike {
  readonly started: boolean;
  readonly active: boolean;
  readonly sessionId: string | undefined;
  start(): Promise<void>;
  runTurn(request: { prompt: string; timeoutMs?: number }): Promise<ClaudeWorkerTurnResult>;
  shutdown(): Promise<void>;
}

export class ClaudeAgentProvider implements AgentProvider {
  public readonly id = CLAUDE_AGENT_PROVIDER_ID;
  public readonly capabilities = CLAUDE_AGENT_PROVIDER_CAPABILITIES;
  readonly #createWorkerSession: (options: ClaudeWorkerSessionOptions) => ClaudeWorkerSessionLike;

  public constructor(dependencies: ClaudeAgentProviderDependencies = {}) {
    this.#createWorkerSession = dependencies.createWorkerSession ?? ((options) => new ClaudeWorkerSession(options));
  }

  public createSession(options: AgentProviderSessionCreateOptions): AgentProviderSession {
    const transportOptions = validateClaudeConfig(options.config);
    const worker = this.#createWorkerSession({
      eventBus: options.eventBus,
      context: Object.freeze({ ...options.context, provider: CLAUDE_AGENT_PROVIDER_ID }),
      ...(transportOptions === undefined ? {} : { transportOptions }),
    });
    return new ClaudeAgentProviderSession(worker);
  }
}

class ClaudeAgentProviderSession implements AgentProviderSession {
  public readonly providerId = CLAUDE_AGENT_PROVIDER_ID;
  public readonly capabilities = CLAUDE_AGENT_PROVIDER_CAPABILITIES;

  public constructor(private readonly worker: ClaudeWorkerSessionLike) {}

  public get started(): boolean {
    return this.worker.started;
  }

  public get active(): boolean {
    return this.worker.active;
  }

  public get sessionId(): string | undefined {
    return this.worker.sessionId;
  }

  public start(): Promise<void> {
    return this.worker.start();
  }

  public async runTurn(request: AgentProviderTurnRequest): Promise<AgentProviderTurnResult> {
    validateAgentProviderTurnRequest(request, this.capabilities);
    const result = await this.worker.runTurn({
      prompt: request.prompt,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    return mapClaudeResult(result);
  }

  public shutdown(): Promise<void> {
    return this.worker.shutdown();
  }
}

function mapClaudeResult(result: ClaudeWorkerTurnResult): AgentProviderTurnResult {
  const metadata = {
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
  };
  if (result.protocolValid) {
    return {
      ...metadata,
      protocol: 'worker-result',
      protocolValid: true,
      workerResult: result.workerResult,
    };
  }
  return {
    ...metadata,
    protocol: 'worker-result',
    protocolValid: false,
    failure: result.failure,
  };
}

const claudeConfigKeys = new Set([
  'mode', 'command', 'env', 'cwd', 'model', 'initialSessionId',
  'defaultTimeoutMs', 'stopTimeoutMs', 'disableTools', 'capabilityReport',
]);

function validateClaudeConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): Omit<ClaudeAutoTransportOptions, 'onRawMessage'> | undefined {
  if (config === undefined) return undefined;
  rejectUnknownKeys(config, claudeConfigKeys, 'Claude');
  validateEnum(config.mode, ['auto', 'persistent-stream', 'resume-per-turn'], 'mode');
  validateOptionalString(config.command, 'command', false);
  validateOptionalString(config.cwd, 'cwd', false);
  validateOptionalString(config.model, 'model', true);
  validateOptionalString(config.initialSessionId, 'initialSessionId', true);
  validateOptionalTimeout(config.defaultTimeoutMs, 'defaultTimeoutMs');
  validateOptionalTimeout(config.stopTimeoutMs, 'stopTimeoutMs');
  if (config.disableTools !== undefined && typeof config.disableTools !== 'boolean') invalidConfig('disableTools');
  if (config.env !== undefined && !isStringRecord(config.env)) invalidConfig('env');
  if (config.capabilityReport !== undefined && !isClaudeCapabilityReport(config.capabilityReport)) {
    invalidConfig('capabilityReport');
  }
  return snapshotClaudeConfig(config);
}

function snapshotClaudeConfig(
  config: Readonly<Record<string, unknown>>,
): Omit<ClaudeAutoTransportOptions, 'onRawMessage'> {
  const report = config.capabilityReport as ClaudeCapabilityReport | undefined;
  return {
    ...config,
    ...(config.env === undefined ? {} : { env: { ...(config.env as NodeJS.ProcessEnv) } }),
    ...(report === undefined ? {} : {
      capabilityReport: {
        ...report,
        capabilities: { ...report.capabilities },
        missingRequiredCapabilities: [...report.missingRequiredCapabilities],
        unknownCapabilities: [...report.unknownCapabilities],
        unsupportedCapabilities: [...report.unsupportedCapabilities],
        checks: report.checks.map((check) => ({ ...check })),
        diagnostics: [...report.diagnostics],
      },
    }),
  };
}

function rejectUnknownKeys(config: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, provider: string): void {
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new TypeError(`${provider} provider config contains unsupported key ${key}`);
  }
}

function validateEnum(value: unknown, allowed: readonly string[], key: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) invalidConfig(key);
}

function validateOptionalString(value: unknown, key: string, requireNonBlank: boolean): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || (requireNonBlank && value.trim().length === 0)) invalidConfig(key);
}

function validateOptionalTimeout(value: unknown, key: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) invalidConfig(key);
}

function invalidConfig(key: string): never {
  throw new TypeError(`Claude provider config field ${key} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string | undefined> {
  return isRecord(value) && Object.values(value).every((entry) => entry === undefined || typeof entry === 'string');
}

function isClaudeCapabilityReport(value: unknown): value is ClaudeCapabilityReport {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !isRecord(value.capabilities)) return false;
  const capabilities = value.capabilities;
  if (!claudeCapabilityNames.every((name) => typeof capabilities[name] === 'boolean')) return false;
  if (typeof capabilities.executablePath !== 'string' ||
    typeof capabilities.executableResolved !== 'boolean' ||
    typeof capabilities.executableExists !== 'boolean' ||
    typeof capabilities.installed !== 'boolean' ||
    typeof capabilities.platform !== 'string' ||
    typeof capabilities.authStatusAvailable !== 'boolean') return false;
  if (!isOptionalString(capabilities.version) || !isOptionalString(capabilities.versionNumber) ||
    !isOptionalBoolean(capabilities.authenticated) || !isOptionalString(capabilities.rawVersion)) return false;
  return isStringArray(value.missingRequiredCapabilities) &&
    isStringArray(value.unknownCapabilities) &&
    isStringArray(value.unsupportedCapabilities) &&
    Array.isArray(value.checks) && value.checks.every(isCapabilityCheck) &&
    isStringArray(value.diagnostics);
}

function isCapabilityCheck(value: unknown): boolean {
  return isRecord(value) && typeof value.capability === 'string' &&
    claudeCapabilityNames.includes(value.capability as (typeof claudeCapabilityNames)[number]) &&
    typeof value.supported === 'boolean' && typeof value.evidence === 'string' &&
    ['help', 'probe', 'unsupported', 'unknown'].includes(value.evidence);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
