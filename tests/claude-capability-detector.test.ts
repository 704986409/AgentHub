import { describe, expect, it } from 'vitest';

import {
  ClaudeCapabilityDetector,
  claudeCapabilityNames,
  parseClaudeVersion,
  type ClaudeCommandResult,
  type ClaudeCommandRunner,
} from '../src/index.js';

class FakeClaudeCommandRunner implements ClaudeCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];

  public constructor(
    private readonly respond: (args: readonly string[]) => ClaudeCommandResult,
  ) {}

  public run(executable: string, args: readonly string[]): ClaudeCommandResult {
    this.calls.push({ executable, args: [...args] });
    return this.respond(args);
  }
}

describe('Claude capability detector', () => {
  it('returns a structured healthy report and detects authenticated state', () => {
    const runner = new FakeClaudeCommandRunner((args) => {
      if (sameArgs(args, ['--version'])) return commandResult(0, 'Claude Code 2.1.223');
      if (sameArgs(args, ['--help'])) return commandResult(0, completeHelp);
      if (sameArgs(args, ['auth', 'status'])) return commandResult(0, '{"loggedIn":true,"token":"must-not-leak"}');
      if (args[0] === '--agenthub-capability-probe-unknown') return commandResult(1, '', 'unknown option');
      return commandResult(0, 'Usage: claude [options]');
    });
    const report = detector(runner).detect();

    expect(report.ok).toBe(true);
    expect(report.capabilities).toMatchObject({
      installed: true,
      versionNumber: '2.1.223',
      authStatusAvailable: true,
      authenticated: true,
      printMode: true,
      inputStreamJson: true,
      outputStreamJson: true,
      resume: true,
      sessionId: true,
      modelSelection: true,
      mcpConfig: true,
      systemPromptFile: true,
      toolsRestriction: true,
      permissionMode: true,
    });
    expect(report.unknownCapabilities).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('must-not-leak');
    expect(runner.calls.some(({ args }) => sameArgs(args, ['auth', 'login']))).toBe(false);
    expect(runner.calls.every(({ args }) => args.includes('--help') || sameArgs(args, ['--version']) || sameArgs(args, ['auth', 'status']))).toBe(true);
  });

  it('distinguishes installed but logged out from not installed', () => {
    const loggedOutRunner = new FakeClaudeCommandRunner((args) => {
      if (sameArgs(args, ['--version'])) return commandResult(0, '2.1.223 (Claude Code)');
      if (sameArgs(args, ['--help'])) return commandResult(0, completeHelp);
      if (sameArgs(args, ['auth', 'status'])) return commandResult(1, '{"loggedIn":false}');
      if (args[0] === '--agenthub-capability-probe-unknown') return commandResult(1, '', 'unknown option');
      return commandResult(0);
    });
    const loggedOut = detector(loggedOutRunner).detect();
    expect(loggedOut.capabilities).toMatchObject({
      installed: true,
      authStatusAvailable: true,
      authenticated: false,
    });

    const missingRunner = new FakeClaudeCommandRunner(() => commandResult(null, '', '', 'spawn ENOENT', 'ENOENT'));
    const missing = detector(missingRunner, 'claude').detect();
    expect(missing.ok).toBe(false);
    expect(missing.capabilities).toMatchObject({ installed: false, authStatusAvailable: false });
    expect(missing.unknownCapabilities).toEqual(claudeCapabilityNames);
    expect(missingRunner.calls).toHaveLength(2);
  });

  it('uses a safe probe when help omits resume instead of treating absence as unsupported', () => {
    const runner = new FakeClaudeCommandRunner((args) => {
      if (sameArgs(args, ['--version'])) return commandResult(0, '2.1.223');
      if (sameArgs(args, ['--help'])) return commandResult(0, '--print --output-format --model');
      if (sameArgs(args, ['auth', 'status'])) return commandResult(1, 'Not logged in');
      if (args[0] === '--agenthub-capability-probe-unknown') return commandResult(1, '', 'unknown option');
      if (args[0] === '--resume') return commandResult(0, 'Usage: claude');
      return commandResult(1, '', 'unknown option');
    });
    const report = detector(runner).detect();
    const resumeCheck = report.checks.find(({ capability }) => capability === 'resume');

    expect(report.capabilities.resume).toBe(true);
    expect(resumeCheck).toEqual({ capability: 'resume', supported: true, evidence: 'probe' });
    expect(report.unsupportedCapabilities).not.toContain('resume');
  });

  it('keeps inconclusive probe failures unknown and identifies explicit unsupported flags', () => {
    const runner = new FakeClaudeCommandRunner((args) => {
      if (sameArgs(args, ['--version'])) return commandResult(0, 'custom-build');
      if (sameArgs(args, ['--help'])) return commandResult(0, '--print');
      if (sameArgs(args, ['auth', 'status'])) return commandResult(1, '', 'unknown command auth');
      if (args[0] === '--agenthub-capability-probe-unknown') return commandResult(1, '', 'unknown option');
      if (args[0] === '--resume') return commandResult(1, '', 'probe timed out', 'timed out', 'ETIMEDOUT');
      return commandResult(1, '', `unknown option ${String(args[0])}`);
    });
    const report = detector(runner).detect();

    expect(report.capabilities.installed).toBe(true);
    expect(report.capabilities.rawVersion).toBe('custom-build');
    expect(report.capabilities.versionNumber).toBeUndefined();
    expect(report.capabilities.authStatusAvailable).toBe(false);
    expect(report.unknownCapabilities).toContain('resume');
    expect(report.unsupportedCapabilities).toContain('sessionId');
  });

  it.each([
    ['2.1.223', '2.1.223'],
    ['Claude Code 2.1.223', '2.1.223'],
    ['2.1.223 (Claude Code)', '2.1.223'],
    ['custom-build', undefined],
  ])('parses version output %s', (output, expected) => {
    expect(parseClaudeVersion(output)).toBe(expected);
  });

  it('turns resolver failures into a clear unavailable report', () => {
    const runner = new FakeClaudeCommandRunner(() => commandResult(0));
    const report = new ClaudeCapabilityDetector({
      runner,
      resolver: () => {
        throw new Error('Explicit Claude executable was not found: C:\\missing\\claude.exe');
      },
    }).detect();

    expect(report.capabilities.installed).toBe(false);
    expect(report.diagnostics).toEqual(['Explicit Claude executable was not found: C:\\missing\\claude.exe']);
    expect(runner.calls).toHaveLength(0);
  });
});

function detector(runner: ClaudeCommandRunner, executable = 'C:\\Tools\\claude.exe'): ClaudeCapabilityDetector {
  return new ClaudeCapabilityDetector({
    runner,
    platform: 'win32',
    resolver: () => executable,
  });
}

function commandResult(
  exitCode: number | null,
  stdout = '',
  stderr = '',
  error?: string,
  errorCode?: string,
): ClaudeCommandResult {
  return { exitCode, stdout, stderr, ...(error === undefined ? {} : { error }), ...(errorCode === undefined ? {} : { errorCode }) };
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

const completeHelp = [
  '--print',
  '--resume',
  '--session-id',
  '--continue',
  '--fork-session',
  '--model',
  '--effort',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
  '--allowedTools',
  '--disallowedTools',
  '--permission-mode',
  '--add-dir',
].join('\n');
