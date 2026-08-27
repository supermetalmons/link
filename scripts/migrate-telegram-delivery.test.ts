import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFinalSnapshotSafe,
  buildImportSql,
  canonicalize,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
} from "./migrate-telegram-delivery.ts";

function fixture() {
  return normalizeSnapshot({
    messages: {
      "event:one:upcoming": {
        desired: { revision: "β", text: "hello 🌟 <b>world</b>" },
        delivery: { status: "delivered" },
      },
    },
    control: null,
    announcements: {
      "18ea8b32-ca88-4492-8ecb-42f87670a901": {
        payloadDigest: "digest",
        status: "sent",
        messageIds: [1, 2],
        createdAtMs: 100,
        updatedAtMs: 200,
      },
    },
  });
}

test("normalizes null control and hashes canonical key order", () => {
  const snapshot = fixture();
  assert.deepEqual(snapshot.control, {});
  assert.equal(
    snapshotDigest(snapshot),
    snapshotDigest({
      announcements: snapshot.announcements,
      control: snapshot.control,
      messages: Object.fromEntries(Object.entries(snapshot.messages).reverse()),
    }),
  );
  assert.deepEqual(canonicalize({ b: 2, a: { d: 4, c: 3 } }), {
    a: { c: 3, d: 4 },
    b: 2,
  });
});

test("builds idempotent hex SQL without exposing message text", () => {
  const sql = buildImportSql(fixture(), 1_000, "final");
  assert.match(sql, /ON CONFLICT \(message_key\) DO UPDATE/);
  assert.match(sql, /storage_mode = 'frozen'/);
  assert.equal(sql.includes("hello"), false);
  assert.equal(sql.includes("🌟"), false);
});

test("summarizes delivery safety state without returning message content", () => {
  const summary = summarize(fixture());
  assert.deepEqual(summary.statuses, { delivered: 1 });
  assert.equal(summary.messages, 1);
  assert.equal(summary.announcements, 1);
  assert.equal("text" in summary, false);
});

test("final migration rejects active delivery state", () => {
  assert.doesNotThrow(() => assertFinalSnapshotSafe(summarize(fixture())));
  const unsafe = normalizeSnapshot({
    messages: {
      active: {
        delivery: {
          status: "processing",
          leaseExpiresAtMs: Date.now() + 60_000,
          sendInFlight: { attemptId: "attempt" },
        },
      },
    },
    control: { apiGate: { owner: "owner" } },
    announcements: null,
  });
  assert.throws(
    () => assertFinalSnapshotSafe(summarize(unsafe)),
    /not quiescent/,
  );
});

test("rejects malformed message and announcement records", () => {
  assert.throws(
    () =>
      normalizeSnapshot({
        messages: { "bad/key": {} },
        control: null,
        announcements: null,
      }),
    /invalid Telegram message record/,
  );
  assert.throws(
    () =>
      normalizeSnapshot({
        messages: {},
        control: null,
        announcements: {
          "not-a-request-id": { status: "sent" },
        },
      }),
    /invalid Telegram announcement record/,
  );
});

test("migration phases are explicit and final is separately selected", () => {
  assert.deepEqual(parseArgs([]), {
    phase: "dry-run",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--final", "--project", "demo"]), {
    phase: "final",
    project: "demo",
  });
  assert.throws(() => parseArgs(["--precopy"]));
});
