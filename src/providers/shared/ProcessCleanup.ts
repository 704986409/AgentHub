import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ProcessCleanupResult =
  | { readonly status: 'exited' }
  | { readonly status: 'timed-out' };

export interface ProcessCleanupKiller {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface ProcessCleanupDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnKiller?: (pid: number) => ProcessCleanupKiller;
  readonly now?: () => number;
}

export async function killProcessTreeAndWait(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  deps: ProcessCleanupDeps = {},
): Promise<ProcessCleanupResult> {
  if (alreadyExited(child)) {
    return { status: 'exited' };
  }

  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const deadline = now() + Math.max(0, timeoutMs);
  const remaining = (): number => Math.max(0, deadline - now());

  if (platform === 'win32' && child.pid !== undefined) {
    const killer = spawnWindowsKiller(child.pid, deps);
    const killerOutcome = await waitForKiller(killer, remaining());
    if (killerOutcome === 'success') {
      return waitForChildEnd(child, remaining());
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }

  if (alreadyExited(child)) {
    return { status: 'exited' };
  }
  return waitForChildEnd(child, remaining());
}

function spawnWindowsKiller(pid: number, deps: ProcessCleanupDeps): ProcessCleanupKiller {
  if (deps.spawnKiller !== undefined) {
    return deps.spawnKiller(pid);
  }
  return spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
  });
}

function alreadyExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildEnd(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<ProcessCleanupResult> {
  if (alreadyExited(child)) {
    return Promise.resolve({ status: 'exited' });
  }
  if (timeoutMs <= 0) {
    return Promise.resolve({ status: 'timed-out' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: ProcessCleanupResult['status']): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onEnded);
      child.off('close', onEnded);
      resolve({ status });
    };
    const onEnded = (): void => {
      finish('exited');
    };
    child.once('exit', onEnded);
    child.once('close', onEnded);
    const timer = setTimeout(() => {
      finish('timed-out');
    }, timeoutMs);
    if (alreadyExited(child)) {
      finish('exited');
    }
  });
}

function waitForKiller(
  killer: ProcessCleanupKiller,
  timeoutMs: number,
): Promise<'success' | 'failed' | 'timed-out'> {
  if (timeoutMs <= 0) {
    return Promise.resolve('timed-out');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: 'success' | 'failed' | 'timed-out'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.off('exit', onExit);
      killer.off('error', onError);
      resolve(status);
    };
    const onExit = (code: number | null): void => {
      finish(code === 0 ? 'success' : 'failed');
    };
    const onError = (): void => {
      finish('failed');
    };
    killer.once('exit', onExit);
    killer.once('error', onError);
    const timer = setTimeout(() => {
      finish('timed-out');
    }, timeoutMs);
  });
}
