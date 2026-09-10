import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionRefreshToken,
  buildSessionRevokeToken,
  isSessionTokenResponse,
  type SessionCreateRequest,
} from "@mons/shared/session-auth";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleRequest } from "../src/router.ts";
import type { SessionRepository } from "../src/sessionD1.ts";
import { handleSessionRoute } from "../src/sessionRoutes.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const NOW_MS = 1_700_000_000_000;
const input: SessionCreateRequest = {
  sessionId: "00112233-4455-4677-8899-aabbccddeeff",
  refreshSecret: "A".repeat(43),
  revokeSecret: `${"B".repeat(42)}A`,
};
const stored = { uid: "a".repeat(28), sessionId: input.sessionId };
const env: Env = { ...TELEGRAM_TEST_ENV };

function request(
  path: string,
  body?: unknown,
  token?: string,
  origin = "https://mons.link",
) {
  return new Request(`https://api.mons.link/auth/session/${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function repository(
  overrides: Partial<SessionRepository> = {},
): SessionRepository {
  return {
    create: async () => stored,
    refresh: async () => stored,
    revoke: async () => undefined,
    ...overrides,
  };
}

test("router creates sessions without prior authentication and returns no long-lived secrets", async () => {
  for (const origin of [
    "https://mons.link",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://8bdf84df-mons-link.lil-org.workers.dev",
  ]) {
    const response = await handleRequest(
      request("anonymous", input, undefined, origin),
      env,
      {
        session: {
          now: () => NOW_MS,
          repository: repository({
            create: async (received, now) => {
              assert.deepEqual(received, input);
              assert.equal(now, NOW_MS);
              return stored;
            },
          }),
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(isSessionTokenResponse(body), true);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(input.refreshSecret));
    assert.doesNotMatch(JSON.stringify(body), new RegExp(input.revokeSecret));
  }
});

test("refresh and logout enforce independent capability purposes", async () => {
  const refresh = buildSessionRefreshToken(
    input.sessionId,
    input.refreshSecret,
  );
  const revoke = buildSessionRevokeToken(input.sessionId, input.revokeSecret);
  let refreshes = 0;
  let revocations = 0;
  const dependencies = {
    now: () => NOW_MS,
    repository: repository({
      refresh: async () => {
        refreshes++;
        return stored;
      },
      revoke: async () => {
        revocations++;
      },
    }),
  };
  assert.equal(
    (
      await handleSessionRoute(
        request("refresh", undefined, refresh),
        env,
        dependencies,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleSessionRoute(
        request("logout", undefined, revoke),
        env,
        dependencies,
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await handleSessionRoute(
        request("refresh", undefined, revoke),
        env,
        dependencies,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleSessionRoute(
        request("logout", undefined, refresh),
        env,
        dependencies,
      )
    ).status,
    401,
  );
  assert.equal(refreshes, 1);
  assert.equal(revocations, 1);
});

test("invalid requests, revoked sessions, unavailable D1 and disallowed origins remain distinct", async () => {
  let creates = 0;
  const dependencies = {
    repository: repository({
      create: async () => {
        creates++;
        return stored;
      },
    }),
  };
  for (const body of [
    { ...input, uid: "chosen-uid" },
    { ...input, revokeSecret: input.refreshSecret },
    { ...input, refreshSecret: `${input.refreshSecret}=` },
    { ...input, sessionId: "bad" },
    { ...input, padding: "x".repeat(2048) },
  ]) {
    assert.equal(
      (await handleSessionRoute(request("anonymous", body), env, dependencies))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await handleSessionRoute(
        request("anonymous", input, undefined, "https://attacker.invalid"),
        env,
        dependencies,
      )
    ).status,
    403,
  );
  assert.equal(creates, 0);
  const token = buildSessionRefreshToken(input.sessionId, input.refreshSecret);
  const revoked = await handleSessionRoute(
    request("refresh", undefined, token),
    env,
    {
      repository: repository({
        refresh: async () => {
          throw new AuthApiFailure(401, "unauthenticated", "session-revoked");
        },
      }),
    },
  );
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), {
    ok: false,
    error: "unauthenticated",
    message: "session-revoked",
  });
  const failed = await handleSessionRoute(
    request("refresh", undefined, token),
    env,
    {
      repository: repository({
        refresh: async () => {
          throw new Error("database unavailable");
        },
      }),
    },
  );
  assert.equal(failed.status, 503);
});

test("session endpoints preflight without D1 and rate limit before writes", async () => {
  const preflight = await handleSessionRoute(
    new Request("https://api.mons.link/auth/session/anonymous", {
      method: "OPTIONS",
      headers: { Origin: "https://mons.link" },
    }),
    env,
  );
  assert.equal(preflight.status, 204);
  let touched = false;
  const limited = await handleSessionRoute(
    request("anonymous", input),
    { ...env, AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    {
      repository: repository({
        create: async () => {
          touched = true;
          return stored;
        },
      }),
    },
  );
  assert.equal(limited.status, 429);
  assert.equal(touched, false);
});

test("creation requires JSON and logout tombstones share the same IP allocation bucket", async () => {
  const keys: string[] = [];
  const environment = {
    ...env,
    AUTH_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    },
  };
  const dependencies = { now: () => NOW_MS, repository: repository() };
  const plain = request("anonymous", input);
  plain.headers.set("Content-Type", "text/plain");
  assert.equal(
    (await handleSessionRoute(plain, environment, dependencies)).status,
    400,
  );
  keys.length = 0;
  const creation = request("anonymous", input);
  creation.headers.set("CF-Connecting-IP", "203.0.113.1");
  await handleSessionRoute(creation, environment, dependencies);
  for (const sessionId of [
    input.sessionId,
    "ffeeddcc-bbaa-4998-8776-554433221100",
  ]) {
    const logout = request(
      "logout",
      undefined,
      buildSessionRevokeToken(sessionId, input.revokeSecret),
    );
    logout.headers.set("CF-Connecting-IP", "203.0.113.1");
    assert.equal(
      (await handleSessionRoute(logout, environment, dependencies)).status,
      204,
    );
  }
  assert.deepEqual(keys, Array(3).fill("session:allocate:ip:203.0.113.1"));
});
