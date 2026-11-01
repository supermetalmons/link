import { applicationRequest } from "./testEnv.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { handleFetch, handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

type Overrides = NonNullable<Parameters<typeof handleRequest>[2]>;

const env = new Proxy(TELEGRAM_TEST_ENV, {
  get(_target, property) {
    if (property === "PROFILE_GAMES_DB")
      return TELEGRAM_TEST_ENV.PROFILE_GAMES_DB;
    return assert.fail(`Unexpected binding: ${String(property)}`);
  },
});

const ctx: ExecutionContext = {
  waitUntil: () => assert.fail("Unexpected background work"),
  passThroughOnException: () => assert.fail("Unexpected exception passthrough"),
  get exports() {
    return assert.fail("Unexpected context exports");
  },
  props: undefined,
  get tracing() {
    return assert.fail("Unexpected tracing");
  },
  abort: () => assert.fail("Unexpected context abort"),
};

const contextRoutes: { path: string; override?: keyof Overrides }[] = [
  { path: "/invites/invite-1/bootstrap", override: "gameBootstrap" },
  { path: "/invites/invite-1/matches/match-1/snapshot", override: "matchSync" },
  { path: "/invites/invite-1/wagers", override: "wagers" },
  { path: "/invites/invite-1/metadata", override: "metadata" },
  {
    path: "/invites/invite-1/matches/invite-1/presentation",
    override: "presentation",
  },
  { path: "/invites/invite-1/reactions", override: "reactions" },
  { path: "/events/snapshot" },
  { path: "/events/prizes" },
  { path: "/auth/identity", override: "auth" },
  { path: "/automatch/start", override: "gameplay" },
  { path: "/profiles/lookup", override: "profile" },
  { path: "/events/create" },
  { path: "/events/prizes/withdrawals" },
  { path: "/events/prizes/withdrawals/status" },
  { path: "/mining/rock", override: "mining" },
];

test("retired migration paths are not routed and do not inspect credentials or stores", async () => {
  const unavailableEnv = new Proxy(TELEGRAM_TEST_ENV, {
    get: () =>
      assert.fail("Retired migration route accessed an environment binding"),
  });
  for (const path of [
    "/internal/canonical-migration",
    "/internal/canonical-migration/control",
  ])
    for (const method of ["GET", "POST"])
      assert.equal(
        (
          await handleRequest(
            new Request(`https://api.mons.link${path}`, { method }),
            unavailableEnv,
          )
        ).status,
        404,
      );
});

test("retired cleanup GET and POST return not-found without capabilities, storage, or body access", async () => {
  const unavailableEnv = new Proxy(TELEGRAM_TEST_ENV, {
    get: () =>
      assert.fail("Retired cleanup route accessed an environment binding"),
  });
  for (const method of ["GET", "POST"])
    for (const withRetiredHeaders of [false, true])
      for (const entrypoint of ["request", "fetch"] as const) {
        const input = new Request(
          "https://api.mons.link/internal/canonical-cleanup",
          {
            method,
            ...(withRetiredHeaders
              ? {
                  headers: {
                    "X-Mons-Cleanup-Id": "12345678-1234-4234-8234-123456789abc",
                    "X-Mons-Cleanup-Time": "1800000000",
                    "X-Mons-Cleanup-Signature": "a".repeat(64),
                  },
                }
              : {}),
            ...(method === "POST" ? { body: "unread cleanup command" } : {}),
          },
        );
        const response =
          entrypoint === "fetch"
            ? await handleFetch(input, unavailableEnv, ctx)
            : await handleRequest(input, unavailableEnv, {}, ctx);
        assert.equal(response.status, 404, `${entrypoint} ${method}`);
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "not-found",
        });
        assert.equal(input.bodyUsed, false);
      }
});

function request(path: string, method = "OPTIONS"): Request {
  return applicationRequest(`https://api.mons.link${path}`, {
    method,
    headers: { Origin: "https://mons.link" },
    ...(method === "POST" ? { body: "unread body" } : {}),
  });
}

function overridesFor(expected?: keyof Overrides) {
  const reads: PropertyKey[] = [];
  const overrides = new Proxy<Overrides>(
    {},
    {
      get(_target, property) {
        assert.equal(property, expected);
        reads.push(property);
        return undefined;
      },
      ownKeys() {
        return assert.fail("Unexpected dependency enumeration");
      },
    },
  );
  return { overrides, reads };
}

