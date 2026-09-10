import { base64url, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import {
  isSessionId,
  isSessionSecret,
  SESSION_ACCESS_TOKEN_TTL_SECONDS,
  type SessionTokenResponse,
} from "@mons/shared/session-auth";
import { AuthApiFailure } from "./authErrors.ts";
import type { StoredSession } from "./sessionD1.ts";

export type WorkerExecutionContext = Pick<ExecutionContext, "waitUntil">;
export type SessionIdentity = {
  uid: string;
  sid: string;
  authExpiresAtMs: number;
};
export type SessionAuthDependencies = { now?: () => number };

export const SESSION_TOKEN_ISSUER = "https://api.mons.link/auth/session";
export const SESSION_TOKEN_AUDIENCE = "mons-link-api";
export const SESSION_TOKEN_TYPE = "mons-session+jwt";
const MAX_ACCESS_TOKEN_BYTES = 2048;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type SessionKeyring = { activeKid: string; keys: Map<string, Uint8Array> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthenticated(): AuthApiFailure {
  return new AuthApiFailure(401, "unauthenticated", "authentication-required");
}

function keyring(env: Pick<Env, "SESSION_JWT_KEYS">): SessionKeyring {
  try {
    if (
      typeof env.SESSION_JWT_KEYS !== "string" ||
      env.SESSION_JWT_KEYS.length > 4096
    ) {
      throw new Error("invalid-session-keys");
    }
    const value: unknown = JSON.parse(env.SESSION_JWT_KEYS);
    if (
      !record(value) ||
      typeof value.activeKid !== "string" ||
      !KID_PATTERN.test(value.activeKid) ||
      !record(value.keys)
    ) {
      throw new Error("invalid-session-keys");
    }
    const entries = Object.entries(value.keys);
    if (entries.length === 0 || entries.length > 4)
      throw new Error("invalid-session-keys");
    const keys = new Map<string, Uint8Array>();
    for (const [kid, secret] of entries) {
      if (!KID_PATTERN.test(kid) || !isSessionSecret(secret))
        throw new Error("invalid-session-keys");
      keys.set(kid, base64url.decode(secret));
    }
    if (!keys.has(value.activeKid)) throw new Error("invalid-session-keys");
    return { activeKid: value.activeKid, keys };
  } catch {
    throw new AuthApiFailure(503, "unavailable", "session-auth-unavailable");
  }
}

export async function issueSessionAccessToken(
  session: StoredSession,
  env: Pick<Env, "SESSION_JWT_KEYS">,
  issuedAtMs: number,
): Promise<SessionTokenResponse> {
  const issuedAt = Math.floor(issuedAtMs / 1000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    !/^[A-Za-z0-9]{28}$/.test(session.uid) ||
    !isSessionId(session.sessionId)
  ) {
    throw new Error("invalid-session");
  }
  const expiration = issuedAt + SESSION_ACCESS_TOKEN_TTL_SECONDS;
  const configured = keyring(env);
  const accessToken = await new SignJWT({ sid: session.sessionId })
    .setProtectedHeader({
      alg: "HS256",
      kid: configured.activeKid,
      typ: SESSION_TOKEN_TYPE,
    })
    .setIssuer(SESSION_TOKEN_ISSUER)
    .setAudience(SESSION_TOKEN_AUDIENCE)
    .setSubject(session.uid)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiration)
    .sign(configured.keys.get(configured.activeKid)!);
  return {
    ok: true,
    uid: session.uid,
    sessionId: session.sessionId,
    accessToken,
    accessExpiresAtMs: expiration * 1000,
  };
}

export async function verifySessionRequest(
  request: Request,
  env: Env,
  _ctx?: WorkerExecutionContext,
  dependencies: SessionAuthDependencies = {},
): Promise<SessionIdentity> {
  const authorization = request.headers.get("Authorization") || "";
  if (authorization.length > MAX_ACCESS_TOKEN_BYTES + 7)
    throw unauthenticated();
  const token = authorization.match(
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
  )?.[1];
  if (!token) throw unauthenticated();
  let kid: string;
  try {
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== "HS256" ||
      header.typ !== SESSION_TOKEN_TYPE ||
      typeof header.kid !== "string" ||
      !KID_PATTERN.test(header.kid)
    )
      throw unauthenticated();
    kid = header.kid;
  } catch {
    throw unauthenticated();
  }
  const key = keyring(env).keys.get(kid);
  if (!key) throw unauthenticated();
  const nowMs = (dependencies.now || Date.now)();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: SESSION_TOKEN_ISSUER,
      audience: SESSION_TOKEN_AUDIENCE,
      typ: SESSION_TOKEN_TYPE,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
      requiredClaims: ["sub", "sid", "iat", "exp"],
    });
    const { sub, sid, iat, exp } = payload;
    if (
      payload.aud !== SESSION_TOKEN_AUDIENCE ||
      typeof sub !== "string" ||
      !/^[A-Za-z0-9]{28}$/.test(sub) ||
      !isSessionId(sid) ||
      typeof iat !== "number" ||
      !Number.isSafeInteger(iat) ||
      iat <= 0 ||
      iat > Math.floor(nowMs / 1000) ||
      typeof exp !== "number" ||
      !Number.isSafeInteger(exp) ||
      exp <= iat ||
      exp - iat > SESSION_ACCESS_TOKEN_TTL_SECONDS ||
      exp * 1000 <= nowMs
    ) {
      throw unauthenticated();
    }
    return { uid: sub, sid, authExpiresAtMs: exp * 1000 };
  } catch {
    throw unauthenticated();
  }
}
