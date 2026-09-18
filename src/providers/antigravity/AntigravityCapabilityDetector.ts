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
import { ANTIGRAVITY_CONVERSATION_RESUME_FLAG } from './AntigravityWorkerSession.js';
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
    readonly sessionContinuation: boolean;
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

const ANTIGRAVITY_STREAM_TOKENS = Object.freeze(['--input-format', '--output-format', 'stream-json']);
const ANTIGRAVITY_HEADLESS_TOKENS = Object.freeze(['--headless', '--non-interactive', '--print', '-p']);

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
    this.#runner = options.runner ?? ((executable, args) => defaultRunner(executable, args, this.#timeoutMs));
  }

  public detect(): AntigravityCapabilityReport {
    const checkedAt = new Date().toISOString();
    let executablePath: string;

    try {
      executablePath = this.#resolver(this.#command, this.#env);
    } catch (err) {
      if (err instanceof AntigravityExecutableResolutionError || (err instanceof Error && err.message.includes('not found'))) {
        return this.#report({
          usable: false,
          installed: false,
          status: 'EXECUTABLE_NOT_FOUND',
          checkedAt,
        });
      }
      return this.#report({
        usable: false,
        installed: false,
        status: 'PROBE_FAILED',
        checkedAt,
      });
    }

    let version: string | null = null;
    try {
      const probeRes = this.#runner(executablePath, ['--version']);
      if (isTimeout(probeRes.error)) {
        return this.#report({
          usable: false,
          installed: true,
          status: 'PROBE_TIMEOUT',
          checkedAt,
        });
      }
      if (probeRes.exitCode !== 0) {
        return this.#report({
          usable: false,
          installed: true,
          status: 'PROBE_FAILED',
          checkedAt,
        });
      }
      version = parseVersion(probeRes.stdout || probeRes.stderr);
    } catch {
      return this.#report({
        usable: false,
        installed: true,
        status: 'PROBE_FAILED',
        checkedAt,
      });
    }

    let helpRes;
    try {
      helpRes = this.#runner(executablePath, ['--help']);
    } catch {
      return this.#report({
        usable: false,
        installed: true,
        version,
        status: 'PROBE_FAILED',
        checkedAt,
      });
    }
    if (isTimeout(helpRes.error)) {
      return this.#report({
        usable: false,
        installed: true,
        version,
        status: 'PROBE_TIMEOUT',
        checkedAt,
      });
    }
    if (helpRes.error !== undefined || helpRes.exitCode !== 0) {
      return this.#report({
        usable: false,
        installed: true,
        version,
        status: 'PROBE_FAILED',
        checkedAt,
      });
    }

    const helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
    const streamOk = ANTIGRAVITY_STREAM_TOKENS.every((token) => helpText.includes(token));
    const headlessOk = ANTIGRAVITY_HEADLESS_TOKENS.some((token) => helpText.includes(token));
    const conversationResumeOk = helpText.includes(ANTIGRAVITY_CONVERSATION_RESUME_FLAG);

    if (!streamOk || !headlessOk || !conversationResumeOk) {
      return this.#report({
        usable: false,
        installed: true,
        version,
        status: 'PROBE_FAILED',
        sessionContinuation: false,
        checkedAt,
      });
    }

    const nativeAdvertised = /\bmodels\b/u.test(helpText);
    const modelResult = nativeAdvertised
      ? discoverAntigravityModels(executablePath, {
          timeoutMs: this.#timeoutMs,
          runner: this.#runner,
        })
      : { modelDiscovery: 'unavailable' as const, models: Object.freeze([]) as readonly AntigravityModelDto[] };

    return this.#report({
      usable: true,
      installed: true,
      version: version || 'unknown',
      status: 'READY',
      sessionContinuation: true,
      modelDiscovery: modelResult.modelDiscovery,
      models: modelResult.models,
      checkedAt,
    });
  }

  #report(input: {
    usable: boolean;
    installed: boolean;
    version?: string | null;
    status: ProviderRuntimeStatus;
    sessionContinuation?: boolean;
    modelDiscovery?: 'native' | 'unavailable';
    models?: readonly AntigravityModelDto[];
    checkedAt: string;
  }): AntigravityCapabilityReport {
    return Object.freeze({
      providerId: 'antigravity',
      supported: true,
      usable: input.usable,
      installed: input.installed,
      authenticated: null,
      version: input.version ?? null,
      status: input.status,
      capabilities: Object.freeze({
        outputProtocols: ANTIGRAVITY_CAPABILITIES.outputProtocols,
        sessionContinuation: input.sessionContinuation ?? false,
      }),
      modelDiscovery: input.modelDiscovery ?? 'unavailable',
      models: Object.freeze([...(input.models ?? [])]),
      checkedAt: input.checkedAt,
    });
  }
}

function parseVersion(raw: string): string {
  const line = raw.trim().split(/\r?\n/u)[0] ?? '';
  const match = /v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/u.exec(line);
  return match?.[1] ?? line.slice(0, 64).trim();
}

function isTimeout(error: string | undefined): boolean {
  return error?.toLowerCase().includes('timeout') === true;
}

function defaultRunner(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): { exitCode: number | null; stdout: string; stderr: string; error?: string | undefined } {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error?.message !== undefined ? { error: result.error.message } : {}),
  };
}
