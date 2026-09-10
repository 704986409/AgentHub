import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { resolveCodexExecutable } from './CodexProcessManager.js';

export interface CodexCapabilities {
  executablePath: string;
  executableResolved: boolean;
  executableExists: boolean;
  installed: boolean;
  version?: string;
  appServer: boolean;
  generateTs: boolean;
  generateJsonSchema: boolean;
  environment: NodeJS.Platform;
  windowsExecutableResolution: boolean;
}

export interface CodexCapabilitySource {
  detect(): CodexCapabilities;
}

export class CodexCapabilityDetector implements CodexCapabilitySource {
  public constructor(private readonly command = 'codex') {}

  public detect(): CodexCapabilities {
    const executablePath = resolveCodexExecutable(this.command);
    const version = this.run(['--version']);
    const appServer = this.run(['app-server', '--help']);
    const generateTs = this.verifyGeneration('generate-ts');
    const generateJsonSchema = this.verifyGeneration('generate-json-schema');
    return {
      executablePath,
      executableResolved: executablePath !== this.command || isAbsolute(executablePath),
      executableExists: !isAbsolute(executablePath) || existsSync(executablePath),
      installed: version.ok,
      ...(version.ok ? { version: version.stdout.trim() } : {}),
      appServer: appServer.ok,
      generateTs: generateTs.ok,
      generateJsonSchema: generateJsonSchema.ok,
      environment: process.platform,
      windowsExecutableResolution: process.platform !== 'win32' || /\.exe$/i.test(executablePath),
    };
  }

  private run(args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync(resolveCodexExecutable(this.command), args, { encoding: 'utf8', shell: false, windowsHide: true });
    return { ok: result.status === 0, stdout: result.stdout };
  }

  private verifyGeneration(command: 'generate-ts' | 'generate-json-schema'): { ok: boolean } {
    const directory = mkdtempSync(join(tmpdir(), `agenthub-codex-${command}-`));
    try {
      const result = this.run(['app-server', command, '--out', directory]);
      return { ok: result.ok && readdirSync(directory, { recursive: true }).length > 0 };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
