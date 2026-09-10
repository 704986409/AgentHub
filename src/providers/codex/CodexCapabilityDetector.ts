import { spawnSync } from 'node:child_process';

export interface CodexCapabilities {
  installed: boolean;
  version?: string;
  appServer: boolean;
  generateTs: boolean;
  generateJsonSchema: boolean;
}

export class CodexCapabilityDetector {
  public constructor(private readonly command = 'codex') {}

  public detect(): CodexCapabilities {
    const version = this.run(['--version']);
    const appServer = this.run(['app-server', '--help']);
    const generateTs = this.run(['app-server', 'generate-ts', '--help']);
    const generateJsonSchema = this.run(['app-server', 'generate-json-schema', '--help']);
    return {
      installed: version.ok,
      ...(version.ok ? { version: version.stdout.trim() } : {}),
      appServer: appServer.ok,
      generateTs: generateTs.ok,
      generateJsonSchema: generateJsonSchema.ok,
    };
  }

  private run(args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync(this.command, args, { encoding: 'utf8', shell: false, windowsHide: true });
    return { ok: result.status === 0, stdout: result.stdout };
  }
}
