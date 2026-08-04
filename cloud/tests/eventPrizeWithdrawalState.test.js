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
  acquireWithdrawalClaim,
  deserializePersistedSubmittedTransaction,
  deserializeSubmittedTransaction,
  persistSubmittedTransaction,
  recoverSubmittedWithdrawal,
  reconcileCompletedWithdrawalProjections,
  sendAndConfirmSubmittedTransaction,
  validatePrizeAssignment,
  waitForSubmittedTransactionStatus,
} = require("../functions/eventPrizeWithdrawal");
const {
  copyProfileEventPrizeAssignment,
  removeProfileEventPrizeAssignmentIfWithdrawalCompleted,
  removeMatchingProfileEventPrizeAssignment,
} = require("../functions/profileEventPrizeProjection");
const admin = require("../functions/firebaseAdmin");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const assetAddress = getEventPrizeAssetAddress(prizeId);
const profileId = "profile";
const recipientAddress = "11111111111111111111111111111111";

const mockProfileMergeTargets = (targets) => () => ({
  collection: () => ({
    doc: (candidateProfileId) => ({
      get: async () => {
        const targetProfileId = targets[candidateProfileId];
        return {
          exists: Boolean(targetProfileId),
          data: () => (targetProfileId ? { targetProfileId } : null),
        };
      },
    }),
  }),
});

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

const createSubmittedTransaction = (transactionSignature, overrides = {}) => ({
  signedTransaction: { signatures: [transactionSignature] },
  transactionSignature: bs58.default.encode(transactionSignature),
  blockhash: "blockhash",
  lastValidBlockHeight: 123,
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
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
  });
  assert.equal(decision.kind, "busy");
});

test("takes over the caller's active processing lease before submission", () => {
  const decision = claim({
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "processing");
  assert.equal(decision.value.leaseId, "lease-next");
  assert.equal(decision.value.recipientAddress, recipientAddress);
});

test("reacquires an active submitted withdrawal for idempotent recovery", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "submitted");
  assert.equal(decision.value.leaseId, "lease-next");
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
});

test("checks the authoritative claim after a stale local transaction read", async () => {
  const authoritative = {
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: Date.now() + 60_000,
  };
  const withdrawalRef = {
    transaction: async (update) => {
      const optimistic = update(null);
      assert.equal(optimistic.status, "processing");
      const unchanged = update(authoritative);
      assert.equal(unchanged, authoritative);
      return {
        committed: true,
        snapshot: { val: () => unchanged },
      };
    },
  };
  await assert.rejects(
    acquireWithdrawalClaim({
      withdrawalRef,
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      canonicalRecordProfileId: profileId,
      canonicalRecordSourceProfileId: profileId,
    }),
    (error) =>
      error.code === "aborted" &&
      error.message === "This prize withdrawal is already being processed.",
  );
});

test("retries acquisition when a busy lease expires after the transaction", async () => {
  const authoritative = {
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: Date.now() + 5,
  };
  let transactionCount = 0;
  const withdrawalRef = {
    transaction: async (update) => {
      transactionCount += 1;
      const next = update(authoritative);
      if (transactionCount === 1) {
        assert.equal(next, authoritative);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else {
        assert.equal(next.status, "processing");
        assert.notEqual(next.leaseId, authoritative.leaseId);
      }
      return {
        committed: true,
        snapshot: { val: () => next },
      };
    },
  };
  const claimResult = await acquireWithdrawalClaim({
    withdrawalRef,
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    canonicalRecordProfileId: profileId,
    canonicalRecordSourceProfileId: profileId,
  });
  assert.equal(transactionCount, 2);
  assert.equal(claimResult.withdrawal.status, "processing");
});

test("persists a submission after refreshing a stale local transaction cache", async () => {
  const authoritative = {
    status: "processing",
    leaseId: "lease",
  };
  const inputs = [];
  const withdrawalRef = {
    transaction: async (update) => {
      inputs.push(null);
      assert.equal(update(null), null);
      inputs.push(authoritative);
      const submitted = update(authoritative);
      return {
        committed: true,
        snapshot: { val: () => submitted },
      };
    },
  };
  const persisted = await persistSubmittedTransaction({
    withdrawalRef,
    leaseId: "lease",
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.deepEqual(inputs, [null, authoritative]);
  assert.equal(persisted.status, "submitted");
  assert.equal(persisted.transactionSignature, "signature");
});

test("does not persist a submission after authoritative lease ownership changes", async () => {
  const authoritative = {
    status: "processing",
    leaseId: "another-lease",
  };
  const withdrawalRef = {
    transaction: async (update) => {
      const unchanged = update(authoritative);
      assert.equal(unchanged, authoritative);
      return {
        committed: true,
        snapshot: { val: () => unchanged },
      };
    },
  };
  await assert.rejects(
    persistSubmittedTransaction({
      withdrawalRef,
      leaseId: "lease",
      transactionSignature: "signature",
      signedTransactionBase64: "transaction",
      blockhash: "blockhash",
      lastValidBlockHeight: 123,
    }),
    (error) => error.code === "aborted",
  );
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

test("recognizes a confirmed submitted transaction by its stored signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(1);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      getSignatureStatuses: async (signatures, options) => {
        assert.equal(signatures[0], transactionSignature);
        assert.deepEqual(options, { searchTransactionHistory: true });
        statusReadCount += 1;
        return statusReadCount === 1
          ? [null]
          : [
              {
                commitment: "confirmed",
                error: null,
              },
            ];
      },
    },
  };
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0, 0],
  });
  assert.equal(status.kind, "confirmed");
  assert.equal(statusReadCount, 2);
});

