import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { resolveClaudeExecutable } from './ClaudeExecutableResolver.js';

export interface ClaudeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  errorCode?: string;
}

export interface ClaudeCommandRunner {
  run(executable: string, args: readonly string[]): ClaudeCommandResult;
}

export type ClaudeCapabilityEvidence = 'help' | 'probe' | 'unsupported' | 'unknown';

export const claudeCapabilityNames = [
  'printMode',
  'inputText',
  'inputStreamJson',
  'outputText',
  'outputJson',
  'outputStreamJson',
  'resume',
  'sessionId',
  'continueSession',
  'forkSession',
  'modelSelection',
  'effortSelection',
  'systemPrompt',
  'systemPromptFile',
  'appendSystemPrompt',
  'appendSystemPromptFile',
  'mcpConfig',
  'strictMcpConfig',
  'toolsRestriction',
  'allowedTools',
  'disallowedTools',
  'permissionMode',
  'workingDirectorySupport',
] as const;

export type ClaudeCapabilityName = (typeof claudeCapabilityNames)[number];

export interface ClaudeCapabilities extends Record<ClaudeCapabilityName, boolean> {
  executablePath: string;
  executableResolved: boolean;
  executableExists: boolean;
  installed: boolean;
  version?: string;
  versionNumber?: string;
  platform: NodeJS.Platform;
  authStatusAvailable: boolean;
  authenticated?: boolean;
  rawVersion?: string;
}

export interface ClaudeCapabilityCheck {
  capability: ClaudeCapabilityName;
  supported: boolean;
  evidence: ClaudeCapabilityEvidence;
}

export interface ClaudeCapabilityReport {
  ok: boolean;
  capabilities: ClaudeCapabilities;
  missingRequiredCapabilities: ClaudeCapabilityName[];
  unknownCapabilities: ClaudeCapabilityName[];
  unsupportedCapabilities: ClaudeCapabilityName[];
  checks: ClaudeCapabilityCheck[];
  diagnostics: string[];
}

export interface ClaudeCapabilityDetectorOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: ClaudeCommandRunner;
  resolver?: (command: string, env: NodeJS.ProcessEnv) => string;
}

interface CapabilityProbe {
  name: ClaudeCapabilityName;
  helpFlags: readonly string[];
  helpValue?: string;
  args: readonly string[];
}

const requiredCapabilities: readonly ClaudeCapabilityName[] = ['printMode', 'outputStreamJson'];

const probes: readonly CapabilityProbe[] = [
  { name: 'printMode', helpFlags: ['--print', '-p'], args: ['--print', '--help'] },
  { name: 'inputText', helpFlags: ['--input-format'], helpValue: 'text', args: ['--input-format', 'text', '--help'] },
  { name: 'inputStreamJson', helpFlags: ['--input-format'], helpValue: 'stream-json', args: ['--input-format', 'stream-json', '--help'] },
  { name: 'outputText', helpFlags: ['--output-format'], helpValue: 'text', args: ['--output-format', 'text', '--help'] },
  { name: 'outputJson', helpFlags: ['--output-format'], helpValue: 'json', args: ['--output-format', 'json', '--help'] },
  { name: 'outputStreamJson', helpFlags: ['--output-format'], helpValue: 'stream-json', args: ['--output-format', 'stream-json', '--help'] },
  { name: 'resume', helpFlags: ['--resume', '-r'], args: ['--resume', '__agenthub_probe__', '--help'] },
  { name: 'sessionId', helpFlags: ['--session-id'], args: ['--session-id', '00000000-0000-4000-8000-000000000000', '--help'] },
  { name: 'continueSession', helpFlags: ['--continue', '-c'], args: ['--continue', '--help'] },
  { name: 'forkSession', helpFlags: ['--fork-session'], args: ['--fork-session', '--help'] },
  { name: 'modelSelection', helpFlags: ['--model'], args: ['--model', '__agenthub_probe__', '--help'] },
  { name: 'effortSelection', helpFlags: ['--effort'], args: ['--effort', 'low', '--help'] },
  { name: 'systemPrompt', helpFlags: ['--system-prompt'], args: ['--system-prompt', '__agenthub_probe__', '--help'] },
  { name: 'systemPromptFile', helpFlags: ['--system-prompt-file'], args: ['--system-prompt-file', '__agenthub_probe__', '--help'] },
  { name: 'appendSystemPrompt', helpFlags: ['--append-system-prompt'], args: ['--append-system-prompt', '__agenthub_probe__', '--help'] },
  { name: 'appendSystemPromptFile', helpFlags: ['--append-system-prompt-file'], args: ['--append-system-prompt-file', '__agenthub_probe__', '--help'] },
  { name: 'mcpConfig', helpFlags: ['--mcp-config'], args: ['--mcp-config', '{}', '--help'] },
  { name: 'strictMcpConfig', helpFlags: ['--strict-mcp-config'], args: ['--strict-mcp-config', '--help'] },
  { name: 'toolsRestriction', helpFlags: ['--tools'], args: ['--tools', '', '--help'] },
  { name: 'allowedTools', helpFlags: ['--allowedTools', '--allowed-tools'], args: ['--allowedTools', '', '--help'] },
  { name: 'disallowedTools', helpFlags: ['--disallowedTools', '--disallowed-tools'], args: ['--disallowedTools', '', '--help'] },
  { name: 'permissionMode', helpFlags: ['--permission-mode'], args: ['--permission-mode', 'default', '--help'] },
  { name: 'workingDirectorySupport', helpFlags: ['--add-dir'], args: ['--add-dir', '.', '--help'] },
];

