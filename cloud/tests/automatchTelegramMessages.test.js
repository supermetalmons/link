const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TELEGRAM_AUTOMATCH_VERSION,
  buildPendingAutomatchTelegramSource,
  buildMatchedAutomatchTelegramChanges,
  buildAutomatchTelegramLifecycleChanges,
} = require("../runtime/telegram/automatchSource");
const {
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  resolveAutomatchTelegramLifecycle,
  getAutomatchResultFragments,
  renderMatchedAutomatchTelegramText,
} = require("../runtime/telegram/projectionCore");

const { invite } = require("./fixtures/canonicalProfileGames");

const inviteId = "auto_example";
const waitingText =
  '<tg-emoji emoji-id="1">&#11088;</tg-emoji> Alice (1512) is looking for a match https://mons.link <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>';
const matchedText =
  '<tg-emoji emoji-id="1">&#11088;</tg-emoji> Alice (1512) vs. Bob (1487) https://mons.link/auto_example';
const canceledText =
  '<i><tg-emoji emoji-id="1">&#11088;</tg-emoji> Alice (1512) canceled an automatch</i>';

/**
 * @typedef {import("../runtime/automatchRecords").AutomatchTelegramSourceRecord} Source
 * @typedef {Partial<Omit<Source, "results">> & {results?: Record<string, {text: string, completedAtMs?: number}>}} SourcePatch
 */
/** @param {SourcePatch} [overrides] @returns {Source} */
const makeSource = (overrides = {}) => ({
  schemaVersion: 1,
  version: TELEGRAM_AUTOMATCH_VERSION,
  lifecycle: "matched",
  waitingText,
  canceledText,
  matchedText,
  waitingInstanceKey: `waiting:${inviteId}`,
  matchedInstanceKey: `matched:${inviteId}`,
  generation: 2,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...overrides,
  results: Object.fromEntries(
    Object.entries(overrides.results ?? {}).map(([key, value]) => [
      key,
      { completedAtMs: 1, ...value },
    ]),
  ),
});

test("pending source stores exact waiting and canceled messages", () => {
  const timestamp = /** @type {const} */ ({ kind: "timestamp" });
  assert.deepEqual(
    buildPendingAutomatchTelegramSource({
      inviteId,
      waitingText,
      canceledText,
      timestamp,
    }),
    {
      schemaVersion: 1,
      version: 2,
      generation: 1,
      matchedText: null,
      matchedInstanceKey: null,
      results: {},
      lifecycle: "pending",
      waitingText,
      canceledText,
      waitingInstanceKey: `waiting:${inviteId}`,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    },
  );
});

test("matched and canceled lifecycle builders only update source state", () => {
  const timestamp = 123;
  const generation = /** @type {const} */ ({ kind: "increment", delta: 1 });
  assert.deepEqual(
    buildMatchedAutomatchTelegramChanges({
      inviteId,
      matchedText,
      timestamp,
      generation,
    }),
    [
      {
        kind: "telegram-source-merge",
        inviteId,
        value: {
          lifecycle: "matched",
          matchedText,
          matchedInstanceKey: `matched:${inviteId}`,
          updatedAtMs: timestamp,
          generation,
        },
      },
    ],
  );
  assert.deepEqual(
    buildAutomatchTelegramLifecycleChanges({
      inviteId,
      lifecycle: "canceled",
      timestamp,
      generation,
    }),
    [
      {
        kind: "telegram-source-merge",
        inviteId,
        value: {
          lifecycle: "canceled",
          updatedAtMs: timestamp,
          generation,
        },
      },
    ],
  );
});

test("guest presence always resolves the lifecycle to matched", () => {
  assert.equal(
    resolveAutomatchTelegramLifecycle(
      makeSource({ lifecycle: "canceled" }),
      invite({ guestId: "guest" }),
    ),
    "matched",
  );
  assert.equal(
    resolveAutomatchTelegramLifecycle(
      makeSource({ lifecycle: "canceled" }),
      invite({ guestId: null }),
    ),
    "canceled",
  );
  assert.equal(
    Reflect.apply(resolveAutomatchTelegramLifecycle, undefined, [
      { version: 1, lifecycle: "pending" },
      {},
    ]),
    null,
  );
  const projection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "canceled" }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(projection);
  assert.equal(projection.operation, "send");
  assert.equal(projection.instanceKey, `matched:${inviteId}`);
  assert.equal(projection.text, matchedText);
});

test("result fragments render once in deterministic rematch order", () => {
  const source = makeSource({
    results: {
      [`${inviteId}2`]: { text: "second rematch" },
      unrelated: { text: "fallback" },
      [inviteId]: { text: "first game" },
      [`${inviteId}1`]: { text: "first rematch" },
      empty: { text: "" },
    },
  });
  assert.deepEqual(
    getAutomatchResultFragments(inviteId, source).map(
      ({ matchId, text, matchIndex }) => ({ matchId, text, matchIndex }),
    ),
    [
      { matchId: inviteId, text: "first game", matchIndex: 0 },
      {
        matchId: `${inviteId}1`,
        text: "first rematch",
        matchIndex: 1,
      },
      {
        matchId: `${inviteId}2`,
        text: "second rematch",
        matchIndex: 2,
      },
      { matchId: "unrelated", text: "fallback", matchIndex: null },
    ],
  );
  assert.equal(
    renderMatchedAutomatchTelegramText(inviteId, source),
    `${matchedText}\n\nfirst game\n\nfirst rematch\n\nsecond rematch\n\nfallback`,
  );
});

