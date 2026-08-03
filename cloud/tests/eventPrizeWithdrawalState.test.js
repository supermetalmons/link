"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const bs58 = require("bs58");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  buildWithdrawalCompletionUpdates,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getWithdrawalProjectionProfileIds,
  isCompletedEventPrizeWithdrawal,
  normalizeSolanaAddress,
} = require("../functions/eventPrizeWithdrawalState");
const {
  deserializeSubmittedTransaction,
  reconcileCompletedWithdrawalProjections,
  validatePrizeAssignment,
} = require("../functions/eventPrizeWithdrawal");
const {
  copyProfileEventPrizeAssignment,
  removeMatchingProfileEventPrizeAssignment,
} = require("../functions/profileEventPrizeProjection");
const admin = require("../functions/firebaseAdmin");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const assetAddress = getEventPrizeAssetAddress(prizeId);
const profileId = "profile";
const recipientAddress = "11111111111111111111111111111111";

const claim = (current, overrides = {}) =>
  decideWithdrawalClaim({
    current,
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-next",
    nowMs: 1000,
    ...overrides,
  });

test("maps every event prize to its Core asset", () => {
  assert.equal(
    getEventPrizeAssetAddress("1092"),
    "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
  );
  assert.equal(
    getEventPrizeAssetAddress("1111"),
    "8BhUWeckB6432Vnxr6Jg9ve2NN39huPk8PBNL87wQgpL",
  );
  assert.equal(
    getEventPrizeAssetAddress("1514"),
    "FxgNuJ47j95kaWEVkPo4QGPfXzF4x5YKLFBSYezyFRRJ",
  );
  assert.equal(getEventPrizeAssetAddress("invalid"), "");
});

test("validates Solana addresses and 64-byte base58 secret keys", () => {
  assert.equal(normalizeSolanaAddress(recipientAddress), recipientAddress);
  assert.equal(normalizeSolanaAddress("invalid"), "");
  const secret = new Uint8Array(64).fill(7);
  assert.deepEqual(decodeAdminSecretKey(bs58.default.encode(secret)), secret);
  assert.equal(
    decodeAdminSecretKey(bs58.default.encode(new Uint8Array(32))),
    null,
  );
  assert.notEqual(EVENT_PRIZE_ADMIN_WALLET, recipientAddress);
});

test("acquires a new withdrawal lease", () => {
  const decision = claim(null);
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "processing");
  assert.equal(decision.value.recipientAddress, recipientAddress);
  assert.equal(decision.value.leaseId, "lease-next");
});

test("rejects concurrent active leases", () => {
  const decision = claim({
    status: "processing",
    profileId,
    recipientAddress,
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
  });
  assert.equal(decision.kind, "busy");
});

test("preserves submitted transaction data on an idempotent retry", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "expired",
    leaseExpiresAtMs: 500,
    startedAtMs: 100,
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "submitted");
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
  assert.equal(decision.value.startedAtMs, 100);
});

test("migrates a submitted attempt to the caller's current profile", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: originalProfileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
      transactionSignature: "signature",
      signedTransactionBase64: "transaction",
      blockhash: "blockhash",
      lastValidBlockHeight: 123,
    },
    { profileId: currentProfileId },
  );
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.profileId, currentProfileId);
  assert.equal(decision.value.entitledProfileId, originalProfileId);
  assert.equal(decision.value.recipientAddress, recipientAddress);
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
  assert.equal(decision.value.blockhash, "blockhash");
  assert.equal(decision.value.lastValidBlockHeight, 123);
});

test("allows canonical profile recovery when the recorded UID changed", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: originalProfileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid-before-merge",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    {
      profileId: currentProfileId,
      requesterUid: "uid-after-merge",
      canonicalRecordProfileId: currentProfileId,
      canonicalRecordSourceProfileId: originalProfileId,
    },
  );
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.profileId, currentProfileId);
  assert.equal(decision.value.entitledProfileId, originalProfileId);
  assert.equal(decision.value.requesterUid, "uid-after-merge");
});

test("does not let a different UID and profile claim a submitted attempt", () => {
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: "profile-before-merge",
      place: 1,
      recipientAddress,
      requesterUid: "uid-before-merge",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    {
      profileId: "unrelated-profile",
      requesterUid: "unrelated-uid",
      canonicalRecordProfileId: "another-profile",
      canonicalRecordSourceProfileId: "profile-before-merge",
    },
  );
  assert.equal(decision.kind, "forbidden");
});

test("does not recover a submitted record for another prize", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId: "1111",
    assetAddress: getEventPrizeAssetAddress("1111"),
    profileId,
    place: 2,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "expired",
    leaseExpiresAtMs: 500,
  });
  assert.equal(decision.kind, "forbidden");
});

