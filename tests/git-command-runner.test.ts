import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { GitCommandRunner, type GitExecFile } from '../src/index.js';

describe('GitCommandRunner', () => {
  it('passes an exact argument array, cwd, bounds, timeout, and shell=false', async () => {
    let invocation: { file: string; args: readonly string[]; options: ExecFileOptions } | undefined;
    const execFile: GitExecFile = (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, 'ok', 'diagnostic');
    };
    const runner = new GitCommandRunner({
      gitExecutable: 'git-custom', defaultTimeoutMs: 1234, maxOutputBytes: 4096, execFile,
    });
    await expect(runner.run(['show', 'value;$(unsafe)', 'path with spaces'], { cwd: 'C:\\repo path' }))
      .resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: 'diagnostic' });
    if (invocation === undefined) throw new Error('execFile was not invoked');
    expect(invocation.file).toBe('git-custom');
    expect(invocation.args).toEqual(['show', 'value;$(unsafe)', 'path with spaces']);
    expect(invocation.options).toMatchObject({
      cwd: 'C:\\repo path', timeout: 1234, maxBuffer: 4096,
      encoding: 'utf8', windowsHide: true, shell: false,
    });
  });

  it('accepts only explicitly allowed nonzero exit codes', async () => {
    const runner = new GitCommandRunner({ execFile: failingExec(1) });
    await expect(runner.run(['show-ref'], { cwd: '.', acceptedExitCodes: [0, 1] }))
      .resolves.toEqual({ exitCode: 1, stdout: '', stderr: 'not found' });
    await expect(runner.run(['show-ref'], { cwd: '.' })).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED', operation: 'show-ref', exitCode: 1,
    });
  });

  it.each([
    ['ENOENT', false, 'GIT_COMMAND_UNAVAILABLE'],
    ['ETIMEDOUT', true, 'GIT_COMMAND_TIMEOUT'],
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', false, 'GIT_COMMAND_OUTPUT_LIMIT'],
  ] as const)('classifies %s killed=%s safely as %s', async (code, killed, expectedCode) => {
    const execFile: GitExecFile = (_file, _args, _options, callback) => {
      callback(commandError(code, killed), '', 'sensitive stderr is not copied');
    };
    const runner = new GitCommandRunner({ execFile });
    const error = await runner.run(['status'], { cwd: '.' }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: expectedCode, operation: 'status' });
    expect(String(error)).not.toContain('sensitive stderr');
  });

  it('validates runner limits and invocation options', async () => {
    expect(() => new GitCommandRunner({ defaultTimeoutMs: 0 })).toThrow(TypeError);
    expect(() => new GitCommandRunner({ maxOutputBytes: 0 })).toThrow(TypeError);
    const runner = new GitCommandRunner({ execFile: failingExec(0) });
    await expect(runner.run(['status'], { cwd: '', acceptedExitCodes: [] })).rejects.toBeInstanceOf(TypeError);
  });
});

function failingExec(exitCode: number): GitExecFile {
  return (_file, _args, _options, callback) => {
    if (exitCode === 0) callback(null, '', '');
    else callback(Object.assign(new Error('failed'), { code: exitCode }), '', 'not found');
  };
}

function commandError(code: string, killed: boolean): ExecFileException {
  return Object.assign(new Error('failed'), { code, killed });
}
