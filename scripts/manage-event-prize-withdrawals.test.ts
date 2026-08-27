import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalize,
  manageEventPrizeWithdrawals,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
  type ManagementDependencies,
  type StorageControl,
} from "./manage-event-prize-withdrawals.ts";

function fixture() {
  return normalizeSnapshot({
    event1: {
      prize1: {
        eventId: "event1",
        prizeId: "prize1",
        status: "submitted",
        leaseExpiresAtMs: 100,
        recipientAddress: "recipient",
        signedTransactionBase64: "sensitive-payload",
        updatedAtMs: 90,
      },
    },
  });
}

function dependencies(initial: StorageControl) {
  let control = initial;
  const logs: string[] = [];
  let updates = 0;
  const value: ManagementDependencies = {
    log: (message) => logs.push(message),
    now: () => 101,
    readControl: () => control,
    readSnapshot: fixture,
    updateMode: ({ expected, next }) => {
      assert.deepEqual(control, expected);
      control = next;
      updates += 1;
    },
  };
  return {
    value,
    get control() {
      return control;
    },
    get logs() {
      return logs;
    },
    get updates() {
      return updates;
    },
  };
}

test("normalizes withdrawals and hashes canonical key order", () => {
  const snapshot = fixture();
  assert.equal(
    snapshotDigest(snapshot),
    snapshotDigest({
      event1: Object.fromEntries(Object.entries(snapshot.event1).reverse()),
    }),
  );
  assert.deepEqual(canonicalize({ b: 2, a: { d: 4, c: 3 } }), {
    a: { c: 3, d: 4 },
    b: 2,
  });
});

test("summarizes records without exposing record contents", () => {
  const summary = summarize(fixture(), 101);
  assert.deepEqual(summary.statuses, { submitted: 1 });
  assert.equal(summary.records, 1);
  assert.equal(summary.activeLeases, 0);
  assert.equal(JSON.stringify(summary).includes("sensitive-payload"), false);
  assert.equal(JSON.stringify(summary).includes("recipient"), false);
});

test("management operations are explicit", () => {
  assert.equal(parseArgs(["--status"]), "status");
  assert.equal(parseArgs(["--freeze"]), "freeze");
  assert.equal(parseArgs(["--resume"]), "resume");
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--freeze", "--resume"]));
  assert.throws(() => parseArgs(["--rollback"]));
});

test("freezes and resumes D1 storage idempotently", () => {
  const state = dependencies({ storageMode: "d1", previousStorageMode: null });
  manageEventPrizeWithdrawals("freeze", state.value);
  assert.deepEqual(state.control, {
    storageMode: "frozen",
    previousStorageMode: "d1",
  });
  assert.equal(state.updates, 1);
  manageEventPrizeWithdrawals("freeze", state.value);
  assert.equal(state.updates, 1);
  manageEventPrizeWithdrawals("resume", state.value);
  assert.deepEqual(state.control, {
    storageMode: "d1",
    previousStorageMode: null,
  });
  assert.equal(state.updates, 2);
  manageEventPrizeWithdrawals("resume", state.value);
  assert.equal(state.updates, 2);
});

test("status is read-only", () => {
  const state = dependencies({ storageMode: "d1", previousStorageMode: null });
  manageEventPrizeWithdrawals("status", state.value);
  assert.equal(state.updates, 0);
  assert.match(state.logs[0], /"storageMode":"d1"/);
});

test("rejects malformed identities and statuses", () => {
  assert.throws(() => normalizeSnapshot({ "bad/event": {} }), /invalid/);
  assert.throws(
    () =>
      normalizeSnapshot({
        event1: {
          prize1: { eventId: "other", prizeId: "prize1", status: "processing" },
        },
      }),
    /invalid event prize withdrawal record/,
  );
});
