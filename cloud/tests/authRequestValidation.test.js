"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isAppleAuthVerificationRequest,
  isAuthProfileResponse,
  isEthereumAuthVerificationRequest,
  isSolanaAuthVerificationRequest,
  isXAuthCompletionRequest,
  normalizeAuthPresentation,
} = require("../functions/shared/auth");

const token = "a".repeat(24);
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
    for (const emoji of [1, 155, 1000, 1466]) {
      assert.equal(validate(request(emoji, null)), true);
    }
    for (const emoji of [-1, 0, 1.5, 156, 999, 1467, "1"]) {
      assert.equal(validate(request(emoji, null)), false);
    }
  }
});

test("auth mutation presentation bounds aura strings", () => {
  for (const { validate, request } of requestValidators) {
    for (const aura of [null, "", "a".repeat(32)]) {
      assert.equal(validate(request(1, aura)), true);
    }
    for (const aura of ["a".repeat(33), 1]) {
      assert.equal(validate(request(1, aura)), false);
    }
  }
});

test("normalizes cached presentation values to request-safe bounds", () => {
  assert.deepEqual(normalizeAuthPresentation("155", "rainbow"), {
    emoji: 155,
    aura: "rainbow",
  });
  assert.deepEqual(normalizeAuthPresentation("1000", ""), {
    emoji: 1000,
    aura: "",
  });
  for (const emoji of ["1.5", "156", "999", "1467", "garbage", null]) {
    assert.equal(normalizeAuthPresentation(emoji, null).emoji, 1);
  }
  assert.equal(normalizeAuthPresentation(1, "a".repeat(33)).aura, null);
});

test("accepts the retired address key without requiring new responses to emit it", () => {
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
    emoji: 1,
    opId: "operation-1",
  };

  assert.equal(isAuthProfileResponse(response), true);
  assert.equal(isAuthProfileResponse({ ...response, address: 1 }), false);
  const { address: _address, ...currentResponse } = response;
  assert.equal(isAuthProfileResponse(currentResponse), true);
});
