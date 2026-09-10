import { CodexCapabilityDetector, type CodexCapabilities } from './CodexCapabilityDetector.js';

export class CodexDoctor {
  public constructor(private readonly detector = new CodexCapabilityDetector()) {}

  public run(): CodexCapabilities {
    return this.detector.detect();
  }

  public format(): string {
    const capabilities = this.run();
    const version = capabilities.version ?? 'NOT FOUND';
    return [
      `Codex CLI          ${capabilities.installed ? 'PASS' : 'FAIL'}`,
      `Version            ${version}`,
      `App Server         ${capabilities.appServer ? 'PASS' : 'FAIL'}`,
      `generate-ts        ${capabilities.generateTs ? 'PASS' : 'FAIL'}`,
      `Protocol           ${capabilities.generateTs || capabilities.generateJsonSchema ? 'READY' : 'UNAVAILABLE'}`,
    ].join('\n');
  }
}
