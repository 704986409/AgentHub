import { spawnSync } from 'node:child_process';

export interface AntigravityModelDto {
  readonly modelId: string;
  readonly label: string;
}

export interface AntigravityModelDiscoveryResult {
  readonly modelDiscovery: 'native' | 'unavailable';
  readonly models: readonly AntigravityModelDto[];
}

export interface AntigravityModelDiscoveryOptions {
  executablePath?: string;
  timeoutMs?: number;
  runner?: (executable: string, args: readonly string[]) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string | undefined;
  };
}

export class AntigravityModelDiscoveryError extends Error {
  public constructor(
    public readonly code:
      | 'ANTIGRAVITY_MODEL_DISCOVERY_MALFORMED'
      | 'ANTIGRAVITY_MODEL_DISCOVERY_OVERFLOW'
      | 'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
    message: string,
  ) {
    super(message);
    this.name = 'AntigravityModelDiscoveryError';
  }
}

const MAX_MODELS = 512;
const MAX_MODEL_ID_BYTES = 256;
const MAX_LABEL_BYTES = 512;

export function discoverAntigravityModels(
  executablePath: string,
  options: AntigravityModelDiscoveryOptions = {},
): AntigravityModelDiscoveryResult {
  const runner = options.runner ?? defaultRunner;

  try {
    const res = runner(executablePath, ['models']);
    if (res.error?.toLowerCase().includes('timeout') === true) {
      return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
    }
    if (res.exitCode !== 0) {
      return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
    }
    return parseAntigravityModelsOutput(res.stdout);
  } catch {
    return { modelDiscovery: 'unavailable', models: Object.freeze([]) };
  }
}

function defaultRunner(
  executable: string,
  args: readonly string[],
): { exitCode: number | null; stdout: string; stderr: string; error?: string | undefined } {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error?.message !== undefined ? { error: result.error.message } : {}),
  };
}

export function parseAntigravityModelsOutput(stdout: string): AntigravityModelDiscoveryResult {
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

function parseKnownGrammar(trimmed: string): AntigravityModelDto[] {
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed) as unknown;
    } catch {
      throw new AntigravityModelDiscoveryError(
        'ANTIGRAVITY_MODEL_DISCOVERY_MALFORMED',
        'Antigravity native model discovery returned malformed JSON',
      );
    }
    return parseJsonModels(json);
  }

  throw new AntigravityModelDiscoveryError(
    'ANTIGRAVITY_MODEL_DISCOVERY_MALFORMED',
    'Antigravity native model discovery output is not a known JSON grammar',
  );
}

function parseJsonModels(json: unknown): AntigravityModelDto[] {
  if (Array.isArray(json)) {
    return parseModelItems(json);
  }
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const models = (json as Record<string, unknown>).models;
    if (!Array.isArray(models)) {
      throw new AntigravityModelDiscoveryError(
        'ANTIGRAVITY_MODEL_DISCOVERY_MALFORMED',
        'Antigravity native model discovery JSON object is not a known schema',
      );
    }
    return parseModelItems(models);
  }
  throw new AntigravityModelDiscoveryError(
    'ANTIGRAVITY_MODEL_DISCOVERY_MALFORMED',
    'Antigravity native model discovery JSON is not a known schema',
  );
}

function parseModelItems(rawList: readonly unknown[]): AntigravityModelDto[] {
  if (rawList.length > MAX_MODELS) {
    throw new AntigravityModelDiscoveryError(
      'ANTIGRAVITY_MODEL_DISCOVERY_OVERFLOW',
      `Antigravity native model discovery returned ${String(rawList.length)} models; maximum is ${String(MAX_MODELS)}`,
    );
  }

  const seen = new Map<string, string>();
  const models: AntigravityModelDto[] = [];

  for (const item of rawList) {
    const parsed = parseModelItem(item);
    const existing = seen.get(parsed.modelId);
    if (existing !== undefined) {
      if (existing !== parsed.label) {
        throw new AntigravityModelDiscoveryError(
          'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
          `Antigravity native model discovery contained conflicting rows for ${parsed.modelId}`,
        );
      }
      continue;
    }
    seen.set(parsed.modelId, parsed.label);
    models.push(Object.freeze(parsed));
  }

  return models;
}

function parseModelItem(item: unknown): AntigravityModelDto {
  if (typeof item === 'string') {
    return validateModel(item, item);
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const rec = item as Record<string, unknown>;
    const rawId = firstString(rec, ['modelId', 'slug', 'id', 'name']);
    const rawLabel = firstString(rec, ['label', 'displayName', 'name']) ?? rawId;
    if (rawId === undefined) {
      throw new AntigravityModelDiscoveryError(
        'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
        'Antigravity native model discovery object is missing modelId',
      );
    }
    return validateModel(rawId, rawLabel ?? rawId);
  }
  throw new AntigravityModelDiscoveryError(
    'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
    'Antigravity native model discovery contained an unexpected primitive',
  );
}

function validateModel(rawId: string, rawLabel: string): AntigravityModelDto {
  const modelId = rawId.trim();
  const label = rawLabel.trim();
  if (modelId.length === 0) {
    throw new AntigravityModelDiscoveryError(
      'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
      'Antigravity native modelId is blank',
    );
  }
  if (modelId.includes('\0') || label.includes('\0')) {
    throw new AntigravityModelDiscoveryError(
      'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
      'Antigravity native model metadata contains NUL',
    );
  }
  if (Buffer.byteLength(modelId, 'utf8') > MAX_MODEL_ID_BYTES) {
    throw new AntigravityModelDiscoveryError(
      'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
      'Antigravity native modelId exceeds size limit',
    );
  }
  if (Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) {
    throw new AntigravityModelDiscoveryError(
      'ANTIGRAVITY_MODEL_DISCOVERY_INVALID_ENTRY',
      'Antigravity native model label exceeds size limit',
    );
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
