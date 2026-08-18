import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { GameplayApiError, cancelAutomatchViaApi, removeNavigationGameViaApi } =
  await import("../src/services/gameplayApi.ts");
const {
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
} = await import("@mons/shared/navigation");

const originalFetch = globalThis.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sends exact authenticated gameplay mutations and validates contracts", async () => {
  const calls = [];
  const responses = [
    { ok: true },
    {
      ok: true,
      skipped: false,
      deleted: true,
      reason: null,
      inviteId: "invite-1",
    },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };

  assert.deepEqual(await cancelAutomatchViaApi(async () => "firebase-token"), {
    ok: true,
  });
  assert.deepEqual(
    await removeNavigationGameViaApi(
      { inviteId: "invite-1" },
      async () => "firebase-token",
    ),
    {
      ok: true,
      skipped: false,
      deleted: true,
      reason: null,
      inviteId: "invite-1",
    },
  );
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      "https://api.mons.link/automatch/cancel",
      "https://api.mons.link/navigation/games/remove",
    ],
  );
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body)),
    [{}, { inviteId: "invite-1" }],
  );
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer firebase-token");
    assert.equal(headers.get("Content-Type"), "application/json");
  }

  assert.equal(isCancelAutomatchResponse({ ok: false }), true);
  assert.equal(isCancelAutomatchResponse({ ok: true, extra: true }), false);
  assert.equal(isRemoveNavigationGameRequest({ inviteId: "invite-1" }), true);
  assert.equal(isRemoveNavigationGameRequest({ inviteId: "" }), false);
  assert.equal(
    isRemoveNavigationGameResponse({
      ok: true,
      skipped: true,
      reason: "invite-active",
      inviteId: "invite-1",
    }),
    true,
  );
  assert.equal(
    isRemoveNavigationGameResponse({
      ok: true,
      skipped: false,
      deleted: false,
      reason: null,
      inviteId: "invite-1",
    }),
    false,
  );
});

test("refreshes the Firebase token once after a 401", async () => {
  const refreshes = [];
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(init.headers).get("Authorization"));
    if (tokens.length === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return jsonResponse({ ok: true });
  };
  assert.deepEqual(
    await cancelAutomatchViaApi(async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return forceRefresh ? "fresh-token" : "stale-token";
    }),
    { ok: true },
  );
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("does not retry mutation or expose transport details after other failures", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    return jsonResponse(
      {
        ok: false,
        error: "unavailable",
        message: "gameplay-service-unavailable",
      },
      503,
    );
  };
  await assert.rejects(
    cancelAutomatchViaApi(async () => {
      tokenCalls++;
      return "token";
    }),
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "unavailable" &&
      error.message === "gameplay-service-unavailable",
  );
  assert.equal(fetches, 1);
  assert.equal(tokenCalls, 1);

  globalThis.fetch = async () => {
    fetches++;
    throw new Error("private-network-detail");
  };
  await assert.rejects(
    cancelAutomatchViaApi(async () => "token"),
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay service is unavailable." &&
      !error.message.includes("private"),
  );
  assert.equal(fetches, 2);
});

test("rejects malformed and oversized gameplay responses", async () => {
  const responses = [
    jsonResponse({ ok: "yes" }),
    jsonResponse({ ok: true, skipped: false }),
    new Response("{}", {
      headers: { "Content-Length": String(64 * 1024 + 1) },
    }),
    new Response("{"),
  ];
  globalThis.fetch = async () => responses.shift();
  await assert.rejects(
    cancelAutomatchViaApi(async () => "token"),
    GameplayApiError,
  );
  for (let index = 0; index < 3; index++) {
    await assert.rejects(
      removeNavigationGameViaApi({ inviteId: "invite" }, async () => "token"),
      GameplayApiError,
    );
  }
});

test("applies one deadline to token acquisition and response reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tokenRequest = cancelAutomatchViaApi(
    () => new Promise(() => undefined),
  );
  const tokenRejection = assert.rejects(
    tokenRequest,
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay request timed out.",
  );
  t.mock.timers.runAll();
  await tokenRejection;

  let signal;
  let bodyStarted;
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    signal = init.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          bodyStarted();
        },
      }),
    );
  };
  const bodyRequest = cancelAutomatchViaApi(async () => "token");
  await started;
  const bodyRejection = assert.rejects(
    bodyRequest,
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay request timed out.",
  );
  assert.equal(signal.aborted, false);
  t.mock.timers.runAll();
  await bodyRejection;
  assert.equal(signal.aborted, true);
});

test("connection no longer references the migrated Firebase callables", () => {
  const source = readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /httpsCallable\([^)]*cancelAutomatch/);
  assert.doesNotMatch(source, /httpsCallable\([^)]*removeNavigationGame/);
  assert.doesNotMatch(source, /"cancelAutomatch"/);
  assert.doesNotMatch(source, /"removeNavigationGame"/);
  assert.match(source, /cancelAutomatchViaApi/);
  assert.match(source, /removeNavigationGameViaApi/);
});
