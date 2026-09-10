import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, CodexProvider, CodexProviderStatus } from '../src/index.js';

describe('Codex app-server process integration', () => {
  it('keeps a long-running stdio child and separates stdout from stderr', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', d => { for (const line of d.toString().split('\\n')) { if (line) process.stdout.write(JSON.stringify({id: 1, result: line}) + '\\n'); } }); process.stderr.write('child-log\\n');"],
      requestTimeoutMs: 2_000,
    });
    const stderr: string[] = [];
    client.onStderr((chunk) => stderr.push(chunk));
    expect(() => client.notify('initialized')).toThrow('Cannot send initialized before receiving the initialize response');
    await client.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await expect(client.request('echo', { value: true })).resolves.toBe('{"id":1,"method":"echo","params":{"value":true}}');
    expect(stderr.join('')).toContain('child-log');
    await client.stop();
    expect(client.processManager.running).toBe(false);
  });

  it('performs the required Codex initialization handshake and shuts down cleanly', async () => {
    const provider = new CodexProvider({ requestTimeoutMs: 20_000, debug: true });
    const response = await provider.initialize();
    expect(provider.client.processManager.running).toBe(true);
    const responseObject = response as { platformFamily: unknown };
    expect(typeof responseObject.platformFamily).toBe('string');

    const diagnostics = provider.client.diagnostics.snapshot();
    const started = diagnostics.find((event) => event.type === 'process-started');
    expect(started?.details.executablePath).toMatch(/codex(?:\.exe)?$/i);
    expect(started?.details.args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(typeof started?.details.pid).toBe('number');

    const initializeOutboundIndex = diagnostics.findIndex((event) => event.type === 'outbound' && event.details.method === 'initialize');
    const initializeResponseIndex = diagnostics.findIndex((event) => event.type === 'inbound-stdout' && typeof event.details.raw === 'string' && event.details.raw.includes('platformFamily'));
    const initializedOutboundIndex = diagnostics.findIndex((event) => event.type === 'outbound' && event.details.method === 'initialized');
    expect(initializeOutboundIndex).toBeGreaterThanOrEqual(0);
    expect(initializeResponseIndex).toBeGreaterThan(initializeOutboundIndex);
    expect(initializedOutboundIndex).toBeGreaterThan(initializeResponseIndex);

    const initializeEvent = diagnostics[initializeOutboundIndex];
    expect(JSON.parse(String(initializeEvent?.details.raw))).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agenthub', title: 'AgentHub', version: '0.2.1' },
        capabilities: {},
      },
    });
    expect(initializeEvent?.details.newline).toBe(true);
    expect(initializeEvent?.details.timeoutMs).toBe(20_000);

    await provider.shutdown();
    expect(provider.getStatus()).toBe(CodexProviderStatus.STOPPED);
    expect(provider.client.processManager.running).toBe(false);
  }, 30_000);
});