test("locks a submitted withdrawal to its original destination", () => {
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    { recipientAddress: "SysvarRent111111111111111111111111111111111" },
  );
  assert.equal(decision.kind, "destination-mismatch");
});

test("returns completed withdrawals without acquiring another lease", () => {
  const completed = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    recipientAddress,
    transactionSignature: "signature",
  };
  const decision = claim(completed);
  assert.equal(decision.kind, "completed");
  assert.equal(decision.value, completed);
  assert.equal(
    isCompletedEventPrizeWithdrawal(completed, eventId, prizeId),
    true,
  );
});

test("returns a completed withdrawal after the caller's profile was merged", () => {
  const completed = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress,
    profileId: "profile-before-merge",
    recipientAddress,
    requesterUid: "uid",
    transactionSignature: "signature",
  };
  const decision = claim(completed, { profileId: "profile-after-merge" });
  assert.equal(decision.kind, "completed");
  assert.equal(decision.value, completed);
});

test("filters completed withdrawals out of prize projections", () => {
  const assignments = {
    1: { eventId, profileId, place: 1, prizeId },
    2: { eventId, profileId: "other", place: 2, prizeId: "1111" },
  };
  const projectable = filterProjectableEventPrizeAssignments({
    eventId,
    assignments,
    withdrawals: {
      [prizeId]: {
        status: "completed",
        eventId,
        prizeId,
        assetAddress,
      },
    },
  });
  assert.deepEqual(Object.keys(projectable), ["2"]);
});

test("schedules ended-event cleanup even when no event fields changed", () => {
  const assignments = {
    1: { eventId, profileId, place: 1, prizeId },
  };
  assert.deepEqual(
    getCompletedEventPrizeProjectionCleanupRequest({
      eventId,
      eventStatus: "ended",
      assignments,
      didChange: false,
    }),
    { eventId, assignments },
  );
  assert.equal(
    getCompletedEventPrizeProjectionCleanupRequest({
      eventId,
      eventStatus: "active",
      assignments,
      didChange: true,
    }),
    null,
  );
});

test("requires the entitlement to match the canonical profile and requested prize", () => {
  const assignment = { eventId, prizeId, profileId, place: 1 };
  assert.equal(
    validatePrizeAssignment({ assignment, eventId, prizeId, profileId }),
    1,
  );
  assert.throws(
    () =>
      validatePrizeAssignment({
        assignment,
        eventId,
        prizeId: "1111",
        profileId,
      }),
    (error) => error.code === "not-found",
  );
  assert.throws(
    () =>
      validatePrizeAssignment({
        assignment,
        eventId,
        prizeId,
        profileId: "different-profile",
      }),
    (error) => error.code === "not-found",
  );
});

test("recovers the same submitted transaction while its blockhash is valid", async () => {
  const serialized = new Uint8Array([1, 2, 3]);
  const deserialized = { message: "same-transaction" };
  const umi = {
    rpc: { call: async () => 100 },
    transactions: {
      deserialize: (bytes) => {
        assert.deepEqual(bytes, serialized);
        return deserialized;
      },
    },
  };
  const recovered = await deserializeSubmittedTransaction(umi, {
    signedTransactionBase64: Buffer.from(serialized).toString("base64"),
    transactionSignature: "signature",
    blockhash: "blockhash",
    lastValidBlockHeight: 101,
  });
  assert.equal(recovered.signedTransaction, deserialized);
  assert.equal(recovered.transactionSignature, "signature");
  assert.equal(recovered.blockhash, "blockhash");
});

test("rebuilds an expired submitted transaction without changing its destination", async () => {
  const umi = {
    rpc: { call: async () => 102 },
    transactions: {
      deserialize: () => {
        throw new Error("expired transaction should not be deserialized");
      },
    },
  };
  const recovered = await deserializeSubmittedTransaction(umi, {
    signedTransactionBase64: Buffer.from([1]).toString("base64"),
    transactionSignature: "signature",
    blockhash: "blockhash",
    lastValidBlockHeight: 101,
  });
  assert.equal(recovered, null);
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    leaseId: "expired",
    leaseExpiresAtMs: 500,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.recipientAddress, recipientAddress);
});

test("completion records the canonical profile and retains event history", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const result = buildWithdrawalCompletionUpdates({
    withdrawal: {
      profileId: originalProfileId,
      entitledProfileId: originalProfileId,
      place: 1,
      requesterUid: "uid",
      startedAtMs: 10,
      submittedAtMs: 20,
    },
    profileId: currentProfileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature: "signature",
    completedAtMs: 30,
  });
  assert.equal(result.completed.status, "completed");
  assert.equal(result.completed.profileId, currentProfileId);
  assert.equal(result.completed.entitledProfileId, originalProfileId);
  assert.equal(
    result.updates[`eventPrizeWithdrawals/${eventId}/${prizeId}`],
    result.completed,
  );
  assert.equal(
    Object.keys(result.updates).some(
      (path) =>
        path.startsWith("profileEventPrizes/") ||
        path.startsWith(`events/${eventId}/prizeAssignments`),
    ),
    false,
  );
});

