import { isSensitiveKey, REDACTED_VALUE, redactSensitiveAssignments } from './sensitive-key-policy.js';

export function redactEventValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED_VALUE;
  if (typeof value === 'string') {
    return redactSensitiveAssignments(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactEventValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactEventValue(entryValue, entryKey)]),
    );
  }
  return value;
}