test("does not treat a processed transaction as failed", async () => {
  const transactionSignature = new Uint8Array(64).fill(6);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      getSignatureStatuses: async () => {
        statusReadCount += 1;
        return [
          {
            commitment: statusReadCount === 1 ? "processed" : "confirmed",
            error: null,
          },
        ];
      },
    },
  };
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0, 0],
  });
  assert.equal(status.kind, "confirmed");
  assert.equal(statusReadCount, 2);
});

test("bounds stalled confirmation and reconciles the exact signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(8);
  const umi = {
    rpc: {
      sendTransaction: async () => transactionSignature,
      confirmTransaction: async () => new Promise(() => {}),
      getSignatureStatuses: async () => [
        { commitment: "confirmed", error: null },
      ],
    },
  };
  const startedAtMs = Date.now();
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    confirmationTimeoutMs: 1,
    statusRetryDelaysMs: [0],
  });
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("exits a stalled unresolved confirmation before the function deadline", async () => {
  const transactionSignature = new Uint8Array(64).fill(9);
  const umi = {
    rpc: {
      sendTransaction: async () => transactionSignature,
      confirmTransaction: async () => new Promise(() => {}),
      getSignatureStatuses: async () => [null],
    },
  };
  const startedAtMs = Date.now();
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      confirmationTimeoutMs: 1,
      statusRetryDelaysMs: [0],
    }),
    (error) => error.code === "confirmation-timeout",
  );
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("bounds a stalled send before confirming the exact signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(10);
  const umi = {
    rpc: {
      sendTransaction: async () => new Promise(() => {}),
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  };
  const startedAtMs = Date.now();
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    sendTimeoutMs: 1,
  });
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("bounds stalled exact-signature status reads", async () => {
  const transactionSignature = new Uint8Array(64).fill(11);
  const startedAtMs = Date.now();
  const status = await waitForSubmittedTransactionStatus({
    umi: {
      rpc: {
        getSignatureStatuses: async () => new Promise(() => {}),
      },
    },
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0],
    statusRequestTimeoutMs: 1,
  });
  assert.equal(status.kind, "unknown");
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("recovers an ambiguous send error when the signature was confirmed", async () => {
  const sendError = new Error("RPC response was lost");
  const transactionSignature = new Uint8Array(64).fill(2);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async (signature, options) => {
        assert.equal(signature, transactionSignature);
        assert.deepEqual(options, {
          commitment: "confirmed",
          strategy: {
            type: "blockhash",
            blockhash: "blockhash",
            lastValidBlockHeight: 123,
          },
        });
        return { value: { err: null } };
      },
      getSignatureStatuses: async () => {
        statusReadCount += 1;
        return [null];
      },
    },
  };
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    statusRetryDelaysMs: [0],
  });
  assert.equal(statusReadCount, 0);
});

test("preserves an ambiguous send error when the signature is not confirmed", async () => {
  const sendError = new Error("RPC rejected the request");
  const transactionSignature = new Uint8Array(64).fill(3);
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async () => {
        throw new Error("signature was not confirmed");
      },
      getSignatureStatuses: async () => [null],
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      statusRetryDelaysMs: [0],
    }),
    (error) => error === sendError,
  );
});

test("preserves a confirmed on-chain transaction error", async () => {
  const transactionSignature = new Uint8Array(64).fill(4);
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw new Error("RPC response was lost");
      },
      confirmTransaction: async () => ({
        value: { err: { InstructionError: [0, "Custom"] } },
      }),
      getSignatureStatuses: async () => {
        throw new Error("status fallback should not run");
      },
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      statusRetryDelaysMs: [0],
    }),
    (error) => error.code === "failed-precondition",
  );
});

