import { describe, expect, it } from 'vitest';

import {
  CodexCapabilityDetector,
  redactProtocolLine,
  CodexMessageParser,
  CodexRequestManager,
  CodexDoctor,
  isCodexErrorResponse,
  isCodexNotification,
  isCodexServerRequest,
} from '../src/index.js';

describe('Codex protocol foundation', () => {
  it('parses fragmented JSONL messages', () => {
    const parser = new CodexMessageParser();
    expect(parser.feed('{"jsonrpc":"2.0","id":1,"res')).toHaveLength(0);
    const parsed = parser.feed('ult":{"ok":true}}\n');
    expect(parsed[0]?.message).toMatchObject({ id: 1, result: { ok: true } });
  });

  it('parses multiple messages in one chunk and ignores empty lines', () => {
    const parser = new CodexMessageParser();
    const parsed = parser.feed('\n{"jsonrpc":"2.0","method":"event","params":{"n":1}}\n{"jsonrpc":"2.0","id":"r","method":"approval","params":{}}\n');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.message && isCodexNotification(parsed[0].message)).toBe(true);
    expect(parsed[1]?.message && isCodexServerRequest(parsed[1].message)).toBe(true);
  });

  it('accepts messages without a jsonrpc field and identifies error responses by shape', () => {
    const parser = new CodexMessageParser();
    const parsed = parser.feed('{"id":1,"error":{"code":-1,"message":"nope"}}\n');
    expect(parsed[0]?.message && isCodexErrorResponse(parsed[0].message)).toBe(true);
  });

  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
  ])('preserves the id and turn context for the %s server request', (method) => {
    const parser = new CodexMessageParser();
    const parsed = parser.feed(`${JSON.stringify({
      id: 'request-7',
      method,
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'item-3' },
    })}\n`);
    expect(parsed[0]?.message && isCodexServerRequest(parsed[0].message)).toBe(true);
    expect(parsed[0]?.message).toEqual({
      id: 'request-7',
      method,
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'item-3' },
    });
  });

  it('redacts credential-shaped fields before a raw protocol line is logged', () => {
    const json = redactProtocolLine('{"access_token":"sensitive","token":"also-sensitive","ok":true}');
    expect(json).not.toContain('sensitive');
    expect(json).toContain('[REDACTED]');
    expect(redactProtocolLine('authorization: bearer-sensitive')).toBe('authorization: [REDACTED]');
  });

  it('reports invalid JSON and overlong messages without crashing', () => {
    const parser = new CodexMessageParser(20);
    expect(parser.feed('{not-json}\n')[0]?.error).toBeInstanceOf(Error);
    const overlong = parser.feed('x'.repeat(21));
    expect(overlong).toHaveLength(1);
    expect(overlong[0]?.error).toBeInstanceOf(Error);
  });

  it('matches concurrent responses, rejects unknown IDs, and times out', async () => {
    const sent: unknown[] = [];
    const manager = new CodexRequestManager((request) => sent.push(request));
    const first = manager.request('first', undefined, 1_000);
    const second = manager.request('second', { value: 2 }, 1_000);
    expect(manager.handleResponse({ jsonrpc: '2.0', id: 999, result: 'ignored' })).toBe(false);
    expect(manager.wasSettled(999)).toBe(false);
    manager.handleResponse({ jsonrpc: '2.0', id: 2, result: 'two' });
    expect(manager.wasSettled(2)).toBe(true);
    manager.handleResponse({ jsonrpc: '2.0', id: 1, result: 'one' });
    await expect(first).resolves.toBe('one');
    await expect(second).resolves.toBe('two');
    expect(sent).toHaveLength(2);
    await expect(manager.request('timeout', undefined, 5)).rejects.toThrow(/timed out/);
  });

  it('detects the installed Codex CLI and reports doctor output', () => {
    const capabilities = new CodexCapabilityDetector().detect();
    expect(capabilities.installed).toBe(true);
    expect(capabilities.version).toContain('0.153.4');
    expect(capabilities.appServer).toBe(true);
    expect(new CodexDoctor().format()).toContain('Codex CLI          PASS');
  });
});
