import type { MiningSnapshot } from "./mining.js";
import { isMiningSnapshot } from "./mining.js";
import { PROFILE_FALLBACK_EMOJI_COUNT } from "./profiles.js";

export type AuthMethodKey = "eth" | "sol" | "apple" | "x";

export type AuthCooldownReason =
  "method-reuse-cooldown" | "profile-method-cooldown";

export type AuthCooldownScope = "method" | "profile-method";

export type AuthMethodField = "eth" | "sol" | "appleSub" | "xUserId";

export interface AuthIntentRequest {
  method: AuthMethodKey;
}

export interface AuthIntentResponse {
  ok: true;
  intentId: string;
  nonce: string;
  state: string;
  expiresAtMs: number;
}

export interface LinkedAuthMethods {
  apple: boolean;
  eth: boolean;
  sol: boolean;
  x: boolean;
}

export interface LinkedAuthMethodsResponse {
  ok: true;
  profileId: string | null;
  linkedMethods: LinkedAuthMethods;
  appleLinked: boolean;
}

export interface AuthProfileResponse {
  ok: true;
  uid: string;
  profileId: string;
  username: string | null;
  eth?: string | null;
  sol?: string | null;
  linkedMethods: LinkedAuthMethods;
  appleLinked: boolean;
  emoji: number;
  aura?: string | null;
  rating?: number | null;
  nonce?: number | null;
  totalManaPoints?: number | null;
  cardBackgroundId?: number | null;
  cardStickers?: string | null;
  cardSubtitleId?: number | null;
  profileCounter?: string | null;
  profileMons?: string | null;
  completedProblems?: string[] | null;
  tutorialCompleted?: boolean | null;
  mining?: MiningSnapshot;
  opId: string;
}

export type AuthVerificationResponse = AuthProfileResponse | { ok: false };

export interface SolanaAuthVerificationRequest {
  intentId: string;
  address: string;
  signature: string;
  emoji: number;
  aura: string | null;
}

export interface EthereumAuthVerificationRequest {
  intentId: string;
  message: string;
  signature: string;
  emoji: number;
  aura: string | null;
}

export interface AppleAuthVerificationRequest {
  intentId: string;
  idToken: string;
  consentSource: "signin" | "settings";
  emoji: number;
  aura: string | null;
}

export interface XAuthCompletionRequest {
  flowId: string;
  emoji: number;
  aura: string | null;
}

export interface AuthMethodUnlinkRequest {
  method: AuthMethodKey;
  opId: string;
}

export interface AuthPresentation {
  emoji: number;
  aura: string | null;
}

const AUTH_METHODS = Object.freeze(["eth", "sol", "apple", "x"] as const);
const AUTH_METHOD_FIELD_BY_TYPE: Readonly<{
  eth: "eth";
  sol: "sol";
  apple: "appleSub";
  x: "xUserId";
}> = Object.freeze({
  eth: "eth",
  sol: "sol",
  apple: "appleSub",
  x: "xUserId",
});
const AUTH_METHOD_LABELS: Readonly<{
  eth: "Ethereum";
  sol: "Solana";
  apple: "Apple";
  x: "X";
}> = Object.freeze({
  eth: "Ethereum",
  sol: "Solana",
  apple: "Apple",
  x: "X",
});
const AUTH_METHOD_REUSE_COOLDOWN_MS: 86400000 = (24 *
  60 *
  60 *
  1000) as 86400000;
