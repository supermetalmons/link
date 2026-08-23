const { isMiningSnapshot } = require("./mining");
const { PROFILE_FALLBACK_EMOJI_COUNT } = require("./profiles");

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
const AUTH_SWAG_EMOJI_MIN = 1000;
const AUTH_SWAG_EMOJI_MAX = 1466;
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
const AUTH_PROFILE_RESPONSE_REQUIRED_KEYS = Object.freeze([
  "ok",
  "uid",
  "profileId",
  "username",
  "emoji",
  "linkedMethods",
  "appleLinked",
  "opId",
]);
const AUTH_PROFILE_RESPONSE_KEYS = Object.freeze([
  ...AUTH_PROFILE_RESPONSE_REQUIRED_KEYS,
  "address",
  "eth",
  "sol",
  "aura",
  "rating",
  "nonce",
  "totalManaPoints",
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
  "completedProblems",
  "tutorialCompleted",
  "mining",
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

const hasOnlyKeys = (value, allowedKeys) =>
  Object.keys(value).every((key) => allowedKeys.includes(key));

const hasRequiredKeys = (value, requiredKeys) =>
  requiredKeys.every((key) => Object.hasOwn(value, key));

const isNullableString = (value) => value === null || typeof value === "string";

const isOptionalNullableString = (value) =>
  value === undefined || isNullableString(value);

const isOptionalNullableFiniteNumber = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isFinite(value));

const isAuthEmoji = (value) =>
  Number.isSafeInteger(value) &&
  ((value >= 1 && value <= PROFILE_FALLBACK_EMOJI_COUNT) ||
    (value >= AUTH_SWAG_EMOJI_MIN && value <= AUTH_SWAG_EMOJI_MAX));

const normalizeAuthPresentation = (emoji, aura) => {
  const numericEmoji =
    typeof emoji === "number" ||
    (typeof emoji === "string" && emoji.trim() !== "")
      ? Number(emoji)
      : NaN;
  return {
    emoji: isAuthEmoji(numericEmoji) ? numericEmoji : 1,
    aura: typeof aura === "string" && aura.length <= 32 ? aura : null,
  };
};

const isEmojiAndAura = (value) => {
  const normalized = normalizeAuthPresentation(value.emoji, value.aura);
  return normalized.emoji === value.emoji && normalized.aura === value.aura;
};

const isAuthToken = (value) =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[A-Za-z0-9_-]{24}$/.test(value);

const isOperationId = (value) =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

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
  isAuthToken(value.intentId) &&
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

const isAuthProfileResponse = (value) =>
  isRecord(value) &&
  hasOnlyKeys(value, AUTH_PROFILE_RESPONSE_KEYS) &&
  hasRequiredKeys(value, AUTH_PROFILE_RESPONSE_REQUIRED_KEYS) &&
  value.ok === true &&
  cleanString(value.uid) !== "" &&
  cleanString(value.profileId) !== "" &&
  isNullableString(value.username) &&
  typeof value.emoji === "number" &&
  Number.isFinite(value.emoji) &&
  isLinkedAuthMethods(value.linkedMethods) &&
  value.appleLinked === value.linkedMethods.apple &&
  cleanString(value.opId) !== "" &&
  isOptionalNullableString(value.address) &&
  isOptionalNullableString(value.eth) &&
  isOptionalNullableString(value.sol) &&
  isOptionalNullableString(value.aura) &&
  isOptionalNullableFiniteNumber(value.rating) &&
  isOptionalNullableFiniteNumber(value.nonce) &&
  isOptionalNullableFiniteNumber(value.totalManaPoints) &&
  isOptionalNullableFiniteNumber(value.cardBackgroundId) &&
  isOptionalNullableFiniteNumber(value.cardSubtitleId) &&
  isOptionalNullableString(value.profileCounter) &&
  isOptionalNullableString(value.cardStickers) &&
  isOptionalNullableString(value.profileMons) &&
  (value.completedProblems === undefined ||
    value.completedProblems === null ||
    (Array.isArray(value.completedProblems) &&
      value.completedProblems.every((item) => typeof item === "string"))) &&
  (value.tutorialCompleted === undefined ||
    value.tutorialCompleted === null ||
    typeof value.tutorialCompleted === "boolean") &&
  (value.mining === undefined || isMiningSnapshot(value.mining));

const isAuthVerificationResponse = (value) =>
  (isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === false) ||
  isAuthProfileResponse(value);

const isSolanaAuthVerificationRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["intentId", "address", "signature", "emoji", "aura"]) &&
  isAuthToken(value.intentId) &&
  cleanString(value.address) !== "" &&
  value.address.length <= 64 &&
  cleanString(value.signature) !== "" &&
  value.signature.length <= 128 &&
  isEmojiAndAura(value);

const isEthereumAuthVerificationRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["intentId", "message", "signature", "emoji", "aura"]) &&
  isAuthToken(value.intentId) &&
  cleanString(value.message) !== "" &&
  cleanString(value.signature) !== "" &&
  isEmojiAndAura(value);

const isAppleAuthVerificationRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "intentId",
    "idToken",
    "consentSource",
    "emoji",
    "aura",
  ]) &&
  isAuthToken(value.intentId) &&
  cleanString(value.idToken) !== "" &&
  (value.consentSource === "signin" || value.consentSource === "settings") &&
  isEmojiAndAura(value);

const isXAuthCompletionRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["flowId", "emoji", "aura"]) &&
  isAuthToken(value.flowId) &&
  isEmojiAndAura(value);

const isAuthMethodUnlinkRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["method", "opId"]) &&
  normalizeAuthMethod(value.method) !== null &&
  isOperationId(value.opId);

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
  normalizeAuthPresentation,
  normalizeAuthMethod,
  normalizeAuthCooldownReason,
  getAuthCooldownScope,
  isAuthIntentResponse,
  isAppleAuthVerificationRequest,
  isAuthMethodUnlinkRequest,
  isAuthProfileResponse,
  isAuthVerificationResponse,
  isEthereumAuthVerificationRequest,
  isLinkedAuthMethodsResponse,
  isSolanaAuthVerificationRequest,
  isXAuthCompletionRequest,
  resolveAuthCooldownRetryAtMs,
};
