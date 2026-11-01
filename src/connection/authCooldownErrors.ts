import {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHOD_LABELS,
  type AuthMethodKey,
} from "@mons/shared/auth";
import {
  parseApiErrorDetails,
  type AuthCooldownDetails,
} from "@mons/shared/api-errors";

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

const parseAuthCooldownError = (error: unknown): AuthCooldownDetails | null => {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return null;
  try {
    const details = parseApiErrorDetails(
      error.code,
      "details" in error ? error.details : undefined,
    );
    return details && "reason" in details ? details : null;
  } catch {
    return null;
  }
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
