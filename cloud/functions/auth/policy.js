const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  getAuthCooldownScope,
  normalizeAuthMethod,
  resolveAuthCooldownRetryAtMs,
} = require("@mons/shared/auth");

const toCleanString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const assertSupportedMethod = (value) => {
  const method = normalizeAuthMethod(value);
  if (!method) {
    throw new HttpsError("invalid-argument", "Unsupported auth method.");
  }
  return method;
};

const isFeatureDisabled = (name) => {
  const value = toCleanString(process.env[name]).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const parseNumber = (value, fallback) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const getProfileMethodCooldownDocId = (profileId, method) => {
  const normalizedProfileId = toCleanString(profileId);
  const normalizedMethod = assertSupportedMethod(method);
  if (!normalizedProfileId) {
    throw new HttpsError("invalid-argument", "profileId is required.");
  }
  return `${normalizedProfileId}:${normalizedMethod}`;
};

const parseCooldownRetryAtMs = resolveAuthCooldownRetryAtMs;

const buildMethodReuseCooldownDetails = ({ method, retryAtMs }) => {
  const normalizedMethod = assertSupportedMethod(method);
  const reason = AUTH_COOLDOWN_REASONS.method;
  return {
    reason,
    scope: getAuthCooldownScope(reason),
    method: normalizedMethod,
    retryAtMs: Math.max(parseNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
  };
};

const buildProfileMethodCooldownDetails = ({
  method,
  profileId,
  retryAtMs,
}) => {
  const normalizedMethod = assertSupportedMethod(method);
  const normalizedProfileId = toCleanString(profileId);
  const reason = AUTH_COOLDOWN_REASONS.profileMethod;
  return {
    reason,
    scope: getAuthCooldownScope(reason),
    method: normalizedMethod,
    retryAtMs: Math.max(parseNumber(retryAtMs, 0), 0),
    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
    profileId: normalizedProfileId || null,
  };
};

const throwMethodReuseCooldownError = ({ method, retryAtMs }) => {
  throw new HttpsError(
    "failed-precondition",
    AUTH_COOLDOWN_REASONS.method,
    buildMethodReuseCooldownDetails({ method, retryAtMs }),
  );
};

const throwProfileMethodCooldownError = ({ method, profileId, retryAtMs }) => {
  throw new HttpsError(
    "failed-precondition",
    AUTH_COOLDOWN_REASONS.profileMethod,
    buildProfileMethodCooldownDetails({
      method,
      profileId,
      retryAtMs,
    }),
  );
};

const createOpId = () => crypto.randomBytes(16).toString("hex");
const createToken = (bytes = 18) =>
  crypto.randomBytes(bytes).toString("base64url");

const createSiweNonce = (length = 24) => {
  const targetLength =
    Number.isFinite(length) && length >= 8 ? Math.floor(length) : 24;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < targetLength; index += 1) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }
  return value;
};

const normalizeEth = (value) => {
  const input = toCleanString(value).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(input)) {
    throw new HttpsError("invalid-argument", "Invalid Ethereum address.");
  }
  return input;
};

const normalizeSol = (value) => {
  const input = toCleanString(value);
  if (input.length < 20 || input.length > 64) {
    throw new HttpsError("invalid-argument", "Invalid Solana address.");
  }
  return input;
};

const normalizeAppleSub = (value) => {
  const input = toCleanString(value);
  if (input.length < 6) {
    throw new HttpsError("invalid-argument", "Invalid Apple subject.");
  }
  return input;
};

const normalizeXUserId = (value) => {
  const input = toCleanString(value);
  if (!/^\d+$/.test(input)) {
    throw new HttpsError("invalid-argument", "Invalid X user id.");
  }
  return input;
};

const normalizeMethodValue = (method, value) => {
  if (method === "eth") {
    return normalizeEth(value);
  }
  if (method === "sol") {
    return normalizeSol(value);
  }
  if (method === "apple") {
    return normalizeAppleSub(value);
  }
  if (method === "x") {
    return normalizeXUserId(value);
  }
  throw new HttpsError("invalid-argument", "Unsupported auth method.");
};

const getMethodField = (method) => {
  const field = AUTH_METHOD_FIELD_BY_TYPE[method];
  if (!field) {
    throw new HttpsError("invalid-argument", "Unsupported auth method.");
  }
  return field;
};

const getMethodKey = (method, normalizedValue) => {
  return `${method}:${Buffer.from(normalizedValue, "utf8").toString("base64url")}`;
};

const hashMethodValue = (method, normalizedValue) => {
  const cleanValue = toCleanString(normalizedValue);
  if (!cleanValue) {
    return "";
  }
  return crypto
    .createHash("sha256")
    .update(`${method}:${cleanValue}`)
    .digest("hex");
};

const getMethodValueFromProfile = (profileData, method) => {
  const field = getMethodField(method);
  return toCleanString(profileData && profileData[field]);
};

const normalizeFromProfileByMethod = (method, profileData) => {
  const value = getMethodValueFromProfile(profileData, method);
  if (!value) {
    return "";
  }
  try {
    return normalizeMethodValue(method, value);
  } catch {
    return "";
  }
};

const linkedMethodsFromProfileData = (profileData) => ({
  apple: normalizeFromProfileByMethod("apple", profileData) !== "",
  eth: normalizeFromProfileByMethod("eth", profileData) !== "",
  sol: normalizeFromProfileByMethod("sol", profileData) !== "",
  x: normalizeFromProfileByMethod("x", profileData) !== "",
});

const linkedMethodCount = (profileData) => {
  const linked = linkedMethodsFromProfileData(profileData);
  return [linked.apple, linked.eth, linked.sol, linked.x].filter(Boolean)
    .length;
};

module.exports = {
  assertSupportedMethod,
  buildMethodReuseCooldownDetails,
  buildProfileMethodCooldownDetails,
  createOpId,
  createSiweNonce,
  createToken,
  getMethodField,
  getMethodKey,
  getMethodValueFromProfile,
  getProfileMethodCooldownDocId,
  hashMethodValue,
  isFeatureDisabled,
  linkedMethodCount,
  linkedMethodsFromProfileData,
  normalizeFromProfileByMethod,
  normalizeMethodValue,
  parseCooldownRetryAtMs,
  parseNumber,
  throwMethodReuseCooldownError,
  throwProfileMethodCooldownError,
  toCleanString,
};
