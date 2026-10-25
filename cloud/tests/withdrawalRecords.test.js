"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  readWithdrawalDocument,
  readStoredWithdrawalDocument,
  storedWithdrawalMatchesIdentity,
  withdrawalStatus,
  withdrawalPlace,
} = require("../runtime/eventPrizes/records");
const {
  createWithdrawalRecordCommands,
  persistSubmittedTransaction,
} = require("../runtime/eventPrizes/withdrawalRepository");
const {
  decideWithdrawalClaim,
  getEventPrizeAssetAddress,
} = require("../runtime/eventPrizeWithdrawalState");
const {
  deserializePersistedSubmittedTransaction,
} = require("../runtime/eventPrizes/submittedTransactions");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
const claim = {
  eventId,
  prizeId,
  assetAddress,
  profileId: "profile",
  place: 1,
  recipientAddress: "11111111111111111111111111111111",
  requesterUid: "uid",
  leaseId: "next-lease",
  nowMs: 1000,
};

function fixture(initial) {
  let current = readWithdrawalDocument(initial);
  const writes = [];
  const record = createWithdrawalRecordCommands({
    read: async () => current,
    async transaction(update) {
      const decision = update(current);
      if ("commit" in decision) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      current = decision.value;
      writes.push(current);
      return { committed: true, decision: decision.decision, value: current };
    },
  });
  return { record, writes };
}

test("withdrawal documents preserve identity and defer legacy numeric observations", () => {
  const source = {
    ...claim,
    status: "completed",
    place: { toString: null },
    futureEvidence: { retained: true },
  };
  const document = readStoredWithdrawalDocument(source);
  assert.strictEqual(document, source);
  assert.deepEqual(Object.getOwnPropertySymbols(document), []);
  assert.equal(withdrawalStatus(document), "completed");
  const result = decideWithdrawalClaim({ ...claim, current: document });
  assert.equal(result.kind, "completed");
  assert.strictEqual(result.value, source);
  assert.throws(() => withdrawalPlace(document), TypeError);
  assert.equal(readStoredWithdrawalDocument([]), null);
});

test("claim retains lease coercion before the completed status branch", () => {
  const current = readWithdrawalDocument({
    ...claim,
    status: "completed",
    leaseExpiresAtMs: { toString: null },
  });
  assert.throws(() => decideWithdrawalClaim({ ...claim, current }), TypeError);
});

test("storage-compatible array statuses never become exact submitted state", () => {
  const current = readWithdrawalDocument({
    ...claim,
    status: ["submitted"],
    futureEvidence: { retained: true },
    signedTransactionBase64: "old",
  });
  assert.equal(
    storedWithdrawalMatchesIdentity(current, eventId, prizeId),
    true,
  );
  assert.equal(withdrawalStatus(current), null);
  const result = decideWithdrawalClaim({ ...claim, current });
  assert.equal(result.kind, "acquired");
  assert.equal(withdrawalStatus(result.value), "processing");
  assert.equal(Object.hasOwn(result.value, "futureEvidence"), false);
  assert.equal(Object.hasOwn(result.value, "signedTransactionBase64"), false);
  assert.deepEqual(current.status, ["submitted"]);
});

test("missing submission strings do not suppress block-height coercion failure", () => {
  const current = readWithdrawalDocument({
    lastValidBlockHeight: { toString: null },
  });
  assert.throws(
    () => deserializePersistedSubmittedTransaction({}, current),
    TypeError,
  );
});

test("unchanged command decisions still write except stale submission discard", async () => {
  const current = {
    ...claim,
    status: "processing",
    leaseId: "owner",
    updatedAtMs: 100,
  };
  const state = fixture(current);
  const originalNow = Date.now;
  let clockCalls = 0;
  Date.now = () => {
    clockCalls++;
    return 200;
  };
  try {
    for (const result of [
      await state.record.releaseProcessing("stale"),
      await state.record.block({ leaseId: "stale", observedOwner: "other" }),
      await state.record.persistSubmission({
        leaseId: "stale",
        transactionSignature: "signature",
        signedTransactionBase64: "AQID",
        blockhash: "hash",
        lastValidBlockHeight: 123,
      }),
    ]) {
      assert.equal(result.committed, true);
      assert.strictEqual(result.value, current);
    }
    const discarded = await state.record.discardSubmission({
      leaseId: "stale",
      transactionSignature: "signature",
    });
    assert.equal(discarded.committed, false);
    assert.equal(discarded.decision, "stale");
    assert.equal(state.writes.length, 3);
    assert.equal(clockCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("submission keeps distinct clock reads and retains unknown source fields", async () => {
  for (const [submittedAtMs, expectedSubmitted, expectedCalls] of [
    ["12.9", 101, 2],
    [12.9, 12, 1],
  ]) {
    const current = {
      ...claim,
      status: "processing",
      leaseId: "owner",
      submittedAtMs,
      futureEvidence: { retained: true },
    };
    const state = fixture(current);
    const originalNow = Date.now;
    let clockCalls = 0;
    Date.now = () => 100 + ++clockCalls;
    try {
      const persisted = await persistSubmittedTransaction({
        withdrawalRecord: state.record,
        leaseId: "owner",
        transactionSignature: "signature",
        signedTransactionBase64: "AQID",
        blockhash: "hash",
        lastValidBlockHeight: 123,
      });
      assert.equal(persisted.submittedAtMs, expectedSubmitted);
      assert.equal(persisted.updatedAtMs, 100 + expectedCalls);
      assert.equal(clockCalls, expectedCalls);
      assert.strictEqual(persisted.futureEvidence, current.futureEvidence);
      assert.strictEqual(state.writes[0], persisted);
      assert.equal(current.status, "processing");
    } finally {
      Date.now = originalNow;
    }
  }
});

test("blocked writes preserve evidence and emit explicit null lease fields", async () => {
  const current = {
    ...claim,
    status: "submitted",
    leaseId: "owner",
    transactionSignature: "signature",
    futureEvidence: { retained: true },
  };
  const state = fixture(current);
  const result = await state.record.block({
    leaseId: "owner",
    observedOwner: "other",
  });
  assert.equal(result.committed, true);
  assert.equal(result.value.status, "blocked");
  assert.equal(result.value.leaseId, null);
  assert.equal(result.value.leaseExpiresAtMs, null);
  assert.equal(result.value.observedOwner, "other");
  assert.equal(result.value.transactionSignature, "signature");
  assert.strictEqual(result.value.futureEvidence, current.futureEvidence);
});
