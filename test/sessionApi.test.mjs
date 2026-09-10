import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { sessionApi, SessionApiError } =
  await import("../src/services/sessionApi.ts");
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
});

const session = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  refreshSecret: "A".repeat(43),
  revokeSecret: `${"B".repeat(42)}A`,
  uid: null,
};
const response = (
  issuedAt = Math.floor(originalDateNow() / 1000),
  lifetime = 300,
) => ({
  ok: true,
  sessionId: session.sessionId,
  uid: "m".repeat(28),
  accessToken: `header.${Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + lifetime })).toString("base64url")}.signature`,
  accessExpiresAtMs: (issuedAt + lifetime) * 1000,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("session endpoints send exact independent capabilities without ambient cookies", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/logout")
      ? new Response(null, { status: 204 })
      : json(response());
  };
  await sessionApi.create(session);
  await sessionApi.refresh({ ...session, uid: "m".repeat(28) });
  await sessionApi.revoke(session);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.mons.link/auth/session/anonymous",
      "https://api.mons.link/auth/session/refresh",
      "https://api.mons.link/auth/session/logout",
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: session.sessionId,
    refreshSecret: session.refreshSecret,
    revokeSecret: session.revokeSecret,
  });
  assert.equal(
    new Headers(calls[1].options.headers).get("Authorization"),
    `Bearer mrs1.${session.sessionId}.${session.refreshSecret}`,
  );
  assert.equal(
    new Headers(calls[2].options.headers).get("Authorization"),
    `Bearer mrv1.${session.sessionId}.${session.revokeSecret}`,
  );
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.redirect, "error");
  }
});

test("logout only acknowledges the exact 204 response contract", async () => {
  for (const status of [200, 202]) {
    globalThis.fetch = async () => new Response("unexpected", { status });
    await assert.rejects(
      sessionApi.revoke(session),
      (error) => error.code === "unavailable",
    );
  }
});

test("revocation is distinguished from unavailable service and errors never echo credentials", async () => {
  for (const status of [401, 503]) {
    globalThis.fetch = async () =>
      json({ message: session.refreshSecret }, status);
    await assert.rejects(
      sessionApi.refresh(session),
      (error) =>
        error instanceof SessionApiError &&
        error.code === (status === 401 ? "session-revoked" : "unavailable") &&
        !error.message.includes(session.refreshSecret),
    );
  }
  globalThis.fetch = async () => {
    throw new Error(session.refreshSecret);
  };
  await assert.rejects(
    sessionApi.create(session),
    (error) =>
      error.code === "unavailable" &&
      !error.message.includes(session.refreshSecret),
  );
});

test("session response validation rejects another session, malformed identities, and oversized bodies", async () => {
  for (const value of [
    { ...response(), sessionId: crypto.randomUUID() },
    { ...response(), uid: "legacy-user" },
    { ...response(), accessToken: "invalid" },
    { ...response(), accessExpiresAtMs: 1 },
    response(Math.floor(originalDateNow() / 1000), 301),
    response(Math.floor(originalDateNow() / 1000), 0),
    { ...response(), extra: "field" },
    { data: "x".repeat(20_000) },
  ]) {
    globalThis.fetch = async () => json(value);
    await assert.rejects(
      sessionApi.create(session),
      (error) => error.code === "unavailable",
    );
  }
});

test("creation and refresh use conservative request-relative deadlines with either client clock skew", async () => {
  for (const skew of [-600_000, 600_000]) {
    const serverResponse = response();
    Date.now = () => originalDateNow() + skew;
    globalThis.fetch = async () => json(serverResponse);
    for (const operation of [sessionApi.create, sessionApi.refresh]) {
      const before = performance.now();
      const result = await operation(session);
      const after = performance.now();
      assert.equal(result.accessExpiresAtMs, serverResponse.accessExpiresAtMs);
      assert.ok(result.accessDeadlineMs >= before + 299_000);
      assert.ok(result.accessDeadlineMs <= after + 299_000);
      assert.ok(result.accessDeadlineMs - after > 298_000);
    }
  }
});

test("network and body time consume token lifetime without depending on later wall-clock changes", async (t) => {
  let elapsed = 1000;
  t.mock.method(performance, "now", () => elapsed);
  globalThis.fetch = async () => {
    elapsed += 12_000;
    Date.now = () => originalDateNow() + 600_000;
    return json(response());
  };
  const result = await sessionApi.create(session);
  assert.equal(result.accessDeadlineMs, 300_000);
  assert.equal(result.accessDeadlineMs - performance.now(), 287_000);
});
