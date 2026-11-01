import assert from "node:assert/strict";
import test from "node:test";
import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import { canonicalAutomatchFixture } from "./automatchRecordFixture.ts";
import {
  parseAutomatchRecord,
  type AutomatchProfileOutboxRecord,
  type AutomatchTelegramOutboxRecord,
  type AutomatchTelegramSourceRecord,
} from "../../../runtime/automatchRecords.js";
import {
  createAutomatchProfileOutboxSnapshot,
  createAutomatchProjectionCommands,
  createAutomatchTelegramOutboxSnapshot,
  createAutomatchTelegramSourceSnapshot,
  type AutomatchTelegramRatingResultInput,
} from "../src/automatchProjectionRecords.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../src/repositoryContracts.ts";

const inviteId = "auto_example";
const descriptor = {
  finalizedAtMs: 100,
  hostPlayerId: "host",
  guestPlayerId: "guest",
  source: "transition" as const,
  retryNotBeforeMs: null,
};
const pendingProfile = (): Extract<
  AutomatchProfileOutboxRecord,
  { status: "pending" }
> => ({
  schemaVersion: 2,
  status: "pending",
  requestId: "request",
  reason: "automatch-result",
  sourceUpdatedAtMs: 100,
  lastQueuedAtMs: 200,
  historicalMatches: { [inviteId]: descriptor },
  archiveRetry: null,
});
const pendingTelegram = (): Extract<
  AutomatchTelegramOutboxRecord,
  { status: "pending" }
> => ({
  schemaVersion: 2,
  status: "pending",
  requestId: "request",
  updatedAtMs: 200,
});
const source = (): AutomatchTelegramSourceRecord =>
  canonicalAutomatchFixture("telegramAutomatches", {
    lifecycle: "matched",
    matchedText: "Matched",
    matchedInstanceKey: `matched:${inviteId}`,
  })!;
const rating = (): AutomatchTelegramRatingResultInput => ({
  inviteId,
  matchId: inviteId,
  telegramDeliveryVersion: 2,
  status: "done",
  updateRatingMessage: "rating result",
  completedAtMs: 300,
  isEventMatch: false,
  eventOwned: false,
  eventId: null,
});
function memory<Value>(initial: Value | null, retryWith?: Value | null) {
  let current = structuredClone(initial);
  const calls: Array<{ inviteId: string; signal?: AbortSignal }> = [];
  const decisions: TransactionDecision<Value>[] = [];
  return {
    calls,
    decisions,
    read: () => current,
    async transact(
      id: string,
      update: (current: Value | null) => TransactionDecision<Value>,
      signal?: AbortSignal,
    ): Promise<TransactionResult<Value>> {
      signal?.throwIfAborted();
      calls.push({ inviteId: id, ...(signal === undefined ? {} : { signal }) });
      let decision = update(structuredClone(current));
      decisions.push(decision);
      if (retryWith !== undefined) {
        current = structuredClone(retryWith);
        decision = update(structuredClone(current));
        decisions.push(decision);
      }
      if ("value" in decision) current = decision.value;
      return {
        committed: "value" in decision,
        ...(decision.decision === undefined
          ? {}
          : { decision: decision.decision }),
        value: current,
      };
    },
  };
}
function fixture(
  input: {
    source?: AutomatchTelegramSourceRecord;
    telegram?: AutomatchTelegramOutboxRecord;
    profile?: AutomatchProfileOutboxRecord;
    retrySource?: AutomatchTelegramSourceRecord;
    retryTelegram?: AutomatchTelegramOutboxRecord;
  } = {},
) {
  const sources = memory(input.source ?? null, input.retrySource);
  const telegram = memory(input.telegram ?? null, input.retryTelegram);
  const profile = memory(input.profile ?? null);
  return {
    sources,
    telegram,
    profile,
    commands: createAutomatchProjectionCommands({
      transactAutomatchTelegramSource: sources.transact,
      transactAutomatchTelegramOutbox: telegram.transact,
      transactAutomatchProfileOutbox: profile.transact,
    }),
  };
}

