import { ClaudeCapabilityDetector } from '../providers/claude/ClaudeCapabilityDetector.js';
import { CodexCapabilityDetector } from '../providers/codex/CodexCapabilityDetector.js';
import { CursorCapabilityDetector } from '../providers/cursor/CursorCapabilityDetector.js';
import { AntigravityCapabilityDetector } from '../providers/antigravity/AntigravityCapabilityDetector.js';
import type { AgentProviderFactory } from '../runtime/providers/AgentProviderFactory.js';
import { CLAUDE_AGENT_PROVIDER_CAPABILITIES } from '../runtime/providers/adapters/ClaudeAgentProvider.js';
import { CODEX_AGENT_PROVIDER_CAPABILITIES } from '../runtime/providers/adapters/CodexAgentProvider.js';
import { CURSOR_AGENT_PROVIDER_CAPABILITIES } from '../runtime/providers/adapters/CursorAgentProvider.js';
import { ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES } from '../runtime/providers/adapters/AntigravityAgentProvider.js';

export type ProviderRuntimeStatus =
  | 'READY'
  | 'EXECUTABLE_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'PROBE_FAILED'
  | 'PROBE_TIMEOUT';

export interface ProviderModelDto {
  readonly modelId: string;
  readonly label: string;
}

export interface ProviderCapabilitiesDto {
  readonly outputProtocols: readonly ('manager-directive' | 'worker-result')[];
  readonly sessionContinuation: boolean;
}

export interface ProviderDto {
  readonly providerId: string;
  readonly supported: true;
  readonly usable: boolean;
  readonly installed: boolean;
  readonly authenticated: boolean | null;
  readonly version: string | null;
  readonly status: ProviderRuntimeStatus;
  readonly capabilities: ProviderCapabilitiesDto;
  readonly modelDiscovery: 'native' | 'unavailable';
  readonly models: readonly ProviderModelDto[];
  readonly checkedAt: string;
}

export interface ProviderDetectorLike {
  detect(): {
    ok?: boolean;
    providerId?: string;
    installed?: boolean;
    capabilities?: unknown;
    usable?: boolean;
    authenticated?: boolean | null;
    version?: string | null;
    status?: ProviderRuntimeStatus;
    modelDiscovery?: 'native' | 'unavailable';
    models?: readonly ProviderModelDto[];
  };
}

export interface ProviderCatalogServiceOptions {
  readonly providerFactory?: AgentProviderFactory;
  readonly claudeDetector?: ProviderDetectorLike;
  readonly codexDetector?: ProviderDetectorLike;
  readonly cursorDetector?: ProviderDetectorLike;
  readonly antigravityDetector?: ProviderDetectorLike;
  readonly ttlMs?: number;
}

export class ProviderCatalogService {
  readonly #providerFactory: AgentProviderFactory | undefined;
  readonly #claudeDetector: ProviderDetectorLike;
  readonly #codexDetector: ProviderDetectorLike;
  readonly #cursorDetector: ProviderDetectorLike;
  readonly #antigravityDetector: ProviderDetectorLike;
  readonly #ttlMs: number;

  #cachedCatalog: readonly ProviderDto[] | null = null;
  #lastCheckedAt = 0;
  #activeProbePromise: Promise<readonly ProviderDto[]> | null = null;

  public constructor(options: ProviderCatalogServiceOptions = {}) {
    this.#providerFactory = options.providerFactory;
    this.#claudeDetector = options.claudeDetector ?? new ClaudeCapabilityDetector();
    this.#codexDetector = options.codexDetector ?? new CodexCapabilityDetector();
    this.#cursorDetector = options.cursorDetector ?? new CursorCapabilityDetector();
    this.#antigravityDetector = options.antigravityDetector ?? new AntigravityCapabilityDetector();
    this.#ttlMs = options.ttlMs ?? 10_000; // 10s default cache TTL
  }

  public get providerFactory(): AgentProviderFactory | undefined {
    return this.#providerFactory;
  }

  public async getCatalog(forceRefresh = false): Promise<readonly ProviderDto[]> {
    const now = Date.now();
    if (!forceRefresh && this.#cachedCatalog !== null && now - this.#lastCheckedAt < this.#ttlMs) {
      return this.#cachedCatalog;
    }

    if (this.#activeProbePromise !== null) {
      return this.#activeProbePromise;
    }

    this.#activeProbePromise = this.#probeAll()
      .then((catalog) => {
        this.#cachedCatalog = catalog;
        this.#lastCheckedAt = Date.now();
        return catalog;
      })
      .finally(() => {
        this.#activeProbePromise = null;
      });

    return this.#activeProbePromise;
  }

  public async isProviderUsable(providerId: string): Promise<boolean> {
    const catalog = await this.getCatalog();
    const found = catalog.find((p) => p.providerId === providerId);
    return found?.usable ?? false;
  }

  public isUsableSync(providerId: string): boolean {
    if (this.#cachedCatalog !== null) {
      const found = this.#cachedCatalog.find((p) => p.providerId === providerId);
      if (found !== undefined) return found.usable;
    }
    const checkedAt = new Date().toISOString();
    let probed: ProviderDto | undefined;
    if (providerId === 'claude') probed = this.#probeClaude(checkedAt);
    else if (providerId === 'codex') probed = this.#probeCodex(checkedAt);
    else if (providerId === 'cursor') probed = this.#probeCursor(checkedAt);
    else if (providerId === 'antigravity') probed = this.#probeAntigravity(checkedAt);
    return probed?.usable ?? false;
  }