const AUTH_SWAG_EMOJI_MIN = 1000;
const AUTH_SWAG_EMOJI_MAX = 1466;
const AUTH_COOLDOWN_REASONS: Readonly<{
  method: "method-reuse-cooldown";
  profileMethod: "profile-method-cooldown";
}> = Object.freeze({
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

const cleanString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

const hasOnlyKeys = (value: object, allowedKeys: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowedKeys.includes(key));

const hasRequiredKeys = (
  value: object,
  requiredKeys: readonly string[],
): boolean => requiredKeys.every((key) => Object.hasOwn(value, key));

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isOptionalNullableString = (
  value: unknown,
): value is string | null | undefined =>
  value === undefined || isNullableString(value);

const isOptionalNullableFiniteNumber = (
  value: unknown,
): value is number | null | undefined =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && Number.isFinite(value));

const isAuthEmoji = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (((value as number) >= 1 &&
    (value as number) <= PROFILE_FALLBACK_EMOJI_COUNT) ||
    ((value as number) >= AUTH_SWAG_EMOJI_MIN &&
      (value as number) <= AUTH_SWAG_EMOJI_MAX));

const normalizeAuthPresentation = (
  emoji: unknown,
  aura: unknown,
): AuthPresentation => {
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

const isEmojiAndAura = (value: Record<string, unknown>) => {
  const normalized = normalizeAuthPresentation(value.emoji, value.aura);
  return normalized.emoji === value.emoji && normalized.aura === value.aura;
};

const isAuthToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[A-Za-z0-9_-]{24}$/.test(value);

const isOperationId = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const normalizeAuthMethod = (value: unknown): AuthMethodKey | null => {
  const method = cleanString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUTH_METHOD_FIELD_BY_TYPE, method)
    ? (method as AuthMethodKey)
    : null;
};

const normalizeAuthCooldownReason = (
  value: unknown,
): AuthCooldownReason | null => {
  const reason = cleanString(value);
  if (
    reason === AUTH_COOLDOWN_REASONS.method ||
    reason === AUTH_COOLDOWN_REASONS.profileMethod
  ) {
    return reason;
  }
  return null;
};

const getAuthCooldownScope = (reason: AuthCooldownReason): AuthCooldownScope =>
  reason === AUTH_COOLDOWN_REASONS.profileMethod ? "profile-method" : "method";

const parseFiniteNumber = (value: unknown, fallback: number) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

const resolveAuthCooldownRetryAtMs = (
  docData: unknown,
  fallbackCooldownMs: number = AUTH_METHOD_REUSE_COOLDOWN_MS,
): number => {
  const retryAtMs = parseFiniteNumber(
    docData && (docData as Record<string, unknown>).retryAtMs,
    0,
  );
  if (retryAtMs > 0) {
    return retryAtMs;
  }
  const expiresAtMs = parseFiniteNumber(
    docData && (docData as Record<string, unknown>).expiresAtMs,
    0,
  );
  if (expiresAtMs > 0) {
    return expiresAtMs;
  }
  const startedAtMs = Math.max(
    parseFiniteNumber(
      docData && (docData as Record<string, unknown>).startedAtMs,
      0,
    ),
    parseFiniteNumber(
      docData && (docData as Record<string, unknown>).revokedAtMs,
      0,
    ),
    parseFiniteNumber(
      docData && (docData as Record<string, unknown>).createdAtMs,
      0,
    ),
    parseFiniteNumber(
      docData && (docData as Record<string, unknown>).updatedAtMs,
      0,
    ),
  );
  const cooldownMs = parseFiniteNumber(
    docData && (docData as Record<string, unknown>).cooldownMs,
    fallbackCooldownMs,
  );
  return startedAtMs > 0 && cooldownMs > 0 ? startedAtMs + cooldownMs : 0;
};

const isAuthIntentResponse = (value: unknown): value is AuthIntentResponse =>
  isRecord(value) &&
  hasExactKeys(value, AUTH_INTENT_RESPONSE_KEYS) &&
  value.ok === true &&
  isAuthToken(value.intentId) &&
  cleanString(value.nonce) !== "" &&
  cleanString(value.state) !== "" &&
  Number.isSafeInteger(value.expiresAtMs) &&
  (value.expiresAtMs as number) > 0;

const isLinkedAuthMethods = (value: unknown): value is LinkedAuthMethods =>
  isRecord(value) &&
  hasExactKeys(value, LINKED_AUTH_METHOD_KEYS) &&
  LINKED_AUTH_METHOD_KEYS.every((key) => typeof value[key] === "boolean");

const isLinkedAuthMethodsResponse = (
  value: unknown,
): value is LinkedAuthMethodsResponse =>
  isRecord(value) &&
  hasExactKeys(value, LINKED_AUTH_METHODS_RESPONSE_KEYS) &&
  value.ok === true &&
  (value.profileId === null || cleanString(value.profileId) !== "") &&
  isLinkedAuthMethods(value.linkedMethods) &&
  value.appleLinked === value.linkedMethods.apple;

const isAuthProfileResponse = (value: unknown): value is AuthProfileResponse =>
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

const isAuthVerificationResponse = (
  value: unknown,
): value is AuthVerificationResponse =>
  (isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === false) ||
  isAuthProfileResponse(value);

const isSolanaAuthVerificationRequest = (
  value: unknown,
): value is SolanaAuthVerificationRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["intentId", "address", "signature", "emoji", "aura"]) &&
  isAuthToken(value.intentId) &&
  cleanString(value.address) !== "" &&
  (value.address as string).length <= 64 &&
  cleanString(value.signature) !== "" &&
  (value.signature as string).length <= 128 &&
  isEmojiAndAura(value);

const isEthereumAuthVerificationRequest = (
  value: unknown,
): value is EthereumAuthVerificationRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["intentId", "message", "signature", "emoji", "aura"]) &&
  isAuthToken(value.intentId) &&
  cleanString(value.message) !== "" &&
  cleanString(value.signature) !== "" &&
  isEmojiAndAura(value);

const isAppleAuthVerificationRequest = (
  value: unknown,
): value is AppleAuthVerificationRequest =>
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

const isXAuthCompletionRequest = (
  value: unknown,
): value is XAuthCompletionRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["flowId", "emoji", "aura"]) &&
  isAuthToken(value.flowId) &&
  isEmojiAndAura(value);

const isAuthMethodUnlinkRequest = (
  value: unknown,
): value is AuthMethodUnlinkRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["method", "opId"]) &&
  normalizeAuthMethod(value.method) !== null &&
  isOperationId(value.opId);

const getLinkedAuthMethodsFromProfile = (value: unknown): LinkedAuthMethods => {
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

export {
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
