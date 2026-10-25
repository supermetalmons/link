import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomatchProfileOutboxSnapshot,
  createAutomatchProjectionCommands,
  createAutomatchTelegramOutboxSnapshot,
  createAutomatchTelegramSourceSnapshot,
  type AutomatchTelegramRatingResultInput,
} from "../src/automatchProjectionRecords.ts";
import type { RawGameSessionPort } from "../src/gameSessionContracts.ts";
import type { TransactionDecision } from "../src/repositoryContracts.ts";

const inviteId = "auto_example";
const descriptor = {
  matchId: inviteId,
  finalizedAtMs: 100,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  source: "transition" as const,
};

function profileOutbox() {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    reason: "  automatch-result  ",
    sourceUpdatedAtMs: 100.75,
    lastQueuedAtMs: 200.5,
    historicalMatches: {
      [descriptor.matchId]: {
        finalizedAtMs: descriptor.finalizedAtMs,
        hostPlayerId: descriptor.hostPlayerId,
        guestPlayerId: descriptor.guestPlayerId,
        source: descriptor.source,
        extra: { preserve: true },
      },
    },
    extra: { preserve: true },
  };
}

function ratingUpdate(): AutomatchTelegramRatingResultInput {
  return {
    inviteId,
    matchId: inviteId,
    telegramDeliveryVersion: 2,
    status: "done",
    updateRatingMessage: "  rating result  ",
    completedAtMs: 123.75,
  };
}

type RawProjectionTransactions = Pick<
  RawGameSessionPort,
  | "transactAutomatchTelegramSource"
  | "transactAutomatchTelegramOutbox"
  | "transactAutomatchProfileOutbox"
>;

function rawTransactions(initial: unknown, retryWith?: unknown) {
  let current = structuredClone(initial);
  const calls: Array<{ inviteId: string; signal?: AbortSignal }> = [];
  const decisions: TransactionDecision<unknown>[] = [];
  const transact: RawProjectionTransactions["transactAutomatchTelegramSource"] =
    async (id, update, signal) => {
      calls.push({ inviteId: id, signal });
      let decision = update(structuredClone(current));
      decisions.push(decision);
      if (retryWith !== undefined) {
        current = structuredClone(retryWith);
        decision = update(structuredClone(current));
        decisions.push(decision);
      }
      const committed = "value" in decision;
      if ("value" in decision) current = decision.value;
      return { committed, decision: decision.decision, value: current };
    };
  const raw: RawProjectionTransactions = {
    transactAutomatchTelegramSource: transact,
    transactAutomatchTelegramOutbox: transact,
    transactAutomatchProfileOutbox: transact,
  };
  return {
    commands: createAutomatchProjectionCommands(raw),
    calls,
    decisions,
    read: () => current,
  };
}

test("source snapshots defer lifecycle resolution to the concurrent invite read", () => {
  const raw = {
    version: 2,
    lifecycle: "invalid",
    generation: "invalid",
    matchedText: "  matched  ",
    matchedInstanceKey: "  matched:auto_example  ",
    results: {
      auto_example: "  legacy result  ",
      auto_example1: { text: "  next result  ", extra: true },
      empty: { text: "" },
    },
    extra: { preserve: true },
  };
  const snapshot = createAutomatchTelegramSourceSnapshot(inviteId, raw);
  assert.equal(snapshot.project(null), null);
  const projection = snapshot.project(
    inviteDocumentFixture({ guestId: "  guest  " }),
  );
  assert.equal(projection?.lifecycle, "matched");
  assert.equal(projection?.sourceGeneration, 0);
  assert.equal(projection?.text, "matched\n\nlegacy result\n\nnext result");
  assert.equal(projection?.instanceKey, "matched:auto_example");
  assert.equal(
    snapshot.fingerprint(inviteDocumentFixture({ guestId: "  guest  " })),
    JSON.stringify({ source: raw, guestId: "  guest  " }),
  );
  assert.notEqual(
    snapshot.fingerprint(inviteDocumentFixture({ guestId: "guest" })),
    createAutomatchTelegramSourceSnapshot(inviteId, {
      ...raw,
      extra: { preserve: false },
    }).fingerprint(inviteDocumentFixture({ guestId: "guest" })),
  );
});

