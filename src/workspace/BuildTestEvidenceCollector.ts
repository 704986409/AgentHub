import { createHash } from 'node:crypto';
import {
  captureWorkspaceChanges,
  canonicalChangeState,
  type GitWorkspaceChangeSnapshot,
} from './GitWorkspaceChangeCapture.js';
import { TaskCommandRunner, type CommandStreamEvidence, type TaskCommandOutcome } from './TaskCommandRunner.js';
import type { GitCommandRunnerLike } from './GitCommandRunner.js';
import type { TaskWorkspace } from './GitWorktreeManager.js';

export type EvidenceCommandPhase = 'build' | 'test';
export interface EvidenceCommandSpec {
  readonly id: string;
  readonly phase: EvidenceCommandPhase;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly continueOnFailure?: boolean;
  readonly inheritEnv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export interface BuildTestEvidencePlan { readonly commands: readonly EvidenceCommandSpec[]; }
export interface CommandEvidence {
  readonly commandId: string;
  readonly phase: EvidenceCommandPhase;
  readonly commandSpecSha256: string;
  readonly executableName: string;
  readonly argCount: number;
  readonly cwd: string;
  readonly outcome: TaskCommandOutcome;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs: number;
  readonly stdout: CommandStreamEvidence;
  readonly stderr: CommandStreamEvidence;
  readonly sourceBeforeSha256: string;
  readonly sourceAfterSha256: string;
  readonly sourceStable: boolean;
}
export interface BuildTestEvidence {
  readonly version: 1;
  readonly taskId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changeSetSha256: string;
  readonly build: 'passed' | 'failed' | 'not-run';
  readonly test: 'passed' | 'failed' | 'not-run';
  readonly outcome: 'passed' | 'failed' | 'workspace-mutated' | 'infrastructure-failed';
  readonly commands: readonly CommandEvidence[];
  readonly evidenceSha256: string;
}

export class BuildTestEvidenceError extends Error {
  public constructor(public readonly code: 'INVALID_PLAN' | 'WORKSPACE_MUTATED' | 'INFRASTRUCTURE_FAILED') {
    super(code);
    this.name = 'BuildTestEvidenceError';
  }
}

export interface BuildTestEvidenceCollectorOptions {
  readonly runner: GitCommandRunnerLike;
  readonly inspect: () => Promise<TaskWorkspace | undefined>;
  readonly worktree: TaskWorkspace;
  readonly maxOutputBytes?: number;
  readonly maxPreviewBytes?: number;
}

type UnknownRecord = Record<string, unknown>;

export function snapshotBuildTestEvidencePlan(value: unknown): BuildTestEvidencePlan {
  if (!isRecord(value)) throw new BuildTestEvidenceError('INVALID_PLAN');
  const rawCommands = value.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > 256) {
    throw new BuildTestEvidenceError('INVALID_PLAN');
  }
  const ids = new Set<string>();
  const commands = rawCommands.map((raw) => {
    if (!isRecord(raw)) throw new BuildTestEvidenceError('INVALID_PLAN');
    const id = raw.id;
    const phase = raw.phase;
    const executable = raw.executable;
    const rawArgs = raw.args;
    const cwd = raw.cwd;
    const timeoutMs = raw.timeoutMs;
    const continueOnFailure = raw.continueOnFailure;
    const rawInheritEnv = raw.inheritEnv;
    const rawEnv = raw.env;
    if (typeof id !== 'string' || ids.has(id) || !/^[A-Za-z0-9._-]{1,64}$/u.test(id) ||
      (phase !== 'build' && phase !== 'test') || typeof executable !== 'string' ||
      executable.length === 0 || executable.length > 4096 || /[\0\r\n]/u.test(executable) ||
      typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60 * 60 * 1000 ||
      (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096 || /[\0\r\n]/u.test(cwd))) ||
      (continueOnFailure !== undefined && typeof continueOnFailure !== 'boolean')) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) throw new BuildTestEvidenceError('INVALID_PLAN');
    const args = rawArgs === undefined ? [] : rawArgs.slice();
    if (!args.every((arg): arg is string => typeof arg === 'string' && arg.length <= 4096 && !/[\0\r\n]/u.test(arg))) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
    if (rawInheritEnv !== undefined && !Array.isArray(rawInheritEnv)) throw new BuildTestEvidenceError('INVALID_PLAN');
    const inheritEnv = rawInheritEnv === undefined ? [] : rawInheritEnv.slice();
    if (!inheritEnv.every((key): key is string => typeof key === 'string' && key.length <= 256 && !/[\0\r\n]/u.test(key))) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
    if (inheritEnv.some((key) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/iu.test(key) || /^GIT_/iu.test(key))) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
    if (rawEnv !== undefined && !isRecord(rawEnv)) throw new BuildTestEvidenceError('INVALID_PLAN');
    const env = rawEnv === undefined ? {} : { ...rawEnv };
    if (Object.entries(env).some(([key, envValue]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof envValue !== 'string' || /\0/u.test(envValue) ||
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/iu.test(key) || /^GIT_/iu.test(key))) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
    ids.add(id);
    return Object.freeze({
      id, phase, executable, args: Object.freeze(args),
      ...(cwd === undefined ? {} : { cwd }), timeoutMs,
      ...(continueOnFailure === undefined ? {} : { continueOnFailure }),
      inheritEnv: Object.freeze(inheritEnv), env: Object.freeze(env),
    });
  });
  return Object.freeze({ commands: Object.freeze(commands) }) as BuildTestEvidencePlan;
}

