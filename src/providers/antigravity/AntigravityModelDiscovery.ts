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
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return { modelDiscovery: 'unavailable', models: [] };
    }
    const parsed = parseAntigravityModelsOutput(res.stdout);
    if (parsed.length === 0) {
      return { modelDiscovery: 'unavailable', models: [] };
    }
    return { modelDiscovery: 'native', models: Object.freeze(parsed) };
  } catch {
    return { modelDiscovery: 'unavailable', models: [] };
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

export function parseAntigravityModelsOutput(stdout: string): AntigravityModelDto[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let rawList: unknown[] = [];
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (Array.isArray(json)) {
      rawList = json;
    } else if (typeof json === 'object' && json !== null && Array.isArray((json as Record<string, unknown>).models)) {
      rawList = (json as Record<string, unknown>).models as unknown[];
    }
  } catch {
    rawList = trimmed
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('Warning:') && !l.startsWith('Error:'));
  }

  const seen = new Set<string>();
  const models: AntigravityModelDto[] = [];

  for (const item of rawList) {
    let modelId = '';
    let label = '';

    if (typeof item === 'string') {
      modelId = item.trim();
      label = item.trim();
    } else if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>;
      const rawId = typeof rec.modelId === 'string' ? rec.modelId
        : typeof rec.slug === 'string' ? rec.slug
        : typeof rec.id === 'string' ? rec.id
        : typeof rec.name === 'string' ? rec.name
        : '';
      modelId = rawId.trim();
      const rawLabel = typeof rec.label === 'string' ? rec.label
        : typeof rec.name === 'string' ? rec.name
        : typeof rec.displayName === 'string' ? rec.displayName
        : modelId;
      label = rawLabel.trim();
    }

    if (!modelId || modelId.includes('\0') || label.includes('\0')) continue;
    if (Buffer.byteLength(modelId, 'utf8') > MAX_MODEL_ID_BYTES) continue;
    if (Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) continue;
    if (seen.has(modelId)) continue;

    seen.add(modelId);
    models.push(Object.freeze({ modelId, label: label || modelId }));

    if (models.length >= MAX_MODELS) break;
  }

  return models;
}
