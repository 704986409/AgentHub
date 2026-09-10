const redacted = '[REDACTED]';
const sensitiveKeyPattern = /authorization|auth|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|password|cookie|credential/i;
const sensitiveAssignmentPattern = /\b(authorization|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|password|cookie|credential)\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function redactEventValue(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) return redacted;
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
