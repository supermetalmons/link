"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isAppleAuthVerificationRequest,
  isAuthProfileResponse,
  isEthereumAuthVerificationRequest,
  isSolanaAuthVerificationRequest,
  isXAuthCompletionRequest,
  createAuthPresentation,
} = require("../runtime/shared/auth");

const token = "a".repeat(24);
/** @type {{validate(value: unknown): boolean, request(emoji: unknown, aura: unknown): unknown}[]} */
const requestValidators = [
  {
    validate: isSolanaAuthVerificationRequest,
    request: (emoji, aura) => ({
      intentId: token,
      address: "address",
      signature: "signature",
      emoji,
      aura,
    }),
  },
  {
    validate: isEthereumAuthVerificationRequest,
    request: (emoji, aura) => ({
      intentId: token,
      message: "message",
      signature: "signature",
      emoji,
      aura,
    }),
  },
  {
    validate: isAppleAuthVerificationRequest,
    request: (emoji, aura) => ({
      intentId: token,
      idToken: "id-token",
      consentSource: "signin",
      emoji,
      aura,
    }),
  },
  {
    validate: isXAuthCompletionRequest,
    request: (emoji, aura) => ({ flowId: token, emoji, aura }),
  },
];

test("auth mutation presentation accepts only supported emoji ranges", () => {
  for (const { validate, request } of requestValidators) {
    for (const emoji of [0, 1, 155, 1000, 1466]) {
      assert.equal(validate(request(emoji, "none")), true);
    }
    for (const emoji of [-1, 1.5, 156, 999, 1467, "1"]) {
      assert.equal(validate(request(emoji, "none")), false);
    }
  }
});

test("auth mutation presentation accepts only canonical aura names", () => {
  for (const { validate, request } of requestValidators) {
    for (const aura of ["none", "rainbow"]) {
      assert.equal(validate(request(1, aura)), true);
    }
    for (const aura of [
      null,
      "",
      "legacy",
      "a".repeat(32),
      "a".repeat(33),
      1,
    ]) {
      assert.equal(validate(request(1, aura)), false);
    }
  }
});

test("auth presentation creation rejects legacy coercions", () => {
  assert.deepEqual(createAuthPresentation(155, "rainbow"), {
    emoji: 155,
    aura: "rainbow",
  });
  assert.deepEqual(createAuthPresentation(1000, "none"), {
    emoji: 1000,
    aura: "none",
  });
  for (const emoji of ["155", "1.5", 156, 999, 1467, "garbage", null])
    assert.throws(
      () => Reflect.apply(createAuthPresentation, undefined, [emoji, "none"]),
      /invalid-auth-presentation/,
    );
  for (const aura of [null, "", "legacy", "a".repeat(33)])
    assert.throws(
      () => Reflect.apply(createAuthPresentation, undefined, [1, aura]),
      /invalid-auth-presentation/,
    );
});

test("rejects the retired address key while accepting complete canonical responses", () => {
  const response = {
    ok: true,
    uid: "login-1",
    profileId: "profile-1",
    username: null,
    address: null,
    eth: null,
    sol: null,
    linkedMethods: { apple: false, eth: false, sol: false, x: false },
    appleLinked: false,
    ...require("../runtime/shared/appearance").createDefaultProfileAppearance(
      1,
    ),
    opId: "operation-1",
  };

  assert.equal(isAuthProfileResponse(response), false);
  assert.equal(isAuthProfileResponse({ ...response, address: 1 }), false);
  const { address: _address, ...currentResponse } = response;
  assert.equal(isAuthProfileResponse(currentResponse), true);
});