export function evidencePlanKey(
  plan: BuildTestEvidencePlan,
  options: Pick<BuildTestEvidenceCollectorOptions, 'maxOutputBytes' | 'maxPreviewBytes'> = {},
): string {
  return sha({ plan, options });
}

export function snapshotBuildTestEvidenceOptions(
  value: unknown,
): Pick<BuildTestEvidenceCollectorOptions, 'maxOutputBytes' | 'maxPreviewBytes'> {
  if (!isRecord(value)) throw new BuildTestEvidenceError('INVALID_PLAN');
  const maxOutputBytes = value.maxOutputBytes;
  const maxPreviewBytes = value.maxPreviewBytes;
  for (const candidate of [maxOutputBytes, maxPreviewBytes]) {
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0)) {
      throw new BuildTestEvidenceError('INVALID_PLAN');
    }
  }
  return Object.freeze({
    ...(typeof maxOutputBytes === 'number' ? { maxOutputBytes } : {}),
    ...(typeof maxPreviewBytes === 'number' ? { maxPreviewBytes } : {}),
  });
}

export async function collectBuildTestEvidence(
  planValue: BuildTestEvidencePlan,
  options: BuildTestEvidenceCollectorOptions,
): Promise<BuildTestEvidence> {
  const plan = snapshotBuildTestEvidencePlan(planValue);
  const optionsSnapshot = snapshotBuildTestEvidenceOptions(options);
  let initial: GitWorkspaceChangeSnapshot | undefined;
  try {
    initial = await capture(options.runner, options.inspect);
  } catch {
    throw new BuildTestEvidenceError('INFRASTRUCTURE_FAILED');
  }
  if (initial === undefined || initial.hasConflicts) throw new BuildTestEvidenceError('WORKSPACE_MUTATED');
  const taskRunner = new TaskCommandRunner({
    worktreePath: options.worktree.worktreePath,
    ...(optionsSnapshot.maxOutputBytes === undefined ? {} : { maxOutputBytes: optionsSnapshot.maxOutputBytes }),
    ...(optionsSnapshot.maxPreviewBytes === undefined ? {} : { maxPreviewBytes: optionsSnapshot.maxPreviewBytes }),
  });
  const commands: CommandEvidence[] = [];
  let stopReason: 'command-failed' | 'infrastructure-failed' | 'workspace-mutated' | undefined;
  let anyCommandFailed = false;
  for (const command of plan.commands) {
    if (stopReason !== undefined) break;
    let before: GitWorkspaceChangeSnapshot | undefined;
    try {
      before = await capture(options.runner, options.inspect);
    } catch {
      stopReason = 'infrastructure-failed';
      break;
    }
    if (!sameIdentity(initial, before)) { stopReason = 'workspace-mutated'; break; }
    let run;
    try {
      run = await taskRunner.run({
        executable: command.executable,
        args: command.args ?? [],
        cwd: command.cwd ?? '.',
        timeoutMs: command.timeoutMs,
        inheritEnv: command.inheritEnv ?? [],
        env: command.env ?? {},
      });
    } catch {
      stopReason = 'infrastructure-failed';
      break;
    }
    const sourceBeforeSha256 = before.changeSetSha256;
    let after: GitWorkspaceChangeSnapshot | undefined;
    try {
      after = await capture(options.runner, options.inspect);
    } catch {
      stopReason = 'infrastructure-failed';
      break;
    }
    const sourceStable = sameIdentity(initial, after);
    const evidence: CommandEvidence = Object.freeze({
      commandId: command.id,
      phase: command.phase,
      commandSpecSha256: sha(canonicalCommandSpec(command)),
      executableName: command.executable.split(/[\\/]/u).pop() ?? command.executable,
      argCount: (command.args ?? []).length,
      cwd: command.cwd ?? '.',
      outcome: run.outcome,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      sourceBeforeSha256,
      sourceAfterSha256: after === undefined ? '' : after.changeSetSha256,
      sourceStable,
    });
    commands.push(evidence);
    if (!sourceStable) { stopReason = 'workspace-mutated'; break; }
    if (run.outcome === 'spawn-failed') {
      stopReason = 'infrastructure-failed';
    } else if (run.outcome !== 'passed') {
      anyCommandFailed = true;
      if (!command.continueOnFailure) stopReason = 'command-failed';
    }
  }
  const outcome: BuildTestEvidence['outcome'] = stopReason === 'infrastructure-failed' ? 'infrastructure-failed' : stopReason === 'workspace-mutated' ? 'workspace-mutated' : (stopReason === 'command-failed' || anyCommandFailed) ? 'failed' : 'passed';
  const phase = (name: EvidenceCommandPhase): 'passed' | 'failed' | 'not-run' => {
    const selected = commands.filter((command) => command.phase === name);
    if (selected.length === 0) return 'not-run';
    return selected.every((command) => command.outcome === 'passed') ? 'passed' : 'failed';
  };
  const base: Omit<BuildTestEvidence, 'evidenceSha256'> = {
    version: 1 as const,
    taskId: initial.taskId,
    branchName: initial.branchName,
    baseCommit: initial.baseCommit,
    headCommit: initial.headCommit,
    changeSetSha256: initial.changeSetSha256,
    build: phase('build'),
    test: phase('test'),
    outcome,
    commands: Object.freeze(commands),
  };
  return Object.freeze({ ...base, evidenceSha256: sha(canonicalEvidence(base)) });
}