test("pending projection builds the existing HTML message as a send", () => {
  const projection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "pending" }),
    inviteData: invite({ guestId: null }),
  });
  assert.ok(projection);
  assert.deepEqual(
    {
      ...projection,
      sourceRevision: typeof projection.sourceRevision,
    },
    {
      operation: "send",
      messageKey: `automatch:${inviteId}`,
      destination: "community",
      instanceKey: `waiting:${inviteId}`,
      text: waitingText,
      parseMode: "HTML",
      silent: false,
      lifecycle: "pending",
      sourceGeneration: 2,
      resultDigests: {},
      sourceRevision: "string",
    },
  );
});

test("matched results edit the fresh matched instance and send if missing", () => {
  const projection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({
      results: {
        [inviteId]: { text: "Alice 1523↑ Bob 1476↓ (7 - 3)" },
      },
    }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(projection);
  assert.equal(projection.operation, "edit");
  assert.equal(projection.instanceKey, `matched:${inviteId}`);
  assert.equal(projection.ifMissing, "send");
  assert.equal(
    projection.text,
    `${matchedText}\n\nAlice 1523↑ Bob 1476↓ (7 - 3)`,
  );
});

test("cancellation edits only the waiting instance and skips if missing", () => {
  const projection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "canceled" }),
    inviteData: invite({ guestId: null }),
  });
  assert.ok(projection);
  assert.equal(projection.operation, "edit");
  assert.equal(projection.instanceKey, `waiting:${inviteId}`);
  assert.equal(projection.text, canceledText);
  assert.equal(projection.ifMissing, "skip");
});

test("v1 sources are never projected", () => {
  assert.equal(
    Reflect.apply(buildAutomatchTelegramProjection, undefined, [
      {
        inviteId,
        source: { ...makeSource(), version: 1 },
        inviteData: invite({ guestId: "guest" }),
      },
    ]),
    null,
  );
});

test("stale pending projection cannot replace a matched applied instance", () => {
  const pendingProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "pending", generation: 99 }),
    inviteData: invite({ guestId: null }),
  });
  assert.ok(pendingProjection);
  const decision = Reflect.apply(evaluateAutomatchProjectionUpdate, undefined, [
    {
      applied: {
        messageId: 42,
        instanceKey: `matched:${inviteId}`,
      },
      delivery: { status: "delivered" },
    },
    pendingProjection,
  ]);

  assert.deepEqual(decision, {
    allowed: false,
    reason: "matched-regression",
  });
});

test("projection guards retain matched lifecycle and source generation", () => {
  const matchedProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ generation: 2 }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(matchedProjection);
  const guard = buildAutomatchProjectionGuard(matchedProjection);

  assert.equal(guard.lifecycle, "matched");
  assert.equal(guard.sourceGeneration, 2);
  assert.equal(guard.sourceRevision, matchedProjection.sourceRevision);
});

test("stale cancellation cannot replace matched desired state", () => {
  const matchedProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ generation: 5 }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(matchedProjection);
  const canceledProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "canceled", generation: 6 }),
    inviteData: invite({ guestId: null }),
  });
  assert.ok(canceledProjection);
  const decision = Reflect.apply(evaluateAutomatchProjectionUpdate, undefined, [
    {
      automatchProjection: buildAutomatchProjectionGuard(matchedProjection),
    },
    canceledProjection,
  ]);

  assert.deepEqual(decision, {
    allowed: false,
    reason: "matched-regression",
  });
});

test("pending projection cannot replace canceled desired state", () => {
  const pendingProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({ lifecycle: "pending", generation: 3 }),
    inviteData: invite({ guestId: null }),
  });
  assert.ok(pendingProjection);
  const decision = Reflect.apply(evaluateAutomatchProjectionUpdate, undefined, [
    {
      desired: {
        operation: "edit",
        ifMissing: "skip",
        instanceKey: `waiting:${inviteId}`,
      },
    },
    pendingProjection,
  ]);

  assert.deepEqual(decision, {
    allowed: false,
    reason: "canceled-regression",
  });
});

test("matched projection cannot drop result fragments already guarded", () => {
  const moreResultsProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({
      generation: 4,
      results: {
        [inviteId]: { text: "first game" },
        [`${inviteId}1`]: { text: "first rematch" },
      },
    }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(moreResultsProjection);
  const fewerResultsProjection = buildAutomatchTelegramProjection({
    inviteId,
    source: makeSource({
      generation: 5,
      results: {
        [inviteId]: { text: "first game" },
      },
    }),
    inviteData: invite({ guestId: "guest" }),
  });
  assert.ok(fewerResultsProjection);
  const decision = Reflect.apply(evaluateAutomatchProjectionUpdate, undefined, [
    {
      automatchProjection: buildAutomatchProjectionGuard(moreResultsProjection),
    },
    fewerResultsProjection,
  ]);

  assert.deepEqual(decision, {
    allowed: false,
    reason: "result-regression",
  });
});
