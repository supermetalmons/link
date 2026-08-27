import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFinalSnapshotSafe,
  buildImportSql,
  canonicalize,
  isFirebaseOriginFreeze,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
} from "./migrate-event-prize-withdrawals.ts";

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

test("builds content-free SQL for an exact replacement import", () => {
  const sql = buildImportSql(fixture(), 1_000);
  assert.match(sql, /^DELETE FROM event_prize_withdrawals;/);
  assert.match(sql, /storage_mode = 'frozen'/);
  assert.equal(sql.includes("sensitive-payload"), false);
  assert.equal(sql.includes("recipient"), false);
});

test("summarizes and rejects only active executor leases", () => {
  const safe = summarize(fixture(), 101);
  assert.deepEqual(safe.statuses, { submitted: 1 });
  assert.equal(safe.activeLeases, 0);
  assert.doesNotThrow(() => assertFinalSnapshotSafe(safe));
  const unsafe = summarize(fixture(), 99);
  assert.equal(unsafe.activeLeases, 1);
  assert.throws(() => assertFinalSnapshotSafe(unsafe), /not quiescent/);
});

test("rejects malformed keys, identities, and statuses", () => {
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
  assert.throws(
    () =>
      normalizeSnapshot({
        event1: {
          prize1: { eventId: "event1", prizeId: "prize1", status: "unknown" },
        },
      }),
    /invalid event prize withdrawal record/,
  );
});

test("migration phases are explicit", () => {
  assert.deepEqual(parseArgs([]), {
    phase: "dry-run",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--freeze", "--project", "demo"]), {
    phase: "freeze",
    project: "demo",
  });
  assert.deepEqual(parseArgs(["--final"]), {
    phase: "final",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--rollback"]), {
    phase: "rollback",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--abort"]), {
    phase: "abort",
    project: "mons-link",
  });
  assert.throws(() => parseArgs(["--freeze", "--final"]));
});

test("final import accepts only a Firebase-origin freeze", () => {
  assert.equal(
    isFirebaseOriginFreeze({
      storageMode: "frozen",
      previousStorageMode: "firebase",
    }),
    true,
  );
  assert.equal(
    isFirebaseOriginFreeze({
      storageMode: "frozen",
      previousStorageMode: "d1",
    }),
    false,
  );
});
