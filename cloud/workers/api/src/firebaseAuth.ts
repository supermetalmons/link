import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { AuthApiFailure } from "./authErrors.ts";

const FIREBASE_PROJECT_ID = "mons-link";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIREBASE_JWKS_MAX_BYTES = 64 * 1024;
const FIREBASE_TOKEN_MAX_BYTES = 8 * 1024;
const FIREBASE_KEYS_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_SECONDS = 5;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_FETCHED_AT_HEADER = "X-Firebase-JWKS-Fetched-At";

class FirebaseKeysFailure extends Error {}

export type FirebaseIdentity = {
  idToken: string;
  profileId?: string;
  uid: string;
};

export type FirebaseAuthDependencies = {
  cache?: Cache | null;
  fetcher?: typeof fetch;
  now?: () => number;
};

export type WorkerExecutionContext = Pick<ExecutionContext, "waitUntil">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  return (
    isRecord(value) &&
    Array.isArray(value.keys) &&
    value.keys.length > 0 &&
    value.keys.length <= 32 &&
    value.keys.every(
      (key) =>
        isRecord(key) &&
        key.kty === "RSA" &&
        typeof key.kid === "string" &&
        typeof key.n === "string" &&
        typeof key.e === "string",
    )
  );
}

async function resolveCache(
  dependencies: FirebaseAuthDependencies,
): Promise<Cache | null> {
  if (dependencies.cache !== undefined) {
    return dependencies.cache;
  }
  return typeof caches === "undefined"
    ? null
    : caches.open("firebase-auth-jwks");
}

async function parseJwksResponse(response: Response): Promise<JSONWebKeySet> {
  const value = await readBoundedJsonValue(
    response,
    FIREBASE_JWKS_MAX_BYTES,
    () => new FirebaseKeysFailure(),
  );
  if (!isJsonWebKeySet(value)) {
    throw new FirebaseKeysFailure();
  }
  return value;
}

function cacheMaxAge(response: Response): number {
  const match = (response.headers.get("Cache-Control") || "").match(
    /(?:^|,)\s*max-age=(\d+)/i,
  );
  const parsed = match ? Number(match[1]) : 3_600;
  return Math.max(
    0,
    Math.min(Number.isFinite(parsed) ? parsed : 3_600, 21_600),
  );
}

function hasMatchingKid(jwks: JSONWebKeySet, kid: string): boolean {
  return jwks.keys.some((key) => key.kid === kid);
}

async function fetchJwks(
  dependencies: FirebaseAuthDependencies,
): Promise<{ jwks: JSONWebKeySet; maxAge: number }> {
  let response: Response;
  try {
    response = await (dependencies.fetcher || fetch)(FIREBASE_JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FIREBASE_KEYS_TIMEOUT_MS),
    });
  } catch {
    throw new FirebaseKeysFailure();
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new FirebaseKeysFailure();
  }
  const maxAge = cacheMaxAge(response);
  return { jwks: await parseJwksResponse(response), maxAge };
}

async function loadFirebaseJwks(
  ctx: WorkerExecutionContext,
  dependencies: FirebaseAuthDependencies,
  expectedKid: string,
): Promise<JSONWebKeySet> {
  const cache = await resolveCache(dependencies);
  const cacheKey = new Request(FIREBASE_JWKS_URL, { method: "GET" });
  const nowMs = (dependencies.now || Date.now)();
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        const fetchedAtMs = Number(cached.headers.get(JWKS_FETCHED_AT_HEADER));
        const jwks = await parseJwksResponse(cached);
        if (
          hasMatchingKid(jwks, expectedKid) ||
          (Number.isFinite(fetchedAtMs) &&
            nowMs - fetchedAtMs < JWKS_REFRESH_COOLDOWN_MS)
        ) {
          return jwks;
        }
      } catch {
        ctx.waitUntil(cache.delete(cacheKey).then(() => undefined));
      }
    }
  }

  const { jwks, maxAge } = await fetchJwks(dependencies);
  if (cache && maxAge > 0) {
    ctx.waitUntil(
      cache
        .put(
          cacheKey,
          new Response(JSON.stringify(jwks), {
            headers: {
              "Cache-Control": `public, max-age=${maxAge}`,
              "Content-Type": "application/json",
              [JWKS_FETCHED_AT_HEADER]: String(nowMs),
            },
          }),
        )
        .catch(() => undefined),
    );
  }
  return jwks;
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.length > FIREBASE_TOKEN_MAX_BYTES + 7) {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  const token = match?.[1] || "";
  if (!token || token.length > FIREBASE_TOKEN_MAX_BYTES) {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  }
  return token;
}

function readProfileIdClaim(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const profileId = value.trim();
  const hasControlCharacter = Array.from(profileId).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (
    !profileId ||
    new TextEncoder().encode(profileId).byteLength > 1_500 ||
    hasControlCharacter
  ) {
    return undefined;
  }
  return profileId;
}

export async function verifyFirebaseRequest(
  request: Request,
  ctx: WorkerExecutionContext,
  dependencies: FirebaseAuthDependencies = {},
): Promise<FirebaseIdentity> {
  const idToken = readBearerToken(request);
  let expectedKid: string;
  try {
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new Error("invalid-header");
    }
    expectedKid = header.kid;
  } catch {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  }
  let jwks: JSONWebKeySet;
  try {
    jwks = await loadFirebaseJwks(ctx, dependencies, expectedKid);
  } catch {
    throw new AuthApiFailure(503, "unavailable", "firebase-auth-unavailable");
  }

  const nowMs = (dependencies.now || Date.now)();
  const nowSeconds = Math.floor(nowMs / 1_000);
  try {
    const { payload, protectedHeader } = await jwtVerify(
      idToken,
      createLocalJWKSet(jwks),
      {
        algorithms: ["RS256"],
        audience: FIREBASE_PROJECT_ID,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(nowMs),
        issuer: FIREBASE_ISSUER,
        requiredClaims: ["auth_time", "exp", "iat", "sub"],
      },
    );
    const uid = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const authTime = payload.auth_time;
    if (
      protectedHeader.alg !== "RS256" ||
      typeof protectedHeader.kid !== "string" ||
      !uid ||
      Array.from(uid).length > 128 ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds - CLOCK_TOLERANCE_SECONDS ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      typeof authTime !== "number" ||
      authTime > nowSeconds + CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error("invalid-token");
    }
    const profileId = readProfileIdClaim(payload.profileId);
    return { idToken, uid, ...(profileId ? { profileId } : {}) };
  } catch {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  }
}

export { readProfileIdClaim };
