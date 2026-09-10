import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient, CodexProvider, CodexProviderStatus } from '../src/index.js';

const managerFixture = fileURLToPath(new URL('./fixtures/codex/fake-manager-app-server.mjs', import.meta.url));

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

  it('runs a complete Manager turn through the fake app-server and reuses its thread', async () => {
    const provider = new CodexProvider({
      command: process.execPath,
      args: [managerFixture, 'success'],
      debug: true,
      managerTurnTimeoutMs: 2_000,
    });
    await provider.initialize();
    expect(provider.getStatus()).toBe(CodexProviderStatus.READY);

    const first = await provider.runTurn({ prompt: 'Reply with exactly OK.' });
    const second = await provider.runTurn({ prompt: 'Reply with exactly OK again.' });
    expect(first).toMatchObject({
      threadId: 'manager-thread-1',
      turnId: 'manager-turn-1',
      status: 'completed',
      text: 'OK',
    });
    expect(second).toMatchObject({
      threadId: 'manager-thread-1',
      turnId: 'manager-turn-2',
      status: 'completed',
      text: 'OK',
    });
    expect(first.events.some((event) => event.kind === 'unknown')).toBe(true);
    expect(provider.pendingTurnCount).toBe(0);
    expect(provider.client.requestManager.pendingCount).toBe(0);

    const outbound = provider.client.diagnostics.snapshot().filter((event) => event.type === 'outbound');
    const methods = outbound.map((event) => event.details.method);
    expect(methods.filter((method) => method === 'thread/start')).toHaveLength(1);
    expect(methods.filter((method) => method === 'turn/start')).toHaveLength(2);
    expect(outbound.filter((event) => event.details.requestId !== undefined).map((event) => event.details.requestId))
      .toEqual([1, 2, 3, 4]);
    const turnTrace = outbound.find((event) => event.details.method === 'turn/start');
    expect(String(turnTrace?.details.raw)).not.toContain('Reply with exactly OK.');
    expect(String(turnTrace?.details.raw)).toContain('[TEXT');

    await provider.shutdown();
    expect(provider.getStatus()).toBe(CodexProviderStatus.STOPPED);
  });

  it('classifies a fake app-server capacity error as upstream unavailable', async () => {
    const provider = new CodexProvider({
      command: process.execPath,
      args: [managerFixture, 'capacity'],
      managerTurnTimeoutMs: 2_000,
    });
    await provider.initialize();
    const result = await provider.runTurn({ prompt: 'Reply with exactly OK.' });
    expect(result).toMatchObject({
      status: 'upstream_unavailable',
      error: { kind: 'upstream_unavailable', code: 'serverOverloaded' },
    });
    expect(provider.getStatus()).toBe(CodexProviderStatus.READY);
    expect(provider.pendingTurnCount).toBe(0);
    await provider.shutdown();
  });

  it('cleans up timed-out and malformed fake app-server turns', async () => {
    const timeoutProvider = new CodexProvider({
      command: process.execPath,
      args: [managerFixture, 'hang'],
      managerTurnTimeoutMs: 30,
    });
    await timeoutProvider.initialize();
    const timeoutResult = await timeoutProvider.runTurn({ prompt: 'wait' });
    expect(timeoutResult).toMatchObject({ status: 'timeout', error: { kind: 'timeout' } });
    expect(timeoutProvider.pendingTurnCount).toBe(0);
    expect(timeoutProvider.client.requestManager.pendingCount).toBe(0);
    await timeoutProvider.shutdown();

    const malformedProvider = new CodexProvider({
      command: process.execPath,
      args: [managerFixture, 'malformed'],
      managerTurnTimeoutMs: 2_000,
    });
    await malformedProvider.initialize();
    const malformedResult = await malformedProvider.runTurn({ prompt: 'malformed' });
    expect(malformedResult).toMatchObject({ status: 'failed', error: { kind: 'protocol_error' } });
    expect(malformedProvider.pendingTurnCount).toBe(0);
    expect(malformedProvider.client.requestManager.pendingCount).toBe(0);
    await malformedProvider.shutdown();

    const unmatchedProvider = new CodexProvider({
      command: process.execPath,
      args: [managerFixture, 'unmatched'],
      managerTurnTimeoutMs: 2_000,
    });
    await unmatchedProvider.initialize();
    const unmatchedResult = await unmatchedProvider.runTurn({ prompt: 'unmatched' });
    expect(unmatchedResult).toMatchObject({ status: 'failed', error: { kind: 'protocol_error' } });
    expect(unmatchedProvider.client.requestManager.pendingCount).toBe(0);
    await unmatchedProvider.shutdown();
  });
});