test("source snapshots retain raw fingerprints for missing and malformed values", () => {
  for (const raw of [undefined, null, false, "malformed", ["malformed"]]) {
    const snapshot = createAutomatchTelegramSourceSnapshot(inviteId, raw);
    assert.equal(
      snapshot.project(inviteDocumentFixture({ guestId: "guest" })),
      null,
    );
    for (const guestId of [undefined, null, false, 0, "", "guest", { id: 1 }]) {
      assert.equal(
        snapshot.fingerprint(inviteDocumentFixture({ guestId: guestId })),
        JSON.stringify({ source: raw, guestId: guestId || null }),
      );
    }
  }
  const snapshot = createAutomatchTelegramSourceSnapshot(inviteId, {
    version: 1,
    lifecycle: "matched",
    matchedText: "matched",
    matchedInstanceKey: "matched:auto_example",
  });
  assert.equal(
    snapshot.project(inviteDocumentFixture({ guestId: "guest" })),
    null,
  );
});

test("Telegram outbox snapshots keep source fields intact while exposing the parsed timestamp", () => {
  const raw = {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    updatedAtMs: 123.75,
    extra: { preserve: true },
  };
  const before = structuredClone(raw);
  const snapshot = createAutomatchTelegramOutboxSnapshot(raw);
  assert.equal("raw" in snapshot, false);
  assert.deepEqual(raw, before);
  assert.deepEqual(snapshot.value, {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    updatedAtMs: 123,
  });
  for (const invalid of [
    undefined,
    null,
    false,
    ["malformed"],
    { ...raw, status: "dead" },
    { ...raw, updatedAtMs: Number.NaN },
    { ...raw, requestId: "unsafe/path" },
  ]) {
    const before = structuredClone(invalid);
    const invalidSnapshot = createAutomatchTelegramOutboxSnapshot(invalid);
    assert.equal("raw" in invalidSnapshot, false);
    assert.deepEqual(invalid, before);
    assert.equal(invalidSnapshot.value, null);
  }
});

test("profile snapshots separate parsed arrays and defaults from the stored maps", () => {
  const raw = {
    ...profileOutbox(),
    archiveRetry: { requestId: "unsafe/path", notBeforeMs: 1 },
  };
  const before = structuredClone(raw);
  const snapshot = createAutomatchProfileOutboxSnapshot(raw);
  assert.equal("raw" in snapshot, false);
  assert.deepEqual(raw, before);
  assert.deepEqual(snapshot.value, {
    schemaVersion: 1,
    status: "pending",
    requestId: "request-1",
    reason: "automatch-result",
    sourceUpdatedAtMs: 100,
    lastQueuedAtMs: 200,
    historicalMatches: [descriptor],
  });
  assert.equal(
    createAutomatchProfileOutboxSnapshot({ ...raw, reason: "" }).value?.reason,
    "automatch-queue",
  );
  const invalidRetry = {
    ...raw,
    historicalMatches: {
      ...raw.historicalMatches,
      [descriptor.matchId]: {
        ...raw.historicalMatches[descriptor.matchId],
        retryNotBeforeMs: "invalid",
      },
    },
  };
  assert.deepEqual(
    createAutomatchProfileOutboxSnapshot(invalidRetry).value?.historicalMatches,
    [descriptor],
  );
  const malformed = {
    ...raw,
    historicalMatches: { ...raw.historicalMatches, broken: {} },
  };
  const beforeMalformed = structuredClone(malformed);
  const malformedSnapshot = createAutomatchProfileOutboxSnapshot(malformed);
  assert.equal("raw" in malformedSnapshot, false);
  assert.deepEqual(malformed, beforeMalformed);
  assert.equal(malformedSnapshot.value, null);
});