test("does not wait on a definitive preflight error", async () => {
  const sendError = new Error("preflight failed");
  sendError.logs = ["Program failed"];
  const transactionSignature = new Uint8Array(64).fill(5);
  let confirmationCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async () => {
        confirmationCount += 1;
      },
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
    }),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(confirmationCount, 0);
});

test("rejects a stored signature that does not match the signed transaction", async () => {
  let sendCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        sendCount += 1;
      },
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(new Uint8Array(64).fill(7), {
        transactionSignature: "different-signature",
      }),
    }),
    (error) => error.code === "internal",
  );
  assert.equal(sendCount, 0);
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

test("reads an expired persisted signature for completed-transfer recovery", () => {
  const transactionSignature = new Uint8Array(64).fill(10);
  const serialized = new Uint8Array([1, 2, 3]);
  const recovered = deserializePersistedSubmittedTransaction(
    {
      transactions: {
        deserialize: (bytes) => {
          assert.deepEqual(bytes, serialized);
          return { signatures: [transactionSignature] };
        },
      },
    },
    {
      signedTransactionBase64: Buffer.from(serialized).toString("base64"),
      transactionSignature: bs58.default.encode(transactionSignature),
      blockhash: "expired-blockhash",
      lastValidBlockHeight: 1,
    },
  );
  assert.equal(recovered.blockhash, "expired-blockhash");
  assert.equal(recovered.lastValidBlockHeight, 1);
  assert.equal(
    recovered.transactionSignature,
    bs58.default.encode(transactionSignature),
  );
});

test("recovers a confirmed submitted transfer after the NFT moved again", async () => {
  const transactionSignature = new Uint8Array(64).fill(11);
  const serialized = new Uint8Array([4, 5, 6]);
  let statusReadCount = 0;
  const recovery = await recoverSubmittedWithdrawal({
    umi: {
      transactions: {
        deserialize: () => ({ signatures: [transactionSignature] }),
      },
      rpc: {
        getSignatureStatuses: async () => {
          statusReadCount += 1;
          return [{ commitment: "finalized", error: null }];
        },
      },
    },
    withdrawal: {
      signedTransactionBase64: Buffer.from(serialized).toString("base64"),
      transactionSignature: bs58.default.encode(transactionSignature),
      blockhash: "expired-blockhash",
      lastValidBlockHeight: 1,
    },
    assetOwner: "11111111111111111111111111111112",
    recipientAddress,
    statusRetryDelaysMs: [0],
  });
  assert.equal(recovery.kind, "completed");
  assert.equal(statusReadCount, 1);
});

test("keeps a submitted withdrawal retryable when status is unavailable", async () => {
  const transactionSignature = new Uint8Array(64).fill(12);
  const statusError = new Error("RPC unavailable");
  let statusReadCount = 0;
  await assert.rejects(
    recoverSubmittedWithdrawal({
      umi: {
        transactions: {
          deserialize: () => ({ signatures: [transactionSignature] }),
        },
        rpc: {
          getSignatureStatuses: async () => {
            statusReadCount += 1;
            throw statusError;
          },
        },
      },
      withdrawal: {
        signedTransactionBase64: Buffer.from([7]).toString("base64"),
        transactionSignature: bs58.default.encode(transactionSignature),
        blockhash: "blockhash",
        lastValidBlockHeight: 123,
      },
      assetOwner: "11111111111111111111111111111112",
      recipientAddress,
      statusRetryDelaysMs: [0],
    }),
    (error) => error === statusError,
  );
  assert.equal(statusReadCount, 1);
});

