import assert from "node:assert/strict";
import test from "node:test";
import { base64url, SignJWT } from "jose";
import {
  buildSessionRefreshToken,
  buildSessionRevokeToken,
  isSessionCreateRequest,
  isSessionTokenResponse,
  parseSessionCapability,
} from "@mons/shared/session-auth";
import {
  issueSessionAccessToken,
  SESSION_TOKEN_AUDIENCE,
  SESSION_TOKEN_ISSUER,
  SESSION_TOKEN_TYPE,
  verifySessionRequest,
} from "../src/sessionAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const NOW_MS = 1_700_000_000_000;
const SESSION_ID = "00112233-4455-4677-8899-aabbccddeeff";
const UID = "a".repeat(28);
const SECRET = "A".repeat(43);
const REVOKE_SECRET = `${"B".repeat(42)}A`;
const env: Env = { ...TELEGRAM_TEST_ENV };
const session = { uid: UID, sessionId: SESSION_ID };
const request = (token: string) =>
  new Request("https://api.mons.link/auth/methods", {
    headers: { Authorization: `Bearer ${token}` },
  });

const unauthorized = (error: unknown) =>
  error instanceof Error && "status" in error && error.status === 401;

test("session capabilities are canonical and purpose separated", () => {
  const refresh = buildSessionRefreshToken(SESSION_ID, SECRET);
  const revoke = buildSessionRevokeToken(SESSION_ID, REVOKE_SECRET);
  assert.deepEqual(parseSessionCapability(refresh, "refresh"), {
    sessionId: SESSION_ID,
    secret: SECRET,
  });
  assert.deepEqual(parseSessionCapability(revoke, "revoke"), {
    sessionId: SESSION_ID,
    secret: REVOKE_SECRET,
  });
  assert.equal(parseSessionCapability(refresh, "revoke"), null);
  assert.equal(parseSessionCapability(revoke, "refresh"), null);
  assert.equal(parseSessionCapability(`${refresh}=`, "refresh"), null);
  assert.equal(
    parseSessionCapability(refresh.slice(0, -1) + "B", "refresh"),
    null,
  );
  assert.equal(
    isSessionCreateRequest({
      sessionId: SESSION_ID,
      refreshSecret: SECRET,
      revokeSecret: REVOKE_SECRET,
    }),
    true,
  );
  assert.equal(
    isSessionCreateRequest({
      sessionId: SESSION_ID,
      refreshSecret: SECRET,
      revokeSecret: SECRET,
    }),
    false,
  );
  assert.equal(
    isSessionCreateRequest({
      sessionId: SESSION_ID,
      refreshSecret: SECRET,
      revokeSecret: REVOKE_SECRET,
      uid: UID,
    }),
    false,
  );
});

test("issued access tokens preserve UID and verify on production and candidate hosts without D1", async () => {
  const response = await issueSessionAccessToken(session, env, NOW_MS);
  assert.equal(isSessionTokenResponse(response), true);
  assert.equal(response.accessExpiresAtMs, NOW_MS + 300_000);
  for (const url of [
    "https://api.mons.link/auth/methods",
    "https://preview.invalid/auth/methods",
    "http://localhost:8787/auth/methods",
  ]) {
    assert.deepEqual(
      await verifySessionRequest(
        new Request(url, { headers: request(response.accessToken).headers }),
        env,
        undefined,
        { now: () => NOW_MS },
      ),
      { uid: UID, sid: SESSION_ID, authExpiresAtMs: NOW_MS + 300_000 },
    );
  }
  await assert.rejects(
    verifySessionRequest(request(response.accessToken), env, undefined, {
      now: () => NOW_MS + 300_000,
    }),
    unauthorized,
  );
});

async function sign(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  return new SignJWT({
    sub: UID,
    sid: SESSION_ID,
    iss: SESSION_TOKEN_ISSUER,
    aud: SESSION_TOKEN_AUDIENCE,
    iat: NOW_MS / 1000,
    exp: NOW_MS / 1000 + 300,
    ...overrides,
  })
    .setProtectedHeader({
      alg: "HS256",
      kid: "test",
      typ: SESSION_TOKEN_TYPE,
      ...header,
    })
    .sign(base64url.decode(SECRET));
}

test("rejects forged, future, overlong and wrong-purpose access credentials", async () => {
  const invalidClaims = [
    { sub: "old-firebase-uid" },
    { sid: "invalid-session-id" },
    { iss: "https://securetoken.google.com/mons-link" },
    { aud: "mons-link" },
    { aud: [SESSION_TOKEN_AUDIENCE, "other"] },
    { iat: NOW_MS / 1000 + 1 },
    { iat: NOW_MS / 1000 - 1, exp: NOW_MS / 1000 + 300 },
    { exp: NOW_MS / 1000 },
    { exp: NOW_MS / 1000 + 300.5 },
    { sid: undefined },
    { iat: undefined },
    { exp: undefined },
  ];
  for (const claims of invalidClaims) {
    await assert.rejects(
      verifySessionRequest(request(await sign(claims)), env, undefined, {
        now: () => NOW_MS,
      }),
      unauthorized,
    );
  }
  for (const header of [{ kid: "unknown" }, { typ: "JWT" }]) {
    await assert.rejects(
      verifySessionRequest(request(await sign({}, header)), env, undefined, {
        now: () => NOW_MS,
      }),
      unauthorized,
    );
  }
  const valid = await sign();
  const forged = `${valid.slice(0, valid.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
  for (const token of [
    forged,
    buildSessionRefreshToken(SESSION_ID, SECRET),
    buildSessionRevokeToken(SESSION_ID, REVOKE_SECRET),
    "a".repeat(2049),
  ]) {
    await assert.rejects(
      verifySessionRequest(request(token), env, undefined, {
        now: () => NOW_MS,
      }),
      unauthorized,
    );
  }
});

test("key rotation retains known keys and missing or malformed keyrings fail closed", async () => {
  const response = await issueSessionAccessToken(session, env, NOW_MS);
  const rotated = {
    ...env,
    SESSION_JWT_KEYS: JSON.stringify({
      activeKid: "next",
      keys: { next: REVOKE_SECRET, test: SECRET },
    }),
  };
  assert.equal(
    (
      await verifySessionRequest(
        request(response.accessToken),
        rotated,
        undefined,
        { now: () => NOW_MS },
      )
    ).uid,
    UID,
  );
  const nextToken = await issueSessionAccessToken(session, rotated, NOW_MS);
  await assert.rejects(
    verifySessionRequest(request(nextToken.accessToken), env, undefined, {
      now: () => NOW_MS,
    }),
    unauthorized,
  );
  for (const value of [
    "",
    "{}",
    "not-json",
    JSON.stringify({ activeKid: "test", keys: { test: "short" } }),
  ]) {
    await assert.rejects(
      verifySessionRequest(
        request(response.accessToken),
        { ...env, SESSION_JWT_KEYS: value },
        undefined,
        { now: () => NOW_MS },
      ),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 503,
    );
  }
});