test("rating result commands preserve raw siblings, coercions and duplicate behavior", async () => {
  const raw = {
    version: 2,
    generation: "invalid",
    updatedAtMs: 50.75,
    results: { older: "legacy", malformed: { extra: true } },
    extra: { preserve: true },
  };
  const fixture = rawTransactions(raw);
  const signal = new AbortController().signal;
  assert.equal(
    await fixture.commands.mergeAutomatchTelegramRatingResult(
      inviteId,
      ratingUpdate(),
      signal,
    ),
    "inserted",
  );
  const stored = {
    ...raw,
    generation: 1,
    updatedAtMs: 123,
    results: {
      ...raw.results,
      [inviteId]: { text: "  rating result  ", completedAtMs: 123 },
    },
  };
  assert.deepEqual(fixture.read(), stored);
  assert.deepEqual(fixture.calls, [{ inviteId, signal }]);
  assert.equal(
    await fixture.commands.mergeAutomatchTelegramRatingResult(
      inviteId,
      ratingUpdate(),
    ),
    "duplicate",
  );
  assert.deepEqual(fixture.read(), stored);
  assert.equal(
    await fixture.commands.mergeAutomatchTelegramRatingResult(inviteId, {
      ...ratingUpdate(),
      isEventMatch: true,
    }),
    "skipped",
  );
  assert.deepEqual(fixture.read(), stored);
});

test("rating result commands return the final transaction attempt's disposition", async () => {
  const fixture = rawTransactions(
    { version: 2 },
    { version: 2, results: { [inviteId]: null }, extra: true },
  );
  assert.equal(
    await fixture.commands.mergeAutomatchTelegramRatingResult(
      inviteId,
      ratingUpdate(),
    ),
    "duplicate",
  );
  assert.deepEqual(fixture.read(), {
    version: 2,
    results: { [inviteId]: null },
    extra: true,
  });
  assert.equal(fixture.decisions.length, 2);
});

test("dead marking matches only the request and samples its clock inside each attempt", async () => {
  const raw = { requestId: "request-1", status: "invalid", extra: true };
  const fixture = rawTransactions(raw, { ...raw, extra: "newer" });
  const signal = new AbortController().signal;
  let nowMs = 100;
  assert.equal(
    await fixture.commands.markAutomatchTelegramOutboxDead(
      inviteId,
      "request-1",
      "invalid-source",
      () => nowMs++,
      signal,
    ),
    true,
  );
  assert.deepEqual(fixture.read(), {
    ...raw,
    extra: "newer",
    status: "dead",
    reason: "invalid-source",
    updatedAtMs: null,
    deadAtMs: 101,
  });
  assert.deepEqual(fixture.calls, [{ inviteId, signal }]);
  assert.equal(
    await fixture.commands.markAutomatchTelegramOutboxDead(
      inviteId,
      "superseded",
      "invalid-source",
      () => {
        throw new Error("unexpected-clock");
      },
    ),
    false,
  );
});

test("historical settlement preserves extra fields and deletes the empty history property", async () => {
  const raw = profileOutbox();
  const fixture = rawTransactions(raw);
  const signal = new AbortController().signal;
  assert.equal(
    await fixture.commands.settleAutomatchHistoricalDescriptor(
      inviteId,
      "request-1",
      descriptor,
      500,
      signal,
    ),
    true,
  );
  assert.deepEqual(fixture.read(), {
    ...raw,
    historicalMatches: {
      [descriptor.matchId]: {
        ...raw.historicalMatches[descriptor.matchId],
        retryNotBeforeMs: 500,
      },
    },
  });
  assert.deepEqual(fixture.calls, [{ inviteId, signal }]);
  assert.equal(
    await fixture.commands.settleAutomatchHistoricalDescriptor(
      inviteId,
      "request-1",
      descriptor,
    ),
    false,
  );
  assert.equal(
    await fixture.commands.settleAutomatchHistoricalDescriptor(
      inviteId,
      "request-1",
      { ...descriptor, retryNotBeforeMs: 500 },
    ),
    true,
  );
  const { historicalMatches, ...remaining } = raw;
  assert.equal(Object.keys(historicalMatches).length, 1);
  assert.deepEqual(fixture.read(), remaining);
  assert.equal(
    await fixture.commands.settleAutomatchHistoricalDescriptor(
      inviteId,
      "request-1",
      descriptor,
    ),
    false,
  );
});

test("historical settlement rejects superseded and malformed outboxes", async () => {
  for (const raw of [
    null,
    "malformed",
    { ...profileOutbox(), requestId: "newer-request" },
    { ...profileOutbox(), historicalMatches: { broken: {} } },
  ]) {
    const fixture = rawTransactions(raw);
    assert.equal(
      await fixture.commands.settleAutomatchHistoricalDescriptor(
        inviteId,
        "request-1",
        descriptor,
      ),
      false,
    );
    assert.deepEqual(fixture.read(), raw);
  }
});
