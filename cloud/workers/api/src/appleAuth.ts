import {
  base64url,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { cancelResponseBody, readBoundedJsonValue } from "./boundedStreams.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { cleanString, normalizeMethodValue } from "./authPolicy.ts";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_JWKS_MAX_BYTES = 64 * 1024;
const APPLE_JWKS_TIMEOUT_MS = 5_000;
const APPLE_CACHE_SECONDS = 3_600;
const APPLE_JWKS_REFRESH_COOLDOWN_MS = 60_000;
const APPLE_JWKS_FETCHED_AT_HEADER = "X-Mons-JWKS-Fetched-At";

export type AppleTokenPayload = {
  emailMasked: string | null;
  sub: string;
};

type AppleAuthDependencies = {
  cache?: Cache | null;
  fetcher?: typeof fetch;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJwks(value: unknown): value is JSONWebKeySet {
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

async function parseJwks(response: Response): Promise<JSONWebKeySet> {
  const value = await readBoundedJsonValue(
    response,
    APPLE_JWKS_MAX_BYTES,
    () => new AuthApiFailure(503, "unavailable", "apple-auth-unavailable"),
  );
  if (!isJwks(value)) {
    throw new AuthApiFailure(503, "unavailable", "apple-auth-unavailable");
  }
  return value;
}

async function resolveCache(
  dependencies: AppleAuthDependencies,
): Promise<Cache | null> {
  if (dependencies.cache !== undefined) {
    return dependencies.cache;
  }
  return typeof caches === "undefined" ? null : caches.open("apple-auth-jwks");
}

async function fetchJwks(
  dependencies: AppleAuthDependencies,
): Promise<JSONWebKeySet> {
  let response: Response;
  try {
    response = await (dependencies.fetcher || fetch)(APPLE_JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(APPLE_JWKS_TIMEOUT_MS),
    });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "apple-auth-unavailable");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new AuthApiFailure(503, "unavailable", "apple-auth-unavailable");
  }
  return parseJwks(response);
}

async function loadJwks(
  expectedKid: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  dependencies: AppleAuthDependencies,
): Promise<JSONWebKeySet> {
  const cache = await resolveCache(dependencies);
  const key = new Request(APPLE_JWKS_URL);
  const nowMs = (dependencies.now || Date.now)();
  if (cache) {
    const cached = await cache.match(key);
    if (cached) {
      try {
        const jwks = await parseJwks(cached);
        const fetchedAtMs = Number(
          cached.headers.get(APPLE_JWKS_FETCHED_AT_HEADER),
        );
        if (
          jwks.keys.some((candidate) => candidate.kid === expectedKid) ||
          (Number.isFinite(fetchedAtMs) &&
            nowMs - fetchedAtMs < APPLE_JWKS_REFRESH_COOLDOWN_MS)
        ) {
          return jwks;
        }
      } catch {
        ctx.waitUntil(cache.delete(key).then(() => undefined));
      }
    }
  }
  const jwks = await fetchJwks(dependencies);
  if (cache) {
    ctx.waitUntil(
      cache
        .put(
          key,
          new Response(JSON.stringify(jwks), {
            headers: {
              "Cache-Control": `public, max-age=${APPLE_CACHE_SECONDS}`,
              "Content-Type": "application/json",
              [APPLE_JWKS_FETCHED_AT_HEADER]: String(nowMs),
            },
          }),
        )
        .catch(() => undefined),
    );
  }
  return jwks;
}

function maskEmail(value: unknown): string | null {
  const email = cleanString(value);
  const separator = email.lastIndexOf("@");
  if (separator < 0) {
    return null;
  }
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (!domain) {
    return null;
  }
  if (!local) {
    return `***@${domain}`;
  }
  if (local.length === 1) {
    return `${local}***@${domain}`;
  }
  return `${local[0]}***${local.at(-1)}@${domain}`;
}

async function acceptedNonces(nonce: string): Promise<Set<string>> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)),
  );
  return new Set([
    nonce,
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    base64url.encode(digest),
  ]);
}

export async function verifyAppleIdToken(
  idToken: string,
  expectedNonce: string,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  dependencies: AppleAuthDependencies = {},
): Promise<AppleTokenPayload> {
  let kid: string;
  try {
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new Error("invalid-header");
    }
    kid = header.kid;
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "Invalid JWT format.");
  }
  const audiences = env.APPLE_AUDIENCES.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (audiences.length === 0) {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "APPLE_AUDIENCES is required.",
    );
  }
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    const jwks = await loadJwks(kid, ctx, dependencies);
    if (!jwks.keys.some((candidate) => candidate.kid === kid)) {
      throw new AuthApiFailure(
        403,
        "permission-denied",
        "Unknown Apple JWT key id.",
      );
    }
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      algorithms: ["RS256"],
      audience: audiences,
      issuer: APPLE_ISSUER,
      currentDate: new Date((dependencies.now || Date.now)()),
      requiredClaims: ["exp", "sub"],
    }));
  } catch (error) {
    if (error instanceof AuthApiFailure) {
      throw error;
    }
    const failure = isRecord(error) ? error : {};
    if (failure.code === "ERR_JWT_EXPIRED") {
      throw new AuthApiFailure(403, "permission-denied", "apple-token-expired");
    }
    if (failure.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      if (failure.claim === "iss") {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "apple-issuer-mismatch",
        );
      }
      if (failure.claim === "aud") {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "apple-audience-mismatch",
        );
      }
    }
    throw new AuthApiFailure(
      403,
      "permission-denied",
      "Invalid Apple token signature.",
    );
  }
  const nonce = cleanString(payload.nonce);
  if (!(await acceptedNonces(expectedNonce)).has(nonce)) {
    throw new AuthApiFailure(403, "permission-denied", "apple-nonce-mismatch");
  }
  return {
    sub: normalizeMethodValue("apple", payload.sub),
    emailMasked: maskEmail(payload.email),
  };
}

export { acceptedNonces, maskEmail };
