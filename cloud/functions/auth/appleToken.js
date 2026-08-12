const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  normalizeMethodValue,
  parseNumber,
  toCleanString,
} = require("./policy");

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const APPLE_JWKS_UNKNOWN_KID_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;
const APPLE_JWKS_RECENT_FETCH_WINDOW_MS = 5 * 1000;
let appleJwksCache = {
  fetchedAtMs: 0,
  keysByKid: new Map(),
};
let appleJwksFetchPromise = null;
let appleJwksLastUnknownKidRefreshAtMs = 0;

const getAppleAudiences = () => {
  const configured = toCleanString(process.env.APPLE_AUDIENCES);
  if (configured) {
    return configured
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "");
  }
  const fallback = toCleanString(process.env.APPLE_CLIENT_ID);
  if (fallback) {
    return [fallback];
  }
  return [];
};

const buildNonceHashes = (nonce) => {
  const digestBuffer = crypto.createHash("sha256").update(nonce).digest();
  const digestHex = digestBuffer.toString("hex");
  const digestBase64Url = digestBuffer.toString("base64url");
  return new Set([nonce, digestHex, digestBase64Url]);
};

const maskEmail = (value) => {
  const email = toCleanString(value);
  if (!email.includes("@")) {
    return null;
  }
  const [localPart, domain] = email.split("@");
  if (!domain) {
    return null;
  }
  if (!localPart) {
    return `***@${domain}`;
  }
  if (localPart.length === 1) {
    return `${localPart}***@${domain}`;
  }
  return `${localPart.slice(0, 1)}***${localPart.slice(-1)}@${domain}`;
};

const decodeJwtPart = (value) => {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpsError("invalid-argument", "Invalid JWT structure.");
  }
};

const readJwt = (token) => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpsError("invalid-argument", "Invalid JWT format.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  const signature = Buffer.from(encodedSignature, "base64url");
  const signedContent = `${encodedHeader}.${encodedPayload}`;
  return {
    header,
    payload,
    signature,
    signedContent,
  };
};

const fetchAppleJwks = async (options = {}) => {
  const forceRefresh = !!(options && options.forceRefresh);
  const nowMs = Date.now();
  if (
    !forceRefresh &&
    nowMs - appleJwksCache.fetchedAtMs < APPLE_JWKS_CACHE_MAX_AGE_MS &&
    appleJwksCache.keysByKid.size > 0
  ) {
    return appleJwksCache.keysByKid;
  }
  if (appleJwksFetchPromise) {
    return appleJwksFetchPromise;
  }
  appleJwksFetchPromise = (async () => {
    const fetchedAtMs = Date.now();
    const response = await fetch("https://appleid.apple.com/auth/keys");
    if (!response.ok) {
      throw new HttpsError("internal", "Failed to fetch Apple JWKS.");
    }
    const data = await response.json();
    const keys = Array.isArray(data && data.keys) ? data.keys : [];
    const keysByKid = new Map();
    keys.forEach((key) => {
      const kid = toCleanString(key && key.kid);
      if (kid) {
        keysByKid.set(kid, key);
      }
    });
    if (keysByKid.size === 0) {
      throw new HttpsError("internal", "Apple JWKS keyset is empty.");
    }
    appleJwksCache = {
      fetchedAtMs,
      keysByKid,
    };
    return keysByKid;
  })();
  try {
    return await appleJwksFetchPromise;
  } finally {
    appleJwksFetchPromise = null;
  }
};

const verifyAppleJwtSignature = async (idToken) => {
  const { header, payload, signature, signedContent } = readJwt(idToken);
  const algorithm = toCleanString(header.alg);
  const keyId = toCleanString(header.kid);
  if (algorithm !== "RS256" || !keyId) {
    throw new HttpsError(
      "permission-denied",
      "Unsupported Apple JWT algorithm.",
    );
  }
  let keysByKid = await fetchAppleJwks();
  let jwk = keysByKid.get(keyId);
  if (!jwk) {
    if (appleJwksFetchPromise) {
      keysByKid = await appleJwksFetchPromise;
      jwk = keysByKid.get(keyId);
    }
  }
  if (!jwk) {
    const nowMs = Date.now();
    const cacheWasFetchedRecently =
      nowMs - appleJwksCache.fetchedAtMs < APPLE_JWKS_RECENT_FETCH_WINDOW_MS;
    const canForceRefreshUnknownKid =
      !cacheWasFetchedRecently &&
      nowMs - appleJwksLastUnknownKidRefreshAtMs >=
        APPLE_JWKS_UNKNOWN_KID_FORCE_REFRESH_COOLDOWN_MS;
    if (canForceRefreshUnknownKid) {
      appleJwksLastUnknownKidRefreshAtMs = nowMs;
      keysByKid = await fetchAppleJwks({ forceRefresh: true });
      jwk = keysByKid.get(keyId);
    }
  }
  if (!jwk) {
    throw new HttpsError("permission-denied", "Unknown Apple JWT key id.");
  }
  let isValidSignature = false;
  try {
    const publicKey = crypto.createPublicKey({
      key: jwk,
      format: "jwk",
    });
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(signedContent);
    verifier.end();
    isValidSignature = verifier.verify(publicKey, signature);
  } catch {
    isValidSignature = false;
  }
  if (!isValidSignature) {
    throw new HttpsError("permission-denied", "Invalid Apple token signature.");
  }
  return payload;
};

const verifyAppleIdToken = async ({ idToken, expectedNonce }) => {
  const audiences = getAppleAudiences();
  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "APPLE_CLIENT_ID or APPLE_AUDIENCES is required.",
    );
  }
  const payload = await verifyAppleJwtSignature(idToken);
  const issuer = toCleanString(payload.iss);
  if (issuer !== APPLE_ISSUER) {
    throw new HttpsError("permission-denied", "apple-issuer-mismatch");
  }
  const audience = toCleanString(payload.aud);
  if (!audiences.includes(audience)) {
    throw new HttpsError("permission-denied", "apple-audience-mismatch");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = parseNumber(payload.exp, 0);
  if (!Number.isFinite(exp) || exp <= nowSeconds) {
    throw new HttpsError("permission-denied", "apple-token-expired");
  }
  const nonceClaim = toCleanString(payload.nonce);
  if (expectedNonce) {
    const acceptedNonces = buildNonceHashes(expectedNonce);
    if (!acceptedNonces.has(nonceClaim)) {
      throw new HttpsError("permission-denied", "apple-nonce-mismatch");
    }
  }
  const subject = normalizeMethodValue("apple", payload.sub);
  return {
    sub: subject,
    emailMasked: maskEmail(payload.email),
    emailVerified:
      payload.email_verified === true || payload.email_verified === "true",
  };
};

module.exports = {
  buildNonceHashes,
  getAppleAudiences,
  maskEmail,
  readJwt,
  verifyAppleIdToken,
};
