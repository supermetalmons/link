import { retainedAutomatchSnapshotFixture } from "./automatchRecordFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAutomatchEntry,
  type AutomatchEntryRead,
} from "../../../runtime/automatchRecords.js";
import { createTypedGameSessionPort } from "../src/gameSessionRecordAdapter.ts";
import { rawGameplayTestPort } from "./gameSessionTestPorts.ts";

function fixture(records: Map<string, unknown>) {
  const reads: Array<{ path: string; signal?: AbortSignal }> = [];
  const raw = rawGameplayTestPort({
    async getPath(path, _query, signal) {
      reads.push({ path, signal });
      signal?.throwIfAborted();
      return records.has(path) ? records.get(path) : null;
    },
    async patchRoot() {
      throw new Error("unexpected-write");
    },
    async transactPath() {
      throw new Error("unexpected-transaction");
    },
  });
  return { raw, port: createTypedGameSessionPort(raw), reads };
}

test("claim adapters forward recovery snapshots and cancellation without serializing them", async () => {
  const { raw } = fixture(new Map());
  const signal = new AbortController().signal;
  const snapshot = retainedAutomatchSnapshotFixture(
    "profileGameProjectionOutbox/automatch",
    "invite",
    { requestId: "request" },
    7,
  );
  const calls: unknown[][] = [];
  raw.claimAutomatchProfileOutbox = async (...args) => {
    calls.push(args);
    return true;
  };
  raw.claimAutomatchTelegramOutbox = async (...args) => {
    calls.push(args);
    return false;
  };
  const port = createTypedGameSessionPort(raw);
  assert.equal(
    await port.claimAutomatchProfileOutbox(
      "invite",
      "request",
      1,
      2,
      signal,
      snapshot,
    ),
    true,
  );
  const telegramSnapshot = retainedAutomatchSnapshotFixture(
    "telegramProjectionOutbox/automatch",
    "invite",
    { requestId: "request" },
    7,
  );
  assert.equal(
    await port.claimAutomatchTelegramOutbox(
      "invite",
      "request",
      1,
      2,
      signal,
      telegramSnapshot,
    ),
    false,
  );
  assert.equal(calls[0][4], signal);
  assert.equal(calls[0][5], snapshot);
  assert.equal(calls[1][4], signal);
  assert.equal(calls[1][5], telegramSnapshot);
});

test("entry adapters preserve selected malformed rows, ordering, and read count", async () => {
  const { port, reads } = fixture(
    new Map<string, unknown>([
      [
        "automatch",
        { first: true, second: { uid: " guest ", timestamp: "1.5" } },
      ],
      ["automatch/first", true],
    ]),
  );
  const signal = new AbortController().signal;
  const entries = await port.readFirstAutomatchEntry(signal);
  assert.deepEqual(Object.keys(entries!), ["first", "second"]);
  assert.deepEqual(entries!.first, {
    isNull: false,
    isTruthy: true,
    record: null,
  });
  assert.equal(entries!.second.record!.uid, " guest ");
  assert.equal(entries!.second.record!.timestamp, 1.5);
  assert.deepEqual(
    await port.readAutomatchEntry("first", signal),
    entries!.first,
  );
  assert.deepEqual(reads, [
    { path: "automatch", signal },
    { path: "automatch/first", signal },
  ]);
});

test("receipt adapters preserve absent and malformed outcomes without extra reads", async () => {
  const { port, reads } = fixture(
    new Map<string, unknown>([
      ["gameplayMutationReceipts/broken", { schemaVersion: 1 }],
    ]),
  );
  assert.deepEqual(await port.readAutomatchReceipt("missing"), {
    kind: "missing",
  });
  assert.deepEqual(await port.readGameSessionMutationReceipt("missing"), {
    kind: "missing",
  });
  assert.deepEqual(await port.readAutomatchReceipt("broken"), {
    kind: "invalid",
  });
  assert.deepEqual(await port.readGameSessionMutationReceipt("broken"), {
    kind: "invalid",
  });
  assert.equal(reads.length, 4);
});

test("outbox reads retain invalid raw request IDs for cancellation confirmation", async () => {
  const rawOutbox = { requestId: " operation ", historicalMatches: false };
  const { port, reads } = fixture(
    new Map<string, unknown>([
      ["profileGameProjectionOutbox/automatch/invite", rawOutbox],
    ]),
  );
  const snapshot = await port.readAutomatchProfileOutbox("invite");
  assert.equal(snapshot.value, null);
  assert.equal("raw" in snapshot, false);
  assert.equal(snapshot.matchesCancellationRequest("operation"), true);
  assert.equal(snapshot.matchesCancellationRequest(" operation "), false);
  assert.equal(reads.length, 1);
  assert.deepEqual(rawOutbox, {
    requestId: " operation ",
    historicalMatches: false,
  });
});

test("typed reads preserve failures and cancellation from raw persistence", async () => {
  const { port, raw } = fixture(new Map());
  const failure = new Error("transition-pending");
  raw.readAutomatchEntry = async () => {
    throw failure;
  };
  await assert.rejects(
    port.readAutomatchEntry("invite"),
    (error) => error === failure,
  );
  const controller = new AbortController();
  controller.abort(failure);
  await assert.rejects(
    port.readGameSessionMutationReceipt("operation", controller.signal),
    (error) => error === failure,
  );
});

test("normal ports expose typed operations and named recovery commands", () => {
  const { port } = fixture(new Map());
  assert.equal("readMutationReceipt" in port, false);
  assert.equal("transactAutomatchTelegramSource" in port, false);
  assert.equal("transactAutomatchProfileOutbox" in port, false);
  assert.equal(
    "transactRawAutomatchProfileOutbox" in port.projectionRecovery,
    false,
  );
  assert.equal(
    "transactRawAutomatchTelegramOutbox" in port.projectionRecovery,
    false,
  );
  assert.equal("listMalformedAutomatchProfileOutboxes" in port, false);
  assert.equal(typeof port.mergeAutomatchTelegramRatingResult, "function");
  assert.equal(
    typeof port.projectionRecovery.repairInvalidAutomatchProfileOutbox,
    "function",
  );
});

test("entry cancellation and navigation observations preserve raw JSON semantics", async () => {
  const values = [null, undefined, false, 0, "", true, "invalid", [], {}];
  for (const value of values) {
    const { port } = fixture(
      new Map<string, unknown>([["automatch/invite", value]]),
    );
    const actual: AutomatchEntryRead = await port.readAutomatchEntry("invite");
    assert.equal(actual.isNull, value === null);
    assert.equal(actual.isTruthy, Boolean(value));
    assert.deepEqual(actual, decodeAutomatchEntry(value));
  }
});
