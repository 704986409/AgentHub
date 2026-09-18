import { spawnSync } from 'node:child_process';
import { resolveCursorExecutable, CursorExecutableResolutionError, type CursorExecutableResolverDependencies } from './CursorExecutableResolver.js';
import { discoverCursorModels, type CursorModelDto } from './CursorModelDiscovery.js';
import type { ProviderRuntimeStatus } from '../../services/provider-catalog-service.js';

export interface CursorCapabilityReport {
  readonly providerId: 'cursor';
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
  readonly models: readonly CursorModelDto[];
  readonly checkedAt: string;
}

export interface CursorCapabilityDetectorOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  resolver?: (command?: string, env?: NodeJS.ProcessEnv, deps?: CursorExecutableResolverDependencies) => string;
  runner?: (executable: string, args: readonly string[]) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string | undefined;
  };
}

export const CURSOR_CAPABILITIES = Object.freeze({
  outputProtocols: Object.freeze(['worker-result'] as const),
  sessionContinuation: true,
});

const CURSOR_HELP_REQUIRED_TOKENS = Object.freeze(['--print', '--output-format', 'stream-json', '--resume']);

export class CursorCapabilityDetector {
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

  public constructor(options: CursorCapabilityDetectorOptions = {}) {
    this.#command = options.command ?? 'agent';
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#resolver = options.resolver ?? ((cmd, env) => resolveCursorExecutable(cmd, env));
    this.#runner = options.runner ?? ((executable, args) => defaultRunner(executable, args, this.#timeoutMs));
  }

  public detect(): CursorCapabilityReport {
    const checkedAt = new Date().toISOString();
    let executablePath: string;

    try {
      executablePath = this.#resolver(this.#command, this.#env);
    } catch (err) {
      if (err instanceof CursorExecutableResolutionError || (err instanceof Error && err.message.includes('not found'))) {
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

    const helpRes = this.#runner(executablePath, ['--help']);
    if (isTimeout(helpRes.error)) {
      return this.#report({
        usable: false,
        installed: true,
        version,
        status: 'PROBE_TIMEOUT',
        checkedAt,
      });
    }

    const helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
    const missingRuntime = CURSOR_HELP_REQUIRED_TOKENS.filter((token) => !helpText.includes(token));
    const resumeAvailable = helpText.includes('--resume');
    if (missingRuntime.length > 0 || !resumeAvailable) {
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
      ? discoverCursorModels(executablePath, {
          timeoutMs: this.#timeoutMs,
          runner: this.#runner,
        })
      : { modelDiscovery: 'unavailable' as const, models: Object.freeze([]) as readonly CursorModelDto[] };

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
    models?: readonly CursorModelDto[];
    checkedAt: string;
  }): CursorCapabilityReport {
    return Object.freeze({
      providerId: 'cursor',
      supported: true,
      usable: input.usable,
      installed: input.installed,
      authenticated: null,
      version: input.version ?? null,
      status: input.status,
      capabilities: Object.freeze({
        outputProtocols: CURSOR_CAPABILITIES.outputProtocols,
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
