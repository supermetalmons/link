import {
  retainedAutomatchSnapshotFixture,
  canonicalAutomatchFixture,
} from "./automatchRecordFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeAutomatchEntry } from "../../../runtime/automatchRecords.js";
import { createTypedGameSessionPort } from "../src/gameSessionRecordAdapter.ts";
import { rawGameplayTestPort } from "./gameSessionTestPorts.ts";

function fixture(records: Map<string, unknown>) {
  const reads: Array<{ path: string; signal?: AbortSignal }> = [];
  const raw = rawGameplayTestPort({
    async getPath(path, _query, signal) {
      reads.push({ path, ...(signal === undefined ? {} : { signal }) });
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
  assert.equal(calls[0]![4], signal);
  assert.equal(calls[0]![5], snapshot);
  assert.equal(calls[1]![4], signal);
  assert.equal(calls[1]![5], telegramSnapshot);
});

test("entry adapters expose canonical values and retain ordering and one read per request", async () => {
  const first = canonicalAutomatchFixture("automatch", {
    uid: "first",
    timestamp: 1,
  });
  const second = canonicalAutomatchFixture("automatch", {
    uid: "second",
    timestamp: 2,
  });
  const { port, reads } = fixture(
    new Map<string, unknown>([
      ["automatch", { first, second }],
      ["automatch/first", first],
    ]),
  );
  const signal = new AbortController().signal;
  assert.deepEqual(await port.readFirstAutomatchEntry(signal), {
    first,
    second,
  });
  assert.deepEqual(await port.readAutomatchEntry("first", signal), first);
  assert.deepEqual(reads, [
    { path: "automatch", signal },
    { path: "automatch/first", signal },
  ]);
});
test("receipt adapters preserve explicit absence and fail closed before exposing malformed persistence", async () => {
  const { port, reads } = fixture(
    new Map([
      [
        "gameplayMutationReceipts/broken",
        { schemaVersion: 1, unexpected: true },
      ],
    ]),
  );
  assert.deepEqual(await port.readAutomatchReceipt("missing"), {
    kind: "missing",
  });
  assert.deepEqual(await port.readGameSessionMutationReceipt("missing"), {
    kind: "missing",
  });
  await assert.rejects(
    port.readAutomatchReceipt("broken"),
    /invalid-canonical/,
  );
  await assert.rejects(
    port.readGameSessionMutationReceipt("broken"),
    /invalid-canonical/,
  );
  assert.equal(reads.length, 4);
});
test("outbox cancellation confirmation uses the exact canonical request identity", async () => {
  const outbox = canonicalAutomatchFixture(
    "profileGameProjectionOutbox/automatch",
    { requestId: "operation" },
  );
  const { port, reads } = fixture(
    new Map([["profileGameProjectionOutbox/automatch/invite", outbox]]),
  );
  const snapshot = await port.readAutomatchProfileOutbox("invite");
  assert.equal(snapshot.value?.requestId, "operation");
  assert.equal(snapshot.matchesCancellationRequest("operation"), true);
  assert.equal(snapshot.matchesCancellationRequest(" operation "), false);
  assert.equal("raw" in snapshot, false);
  assert.equal(reads.length, 1);
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

test("canonical entry absence and presence are explicit for cancellation and navigation", () => {
  assert.equal(decodeAutomatchEntry(null), null);
  const entry = canonicalAutomatchFixture("automatch", { uid: "host" });
  assert.deepEqual(decodeAutomatchEntry(entry), entry);
  for (const invalid of [undefined, false, true, 0, "", {}, { uid: "host" }])
    assert.throws(() => decodeAutomatchEntry(invalid), /invalid-canonical/);
});
