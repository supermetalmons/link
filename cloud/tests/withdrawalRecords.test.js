"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalWithdrawalFixture } = require("./withdrawalFixture");
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
} = require("../runtime/eventPrizeWithdrawalState");
const {
  deserializePersistedSubmittedTransaction,
} = require("../runtime/eventPrizes/submittedTransactions");
const address = "11111111111111111111111111111111";
const evidence = {
  transactionSignature: "signature",
  signedTransactionBase64: "AQID",
  blockhash: address,
  lastValidBlockHeight: 123,
};
/** @param {import("../runtime/eventPrizes/records").WithdrawalDocument | null} initial @param {() => number} [now] */
function fixture(initial, now = Date.now) {
  let current = initial;
  if (current !== null) assert.ok(readWithdrawalDocument(current));
  /** @type {(import("../runtime/eventPrizes/records").WithdrawalDocument | null)[]} */
  const writes = [];
  const record = createWithdrawalRecordCommands(
    {
      read: async () => current,
      async transaction(update) {
        const decision = update(current);
        if ("commit" in decision)
          return {
            committed: false,
            ...(decision.decision === undefined
              ? {}
              : { decision: decision.decision }),
            value: current,
          };
        current = decision.value;
        if (current !== null) assert.ok(readWithdrawalDocument(current));
        writes.push(current);
        return {
          committed: true,
          ...(decision.decision === undefined
            ? {}
            : { decision: decision.decision }),
          value: current,
        };
      },
    },
    { now },
  );
  return { record, writes };
}

test("stored withdrawal documents reject unknown fields and retain complete canonical identity", () => {
  const source = canonicalWithdrawalFixture({ status: "completed" });
  assert.strictEqual(readStoredWithdrawalDocument(source), source);
  assert.equal(withdrawalStatus(source), "completed");
  assert.equal(withdrawalPlace(source), 1);
  assert.equal(
    storedWithdrawalMatchesIdentity(source, source.eventId, source.prizeId),
    true,
  );
  for (const malformed of [
    { ...source, futureEvidence: {} },
    { ...source, place: "1" },
    { ...source, schemaVersion: 0 },
    [],
    {},
  ])
    assert.equal(readStoredWithdrawalDocument(malformed), null);
});

test("lifecycle parsers reject impossible leases and submission evidence without coercion", () => {
  const processing = canonicalWithdrawalFixture();
  const submitted = canonicalWithdrawalFixture({ status: "submitted" });
  const completed = canonicalWithdrawalFixture({ status: "completed" });
  for (const malformed of [
    { ...processing, transactionSignature: "premature" },
    { ...submitted, blockhash: null },
    { ...submitted, lastValidBlockHeight: "123" },
    { ...completed, leaseId: "still-owned" },
    { ...submitted, status: ["submitted"] },
  ])
    assert.equal(readWithdrawalDocument(malformed), null);
});

test("completed receipts replay without acquiring or changing leases", () => {
  const current = canonicalWithdrawalFixture({ status: "completed" });
  const result = decideWithdrawalClaim({
    current,
    eventId: current.eventId,
    prizeId: current.prizeId,
    assetAddress: current.assetAddress,
    profileId: current.profileId,
    place: 1,
    recipientAddress: address,
    requesterUid: "uid",
    leaseId: "new",
    nowMs: 1000,
  });
  assert.equal(result.kind, "completed");
  assert.strictEqual(result.value, current);
});

test("only complete signed evidence is deserialized and storage fields remain exact", () => {
  let calls = 0;
  const umi = {
    transactions: {
      /** @param {Uint8Array} bytes */
      deserialize(bytes) {
        calls++;
        assert.deepEqual([...bytes], [1, 2, 3]);
        return { bytes };
      },
    },
  };
  assert.equal(
    Reflect.apply(deserializePersistedSubmittedTransaction, undefined, [
      umi,
      canonicalWithdrawalFixture(),
    ]),
    null,
  );
  const submitted = canonicalWithdrawalFixture({
    status: "submitted",
    ...evidence,
  });
  assert.deepEqual(
    Reflect.apply(deserializePersistedSubmittedTransaction, undefined, [
      umi,
      submitted,
    ]),
    {
      signedTransaction: { bytes: new Uint8Array([1, 2, 3]) },
      transactionSignature: "signature",
      blockhash: address,
      lastValidBlockHeight: 123,
    },
  );
  assert.equal(calls, 1);
});

test("stale record commands preserve the current owner and decline stale submission discard", async () => {
  const current = canonicalWithdrawalFixture({ leaseId: "owner" });
  let clocks = 0;
  const state = fixture(current, () => {
    clocks++;
    return 200;
  });
  for (const result of [
    await state.record.releaseProcessing("stale"),
    await state.record.block({ leaseId: "stale", observedOwner: address }),
    await state.record.persistSubmission({ leaseId: "stale", ...evidence }),
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
  assert.equal(clocks, 0);
});

test("submission records distinct clock reads and preserves exact prior evidence on retry", async () => {
  for (const status of /** @type {const} */ (["processing", "submitted"])) {
    const current = canonicalWithdrawalFixture({ status, leaseId: "owner" });
    let clocks = 0;
    const state = fixture(current, () => 100 + ++clocks);
    const persisted = await persistSubmittedTransaction({
      withdrawalRecord: state.record,
      leaseId: "owner",
      ...evidence,
    });
    assert.equal(
      persisted.submittedAtMs,
      status === "submitted" ? current.submittedAtMs : 101,
    );
    assert.equal(clocks, status === "submitted" ? 1 : 2);
    assert.equal(persisted.updatedAtMs, 100 + clocks);
    assert.deepEqual(
      {
        transactionSignature: persisted.transactionSignature,
        signedTransactionBase64: persisted.signedTransactionBase64,
        blockhash: persisted.blockhash,
        lastValidBlockHeight: persisted.lastValidBlockHeight,
      },
      evidence,
    );
    assert.equal(current.status, status);
    assert.ok(readWithdrawalDocument(persisted));
  }
});

test("blocked writes preserve signed evidence and clear leases explicitly", async () => {
  const current = canonicalWithdrawalFixture({
    status: "submitted",
    leaseId: "owner",
    ...evidence,
  });
  const result = await fixture(current, () => 100).record.block({
    leaseId: "owner",
    observedOwner: address,
  });
  assert.ok(result.value);
  assert.equal(result.value.status, "blocked");
  assert.equal(result.value.leaseId, null);
  assert.equal(result.value.leaseExpiresAtMs, null);
  assert.equal(result.value.observedOwner, address);
  assert.equal(
    result.value.transactionSignature,
    evidence.transactionSignature,
  );
  assert.equal(
    result.value.signedTransactionBase64,
    evidence.signedTransactionBase64,
  );
  assert.equal(result.value.completedAtMs, null);
});