test("rejects a mismatched persisted signature before reading its status", async () => {
  let statusReadCount = 0;
  await assert.rejects(
    recoverSubmittedWithdrawal({
      umi: {
        transactions: {
          deserialize: () => ({ signatures: [new Uint8Array(64).fill(13)] }),
        },
        rpc: {
          getSignatureStatuses: async () => {
            statusReadCount += 1;
            return [null];
          },
        },
      },
      withdrawal: {
        signedTransactionBase64: Buffer.from([8]).toString("base64"),
        transactionSignature: "different-signature",
        blockhash: "blockhash",
        lastValidBlockHeight: 123,
      },
      assetOwner: EVENT_PRIZE_ADMIN_WALLET,
      recipientAddress,
      statusRetryDelaysMs: [0],
    }),
    (error) => error.code === "internal",
  );
  assert.equal(statusReadCount, 0);
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
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
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
        return {
          committed: true,
          snapshot: { val: () => next },
        };
      },
    }),
  });
  admin.firestore = mockProfileMergeTargets({
    [originalProfileId]: currentProfileId,
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

test("completed reconciliation cleans every profile in a merge chain", async (t) => {
  const originalDatabase = admin.database;
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
  });
  const sourceProfileId = "profile-source";
  const middleProfileId = "profile-middle";
  const targetProfileId = "profile-target";
  const profileIds = [sourceProfileId, middleProfileId, targetProfileId];
  const assignments = new Map(
    profileIds.map((candidateProfileId) => [
      `profileEventPrizes/${candidateProfileId}/${eventId}`,
      { eventId, prizeId, profileId: candidateProfileId, place: 1 },
    ]),
  );
  admin.firestore = mockProfileMergeTargets({
    [sourceProfileId]: middleProfileId,
    [middleProfileId]: targetProfileId,
  });
  admin.database = () => ({
    ref: (path) => ({
      transaction: async (update) => {
        const next = update(assignments.get(path) ?? null);
        assignments.set(path, next);
        return {
          committed: true,
          snapshot: { val: () => next },
        };
      },
    }),
  });

  await reconcileCompletedWithdrawalProjections({
    withdrawal: {
      profileId: targetProfileId,
      entitledProfileId: sourceProfileId,
    },
    profileIds: [],
    eventId,
    prizeId,
  });

  profileIds.forEach((candidateProfileId) => {
    assert.equal(
      assignments.get(`profileEventPrizes/${candidateProfileId}/${eventId}`),
      null,
    );
  });
});

test("projection cleanup failures remain retryable", async (t) => {
  const originalDatabase = admin.database;
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
  });
  admin.firestore = mockProfileMergeTargets({});
  admin.database = () => ({
    ref: () => ({
      transaction: async () => {
        throw new Error("database unavailable");
      },
    }),
  });

  await assert.rejects(
    reconcileCompletedWithdrawalProjections({
      withdrawal: { profileId },
      profileIds: [],
      eventId,
      prizeId,
    }),
    /database unavailable/,
  );
});

test("a late profile projection removes itself after withdrawal completion", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const assignment = { eventId, prizeId, profileId, place: 1 };
  let currentAssignment = assignment;
  admin.database = () => ({
    ref: (path) => {
      if (path === `eventPrizeWithdrawals/${eventId}/${prizeId}`) {
        return {
          once: async () => ({
            val: () => ({
              status: "completed",
              eventId,
              prizeId,
              assetAddress,
            }),
          }),
        };
      }
      assert.equal(path, `profileEventPrizes/${profileId}/${eventId}`);
      return {
        transaction: async (update) => {
          currentAssignment = update(currentAssignment);
          return {
            committed: true,
            snapshot: { val: () => currentAssignment },
          };
        },
      };
    },
  });

  assert.equal(
    await removeProfileEventPrizeAssignmentIfWithdrawalCompleted({
      profileId,
      eventId,
      assignment,
    }),
    true,
  );
  assert.equal(currentAssignment, null);
});

test("late cleanup preserves a newer assignment for another prize", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const completedAssignment = { eventId, prizeId, profileId, place: 1 };
  const currentAssignment = {
    eventId,
    prizeId: "1111",
    profileId,
    place: 2,
  };
  let storedAssignment = currentAssignment;
  admin.database = () => ({
    ref: (path) => {
      if (path === `eventPrizeWithdrawals/${eventId}/${prizeId}`) {
        return {
          once: async () => ({
            val: () => ({
              status: "completed",
              eventId,
              prizeId,
              assetAddress,
            }),
          }),
        };
      }
      return {
        transaction: async (update) => {
          storedAssignment = update(storedAssignment);
          return {
            committed: true,
            snapshot: { val: () => storedAssignment },
          };
        },
      };
    },
  });

  assert.equal(
    await removeProfileEventPrizeAssignmentIfWithdrawalCompleted({
      profileId,
      eventId,
      assignment: completedAssignment,
    }),
    true,
  );
  assert.deepEqual(storedAssignment, currentAssignment);
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
          return {
            committed: true,
            snapshot: { val: () => next },
          };
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
      return {
        committed: true,
        snapshot: { val: () => next },
      };
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

test("removes a completed prize projection after a stale local read", async () => {
  const authoritative = { eventId, prizeId, profileId, place: 1 };
  const inputs = [];
  const targetRef = {
    transaction: async (update) => {
      inputs.push(null);
      assert.equal(update(null), null);
      inputs.push(authoritative);
      const removed = update(authoritative);
      return {
        committed: true,
        snapshot: { val: () => removed },
      };
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
  assert.deepEqual(inputs, [null, authoritative]);
});
