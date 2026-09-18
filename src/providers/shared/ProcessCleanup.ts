import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ProcessCleanupResult =
  | { readonly status: 'exited' }
  | {
      readonly status: 'timed-out';
      readonly pendingKiller?: ProcessCleanupKiller;
    };

export interface ProcessCleanupKiller {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface ProcessCleanupDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnKiller?: (pid: number) => ProcessCleanupKiller;
  readonly now?: () => number;
}

type KillerOutcome =
  | { readonly status: 'success' }
  | { readonly status: 'failed-settled' }
  | { readonly status: 'unresolved'; readonly killer: ProcessCleanupKiller };

type KillerWait = 'success' | 'failed' | 'timed-out' | 'error';

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
  const total = Math.max(0, timeoutMs);
  const deadline = now() + total;
  const remaining = (): number => Math.max(0, deadline - now());

  let unresolvedKiller: ProcessCleanupKiller | undefined;

  if (platform === 'win32' && child.pid !== undefined) {
    const killer = spawnWindowsKiller(child.pid, deps);
    const helperBudget = Math.min(remaining(), Math.floor(total * 0.6));
    const killerOutcome = await settleKiller(killer, helperBudget, remaining);
    if (killerOutcome.status === 'success') {
      return waitForChildEnd(child, remaining());
    }
    if (killerOutcome.status === 'unresolved') {
      unresolvedKiller = killerOutcome.killer;
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }

  const childResult = alreadyExited(child)
    ? { status: 'exited' as const }
    : await waitForChildEnd(child, remaining());

  if (unresolvedKiller !== undefined) {
    return { status: 'timed-out', pendingKiller: unresolvedKiller };
  }
  return childResult;
}

export async function retryPendingKillerCleanup(
  killer: ProcessCleanupKiller,
  timeoutMs: number,
): Promise<'exited' | 'timed-out'> {
  try {
    if (killerAlreadySettled(killer) !== null) {
      return 'exited';
    }
    try {
      killer.kill('SIGKILL');
    } catch {
      // ignore
    }
    if (killerAlreadySettled(killer) !== null) {
      return 'exited';
    }
    const waited = await waitForKillerExit(killer, Math.max(0, timeoutMs));
    return waited;
  } catch {
    return 'timed-out';
  }
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

function killerAlreadySettled(killer: ProcessCleanupKiller): 'success' | 'failed' | null {
  if (killer.exitCode !== undefined && killer.exitCode !== null) {
    return killer.exitCode === 0 ? 'success' : 'failed';
  }
  if (killer.signalCode != null) {
    return 'failed';
  }
  return null;
}

async function settleKiller(
  killer: ProcessCleanupKiller,
  helperBudget: number,
  remaining: () => number,
): Promise<KillerOutcome> {
  const first = await waitForKiller(killer, helperBudget);
  if (first === 'success') {
    return { status: 'success' };
  }
  if (first === 'failed') {
    return { status: 'failed-settled' };
  }

  try {
    killer.kill('SIGKILL');
  } catch {
    // ignore
  }

  if (killerAlreadySettled(killer) !== null) {
    return { status: 'failed-settled' };
  }

  const confirmed = await waitForKillerExit(killer, remaining());
  if (confirmed === 'exited') {
    return { status: 'failed-settled' };
  }
  return { status: 'unresolved', killer };
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
    const finish = (status: 'exited' | 'timed-out'): void => {
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

function waitForKiller(killer: ProcessCleanupKiller, timeoutMs: number): Promise<KillerWait> {
  const already = killerAlreadySettled(killer);
  if (already !== null) {
    return Promise.resolve(already);
  }
  if (timeoutMs <= 0) {
    return Promise.resolve('timed-out');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: KillerWait): void => {
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
      finish('error');
    };
    killer.once('exit', onExit);
    killer.once('error', onError);
    const timer = setTimeout(() => {
      finish('timed-out');
    }, timeoutMs);
    const raced = killerAlreadySettled(killer);
    if (raced !== null) {
      finish(raced);
    }
  });
}

function waitForKillerExit(
  killer: ProcessCleanupKiller,
  timeoutMs: number,
): Promise<'exited' | 'timed-out'> {
  if (killerAlreadySettled(killer) !== null) {
    return Promise.resolve('exited');
  }
  if (timeoutMs <= 0) {
    return Promise.resolve('timed-out');
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: 'exited' | 'timed-out'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.off('exit', onExit);
      resolve(status);
    };
    const onExit = (): void => {
      finish('exited');
    };
    killer.once('exit', onExit);
    const timer = setTimeout(() => {
      finish('timed-out');
    }, timeoutMs);
    if (killerAlreadySettled(killer) !== null) {
      finish('exited');
    }
  });
}
