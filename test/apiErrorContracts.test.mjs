import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      specifier.startsWith(".") &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { authenticatedJsonRequest } =
  await import("../src/services/apiTransport.ts");
const { AuthApiError } = await import("../src/services/authApi.ts");
const { ProfileApiError } = await import("../src/services/profileApi.ts");
const { MiningApiError } = await import("../src/services/miningApi.ts");
const { EventPrizeWithdrawalApiError } =
  await import("../src/services/eventPrizeApi.ts");
const { GameplayApiError, responseError } =
  await import("../src/services/gameplayTransport.ts");

const cooldown = {
  reason: "method-reuse-cooldown",
  scope: "method",
  method: "apple",
  retryAtMs: 123,
  cooldownMs: 86_400_000,
};
/** @param {unknown} value @returns {value is unknown} */
const acceptPayload = (value) => {
  void value;
  return true;
};
/** @param {string} code @param {unknown} details */
const requestError = (code, details) =>
  authenticatedJsonRequest({
    url: "https://api.mons.link/test",
    createRequestInit: () => ({ method: "POST" }),
    tokenProvider: async () => "token",
    validate: acceptPayload,
    timeoutMs: 1_000,
    maxResponseBytes: 8_192,
    fetcher: async () =>
      Response.json(
        { ok: false, error: code, message: "server message", details },
        { status: 409 },
      ),
    errors: {
      createError: (nextCode, message, nextDetails) =>
        new AuthApiError(nextCode, message, nextDetails),
      normalizeError: (error) =>
        error instanceof AuthApiError ? error : undefined,
      unavailableMessage: "Service is unavailable.",
      timeoutMessage: "Request timed out.",
    },
  });

test("client errors preserve only the declared cooldown and terminal detail variants", async () => {
  for (const [code, details] of /** @type {[string, unknown][]} */ ([
    ["failed-precondition", cooldown],
    [
      "failed-precondition",
      {
        ...cooldown,
        reason: "profile-method-cooldown",
        scope: "profile-method",
        profileId: null,
      },
    ],
    ["unavailable", { terminal: true }],
  ])) {
    await assert.rejects(requestError(code, details), (error) => {
      assert.ok(error instanceof AuthApiError);
      assert.equal(error.code, code);
      assert.deepEqual(error.details, details);
      return true;
    });
    const gameplay = responseError(
      { error: code, message: "server message", details },
      409,
    );
    assert.equal(gameplay.code, code);
    assert.deepEqual(gameplay.details, details);
  }
});

test("arbitrary diagnostic extensions and legacy detail fields become generic unavailable errors", async () => {
  for (const [code, details] of /** @type {[string, unknown][]} */ ([
    ["failed-precondition", { ...cooldown, diagnostic: { private: "value" } }],
    ["failed-precondition", { ...cooldown, retryAtMs: "123" }],
    [
      "failed-precondition",
      { reason: "method-reuse-cooldown", method: "apple" },
    ],
    ["failed-precondition", { terminal: true }],
    ["permission-denied", cooldown],
    ["unavailable", { terminal: true, extra: true }],
    ["unavailable", null],
  ])) {
    await assert.rejects(requestError(code, details), (error) => {
      assert.ok(error instanceof AuthApiError);
      assert.equal(error.code, "unavailable");
      assert.equal(error.message, "Service is unavailable.");
      assert.equal(error.details, undefined);
      return true;
    });
    const gameplay = responseError(
      { error: code, message: "private server message", details },
      409,
    );
    assert.equal(gameplay.code, "unavailable");
    assert.equal(gameplay.message, "Gameplay service is unavailable.");
    assert.equal(gameplay.details, undefined);
  }
});

test("all endpoint error constructors reject undeclared details without casting them into the contract", () => {
  for (const ErrorType of [
    AuthApiError,
    ProfileApiError,
    MiningApiError,
    EventPrizeWithdrawalApiError,
    GameplayApiError,
  ]) {
    assert.throws(
      () =>
        Reflect.construct(ErrorType, [
          "unavailable",
          "message",
          { diagnostic: true },
        ]),
      /invalid-api-error-details/,
    );
    assert.deepEqual(
      new ErrorType("unavailable", "message", { terminal: true }).details,
      { terminal: true },
    );
  }
});
