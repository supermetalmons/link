import {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  getLinkedAuthMethodsFromProfile,
  getAuthCooldownScope,
  normalizeAuthMethod,
  resolveAuthCooldownRetryAtMs,
  type AuthMethodKey,
} from "@mons/shared/auth";
import { base64url } from "jose";
import { createHash } from "node:crypto";
import { AuthApiFailure } from "./authErrors.ts";

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readStoredFirebaseUid(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function uniqueStoredFirebaseUids(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === "string") {
        result.add(item);
      }
    }
  }
  return [...result];
}

export function uniqueStrings(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      const normalized = cleanString(item);
      if (normalized) {
        result.add(normalized);
      }
    }
  }
  return [...result];
}

export function authMutationsDisabled(value: unknown): boolean {
  return value === "true";
}

export function finiteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function assertAuthMethod(value: unknown): AuthMethodKey {
  const method = normalizeAuthMethod(value);
  if (!method) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "Unsupported auth method.",
    );
  }
  return method;
}

export function normalizeMethodValue(
  method: AuthMethodKey,
  value: unknown,
): string {
  const input = cleanString(value);
  if (method === "eth") {
    const normalized = input.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "Invalid Ethereum address.",
      );
    }
    return normalized;
  }
  if (method === "sol") {
    if (input.length < 20 || input.length > 64) {
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "Invalid Solana address.",
      );
    }
    return input;
  }
  if (method === "apple") {
    if (input.length < 6) {
      throw new AuthApiFailure(
        400,
        "invalid-argument",
        "Invalid Apple subject.",
      );
    }
    return input;
  }
  if (!/^\d+$/.test(input)) {
    throw new AuthApiFailure(400, "invalid-argument", "Invalid X user id.");
  }
  return input;
}

export function getMethodField(method: AuthMethodKey): string {
  return AUTH_METHOD_FIELD_BY_TYPE[method];
}

export function getMethodKey(
  method: AuthMethodKey,
  normalizedValue: string,
): string {
  return `${method}:${base64url.encode(normalizedValue)}`;
}

export function hashMethodValue(
  method: AuthMethodKey,
  normalizedValue: string,
): string {
  if (!cleanString(normalizedValue)) {
    return "";
  }
  return createHash("sha256")
    .update(`${method}:${normalizedValue}`)
    .digest("hex");
}

export function normalizeProfileMethod(
  method: AuthMethodKey,
  profile: Record<string, unknown>,
): string {
  const value = cleanString(profile[getMethodField(method)]);
  if (!value) {
    return "";
  }
  try {
    return normalizeMethodValue(method, value);
  } catch {
    return "";
  }
}

export function linkedMethodCount(profile: Record<string, unknown>): number {
  return Object.values(getLinkedAuthMethodsFromProfile(profile)).filter(Boolean)
    .length;
}

export function profileMethodCooldownId(
  profileId: string,
  method: AuthMethodKey,
): string {
  const normalizedProfileId = cleanString(profileId);
  if (!normalizedProfileId) {
    throw new AuthApiFailure(400, "invalid-argument", "profileId is required.");
  }
  return `${normalizedProfileId}:${method}`;
}

export function throwMethodCooldown(
  method: AuthMethodKey,
  retryAtMs: number,
): never {
  const reason = AUTH_COOLDOWN_REASONS.method;
  throw new AuthApiFailure(409, "failed-precondition", reason, {
    reason,
    scope: getAuthCooldownScope(reason),
    method,
    retryAtMs: Math.max(finiteNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
  });
}

export function throwProfileMethodCooldown(
  method: AuthMethodKey,
  profileId: string,
  retryAtMs: number,
): never {
  const reason = AUTH_COOLDOWN_REASONS.profileMethod;
  throw new AuthApiFailure(409, "failed-precondition", reason, {
    reason,
    scope: getAuthCooldownScope(reason),
    method,
    retryAtMs: Math.max(finiteNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
    profileId: cleanString(profileId) || null,
  });
}

export function cooldownRetryAtMs(value: unknown): number {
  return resolveAuthCooldownRetryAtMs(value);
}
