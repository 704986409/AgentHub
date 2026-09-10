const redacted = '[REDACTED]';
const sensitiveKeys = new Set([
  'authorization',
  'auth',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'password',
  'cookie',
  'credential',
  'credentials',
]);
const sensitiveAssignmentPattern = /\b(authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|credentials?)\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(key.toLowerCase().replace(/[_-]/g, ''));
}

export function redactEventValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return redacted;
  if (typeof value === 'string') {
    return value.replace(sensitiveAssignmentPattern, (_match, label: string) => `${label}=${redacted}`);
  }
  if (Array.isArray(value)) return value.map((item) => redactEventValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactEventValue(entryValue, entryKey)]),
    );
  }
  return value;
}