async function responseValue(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete("Server-Timing");
  return {
    status: response.status,
    headers: [...headers],
    body: await response.text(),
  };
}

test("missing context rejects each protected route before method, origin, body, or dependencies", async () => {
  const { overrides, reads } = overridesFor();
  for (const { path } of contextRoutes) {
    for (const method of ["OPTIONS", "POST"]) {
      const input = request(path, method);
      input.headers.set("Origin", "https://untrusted.invalid");
      const response = await handleRequest(input, env, overrides);
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "unavailable",
      });
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(input.bodyUsed, false);
    }
  }
  assert.deepEqual(reads, []);
});

test("ordinary preflights share dispatch and access only their selected dependency", async () => {
  for (const { path, override } of [
    ...contextRoutes,
    { path: "/auth/session/anonymous", override: "session" as const },
    { path: "/nfts" },
  ]) {
    const { overrides, reads } = overridesFor(override);
    const response = await handleRequest(request(path), env, overrides, ctx);
    assert.equal(response.status, 204, path);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      path === "/nfts" ? "*" : "https://mons.link",
      path,
    );
    assert.deepEqual(reads, override ? [override] : [], path);
    assert.deepEqual(
      await responseValue(await handleFetch(request(path), env, ctx)),
      await responseValue(response),
      path,
    );
  }
});

test("sessions, X callbacks, and NFT methods remain usable without context", async () => {
  for (const [path, method, status] of [
    ["/auth/session/anonymous", "OPTIONS", 204],
    ["/auth/x/callback", "GET", 400],
    ["/auth/x/callback", "OPTIONS", 405],
    ["/nfts?ignored=1", "OPTIONS", 204],
    ["/nfts", "GET", 405],
  ] as const) {
    const response = await handleRequest(request(path, method), env);
    assert.equal(response.status, status, `${method} ${path}`);
  }
});

test("snapshot and Telegram routes retain their fetch-only methods and headers", async () => {
  for (const path of [
    "/matches/snapshot",
    "/matches/history",
    "/internal/telegram/delivery",
    "/internal/telegram/command",
  ]) {
    const snapshot = path.startsWith("/matches/");
    for (const method of ["OPTIONS", "GET", "POST"]) {
      const input = request(path, method);
      const ordinary = await handleRequest(input, env);
      assert.equal(ordinary.status, 404, `${method} ${path}`);
      assert.deepEqual(await ordinary.json(), {
        ok: false,
        error: "not-found",
      });
      assert.equal(input.bodyUsed, false);
      if (!snapshot && method === "POST") continue;
      const response = await handleFetch(input, env, ctx);
      assert.equal(
        response.status,
        snapshot
          ? method === "OPTIONS"
            ? 204
            : method === "GET"
              ? 400
              : 405
          : 405,
        `${method} ${path}`,
      );
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        snapshot ? "*" : null,
      );
      assert.equal(
        response.headers.get("Access-Control-Allow-Methods"),
        snapshot ? "GET, OPTIONS" : null,
      );
      assert.equal(
        response.headers.get("Allow"),
        snapshot && method === "POST" ? "GET, OPTIONS" : null,
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(input.bodyUsed, false);
    }
  }
});

test("nearby unknown and retired paths stay inert through both entrypoints", async () => {
  const { overrides, reads } = overridesFor();
  for (const path of [
    "/nfts/",
    "/NFTS",
    "/auth/x/callback/",
    "/matches/snapshot/",
    "/invites/invite-1/metadata/",
    "/invites/invite-1/matches/match-1/unknown",
    "/internal/telegram/command/status",
    "/internal/telegram/event-prize-announcement",
    "/internal/d1-migration",
    "/auth/profile-claim/sync",
  ]) {
    for (const method of ["OPTIONS", "POST"]) {
      const input = request(path, method);
      const response = await handleRequest(input, env, overrides, ctx);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(
        await responseValue(await handleFetch(input, env, ctx)),
        await responseValue(response),
      );
      assert.equal(input.bodyUsed, false);
    }
  }
  assert.deepEqual(reads, []);
});

test("matched invite paths preserve leaf validation of encoded identities and queries", async () => {
  for (const path of [
    "/invites/%ZZ/metadata",
    "/invites/%2F/metadata",
    "/invites/invite-1/metadata?unexpected=1",
  ]) {
    for (const response of [
      await handleRequest(request(path), env, {}, ctx),
      await handleFetch(request(path), env, ctx),
    ]) {
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "invalid-argument",
        message: "invalid-invite-id",
      });
    }
  }
});
