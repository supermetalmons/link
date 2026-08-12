export const normalizeStringOrNull = (value: unknown): string | null => {
  return typeof value === "string" && value !== "" ? value : null;
};

export const normalizeString = (value: unknown): string => {
  return typeof value === "string" ? value : "";
};

export const normalizeFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (
    typeof value === "string" &&
    value !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Math.floor(Number(value));
  }
  return fallback;
};

export const readTimestampMillis = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis: unknown }).toMillis === "function"
  ) {
    try {
      const millis = (value as { toMillis: () => number }).toMillis();
      if (Number.isFinite(millis)) {
        return Math.floor(millis);
      }
    } catch {}
  }
  return 0;
};