test("source snapshots cannot publish a stale waiting message after the invite joins", () => {
  const pending = canonicalAutomatchFixture("telegramAutomatches", {})!;
  const snapshot = createAutomatchTelegramSourceSnapshot(inviteId, pending);
  assert.equal(snapshot.project(null)?.lifecycle, "pending");
  const joined = inviteDocumentFixture({ hostId: "host", guestId: "guest" });
  assert.equal(snapshot.project(joined), null);
  const matched = createAutomatchTelegramSourceSnapshot(inviteId, source());
  assert.equal(matched.project(joined)?.lifecycle, "matched");
  assert.notEqual(snapshot.fingerprint(null), matched.fingerprint(joined));
});
test("outbox snapshots expose exact canonical times and no raw escape", () => {
  const value = pendingTelegram();
  const snapshot = createAutomatchTelegramOutboxSnapshot(value);
  assert.strictEqual(snapshot.value, value);
  assert.equal("raw" in snapshot, false);
  for (const updatedAtMs of [undefined, "200", 200.5, -1])
    assert.throws(
      () =>
        parseAutomatchRecord("telegramProjectionOutbox/automatch", {
          ...value,
          updatedAtMs,
        }),
      /invalid-canonical/,
    );
});
test("profile snapshots expose descriptors without changing stored maps or filling invalid fields", () => {
  const value = pendingProfile(),
    before = structuredClone(value);
  const snapshot = createAutomatchProfileOutboxSnapshot(value);
  assert.deepEqual(snapshot.value?.historicalMatches, [
    {
      matchId: inviteId,
      finalizedAtMs: 100,
      hostPlayerId: "host",
      guestPlayerId: "guest",
      source: "transition",
    },
  ]);
  assert.equal(snapshot.matchesCancellationRequest("request"), true);
  assert.equal(snapshot.matchesCancellationRequest(" request "), false);
  assert.deepEqual(value, before);
  assert.throws(
    () =>
      parseAutomatchRecord("profileGameProjectionOutbox/automatch", {
        ...value,
        extra: true,
      }),
    /invalid-canonical/,
  );
});
test("rating result commands retain existing fragments and advance exact generation once", async () => {
  const original = {
    ...source(),
    results: { [`${inviteId}1`]: { completedAtMs: 200, text: "earlier" } },
  };
  const f = fixture({ source: original });
  assert.equal(
    await f.commands.mergeAutomatchTelegramRatingResult(inviteId, rating()),
    "inserted",
  );
  const stored = f.sources.read()!;
  assert.equal(stored.generation, original.generation + 1);
  assert.deepEqual(
    stored.results[`${inviteId}1`],
    original.results[`${inviteId}1`],
  );
  assert.deepEqual(stored.results[inviteId], {
    completedAtMs: 300,
    text: "rating result",
  });
  assert.equal(stored.updatedAtMs, 300);
  assert.equal(
    await f.commands.mergeAutomatchTelegramRatingResult(inviteId, rating()),
    "duplicate",
  );
  assert.deepEqual(f.sources.read(), stored);
});
test("rating result commands report the final transaction attempt disposition", async () => {
  const retry = {
    ...source(),
    results: { [inviteId]: { completedAtMs: 300, text: "rating result" } },
    generation: 2,
    updatedAtMs: 300,
  };
  const f = fixture({ source: source(), retrySource: retry });
  assert.equal(
    await f.commands.mergeAutomatchTelegramRatingResult(inviteId, rating()),
    "duplicate",
  );
  assert.equal(f.sources.decisions.length, 2);
  assert.deepEqual(f.sources.read(), retry);
});
test("dead marking requires a pending exact request and samples time at each attempt", async () => {
  const f = fixture({
    telegram: pendingTelegram(),
    retryTelegram: pendingTelegram(),
  });
  let clock = 300;
  assert.equal(
    await f.commands.markAutomatchTelegramOutboxDead(
      inviteId,
      "other",
      "terminal",
      () => ++clock,
    ),
    false,
  );
  assert.equal(clock, 300);
  assert.equal(
    await f.commands.markAutomatchTelegramOutboxDead(
      inviteId,
      "request",
      "terminal",
      () => ++clock,
    ),
    true,
  );
  assert.deepEqual(f.telegram.read(), {
    schemaVersion: 2,
    status: "dead",
    requestId: "request",
    reason: "terminal",
    updatedAtMs: null,
    deadAtMs: 302,
  });
});
test("historical settlement uses exact descriptor identity and retains explicit empty history", async () => {
  const f = fixture({ profile: pendingProfile() });
  const expected = {
    matchId: inviteId,
    finalizedAtMs: 100,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    source: "transition" as const,
  };
  assert.equal(
    await f.commands.settleAutomatchHistoricalDescriptor(inviteId, "request", {
      ...expected,
      finalizedAtMs: 101,
    }),
    false,
  );
  assert.equal(
    await f.commands.settleAutomatchHistoricalDescriptor(
      inviteId,
      "request",
      expected,
    ),
    true,
  );
  assert.deepEqual(f.profile.read()?.historicalMatches, {});
  assert.equal(f.profile.read()?.archiveRetry, null);
});
test("cancelled histories and terminal Telegram outboxes cannot be revived by repair commands", async () => {
  const retired: AutomatchProfileOutboxRecord = {
    ...pendingProfile(),
    status: "cancelled",
    retirement: {
      state: "retired",
      retiredAtMs: 500,
      sourceDigest: "a".repeat(64),
    },
  };
  const f = fixture({
    profile: retired,
    telegram: {
      schemaVersion: 2,
      status: "dead",
      requestId: "request",
      updatedAtMs: null,
      deadAtMs: 500,
      reason: "terminal",
    },
  });
  assert.deepEqual(
    await f.commands.repairInvalidAutomatchProfileOutbox(inviteId, 600, () => {
      throw new Error("must-not-create");
    }),
    { kind: "changed" },
  );
  await f.commands.repairInvalidAutomatchTelegramOutbox(inviteId, 600);
  assert.deepEqual(f.profile.read(), retired);
  assert.equal(
    createAutomatchProfileOutboxSnapshot(retired).matchesCancellationRequest(
      "request",
    ),
    false,
  );
});
test("source command cancellation prevents any mutation", async () => {
  const f = fixture({ source: source() }),
    failure = new Error("cancelled");
  await assert.rejects(
    f.commands.mergeAutomatchTelegramRatingResult(
      inviteId,
      rating(),
      AbortSignal.abort(failure),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(f.sources.read(), source());
  assert.deepEqual(f.sources.decisions, []);
});
