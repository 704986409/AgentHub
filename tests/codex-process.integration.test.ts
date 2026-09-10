import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, CodexCapabilityDetector } from '../src/index.js';

const capabilities = new CodexCapabilityDetector().detect();

describe('Codex app-server process integration', () => {
  it('keeps a long-running stdio child and separates stdout from stderr', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', d => { for (const line of d.toString().split('\\n')) { if (line) process.stdout.write(JSON.stringify({id: 1, result: line}) + '\\n'); } }); process.stderr.write('child-log\\n');"],
      requestTimeoutMs: 2_000,
    });
    const stderr: string[] = [];
    client.onStderr((chunk) => stderr.push(chunk));
    client.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await expect(client.request('echo', { value: true })).resolves.toBe('{"id":1,"method":"echo","params":{"value":true}}');
    expect(stderr.join('')).toContain('child-log');
    await client.stop();
    expect(client.processManager.running).toBe(false);
  });

  it.skipIf(!capabilities.appServer || process.env.AGENTHUB_RUN_CODEX_INTEGRATION !== '1')('starts, communicates over JSONL, and shuts down cleanly', async () => {
    const client = new CodexAppServerClient({ requestTimeoutMs: 15_000 });
    client.start();
    expect(client.processManager.running).toBe(true);
    const response = await client.request('initialize', {
      clientInfo: { name: 'agenthub', title: 'AgentHub', version: '0.2.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const responseObject = response as { platformFamily: unknown };
    expect(typeof responseObject.platformFamily).toBe('string');
    await client.stop();
    expect(client.processManager.running).toBe(false);
  }, 20_000);
});
