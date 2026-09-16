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
const {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
} = await import("@mons/shared/session-bootstrap");
const { eventSnapshotEtag } = await import("@mons/shared/events");
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

test("optional bootstrap uses only validated query parameters on session create and refresh", async () => {
  const target = { inviteId: "game-a", selection: "approved" };
  const gameBootstrap = { ...target, result: { ok: false, status: 404 } };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return json({ ...response(), gameBootstrap });
  };
  for (const operation of [sessionApi.create, sessionApi.refresh]) {
    const result = await operation(session, target);
    assert.deepEqual(result.gameBootstrap, gameBootstrap);
    assert.equal(result.uid, response().uid);
  }
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(
      url.search,
      "?bootstrapInviteId=game-a&bootstrapSelection=approved",
    );
    assert.equal(url.href.includes(session.refreshSecret), false);
    assert.equal(url.href.includes(session.revokeSecret), false);
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: session.sessionId,
    refreshSecret: session.refreshSecret,
    revokeSecret: session.revokeSecret,
  });
  assert.equal(calls[1].options.body, undefined);
  assert.equal(new Headers(calls[1].options.headers).get("Content-Type"), null);
  await assert.rejects(
    sessionApi.create(session, { ...target, inviteId: "bad/invite" }),
    { code: "unavailable" },
  );
  assert.equal(calls.length, 2);
});

test("missing or malformed optional games preserve valid tokens while legacy validation stays strict", async () => {
  const target = { inviteId: "game-a", selection: "current" };
  for (const gameBootstrap of [
    undefined,
    null,
    {},
    { ...target, result: { ok: false, status: 401 } },
    { ...target, inviteId: "foreign", result: { ok: false, status: 404 } },
    { ...target, selection: "approved", result: { ok: false, status: 404 } },
    { ...target, result: { ok: false, status: 404, secret: "private" } },
  ]) {
    globalThis.fetch = async () =>
      json({
        ...response(),
        ...(gameBootstrap === undefined ? {} : { gameBootstrap }),
      });
    const result = await sessionApi.refresh(session, target);
    assert.equal(result.gameBootstrap, undefined);
    assert.equal(result.uid, response().uid);
  }
  globalThis.fetch = async () =>
    json({
      ...response(),
      gameBootstrap: { ...target, result: { ok: false, status: 404 } },
    });
  await assert.rejects(sessionApi.refresh(session), { code: "unavailable" });
  globalThis.fetch = async () =>
    json({ ...response(), secret: "private", gameBootstrap: null });
  await assert.rejects(sessionApi.refresh(session, target), {
    code: "unavailable",
  });
});

const eventSeed = (eventId = "event-a") => ({
  snapshot: {
    ok: true,
    eventId,
    revision: 1,
    event: { eventId, status: "scheduled" },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag(eventId, 1),
  bookmark: "mons-d1-v1:11111111-1111-4111-8111-111111111111:bookmark-1",
});

test("event-only bootstrap keeps session capabilities out of its query and validates its seed", async () => {
  const target = { eventId: "event-a" };
  const eventBootstrap = { ...target, result: eventSeed() };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return json({ ...response(), eventBootstrap });
  };
  for (const operation of [sessionApi.create, sessionApi.refresh]) {
    const result = await operation(session, target);
    assert.deepEqual(result.eventBootstrap, eventBootstrap);
    assert.equal(result.gameBootstrap, undefined);
    assert.equal(result.uid, response().uid);
  }
  for (const { url } of calls)
    assert.equal(new URL(url).search, "?bootstrapEventId=event-a");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: session.sessionId,
    refreshSecret: session.refreshSecret,
    revokeSecret: session.revokeSecret,
  });
  for (const invalid of [
    { eventId: "bad/event" },
    { ...target, inviteId: "game-a", selection: "current" },
  ])
    await assert.rejects(sessionApi.create(session, invalid), {
      code: "unavailable",
    });
  assert.equal(calls.length, 2);
});