test("completion marker updates never delete profile projections directly", () => {
  const result = buildWithdrawalCompletionUpdates({
    withdrawal: {
      profileId,
      entitledProfileId: profileId,
      place: 1,
      requesterUid: "uid",
    },
    profileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature: "signature",
    completedAtMs: 30,
  });
  assert.equal(
    Object.keys(result.updates).some((path) =>
      path.startsWith("profileEventPrizes/"),
    ),
    false,
  );
});

test("completion reconciliation includes every known profile exactly once", () => {
  assert.deepEqual(
    getWithdrawalProjectionProfileIds({
      withdrawal: {
        profileId: "profile-before-merge",
        entitledProfileId: "profile-before-merge",
      },
      profileIds: ["profile-after-merge", "profile-before-merge", ""],
    }),
    ["profile-before-merge", "profile-after-merge"],
  );
});

test("completed retries reconcile old and current profile projections", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const assignments = new Map([
    [
      `profileEventPrizes/${originalProfileId}/${eventId}`,
      { eventId, prizeId, profileId: originalProfileId, place: 1 },
    ],
    [
      `profileEventPrizes/${currentProfileId}/${eventId}`,
      { eventId, prizeId, profileId: currentProfileId, place: 1 },
    ],
  ]);
  admin.database = () => ({
    ref: (path) => ({
      transaction: async (update) => {
        const next = update(assignments.get(path) ?? null);
        if (next === undefined) {
          return { committed: false };
        }
        assignments.set(path, next);
        return { committed: true };
      },
    }),
  });

  const withdrawal = {
    profileId: originalProfileId,
    entitledProfileId: originalProfileId,
  };
  await reconcileCompletedWithdrawalProjections({
    withdrawal,
    profileIds: [currentProfileId],
    eventId,
    prizeId,
  });
  await reconcileCompletedWithdrawalProjections({
    withdrawal,
    profileIds: [currentProfileId],
    eventId,
    prizeId,
  });

  assert.equal(
    assignments.get(`profileEventPrizes/${originalProfileId}/${eventId}`),
    null,
  );
  assert.equal(
    assignments.get(`profileEventPrizes/${currentProfileId}/${eventId}`),
    null,
  );
});

test("merge cleanup rechecks completion after an uncommitted copy", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const sourceProfileId = "profile-before-merge";
  const targetProfileId = "profile-after-merge";
  const targetPath = `profileEventPrizes/${targetProfileId}/${eventId}`;
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  let markerReadCount = 0;
  let targetAssignment = {
    eventId,
    prizeId,
    profileId: targetProfileId,
    place: 1,
    assignedAtMs: 10,
  };
  admin.database = () => ({
    ref: (path) => {
      if (path === withdrawalPath) {
        return {
          once: async () => ({
            val: () => {
              markerReadCount += 1;
              return markerReadCount === 1
                ? { status: "submitted" }
                : { status: "completed", eventId, prizeId, assetAddress };
            },
          }),
        };
      }
      assert.equal(path, targetPath);
      return {
        transaction: async (update) => {
          const next = update(targetAssignment);
          if (next === undefined) {
            return { committed: false };
          }
          targetAssignment = next;
          return { committed: true };
        },
      };
    },
  });

  const copied = await copyProfileEventPrizeAssignment({
    sourceProfileId,
    targetProfileId,
    eventId,
    sourceAssignment: {
      eventId,
      prizeId,
      profileId: sourceProfileId,
      place: 1,
      assignedAtMs: 10,
    },
  });

  assert.equal(copied, false);
  assert.equal(markerReadCount, 2);
  assert.equal(targetAssignment, null);
});

test("completed merge cleanup removes only the matching target projection", async () => {
  let currentAssignment = { eventId, prizeId, profileId, place: 1 };
  const targetRef = {
    transaction: async (update) => {
      const next = update(currentAssignment);
      if (next === undefined) {
        return { committed: false };
      }
      currentAssignment = next;
      return { committed: true };
    },
  };
  assert.equal(
    await removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }),
    true,
  );
  assert.equal(currentAssignment, null);

  currentAssignment = {
    eventId: "another-event",
    prizeId,
    profileId,
    place: 1,
  };
  assert.equal(
    await removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }),
    false,
  );
  assert.deepEqual(currentAssignment, {
    eventId: "another-event",
    prizeId,
    profileId,
    place: 1,
  });
});