export class SpawnSyncClaudeCommandRunner implements ClaudeCommandRunner {
  public constructor(
    private readonly timeoutMs = 7_500,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  public run(executable: string, args: readonly string[]): ClaudeCommandResult {
    const invocation = createSpawnInvocation(executable, args, this.env);
    const result = spawnSync(invocation.executable, invocation.args, {
      encoding: 'utf8',
      env: this.env,
      shell: false,
      windowsHide: true,
      timeout: this.timeoutMs,
      input: '',
    });
    return {
      exitCode: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      ...(result.error === undefined ? {} : {
        error: result.error.message,
        ...('code' in result.error && typeof result.error.code === 'string' ? { errorCode: result.error.code } : {}),
      }),
    };
  }
}

export class ClaudeCapabilityDetector {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #runner: ClaudeCommandRunner;
  readonly #resolver: (command: string, env: NodeJS.ProcessEnv) => string;

  public constructor(options: ClaudeCapabilityDetectorOptions = {}) {
    this.#command = options.command ?? 'claude';
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? new SpawnSyncClaudeCommandRunner(options.timeoutMs, this.#env);
    this.#resolver = options.resolver ?? resolveClaudeExecutable;
  }

  public detect(): ClaudeCapabilityReport {
    const diagnostics: string[] = [];
    let executablePath: string;
    try {
      executablePath = this.#resolver(this.#command, this.#env);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      return unavailableReport(this.#command, this.#platform, diagnostics);
    }

    let version = this.#runner.run(executablePath, ['--version']);
    if (version.exitCode !== 0) version = this.#runner.run(executablePath, ['-v']);
    const installed = version.exitCode === 0;
    if (!installed) {
      diagnostics.push(commandFailure('Claude version detection failed', version));
      return unavailableReport(executablePath, this.#platform, diagnostics, isResolved(executablePath, this.#command));
    }

    const rawVersion = firstOutput(version).trim();
    const versionNumber = parseClaudeVersion(rawVersion);
    const help = this.#runner.run(executablePath, ['--help']);
    if (help.exitCode !== 0) diagnostics.push(commandFailure('Claude help probe failed', help));
    const helpText = `${help.stdout}\n${help.stderr}`;
    const canary = this.#runner.run(executablePath, ['--agenthub-capability-probe-unknown', '--help']);
    const canValidateFlags = isUnknownOptionFailure(canary);
    const checks = probes.map((probe) =>
      detectCapability(probe, helpText, executablePath, this.#runner, canValidateFlags));
    const capabilityValues = Object.fromEntries(checks.map((check) => [check.capability, check.supported])) as Record<
      ClaudeCapabilityName,
      boolean
    >;
    const auth = detectAuthentication(this.#runner.run(executablePath, ['auth', 'status']));
    const capabilities: ClaudeCapabilities = {
      executablePath,
      executableResolved: isResolved(executablePath, this.#command),
      executableExists: isAbsolute(executablePath) ? existsSync(executablePath) || installed : installed,
      installed,
      ...(rawVersion.length === 0 ? {} : { version: rawVersion, rawVersion }),
      ...(versionNumber === undefined ? {} : { versionNumber }),
      platform: this.#platform,
      authStatusAvailable: auth.available,
      ...(auth.authenticated === undefined ? {} : { authenticated: auth.authenticated }),
      ...capabilityValues,
    };
    const unknownCapabilities = checks.filter((check) => check.evidence === 'unknown').map((check) => check.capability);
    const unsupportedCapabilities = checks
      .filter((check) => check.evidence === 'unsupported')
      .map((check) => check.capability);
    const missingRequiredCapabilities = requiredCapabilities.filter((name) => !capabilities[name]);
    return {
      ok: missingRequiredCapabilities.length === 0,
      capabilities,
      missingRequiredCapabilities,
      unknownCapabilities,
      unsupportedCapabilities,
      checks,
      diagnostics,
    };
  }
}

export function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\b\d+\.\d+\.\d+\b/u)?.[0];
}

function detectCapability(
  probe: CapabilityProbe,
  helpText: string,
  executable: string,
  runner: ClaudeCommandRunner,
  canValidateFlags: boolean,
): ClaudeCapabilityCheck {
  if (probe.helpFlags.some((flag) => containsHelpEvidence(helpText, flag, probe.helpValue))) {
    return { capability: probe.name, supported: true, evidence: 'help' };
  }
  if (!canValidateFlags) return { capability: probe.name, supported: false, evidence: 'unknown' };
  const result = runner.run(executable, probe.args);
  if (result.exitCode === 0) return { capability: probe.name, supported: true, evidence: 'probe' };
  if (isUnknownOptionFailure(result)) {
    return { capability: probe.name, supported: false, evidence: 'unsupported' };
  }
  return { capability: probe.name, supported: false, evidence: 'unknown' };
}

function detectAuthentication(result: ClaudeCommandResult): { available: boolean; authenticated?: boolean } {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/unknown (?:command|option)|unrecognized (?:command|option)/iu.test(output)) return { available: false };
  if (result.errorCode === 'ENOENT') return { available: false };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (isRecord(parsed) && typeof parsed.loggedIn === 'boolean') {
      return { available: true, authenticated: parsed.loggedIn };
    }
  } catch {
    // Older CLI versions can return plain text; the exit status remains useful.
  }
  return { available: true, authenticated: result.exitCode === 0 };
}

function unavailableReport(
  executablePath: string,
  platform: NodeJS.Platform,
  diagnostics: string[],
  executableResolved = false,
): ClaudeCapabilityReport {
  const checks = claudeCapabilityNames.map((capability) => ({
    capability,
    supported: false,
    evidence: 'unknown' as const,
  }));
  const values = Object.fromEntries(claudeCapabilityNames.map((name) => [name, false])) as Record<
    ClaudeCapabilityName,
    boolean
  >;
  return {
    ok: false,
    capabilities: {
      executablePath,
      executableResolved,
      executableExists: false,
      installed: false,
      platform,
      authStatusAvailable: false,
      ...values,
    },
    missingRequiredCapabilities: [...requiredCapabilities],
    unknownCapabilities: [...claudeCapabilityNames],
    unsupportedCapabilities: [],
    checks,
    diagnostics,
  };
}

function createSpawnInvocation(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { executable: string; args: readonly string[] } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(executable)) return { executable, args };
  return { executable: env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', executable, ...args] };
}

function containsFlag(helpText: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=[,=\\s]|$)`, 'mu').test(helpText);
}

function containsHelpEvidence(helpText: string, flag: string, value: string | undefined): boolean {
  if (!containsFlag(helpText, flag)) return false;
  if (value === undefined) return true;
  const lines = helpText.split(/\r?\n/u);
  const start = lines.findIndex((line) => containsFlag(line, flag));
  if (start < 0) return false;
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (index > start && /^ {2}(?:-|[a-z])/u.test(line)) break;
    block.push(line);
  }
  return block.join('\n').includes(value);
}

function isUnknownOptionFailure(result: ClaudeCommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`;
  return result.exitCode !== 0 && /unknown (?:option|argument)|unrecognized (?:option|argument)|invalid option/iu.test(output);
}

function commandFailure(prefix: string, result: ClaudeCommandResult): string {
  const detail = result.error ?? (result.stderr.trim() || `exit code ${String(result.exitCode)}`);
  return `${prefix}: ${detail}`;
}

function firstOutput(result: ClaudeCommandResult): string {
  return result.stdout.trim().length > 0 ? result.stdout : result.stderr;
}

function isResolved(executablePath: string, command: string): boolean {
  return executablePath !== command || isAbsolute(executablePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
