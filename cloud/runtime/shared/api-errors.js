// Generated from src/shared/api-errors.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isApiErrorDetails = isApiErrorDetails;
exports.parseApiErrorDetails = parseApiErrorDetails;
function isApiErrorDetails(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  if ("terminal" in value) return keys.length === 1 && value.terminal === true;
  if (
    !("method" in value) ||
    !["apple", "eth", "sol", "x"].some((method) => method === value.method) ||
    !("retryAtMs" in value) ||
    typeof value.retryAtMs !== "number" ||
    !Number.isSafeInteger(value.retryAtMs) ||
    value.retryAtMs < 0 ||
    !("cooldownMs" in value) ||
    typeof value.cooldownMs !== "number" ||
    !Number.isSafeInteger(value.cooldownMs) ||
    value.cooldownMs < 0 ||
    !("reason" in value) ||
    !("scope" in value)
  )
    return false;
  if (value.reason === "method-reuse-cooldown")
    return keys.length === 5 && value.scope === "method";
  return (
    value.reason === "profile-method-cooldown" &&
    value.scope === "profile-method" &&
    keys.length === 6 &&
    "profileId" in value &&
    (value.profileId === null ||
      (typeof value.profileId === "string" &&
        value.profileId.length > 0 &&
        value.profileId.trim() === value.profileId))
  );
}
function parseApiErrorDetails(code, value) {
  if (value === undefined) return undefined;
  if (
    !isApiErrorDetails(value) ||
    ("terminal" in value
      ? code !== "unavailable"
      : code !== "failed-precondition")
  )
    throw new TypeError("invalid-api-error-details");
  return value;
}
