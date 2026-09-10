export function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

export function assertEnumValue<T extends string>(
  enumObject: Record<string, T>,
  value: unknown,
  field: string,
): asserts value is T {
  if (!Object.values(enumObject).includes(value as T)) {
    throw new TypeError(`${field} has an invalid value: ${String(value)}`);
  }
}
