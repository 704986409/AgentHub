export const REDACTED_VALUE = '[REDACTED]';

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

const sensitiveAssignmentPattern = /\b(authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|credentials?)\s*([:=])\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(normalizeSensitiveKey(key));
}

export function redactSensitiveAssignments(value: string, preserveSeparator = false): string {
  return value.replace(
    sensitiveAssignmentPattern,
    (_match, label: string, separator: string) => preserveSeparator
      ? `${label}${separator} ${REDACTED_VALUE}`
      : `${label}=${REDACTED_VALUE}`,
  );
}