async function capture(runner: GitCommandRunnerLike, inspect: () => Promise<TaskWorkspace | undefined>): Promise<GitWorkspaceChangeSnapshot | undefined> {
  return captureWorkspaceChanges(runner, inspect, { includePatchText: false, maxPatchBytes: 1, maxChangedPaths: 4096, maxFingerprintBytes: 64 * 1024 * 1024, maxIgnoredPaths: 4096 });
}
function sameIdentity(a: GitWorkspaceChangeSnapshot, b: GitWorkspaceChangeSnapshot | undefined): b is GitWorkspaceChangeSnapshot {
  return b !== undefined && a.taskId === b.taskId && a.branchName === b.branchName && a.baseCommit === b.baseCommit && a.headCommit === b.headCommit && a.changeSetSha256 === b.changeSetSha256;
}
function canonicalCommandSpec(command: EvidenceCommandSpec): unknown { return { id: command.id, phase: command.phase, executable: command.executable, args: command.args ?? [], cwd: command.cwd ?? '.', timeoutMs: command.timeoutMs, continueOnFailure: command.continueOnFailure ?? false, inheritEnv: command.inheritEnv ?? [], env: command.env ?? {} }; }
function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'durationMs' || key === 'preview' || key === 'previewTruncated' || key === 'executableName' || key === 'cwd') continue;
      result[key] = canonicalEvidence(value[key]);
    }
    return result;
  }
  return value;
}
function sha(value: unknown): string { return createHash('sha256').update(canonicalChangeState(value)).digest('hex'); }

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
