import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface TaskCommandRunSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly inheritEnv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandStreamEvidence {
  readonly byteLength: number;
  readonly sha256: string;
  readonly preview: string;
  readonly previewTruncated: boolean;
}

export type TaskCommandOutcome = 'passed' | 'failed' | 'timed-out' | 'output-limit' | 'spawn-failed';

export interface TaskCommandRunResult {
  readonly outcome: TaskCommandOutcome;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs: number;
  readonly stdout: CommandStreamEvidence;
  readonly stderr: CommandStreamEvidence;
  readonly cleanupFailed?: boolean;
}

export interface TaskCommandRunnerOptions {
  readonly worktreePath: string;
  readonly maxOutputBytes?: number;
  readonly maxPreviewBytes?: number;
}

const defaultSafeEnvironment = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
];
const secretKey = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i;
const defaultMaxOutputBytes = 64 * 1024 * 1024;
const defaultMaxPreviewBytes = 64 * 1024;
const maxOutputBytes = 1024 * 1024 * 1024;
const maxPreviewBytes = 1024 * 1024;
const maxTimeoutMs = 60 * 60 * 1000;
const cleanupDeadlineMs = 2_000;

export class TaskCommandRunnerError extends Error {
  public constructor(
    public readonly code: 'UNSAFE_CWD' | 'INVALID_COMMAND' | 'INVALID_ENV' | 'PROCESS_CLEANUP_FAILED',
    public readonly result?: TaskCommandRunResult,
  ) {
    super(code);
    this.name = 'TaskCommandRunnerError';
  }
}

export class TaskCommandRunner {
  readonly #worktreePath: string;
  readonly #maxOutputBytes: number;
  readonly #maxPreviewBytes: number;

  public constructor(options: TaskCommandRunnerOptions) {
    this.#worktreePath = path.resolve(options.worktreePath);
    this.#maxOutputBytes = boundedPositive(options.maxOutputBytes ?? defaultMaxOutputBytes, maxOutputBytes);
    this.#maxPreviewBytes = boundedPositive(options.maxPreviewBytes ?? defaultMaxPreviewBytes, maxPreviewBytes);
  }