  public getCachedProvider(providerId: string): ProviderDto | undefined {
    return this.#cachedCatalog?.find((p) => p.providerId === providerId);
  }

  #probeAll(): Promise<readonly ProviderDto[]> {
    const checkedAt = new Date().toISOString();

    const claudeDto = this.#probeClaude(checkedAt);
    const codexDto = this.#probeCodex(checkedAt);
    const cursorDto = this.#probeCursor(checkedAt);
    const antigravityDto = this.#probeAntigravity(checkedAt);

    return Promise.resolve(Object.freeze([claudeDto, codexDto, cursorDto, antigravityDto]));
  }

  #probeClaude(checkedAt: string): ProviderDto {
    try {
      const res = this.#claudeDetector.detect() as {
        ok?: boolean;
        installed?: boolean;
        capabilities?: { installed?: boolean; version?: string; authStatusAvailable?: boolean; authenticated?: boolean };
        usable?: boolean;
        status?: ProviderRuntimeStatus;
        version?: string | null;
        models?: readonly ProviderModelDto[];
      };

      const installed = res.capabilities?.installed ?? res.installed ?? false;
      const status: ProviderRuntimeStatus = res.status ?? (installed ? 'READY' : 'EXECUTABLE_NOT_FOUND');
      const usable = res.usable ?? (status === 'READY');
      const version = res.capabilities?.version ?? res.version ?? null;
      const authenticated = res.capabilities?.authStatusAvailable ? (res.capabilities.authenticated ?? null) : null;

      return Object.freeze({
        providerId: 'claude',
        supported: true,
        usable,
        installed,
        authenticated,
        version: version ? version.slice(0, 64) : null,
        status,
        capabilities: CLAUDE_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: res.models && res.models.length > 0 ? 'native' : 'unavailable',
        models: res.models ? Object.freeze([...res.models]) : Object.freeze([]),
        checkedAt,
      });
    } catch {
      return Object.freeze({
        providerId: 'claude',
        supported: true,
        usable: false,
        installed: false,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: CLAUDE_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }
  }

  #probeCodex(checkedAt: string): ProviderDto {
    try {
      const res = this.#codexDetector.detect() as {
        installed?: boolean;
        version?: string;
        usable?: boolean;
        status?: ProviderRuntimeStatus;
        models?: readonly ProviderModelDto[];
      };

      const installed = res.installed ?? false;
      const status: ProviderRuntimeStatus = res.status ?? (installed ? 'READY' : 'EXECUTABLE_NOT_FOUND');
      const usable = res.usable ?? (status === 'READY');
      const version = res.version ?? null;

      return Object.freeze({
        providerId: 'codex',
        supported: true,
        usable,
        installed,
        authenticated: null,
        version: version ? version.slice(0, 64) : null,
        status,
        capabilities: CODEX_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: res.models && res.models.length > 0 ? 'native' : 'unavailable',
        models: res.models ? Object.freeze([...res.models]) : Object.freeze([]),
        checkedAt,
      });
    } catch {
      return Object.freeze({
        providerId: 'codex',
        supported: true,
        usable: false,
        installed: false,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: CODEX_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }
  }

  #probeCursor(checkedAt: string): ProviderDto {
    try {
      const res = this.#cursorDetector.detect();
      const status: ProviderRuntimeStatus = res.status ?? (res.installed ? 'READY' : 'EXECUTABLE_NOT_FOUND');
      const usable = res.usable ?? (status === 'READY');

      return Object.freeze({
        providerId: 'cursor',
        supported: true,
        usable,
        installed: res.installed ?? false,
        authenticated: res.authenticated ?? null,
        version: res.version ? res.version.slice(0, 64) : null,
        status,
        capabilities: CURSOR_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: res.modelDiscovery ?? (res.models && res.models.length > 0 ? 'native' : 'unavailable'),
        models: res.models ? Object.freeze([...res.models]) : Object.freeze([]),
        checkedAt,
      });
    } catch {
      return Object.freeze({
        providerId: 'cursor',
        supported: true,
        usable: false,
        installed: false,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: CURSOR_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }
  }

  #probeAntigravity(checkedAt: string): ProviderDto {
    try {
      const res = this.#antigravityDetector.detect();
      const status: ProviderRuntimeStatus = res.status ?? (res.installed ? 'READY' : 'EXECUTABLE_NOT_FOUND');
      const usable = res.usable ?? (status === 'READY');

      return Object.freeze({
        providerId: 'antigravity',
        supported: true,
        usable,
        installed: res.installed ?? false,
        authenticated: res.authenticated ?? null,
        version: res.version ? res.version.slice(0, 64) : null,
        status,
        capabilities: ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: res.modelDiscovery ?? (res.models && res.models.length > 0 ? 'native' : 'unavailable'),
        models: res.models ? Object.freeze([...res.models]) : Object.freeze([]),
        checkedAt,
      });
    } catch {
      return Object.freeze({
        providerId: 'antigravity',
        supported: true,
        usable: false,
        installed: false,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: ANTIGRAVITY_AGENT_PROVIDER_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }
  }
}
