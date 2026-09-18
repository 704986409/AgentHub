import { spawnSync } from 'node:child_process';
import {
  resolveAntigravityExecutable,
  AntigravityExecutableResolutionError,
  type AntigravityExecutableResolverDependencies,
} from './AntigravityExecutableResolver.js';
import {
  discoverAntigravityModels,
  type AntigravityModelDto,
} from './AntigravityModelDiscovery.js';
import type { ProviderRuntimeStatus } from '../../services/provider-catalog-service.js';

export interface AntigravityCapabilityReport {
  readonly providerId: 'antigravity';
  readonly supported: true;
  readonly usable: boolean;
  readonly installed: boolean;
  readonly authenticated: boolean | null;
  readonly version: string | null;
  readonly status: ProviderRuntimeStatus;
  readonly capabilities: {
    readonly outputProtocols: readonly ['worker-result'];
    readonly sessionContinuation: true;
  };
  readonly modelDiscovery: 'native' | 'unavailable';
  readonly models: readonly AntigravityModelDto[];
  readonly checkedAt: string;
}

export interface AntigravityCapabilityDetectorOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  resolver?: (command?: string, env?: NodeJS.ProcessEnv, deps?: AntigravityExecutableResolverDependencies) => string;
  runner?: (executable: string, args: readonly string[]) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string | undefined;
  };
}

export const ANTIGRAVITY_CAPABILITIES = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

export class AntigravityCapabilityDetector {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #resolver: (command?: string, env?: NodeJS.ProcessEnv) => string;
  readonly #runner: (executable: string, args: readonly string[]) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string | undefined;
  };

  public constructor(options: AntigravityCapabilityDetectorOptions = {}) {
    this.#command = options.command ?? 'agy';
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#resolver = options.resolver ?? ((cmd, env) => resolveAntigravityExecutable(cmd, env));
    this.#runner = options.runner ?? defaultRunner;
  }

  public detect(): AntigravityCapabilityReport {
    const checkedAt = new Date().toISOString();
    let executablePath: string;

    try {
      executablePath = this.#resolver(this.#command, this.#env);
    } catch (err) {
      if (err instanceof AntigravityExecutableResolutionError || (err instanceof Error && err.message.includes('not found'))) {
        return Object.freeze({
          providerId: 'antigravity',
          supported: true,
          usable: false,
          installed: false,
          authenticated: null,
          version: null,
          status: 'EXECUTABLE_NOT_FOUND',
          capabilities: ANTIGRAVITY_CAPABILITIES,
          modelDiscovery: 'unavailable',
          models: Object.freeze([]),
          checkedAt,
        });
      }
      return Object.freeze({
        providerId: 'antigravity',
        supported: true,
        usable: false,
        installed: false,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: ANTIGRAVITY_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }

    let version: string | null = null;
    try {
      const probeRes = this.#runner(executablePath, ['--version']);
      if (probeRes.error && probeRes.error.toLowerCase().includes('timeout')) {
        return Object.freeze({
          providerId: 'antigravity',
          supported: true,
          usable: false,
          installed: true,
          authenticated: null,
          version: null,
          status: 'PROBE_TIMEOUT',
          capabilities: ANTIGRAVITY_CAPABILITIES,
          modelDiscovery: 'unavailable',
          models: Object.freeze([]),
          checkedAt,
        });
      }
      if (probeRes.exitCode !== 0) {
        return Object.freeze({
          providerId: 'antigravity',
          supported: true,
          usable: false,
          installed: true,
          authenticated: null,
          version: null,
          status: 'PROBE_FAILED',
          capabilities: ANTIGRAVITY_CAPABILITIES,
          modelDiscovery: 'unavailable',
          models: Object.freeze([]),
          checkedAt,
        });
      }
      version = parseVersion(probeRes.stdout || probeRes.stderr);
    } catch {
      return Object.freeze({
        providerId: 'antigravity',
        supported: true,
        usable: false,
        installed: true,
        authenticated: null,
        version: null,
        status: 'PROBE_FAILED',
        capabilities: ANTIGRAVITY_CAPABILITIES,
        modelDiscovery: 'unavailable',
        models: Object.freeze([]),
        checkedAt,
      });
    }

    const modelResult = discoverAntigravityModels(executablePath, {
      timeoutMs: this.#timeoutMs,
      runner: this.#runner,
    });

    return Object.freeze({
      providerId: 'antigravity',
      supported: true,
      usable: true,
      installed: true,
      authenticated: null,
      version: version || 'unknown',
      status: 'READY',
      capabilities: ANTIGRAVITY_CAPABILITIES,
      modelDiscovery: modelResult.modelDiscovery,
      models: modelResult.models,
      checkedAt,
    });
  }
}

function parseVersion(raw: string): string {
  const line = raw.trim().split(/\r?\n/u)[0] ?? '';
  const match = /v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/u.exec(line);
  return match?.[1] ?? line.slice(0, 64).trim();
}

function defaultRunner(
  executable: string,
  args: readonly string[],
): { exitCode: number | null; stdout: string; stderr: string; error?: string | undefined } {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error?.message !== undefined ? { error: result.error.message } : {}),
  };
}