  public async run(spec: TaskCommandRunSpec): Promise<TaskCommandRunResult> {
    // Read each caller-owned field exactly once before the first await. Every
    // subsequent validation, timer, and spawn operation uses this snapshot.
    const executableValue = spec.executable;
    const argsValue = spec.args;
    const cwdValue = spec.cwd;
    const timeoutValue = spec.timeoutMs;
    const inheritEnvValue = spec.inheritEnv;
    const envValue = spec.env;
    const executable = validateString(executableValue, 'INVALID_COMMAND');
    if (/\.(?:cmd|bat)$/iu.test(executable)) throw new TaskCommandRunnerError('INVALID_COMMAND');
    if (!Array.isArray(argsValue)) throw new TaskCommandRunnerError('INVALID_COMMAND');
    const args: string[] = Array.from(argsValue as readonly string[]);
    if (!args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
      throw new TaskCommandRunnerError('INVALID_COMMAND');
    }
    if (!Number.isSafeInteger(timeoutValue) || timeoutValue < 1 || timeoutValue > maxTimeoutMs) {
      throw new TaskCommandRunnerError('INVALID_COMMAND');
    }
    const cwd = cwdValue;
    if (!Array.isArray(inheritEnvValue) || typeof envValue !== 'object' || Array.isArray(envValue)) {
      throw new TaskCommandRunnerError('INVALID_ENV');
    }
    const inheritEnv: string[] = Array.from(inheritEnvValue as readonly string[]);
    const env = { ...envValue } as Record<string, string>;
    await this.#validateCwd(cwd);
    const environment = buildEnvironment(inheritEnv, env);
    const stdout = createAccumulator(this.#maxPreviewBytes);
    const stderr = createAccumulator(this.#maxPreviewBytes);
    const started = process.hrtime.bigint();
    let child: ChildProcess;
    // The directory is checked once while validating the request and again
    // immediately before spawn. Both checks use the same snapshotted string.
    const spawnCwd = await this.#validateCwd(cwd);
    try {
      child = spawn(executable, args, {
        cwd: spawnCwd,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return result('spawn-failed', started, stdout, stderr);
    }

    let outcome: TaskCommandOutcome | undefined;
    let killPromise: Promise<void> | undefined;
    let finishProcess: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const terminate = (reason: 'timed-out' | 'output-limit'): void => {
      if (outcome !== undefined) return;
      outcome = reason;
      killPromise ??= terminateProcess(child);
      void killPromise.catch(() => finishProcess?.(null, null));
    };
    const onData = (accumulator: Accumulator, chunk: Buffer | string): void => {
      accumulator.add(chunk);
      if (stdout.byteLength + stderr.byteLength > this.#maxOutputBytes) terminate('output-limit');
    };
    child.stdout?.on('data', (chunk: Buffer | string) => onData(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => onData(stderr, chunk));
    const timer = setTimeout(() => terminate('timed-out'), timeoutValue);
    return await new Promise<TaskCommandRunResult>((resolve, reject) => {
      let settled = false;
      const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const finalOutcome = outcome ?? (code === 0 ? 'passed' : 'failed');
        const values = { ...resultValues(finalOutcome, started, stdout, stderr),
          ...(code === null ? {} : { exitCode: code }),
          ...(signal === null ? {} : { signal }), };
        try {
          await killPromise;
          resolve({ outcome: finalOutcome, ...values });
        } catch {
          // Preserve factual process and stream evidence on cleanup failure;
          // callers must still classify the operation as infrastructure-failed.
          const factual = Object.freeze({ outcome: finalOutcome, ...values, cleanupFailed: true });
          reject(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED', factual));
        }
      };
      finishProcess = (code, signal) => { void finish(code, signal); };
      child.once('error', () => {
        outcome ??= 'spawn-failed';
        finishProcess?.(null, null);
      });
      child.once('close', (code, signal) => finishProcess?.(code, signal));
    });
  }

  async #validateCwd(relativeCwd: string): Promise<string> {
    if (typeof relativeCwd !== 'string' || relativeCwd.length === 0 || path.isAbsolute(relativeCwd) ||
      relativeCwd.includes('\0') || relativeCwd.split(/[\\/]/u).some((part) => part === '..')) {
      throw new TaskCommandRunnerError('UNSAFE_CWD');
    }
    const rootStat = await lstat(this.#worktreePath).catch(() => undefined);
    if (rootStat === undefined || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TaskCommandRunnerError('UNSAFE_CWD');
    }
    const canonicalRoot = await realpath(this.#worktreePath);
    const target = path.resolve(canonicalRoot, relativeCwd);
    if (!contained(canonicalRoot, target)) throw new TaskCommandRunnerError('UNSAFE_CWD');
    let cursor = canonicalRoot;
    const relative = path.relative(canonicalRoot, target);
    for (const part of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor).catch(() => undefined);
      if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() ||
        !samePath(await realpath(cursor), cursor)) throw new TaskCommandRunnerError('UNSAFE_CWD');
    }
    if (!contained(canonicalRoot, await realpath(target))) throw new TaskCommandRunnerError('UNSAFE_CWD');
    return target;
  }
}

interface Accumulator {
  byteLength: number;
  add(chunk: Buffer | string): void;
  finish(): CommandStreamEvidence;
}

function createAccumulator(previewBytes: number): Accumulator {
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const pieces: Buffer[] = [];
  let byteLength = 0;
  let previewLength = 0;
  return {
    get byteLength() { return byteLength; },
    add(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      hash.update(bytes);
      const remaining = previewBytes - previewLength;
      if (remaining > 0) {
        const piece = bytes.subarray(0, remaining);
        pieces.push(piece);
        previewLength += piece.length;
      }
    },
    finish() {
      const previewBytesValue = Buffer.concat(pieces);
      const preview = decoder.write(previewBytesValue) + decoder.end();
      return Object.freeze({
        byteLength,
        sha256: hash.digest('hex'),
        preview,
        previewTruncated: byteLength > previewBytes,
      });
    },
  };
}

function result(outcome: TaskCommandOutcome, started: bigint, stdout: Accumulator, stderr: Accumulator): TaskCommandRunResult {
  return { outcome, ...resultValues(outcome, started, stdout, stderr) };
}

function resultValues(_outcome: TaskCommandOutcome, started: bigint, stdout: Accumulator, stderr: Accumulator) {
  return {
    durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
  };
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    await boundedTaskkill(child.pid);
    await waitForSettlement(child);
  } else {
    let signalled = false;
    try { process.kill(-child.pid, 'SIGTERM'); signalled = true; } catch { try { child.kill('SIGTERM'); signalled = true; } catch { /* already dead */ } }
    if (!signalled && child.exitCode === null) throw new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED');
    await delay(50);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    }
    await waitForSettlement(child);
  }
}

async function boundedTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(); else reject(error);
    };
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try { killer.kill(); } catch { /* best effort */ }
      finish(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED'));
    }, cleanupDeadlineMs);
    killer.once('error', () => finish(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED')));
    killer.once('close', (code) => {
      if (code === 0) finish();
      else finish(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED'));
    });
  });
}

async function waitForSettlement(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (error === undefined) resolve(); else reject(error);
    };
    const onClose = (): void => finish();
    const onError = (): void => finish(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED'));
    const timer = setTimeout(() => finish(new TaskCommandRunnerError('PROCESS_CLEANUP_FAILED')), cleanupDeadlineMs);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function buildEnvironment(inheritEnv: readonly string[], explicit: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const requested = new Map<string, string>();
  for (const key of [...defaultSafeEnvironment, ...inheritEnv]) {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.includes('\0')) {
      throw new TaskCommandRunnerError('INVALID_ENV');
    }
    const normalized = key.toLocaleUpperCase('en-US');
    if (secretKey.test(key) || /^GIT_/i.test(key)) {
      if (!defaultSafeEnvironment.some((safe) => safe.toLocaleUpperCase('en-US') === normalized)) {
        throw new TaskCommandRunnerError('INVALID_ENV');
      }
      continue;
    }
    requested.set(normalized, key);
  }
  for (const key of requested.values()) {
    const sourceKey = Object.keys(process.env).find((candidate) =>
      candidate.toLocaleUpperCase('en-US') === key.toLocaleUpperCase('en-US'));
    if (sourceKey !== undefined) {
      const value = process.env[sourceKey];
      if (value !== undefined) result[key] = value;
    }
  }
  const explicitKeys = new Set<string>();
  for (const [key, value] of Object.entries(explicit)) {
    const normalized = key.toLocaleUpperCase('en-US');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' ||
      secretKey.test(key) || /^GIT_/i.test(key) || value.includes('\0')) {
      throw new TaskCommandRunnerError('INVALID_ENV');
    }
    if (explicitKeys.has(normalized)) throw new TaskCommandRunnerError('INVALID_ENV');
    if (requested.has(normalized)) throw new TaskCommandRunnerError('INVALID_ENV');
    explicitKeys.add(normalized);
    result[key] = value;
  }
  return result;
}

function validateString(value: unknown, code: 'INVALID_COMMAND'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new TaskCommandRunnerError(code);
  }
  return value;
}
function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError('bounded positive integer required');
  return value;
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => path.normalize(value).replace(/[\\/]$/u, '');
  if (process.platform !== 'win32') return normalize(a) === normalize(b);
  const fold = (value: string) => normalize(value).toLocaleLowerCase('en-US');
  return fold(a) === fold(b);
}
