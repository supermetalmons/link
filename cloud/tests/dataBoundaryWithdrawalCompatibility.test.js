"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalWithdrawalFixture } = require("./withdrawalFixture");
const {
  readStoredWithdrawalDocument,
} = require("../runtime/eventPrizes/records");
const {
  buildWithdrawalCompletion,
  decideWithdrawalClaim,
} = require("../runtime/eventPrizeWithdrawalState");
/** @param {import("../runtime/eventPrizes/records").WithdrawalDocument} current */
function request(current) {
  return {
    eventId: current.eventId,
    prizeId: current.prizeId,
    assetAddress: current.assetAddress,
    profileId: "current-profile",
    place: 1,
    recipientAddress: current.recipientAddress,
    requesterUid: "uid",
    leaseId: "next-lease",
    nowMs: 1000,
  };
}

test("submitted recovery preserves signed evidence and original entitlement in the canonical document", () => {
  const current = canonicalWithdrawalFixture({
    status: "submitted",
    profileId: "original-profile",
    entitledProfileId: "original-profile",
    leaseId: "prior",
    leaseExpiresAtMs: 100,
    startedAtMs: 12,
    submittedAtMs: 31,
  });
  const before = JSON.stringify(current);
  const result = decideWithdrawalClaim({ ...request(current), current });
  assert.equal(result.kind, "acquired");
  assert.deepEqual(result.value, {
    ...current,
    profileId: "current-profile",
    leaseId: "next-lease",
    leaseExpiresAtMs: 301000,
    updatedAtMs: 1000,
  });
  assert.equal(JSON.stringify(current), before);
});

test("legacy extensions and coerced numbers are rejected at the storage boundary", () => {
  const current = canonicalWithdrawalFixture({ status: "submitted" });
  for (const malformed of [
    { ...current, startedAtMs: "12.9" },
    { ...current, lastValidBlockHeight: "123" },
    { ...current, entitledProfileId: " profile " },
    { ...current, futureEvidence: { retained: true } },
  ])
    assert.equal(readStoredWithdrawalDocument(malformed), null);
});

test("completion preserves confirmed bytes and canonical timestamp fields", () => {
  const withdrawal = canonicalWithdrawalFixture({
    status: "submitted",
    startedAtMs: 12,
    submittedAtMs: 20,
  });
  assert.ok(typeof withdrawal.transactionSignature === "string");
  const completed = buildWithdrawalCompletion({
    ...request(withdrawal),
    withdrawal,
    transactionSignature: withdrawal.transactionSignature,
    completedAtMs: 30,
  });
  assert.deepEqual(completed, {
    ...withdrawal,
    status: "completed",
    profileId: "current-profile",
    leaseId: null,
    leaseExpiresAtMs: null,
    completedAtMs: 30,
    updatedAtMs: 30,
  });
  assert.ok(readStoredWithdrawalDocument(completed));
});
