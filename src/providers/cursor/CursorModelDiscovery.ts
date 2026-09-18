import { spawnSync } from 'node:child_process';

export interface CursorModelDto {
  readonly modelId: string;
  readonly label: string;
}

export interface CursorModelDiscoveryResult {
  readonly modelDiscovery: 'native' | 'unavailable';
  readonly models: readonly CursorModelDto[];
}

export interface CursorModelDiscoveryOptions {
  executablePath?: string;
  timeoutMs?: number;
  runner?: (executable: string, args: readonly string[], timeoutMs?: number) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string | undefined;
  };
}

export class CursorModelDiscoveryError extends Error {
  public constructor(
    public readonly code:
      | 'CURSOR_MODEL_DISCOVERY_MALFORMED'
      | 'CURSOR_MODEL_DISCOVERY_OVERFLOW'
      | 'CURSOR_MODEL_DISCOVERY_INVALID_ENTRY',
    message: string,
  ) {
    super(message);
    this.name = 'CursorModelDiscoveryError';
  }
}

const MAX_MODELS = 512;
const MAX_MODEL_ID_BYTES = 256;
const MAX_LABEL_BYTES = 512;

export function discoverCursorModels(
  executablePath: string,
  options: CursorModelDiscoveryOptions = {},
): CursorModelDiscoveryResult {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const runner = options.runner ?? defaultRunner;

  try {
    const res = runner(executablePath, ['models'], timeoutMs);
    if (res.error?.toLowerCase().includes('timeout') === true) {
      return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
    }
    if (res.exitCode !== 0) {
      return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
    }
    return parseCursorModelsOutput(res.stdout);
  } catch {
    return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
  }
}

function defaultRunner(
  executable: string,
  args: readonly string[],
  timeoutMs = 5_000,
): { exitCode: number | null; stdout: string; stderr: string; error?: string | undefined } {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error?.message !== undefined ? { error: result.error.message } : {}),
  };
}

export function parseCursorModelsOutput(stdout: string): CursorModelDiscoveryResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
  }

  try {
    const models = parseKnownGrammar(trimmed);
    return { modelDiscovery: 'native', models: Object.freeze(models) };
  } catch {
    return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
  }
}

function parseKnownGrammar(trimmed: string): CursorModelDto[] {
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed) as unknown;
    } catch {
      throw new CursorModelDiscoveryError(
        'CURSOR_MODEL_DISCOVERY_MALFORMED',
        'Cursor native model discovery returned malformed JSON',
      );
    }
    return parseJsonModels(json);
  }

  throw new CursorModelDiscoveryError(
    'CURSOR_MODEL_DISCOVERY_MALFORMED',
    'Cursor native model discovery output is not a known JSON grammar',
  );
}

function parseJsonModels(json: unknown): CursorModelDto[] {
  if (Array.isArray(json)) {
    return parseModelItems(json);
  }
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const models = (json as Record<string, unknown>).models;
    if (!Array.isArray(models)) {
      throw new CursorModelDiscoveryError(
        'CURSOR_MODEL_DISCOVERY_MALFORMED',
        'Cursor native model discovery JSON object is not a known schema',
      );
    }
    return parseModelItems(models);
  }
  throw new CursorModelDiscoveryError(
    'CURSOR_MODEL_DISCOVERY_MALFORMED',
    'Cursor native model discovery JSON is not a known schema',
  );
}

function parseModelItems(rawList: readonly unknown[]): CursorModelDto[] {
  if (rawList.length > MAX_MODELS) {
    throw new CursorModelDiscoveryError(
      'CURSOR_MODEL_DISCOVERY_OVERFLOW',
      `Cursor native model discovery returned ${String(rawList.length)} models; maximum is ${String(MAX_MODELS)}`,
    );
  }

  const seen = new Map<string, string>();
  const models: CursorModelDto[] = [];

  for (const item of rawList) {
    const parsed = parseModelItem(item);
    const existing = seen.get(parsed.modelId);
    if (existing !== undefined) {
      if (existing !== parsed.label) {
        throw new CursorModelDiscoveryError(
          'CURSOR_MODEL_DISCOVERY_INVALID_ENTRY',
          `Cursor native model discovery contained conflicting rows for ${parsed.modelId}`,
        );
      }
      continue;
    }
    seen.set(parsed.modelId, parsed.label);
    models.push(Object.freeze(parsed));
  }

  return models;
}

function parseModelItem(item: unknown): CursorModelDto {
  if (typeof item === 'string') {
    return validateModel(item, item);
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const rec = item as Record<string, unknown>;
    const rawId = firstString(rec, ['modelId', 'id', 'slug', 'name']);
    const rawLabel = firstString(rec, ['label', 'displayName', 'name']) ?? rawId;
    if (rawId === undefined) {
      throw new CursorModelDiscoveryError(
        'CURSOR_MODEL_DISCOVERY_INVALID_ENTRY',
        'Cursor native model discovery object is missing modelId',
      );
    }
    return validateModel(rawId, rawLabel ?? rawId);
  }
  throw new CursorModelDiscoveryError(
    'CURSOR_MODEL_DISCOVERY_INVALID_ENTRY',
    'Cursor native model discovery contained an unexpected primitive',
  );
}

function validateModel(rawId: string, rawLabel: string): CursorModelDto {
  const modelId = rawId.trim();
  const label = rawLabel.trim();
  if (modelId.length === 0) {
    throw new CursorModelDiscoveryError('CURSOR_MODEL_DISCOVERY_INVALID_ENTRY', 'Cursor native modelId is blank');
  }
  if (modelId.includes('\0') || label.includes('\0')) {
    throw new CursorModelDiscoveryError('CURSOR_MODEL_DISCOVERY_INVALID_ENTRY', 'Cursor native model metadata contains NUL');
  }
  if (Buffer.byteLength(modelId, 'utf8') > MAX_MODEL_ID_BYTES) {
    throw new CursorModelDiscoveryError('CURSOR_MODEL_DISCOVERY_INVALID_ENTRY', 'Cursor native modelId exceeds size limit');
  }
  if (Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) {
    throw new CursorModelDiscoveryError('CURSOR_MODEL_DISCOVERY_INVALID_ENTRY', 'Cursor native model label exceeds size limit');
  }
  return { modelId, label: label.length > 0 ? label : modelId };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
