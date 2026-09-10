import {
  CodexCapabilityDetector,
  type CodexCapabilities,
  type CodexCapabilitySource,
} from './CodexCapabilityDetector.js';
import { CodexAppServerClient } from './CodexAppServerClient.js';
import { redactProtocolLine } from './CodexDiagnostics.js';

export interface DoctorCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
}

export interface CodexDoctorReport {
  ok: boolean;
  capabilities: CodexCapabilities;
  checks: DoctorCheck[];
}

interface HandshakeClient {
  initialize(): Promise<unknown>;
  stop(): Promise<void>;
}

export class CodexDoctor {
  public constructor(
    private readonly detector: CodexCapabilitySource = new CodexCapabilityDetector(),
    private readonly createHandshakeClient: () => HandshakeClient = () => new CodexAppServerClient(),
  ) {}

  public run(): CodexDoctorReport {
    return createReport(this.detector.detect(), {
      name: 'Handshake capability',
      status: 'WARN',
      message: 'Not executed by the static check',
    });
  }

  public async runFull(): Promise<CodexDoctorReport> {
    const capabilities = this.detector.detect();
    let handshake: DoctorCheck;
    const client = this.createHandshakeClient();
    try {
      await client.initialize();
      handshake = { name: 'Handshake capability', status: 'PASS', message: 'initialize / initialized succeeded' };
    } catch (error) {
      handshake = {
        name: 'Handshake capability',
        status: 'FAIL',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.stop();
    }
    return createReport(capabilities, handshake);
  }

  public format(report: CodexDoctorReport = this.run()): string {
    return report.checks
      .map((check) => `${check.name.padEnd(30)} ${check.status}  ${check.message}`)
      .join('\n');
  }
}

function createReport(capabilities: CodexCapabilities, handshake: DoctorCheck): CodexDoctorReport {
  const diagnosticsValue = JSON.parse(redactProtocolLine(JSON.stringify({
    authority: 'ADMIN',
    authenticationMode: 'oauth',
    authorization: 'Bearer secret',
  }))) as Record<string, unknown>;
  const checks: DoctorCheck[] = [
    check('Codex executable', capabilities.executableResolved && capabilities.executableExists, capabilities.executablePath),
    check('Codex version', capabilities.installed, capabilities.version ?? 'Not found'),
    check('App Server capability', capabilities.appServer, capabilities.appServer ? 'app-server available' : 'app-server unavailable'),
    handshake,
    check(
      'Schema generation capability',
      capabilities.generateTs || capabilities.generateJsonSchema,
      `generate-ts=${String(capabilities.generateTs)}, generate-json-schema=${String(capabilities.generateJsonSchema)}`,
    ),
    { name: 'Environment', status: 'PASS', message: capabilities.environment },
    check(
      'Windows executable resolution',
      capabilities.windowsExecutableResolution,
      capabilities.environment === 'win32' ? capabilities.executablePath : 'Not applicable',
    ),
    check(
      'Diagnostics redaction',
      diagnosticsValue.authority === 'ADMIN'
        && diagnosticsValue.authenticationMode === 'oauth'
        && diagnosticsValue.authorization === '[REDACTED]',
      'precise sensitive-key policy',
    ),
  ];
  return { ok: checks.every((entry) => entry.status !== 'FAIL'), capabilities, checks };
}

function check(name: string, passed: boolean, message: string): DoctorCheck {
  return { name, status: passed ? 'PASS' : 'FAIL', message };
}
