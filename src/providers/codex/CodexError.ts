export function normalizeCodexErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!isRecord(value)) return undefined;
  const code = Object.keys(value)[0];
  return code !== undefined && code.length > 0 ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