test("event enrichment failures and malformed optional data preserve the session token", async () => {
  const target = { eventId: "event-a" };
  for (const eventBootstrap of [
    undefined,
    null,
    {},
    { eventId: "other", result: eventSeed("other") },
    { ...target, result: { ...eventSeed(), etag: "wrong" } },
    { ...target, result: { ...eventSeed(), bookmark: "unscoped" } },
  ]) {
    globalThis.fetch = async () =>
      json({
        ...response(),
        ...(eventBootstrap === undefined ? {} : { eventBootstrap }),
      });
    const result = await sessionApi.refresh(session, target);
    assert.equal(result.eventBootstrap, undefined);
    assert.equal(result.uid, response().uid);
  }
  const eventBootstrap = { ...target, result: { ok: false, status: 503 } };
  globalThis.fetch = async () => json({ ...response(), eventBootstrap });
  assert.deepEqual(
    (await sessionApi.refresh(session, target)).eventBootstrap,
    eventBootstrap,
  );
  await assert.rejects(sessionApi.refresh(session), { code: "unavailable" });
  globalThis.fetch = async () =>
    json({ ...response(), eventBootstrap, gameBootstrap: null });
  await assert.rejects(sessionApi.refresh(session, target), {
    code: "unavailable",
  });
});

test("event bootstrap has a separate bounded response budget", async () => {
  const target = { eventId: "event-a" };
  const seed = eventSeed();
  seed.snapshot.event.description = "a".repeat(64 * 1024);
  globalThis.fetch = async () =>
    json({ ...response(), eventBootstrap: { ...target, result: seed } });
  assert.deepEqual(
    (await sessionApi.refresh(session, target)).eventBootstrap.result,
    seed,
  );
  let canceled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new Uint8Array(SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES + 1),
          );
        },
        cancel() {
          canceled = true;
        },
      }),
    );
  await assert.rejects(sessionApi.refresh(session, target), {
    code: "unavailable",
  });
  assert.equal(canceled, true);
});

test("combined responses accept a validated game larger than the legacy token response cap", async () => {
  const target = { inviteId: "game-a", selection: "current" };
  const match = (color) => ({
    version: 2,
    color,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "a".repeat(9000),
    status: "",
    flatMovesString: "",
    timer: "",
  });
  const result = {
    ok: true,
    schemaVersion: 1,
    hasPendingProposal: false,
    metadata: {
      inviteId: target.inviteId,
      revision: 1,
      hostId: "host",
      guestId: "guest",
      hostColor: "white",
      hostRematches: "",
      guestRematches: "",
      automatchStateHint: null,
      eventId: null,
      eventOwned: false,
    },
    viewer: { role: "watch", actorUid: null, automatchOperationId: null },
    match: {
      inviteId: target.inviteId,
      matchId: target.inviteId,
      revision: 1,
      hostPlayerId: "host",
      guestPlayerId: "guest",
      hostMatch: match("white"),
      guestMatch: match("black"),
    },
  };
  const gameBootstrap = { ...target, result };
  const payload = { ...response(), gameBootstrap };
  assert.ok(JSON.stringify(payload).length > 16_384);
  globalThis.fetch = async () => json(payload);
  assert.deepEqual(
    (await sessionApi.refresh(session, target)).gameBootstrap,
    gameBootstrap,
  );
});

test("combined response size is bounded and its single deadline spans network and body", async (t) => {
  const target = { inviteId: "game-a", selection: "current" };
  let canceled = 0;
  for (const headers of [
    { "Content-Length": String(SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES + 1) },
    {},
  ]) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES + 1),
            );
          },
          cancel() {
            canceled++;
          },
        }),
        { headers },
      );
    await assert.rejects(sessionApi.refresh(session, target), {
      code: "unavailable",
    });
  }
  assert.equal(canceled, 2);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveNetwork;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveNetwork = resolve;
    });
  const pending = sessionApi.refresh(session, target);
  const rejected = assert.rejects(pending, { code: "unavailable" });
  t.mock.timers.tick(20_000);
  resolveNetwork(
    new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    ),
  );
  await new Promise(setImmediate);
  t.mock.timers.tick(SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS - 20_000);
  await rejected;
  assert.equal(canceled, 3);
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
