const AUTH_METHODS = Object.freeze(["eth", "sol", "apple", "x"]);
const AUTH_METHOD_FIELD_BY_TYPE = Object.freeze({
  eth: "eth",
  sol: "sol",
  apple: "appleSub",
  x: "xUserId",
});
const AUTH_METHOD_LABELS = Object.freeze({
  eth: "Ethereum",
  sol: "Solana",
  apple: "Apple",
  x: "X",
});
const AUTH_METHOD_REUSE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const AUTH_COOLDOWN_REASONS = Object.freeze({
  method: "method-reuse-cooldown",
  profileMethod: "profile-method-cooldown",
});

const cleanString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeAuthMethod = (value) => {
  const method = cleanString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUTH_METHOD_FIELD_BY_TYPE, method)
    ? method
    : null;
};

const normalizeAuthCooldownReason = (value) => {
  const reason = cleanString(value);
  if (
    reason === AUTH_COOLDOWN_REASONS.method ||
    reason === AUTH_COOLDOWN_REASONS.profileMethod
  ) {
    return reason;
  }
  return null;
};

const getAuthCooldownScope = (reason) =>
  reason === AUTH_COOLDOWN_REASONS.profileMethod ? "profile-method" : "method";

const parseFiniteNumber = (value, fallback) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

const resolveAuthCooldownRetryAtMs = (
  docData,
  fallbackCooldownMs = AUTH_METHOD_REUSE_COOLDOWN_MS,
) => {
  const retryAtMs = parseFiniteNumber(docData && docData.retryAtMs, 0);
  if (retryAtMs > 0) {
    return retryAtMs;
  }
  const expiresAtMs = parseFiniteNumber(docData && docData.expiresAtMs, 0);
  if (expiresAtMs > 0) {
    return expiresAtMs;
  }
  const startedAtMs = Math.max(
    parseFiniteNumber(docData && docData.startedAtMs, 0),
    parseFiniteNumber(docData && docData.revokedAtMs, 0),
    parseFiniteNumber(docData && docData.createdAtMs, 0),
    parseFiniteNumber(docData && docData.updatedAtMs, 0),
  );
  const cooldownMs = parseFiniteNumber(
    docData && docData.cooldownMs,
    fallbackCooldownMs,
  );
  return startedAtMs > 0 && cooldownMs > 0 ? startedAtMs + cooldownMs : 0;
};

module.exports = {
  AUTH_METHODS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_LABELS,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  AUTH_COOLDOWN_REASONS,
  normalizeAuthMethod,
  normalizeAuthCooldownReason,
  getAuthCooldownScope,
  resolveAuthCooldownRetryAtMs,
};
