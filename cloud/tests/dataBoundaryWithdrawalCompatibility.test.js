"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildWithdrawalCompletion,
  decideWithdrawalClaim,
  getEventPrizeAssetAddress,
} = require("../runtime/eventPrizeWithdrawalState");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
const recipientAddress = "11111111111111111111111111111111";
const request = {
  eventId,
  prizeId,
  assetAddress,
  profileId: "current-profile",
  place: 1,
  recipientAddress,
  requesterUid: "uid",
  leaseId: "next-lease",
  nowMs: 1000,
};
const serialized = (value) => JSON.parse(JSON.stringify(value));

test("withdrawal compatibility: submitted reacquisition merges legacy fields without coercing submission evidence", () => {
  const current = {
    eventId,
    prizeId,
    assetAddress,
    profileId: "original-profile",
    entitledProfileId: " original-profile ",
    recipientAddress,
    requesterUid: "uid",
    status: "submitted",
    startedAtMs: "12.9",
    submittedAtMs: "31.5",
    transactionSignature: "signature",
    signedTransactionBase64: "AQID",
    blockhash: "blockhash",
    lastValidBlockHeight: "123",
    futureEvidence: { retained: [true, null, 3] },
  };
  const original = JSON.stringify(current);
  const result = decideWithdrawalClaim({ ...request, current });
  assert.equal(result.kind, "acquired");
  assert.deepEqual(serialized(result.value), {
    eventId,
    prizeId,
    assetAddress,
    assetStandard: "core",
    profileId: "current-profile",
    entitledProfileId: "original-profile",
    recipientAddress,
    requesterUid: "uid",
    status: "submitted",
    startedAtMs: 1000,
    submittedAtMs: "31.5",
    transactionSignature: "signature",
    signedTransactionBase64: "AQID",
    blockhash: "blockhash",
    lastValidBlockHeight: "123",
    futureEvidence: { retained: [true, null, 3] },
    place: 1,
    leaseId: "next-lease",
    leaseExpiresAtMs: 301000,
    updatedAtMs: 1000,
  });
  assert.equal(JSON.stringify(current), original);
});

test("withdrawal compatibility: processing reacquisition replaces stale fields and extensions", () => {
  const result = decideWithdrawalClaim({
    ...request,
    current: {
      eventId,
      prizeId,
      assetAddress,
      profileId: "original-profile",
      requesterUid: "uid",
      recipientAddress,
      status: "processing",
      leaseExpiresAtMs: "999",
      leaseId: "old-lease",
      startedAtMs: 12,
      transactionSignature: "stale-signature",
      futureEvidence: { stale: true },
    },
  });
  assert.equal(result.kind, "acquired");
  assert.deepEqual(serialized(result.value), {
    eventId,
    prizeId,
    assetAddress,
    assetStandard: "core",
    entitledProfileId: "current-profile",
    profileId: "current-profile",
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    status: "processing",
    leaseId: "next-lease",
    leaseExpiresAtMs: 301000,
    startedAtMs: 1000,
    updatedAtMs: 1000,
  });
});

test("withdrawal compatibility: completion replaces submission fields and preserves numeric timestamp coercions", () => {
  const completed = buildWithdrawalCompletion({
    ...request,
    withdrawal: {
      profileId: "original-profile",
      entitledProfileId: " original-profile ",
      requesterUid: " uid ",
      place: "2",
      startedAtMs: "12.9",
      submittedAtMs: "0",
      signedTransactionBase64: "AQID",
      futureEvidence: { stale: true },
    },
    transactionSignature: "confirmed-signature",
    completedAtMs: 2000,
  });
  assert.deepEqual(serialized(completed), {
    eventId,
    prizeId,
    assetAddress,
    assetStandard: "core",
    profileId: "current-profile",
    entitledProfileId: "original-profile",
    place: 2,
    recipientAddress,
    requesterUid: "uid",
    status: "completed",
    transactionSignature: "confirmed-signature",
    startedAtMs: 12.9,
    submittedAtMs: 2000,
    completedAtMs: 2000,
    updatedAtMs: 2000,
  });
});
