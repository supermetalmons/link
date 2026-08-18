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
const AUTH_INTENT_RESPONSE_KEYS = Object.freeze([
  "ok",
  "intentId",
  "nonce",
  "state",
  "expiresAtMs",
]);
const LINKED_AUTH_METHOD_KEYS = Object.freeze(["apple", "eth", "sol", "x"]);
const LINKED_AUTH_METHODS_RESPONSE_KEYS = Object.freeze([
  "ok",
  "profileId",
  "linkedMethods",
  "appleLinked",
]);

const cleanString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

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

const isAuthIntentResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, AUTH_INTENT_RESPONSE_KEYS) &&
  value.ok === true &&
  cleanString(value.intentId) !== "" &&
  cleanString(value.nonce) !== "" &&
  cleanString(value.state) !== "" &&
  Number.isSafeInteger(value.expiresAtMs) &&
  value.expiresAtMs > 0;

const isLinkedAuthMethods = (value) =>
  isRecord(value) &&
  hasExactKeys(value, LINKED_AUTH_METHOD_KEYS) &&
  LINKED_AUTH_METHOD_KEYS.every((key) => typeof value[key] === "boolean");

const isLinkedAuthMethodsResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, LINKED_AUTH_METHODS_RESPONSE_KEYS) &&
  value.ok === true &&
  (value.profileId === null || cleanString(value.profileId) !== "") &&
  isLinkedAuthMethods(value.linkedMethods) &&
  value.appleLinked === value.linkedMethods.apple;

const getLinkedAuthMethodsFromProfile = (value) => {
  const profile = isRecord(value) ? value : {};
  const eth = cleanString(profile.eth).toLowerCase();
  const sol = cleanString(profile.sol);
  const apple = cleanString(profile.appleSub);
  const x = cleanString(profile.xUserId);
  return {
    apple: apple.length >= 6,
    eth: /^0x[a-f0-9]{40}$/.test(eth),
    sol: sol.length >= 20 && sol.length <= 64,
    x: /^\d+$/.test(x),
  };
};

module.exports = {
  AUTH_METHODS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_LABELS,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  AUTH_COOLDOWN_REASONS,
  getLinkedAuthMethodsFromProfile,
  normalizeAuthMethod,
  normalizeAuthCooldownReason,
  getAuthCooldownScope,
  isAuthIntentResponse,
  isLinkedAuthMethodsResponse,
  resolveAuthCooldownRetryAtMs,
};
