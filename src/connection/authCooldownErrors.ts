import {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHOD_LABELS,
  getAuthCooldownScope,
  normalizeAuthCooldownReason,
  normalizeAuthMethod,
  type AuthCooldownReason,
  type AuthCooldownScope,
  type AuthMethodKey,
} from "@mons/shared/auth";

interface AuthCooldownErrorDetails {
  reason: AuthCooldownReason;
  scope: AuthCooldownScope;
  method: AuthMethodKey | null;
  retryAtMs: number | null;
  cooldownMs: number | null;
  profileId: string | null;
}

const toCleanString = (value: unknown): string => {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
};

const parseFiniteNumber = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeCooldownScope = (
  value: unknown,
  reason: AuthCooldownReason,
): AuthCooldownScope => {
  const scope = toCleanString(value);
  if (scope === "method" || scope === "profile-method") {
    return scope;
  }
  return getAuthCooldownScope(reason);
};

const parseDetailsObject = (
  value: unknown,
): AuthCooldownErrorDetails | null => {
  if (!isRecord(value)) {
    return null;
  }
  const reason = normalizeAuthCooldownReason(value.reason);
  if (!reason) {
    return null;
  }
  const retryAtMs = parseFiniteNumber(value.retryAtMs);
  const cooldownMs = parseFiniteNumber(value.cooldownMs);
  const profileId = toCleanString(value.profileId) || null;
  return {
    reason,
    scope: normalizeCooldownScope(value.scope, reason),
    method: normalizeAuthMethod(value.method),
    retryAtMs,
    cooldownMs,
    profileId,
  };
};

const getMethodLabel = (method: AuthMethodKey | null): string => {
  return method ? AUTH_METHOD_LABELS[method] : "this sign-in method";
};

const formatRetryAt = (retryAtMs: number | null): string | null => {
  if (!retryAtMs || !Number.isFinite(retryAtMs) || retryAtMs <= 0) {
    return null;
  }
  const date = new Date(retryAtMs);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const parseAuthCooldownError = (
  error: unknown,
): AuthCooldownErrorDetails | null => {
  if (!isRecord(error)) {
    return null;
  }
  return parseDetailsObject(error.details);
};

export const formatAuthCooldownErrorMessage = (
  error: unknown,
): string | null => {
  const details = parseAuthCooldownError(error);
  if (!details) {
    return null;
  }
  const methodLabel = getMethodLabel(details.method);
  const retryAtText = formatRetryAt(details.retryAtMs);
  if (details.reason === AUTH_COOLDOWN_REASONS.method) {
    const methodSignInLabel = details.method
      ? `${methodLabel} sign-in`
      : "sign-in method";
    if (retryAtText) {
      return `This ${methodSignInLabel} was recently unlinked. Try again after ${retryAtText}.`;
    }
    return `This ${methodSignInLabel} was recently unlinked. Try again in up to 24 hours.`;
  }
  const profileMethodLabel = details.method ? methodLabel : "this method type";
  if (retryAtText) {
    return `You recently unlinked ${profileMethodLabel} on this profile. You can link it again after ${retryAtText}.`;
  }
  return `You recently unlinked ${profileMethodLabel} on this profile. You can link it again in up to 24 hours.`;
};
