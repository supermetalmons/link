import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import { EventWritesDisabled } from "../src/eventD1.ts";
import { handleEventRoute } from "../src/eventRoute.ts";
import { handleGameplayRoute } from "../src/gameplayRoute.ts";
import { handleMiningRoute } from "../src/miningRoute.ts";
import { handleProfileRoute } from "../src/profileRoute.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const ctx = { waitUntil: () => undefined };
const routes = [
  {
    domain: "gameplay",
    path: "/automatch/cancel",
    handle: handleGameplayRoute,
  },
  { domain: "profile", path: "/profiles/custom", handle: handleProfileRoute },
  {
    domain: "event",
    path: "/events/participants/join",
    handle: handleEventRoute,
  },
  { domain: "mining", path: "/mining/rock", handle: handleMiningRoute },
];

function request(path: string, method = "POST", origin = "https://mons.link") {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: "invalid-json" } : {}),
  });
}

for (const route of routes) {
  test(`${route.domain} keeps preflight, origin, and method rejection ahead of authentication`, async () => {
    const calls: string[] = [];
    const dependencies = {
      verifyIdentity: async () => {
        calls.push("authenticate");
        return { uid: "login-1" };
      },
      logFailure: (kind: string) => calls.push(kind),
    };
    const preflight = await route.handle(
      request(route.path, "OPTIONS"),
      TELEGRAM_TEST_ENV,
      ctx,
      dependencies,
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Origin"),
      "https://mons.link",
    );
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, OPTIONS",
    );
    assert.equal(preflight.headers.get("Cache-Control"), "no-store");
    assert.equal(await preflight.text(), "");

    const denied = await route.handle(
      request(route.path, "OPTIONS", "https://denied.invalid"),
      TELEGRAM_TEST_ENV,
      ctx,
      dependencies,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(denied.headers.get("Vary"), "Origin");
    const wrongMethod = await route.handle(
      request(route.path, "GET"),
      TELEGRAM_TEST_ENV,
      ctx,
      dependencies,
    );
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(calls, []);
  });

  test(`${route.domain} preserves structured auth errors and sanitizes unknown failures`, async () => {
    for (const error of [
      new AuthApiFailure(401, "unauthenticated", "authentication-required", {
        reason: "expired",
      }),
      new Error("private-provider-detail"),
    ]) {
      const input = request(route.path);
      const logged: string[] = [];
      const response = await route.handle(input, TELEGRAM_TEST_ENV, ctx, {
        verifyIdentity: async () => {
          throw error;
        },
        logFailure: (kind) => logged.push(kind),
      });
      assert.equal(input.bodyUsed, false);
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://mons.link",
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(
        response.headers.get("Content-Type"),
        "application/json; charset=utf-8",
      );
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(
        response.status,
        error instanceof AuthApiFailure ? 401 : 503,
      );
      assert.deepEqual(
        await response.json(),
        error instanceof AuthApiFailure
          ? {
              ok: false,
              error: "unauthenticated",
              message: "authentication-required",
              details: { reason: "expired" },
            }
          : {
              ok: false,
              error: "unavailable",
              message: `${route.domain}-service-unavailable`,
            },
      );
      assert.deepEqual(
        logged,
        error instanceof AuthApiFailure
          ? []
          : [`${route.domain}-service-unavailable`],
      );
    }
  });

  test(`${route.domain} retains quiet frozen-write responses before body parsing`, async () => {
    const input = request(route.path);
    const calls: string[] = [];
    const response = await route.handle(
      input,
      withProfileControl(TELEGRAM_TEST_ENV, "frozen"),
      ctx,
      {
        verifyIdentity: async () => {
          calls.push("authenticate");
          return { uid: "login-1" };
        },
        logFailure: (kind) => calls.push(kind),
      },
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(input.bodyUsed, false);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "unavailable",
      message: "profile-writes-disabled",
    });
    assert.deepEqual(calls, ["authenticate"]);
  });
}

test("event write admission retains its specialized response before body parsing", async () => {
  const calls: string[] = [];
  const input = request("/events/participants/join");
  const response = await handleEventRoute(input, TELEGRAM_TEST_ENV, ctx, {
    verifyIdentity: async () => {
      calls.push("authenticate");
      return { uid: "login-1" };
    },
    assertEventWrites: async () => {
      calls.push("admission");
      throw new EventWritesDisabled();
    },
    logFailure: (kind) => calls.push(kind),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(input.bodyUsed, false);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "event-writes-disabled",
  });
  assert.deepEqual(calls, ["authenticate", "admission"]);
});

test("unknown event paths reject before authentication or parsing", async () => {
  let verifications = 0;
  const input = request("/events/unknown");
  const response = await handleEventRoute(input, TELEGRAM_TEST_ENV, ctx, {
    verifyIdentity: async () => {
      verifications++;
      return { uid: "login-1" };
    },
  });
  assert.equal(response.status, 404);
  assert.equal(input.bodyUsed, false);
  assert.equal(verifications, 0);
});
