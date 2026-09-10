import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeJsonlParser,
  ClaudeProcessManager,
  type ClaudeJsonlParseError,
  type ClaudeProcessExit,
  type ClaudeRawMessage,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude/fake-claude-process.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Claude process manager', () => {
  it('streams stdout and stderr independently and preserves a non-zero exit', async () => {
    const stderrManager = fixtureManager('stderr');
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const errors: Error[] = [];
    stderrManager.on('stdout', (chunk: Buffer) => stdout.push(chunk));
    stderrManager.on('stderr', (chunk: Buffer) => stderr.push(chunk));
    stderrManager.on('error', (error: Error) => errors.push(error));
    await stderrManager.start();
    await expect(stderrManager.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stdout).toString('utf8')).toContain('"type":"result"');
    expect(Buffer.concat(stderr).toString('utf8')).toContain('INFO normal diagnostic');
    expect(errors).toEqual([]);
    expect(stderrManager.running).toBe(false);

    const exitManager = fixtureManager('exit', ['7']);
    await exitManager.start();
    const exit = await exitManager.waitForExit();
    expect(exit).toEqual({ code: 7, signal: null });
    await expect(exitManager.waitForExit()).resolves.toEqual(exit);
  });

  it('writes stdin with backpressure support, ends input, and rejects writes after exit', async () => {
    const manager = fixtureManager('stdin-count');
    const messages: ClaudeRawMessage[] = [];
    const parser = parserFor(messages);
    manager.on('stdout', (chunk: Buffer) => parser.push(chunk));
    await manager.start();
    const payload = Buffer.alloc(2 * 1024 * 1024, 97);
    await manager.write(payload);
    await manager.endInput();
    const exit = await manager.waitForExit();
    parser.end();

    expect(exit.code).toBe(0);
    expect(messages).toEqual([{ type: 'stdin', bytes: payload.length }]);
    await expect(manager.write('after exit')).rejects.toMatchObject({ code: 'CLAUDE_STDIN_NOT_WRITABLE' });
  });

  it('fails duplicate starts and makes stop and forceStop idempotent', async () => {
    const manager = fixtureManager('hang', [], 50);
    await manager.start();
    await expect(manager.start()).rejects.toMatchObject({ code: 'CLAUDE_PROCESS_ALREADY_RUNNING' });
    const stopping = manager.stop();
    const sameStop = manager.stop();
    manager.forceStop();
    manager.forceStop();
    await Promise.all([stopping, sameStop]);
    expect(manager.running).toBe(false);
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('can restart the same manager repeatedly without listener accumulation', async () => {
    const manager = fixtureManager('quick');
    const exits: ClaudeProcessExit[] = [];
    manager.on('exit', (exit: ClaudeProcessExit) => exits.push(exit));
    for (let index = 0; index < 25; index += 1) {
      await manager.start();
      await manager.waitForExit();
    }
    expect(exits).toHaveLength(25);
    expect(exits.every((exit) => exit.code === 0)).toBe(true);
    expect(manager.listenerCount('exit')).toBe(1);
  });

  it('rejects spawn failures and resets lifecycle state', async () => {
    const missing = join(createTemporaryDirectory('missing-claude-'), 'claude.exe');
    const manager = new ClaudeProcessManager({ command: missing });
    const errors: Error[] = [];
    manager.on('error', (error: Error) => errors.push(error));
    await expect(manager.start()).rejects.toMatchObject({ code: 'CLAUDE_PROCESS_SPAWN_FAILED' });
    expect(manager.running).toBe(false);
    expect(manager.pid).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('runs a path-with-spaces cmd shim without interpreting special arguments', async () => {
    const directory = createTemporaryDirectory('Claude Process With Spaces ');
    const shimPath = join(directory, 'claude.cmd');
    const fixedArgs = [fixturePath, 'echo-args'] as const;
    writeFileSync(shimPath, `@ECHO off\r\n"${process.execPath}" "${fixedArgs[0]}" "${fixedArgs[1]}" %*\r\n`, 'utf8');
    const unsafeLookingArguments = [
      'hello world',
      'quote " value',
      'hello & echo INJECTED',
      'pipe | value',
      'caret ^ value',
      'percent %PATH% value',
    ];
    const manager = new ClaudeProcessManager({ command: shimPath, args: unsafeLookingArguments });
    const messages: ClaudeRawMessage[] = [];
    const parser = parserFor(messages);
    manager.on('stdout', (chunk: Buffer) => parser.push(chunk));
    await manager.start();
    const exit = await manager.waitForExit();
    parser.end();

    expect(exit.code).toBe(0);
    expect(messages).toEqual([{ type: 'args', args: unsafeLookingArguments }]);
    expect(manager.executablePath).toBe(shimPath);
  });

  it('wires fragmented process stdout into the JSONL parser without treating stderr as failure', async () => {
    const manager = fixtureManager('jsonl');
    const messages: ClaudeRawMessage[] = [];
    const parseErrors: ClaudeJsonlParseError[] = [];
    const processErrors: Error[] = [];
    const stderr: Buffer[] = [];
    const parser = new ClaudeJsonlParser({
      onMessage: (message) => messages.push(message),
      onError: (error) => parseErrors.push(error),
    });
    manager.on('stdout', (chunk: Buffer) => parser.push(chunk));
    manager.on('stderr', (chunk: Buffer) => stderr.push(chunk));
    manager.on('error', (error: Error) => processErrors.push(error));
    await manager.start();
    const exit = await manager.waitForExit();
    parser.end();

    expect(exit.code).toBe(0);
    expect(messages).toEqual([
      { type: 'system', subtype: 'init', session_id: 'fixture-会话' },
      { type: 'assistant', text: 'ok' },
      { type: 'result', result: 'done' },
    ]);
    expect(parseErrors).toEqual([]);
    expect(processErrors).toEqual([]);
    expect(Buffer.concat(stderr).toString('utf8')).toContain('INFO fixture diagnostic');
  });
});

function fixtureManager(mode: string, extraArgs: readonly string[] = [], stopTimeoutMs = 500): ClaudeProcessManager {
  return new ClaudeProcessManager({
    command: process.execPath,
    args: [fixturePath, mode, ...extraArgs],
    stopTimeoutMs,
  });
}

function parserFor(messages: ClaudeRawMessage[]): ClaudeJsonlParser {
  return new ClaudeJsonlParser({
    onMessage: (message) => messages.push(message),
    onError: (error) => {
      throw error;
    },
  });
}

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
