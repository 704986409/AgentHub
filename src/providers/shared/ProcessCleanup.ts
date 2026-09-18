import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ProcessCleanupResult =
  | { readonly status: 'exited' }
  | { readonly status: 'timed-out' };

export async function killProcessTreeAndWait(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<ProcessCleanupResult> {
  if (child.exitCode !== null || child.signalCode != null) {
    return { status: 'exited' };
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

    requestKill(child);

    if (child.exitCode !== null || child.signalCode != null) {
      finish('exited');
    }
  });
}

function requestKill(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => {
        // fallback is child.kill below
      });
    } catch {
      // fallback
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
}
