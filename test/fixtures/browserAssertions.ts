export function requireValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined)
    throw new Error("browser-fixture-value-missing");
  return value;
}
