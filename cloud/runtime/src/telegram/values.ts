export function readProperty(value: unknown, key: PropertyKey): unknown {
  return value == null
    ? undefined
    : (value as Record<PropertyKey, unknown>)[key];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
