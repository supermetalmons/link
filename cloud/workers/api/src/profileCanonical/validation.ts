import { type AuthMethodKey, AUTH_METHODS } from "@mons/shared/auth";
import { CanonicalProfileCorruption } from "./types.ts";
type JsonObject = Record<string, unknown>;

export function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function parseObjectJson(value: unknown): JsonObject {
  if (typeof value !== "string") {
    throw new CanonicalProfileCorruption();
  }
  try {
    const parsed = record(JSON.parse(value) as unknown);
    if (parsed) return parsed;
  } catch {}
  throw new CanonicalProfileCorruption();
}

export function parseNullableObjectJson(value: unknown): JsonObject | null {
  return value === null ? null : parseObjectJson(value);
}

export function parseStringArrayJson(value: unknown): string[] {
  if (typeof value !== "string") {
    throw new CanonicalProfileCorruption();
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string" && entry !== "") &&
      new Set(parsed).size === parsed.length
    ) {
      return parsed;
    }
  } catch {}
  throw new CanonicalProfileCorruption();
}

export function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new CanonicalProfileCorruption();
  }
  return Number(value);
}

export function nullableSafeInteger(
  value: unknown,
  minimum = 0,
): number | null {
  return value === null ? null : safeInteger(value, minimum);
}

export function nonempty(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

export function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new CanonicalProfileCorruption();
  return value;
}

export function authMethod(value: unknown): AuthMethodKey {
  if (
    typeof value !== "string" ||
    !(AUTH_METHODS as readonly string[]).includes(value)
  ) {
    throw new CanonicalProfileCorruption();
  }
  return value as AuthMethodKey;
}

export function nullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CanonicalProfileCorruption();
  }
  return value;
}

export function flag(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new CanonicalProfileCorruption();
  return value === 1;
}
