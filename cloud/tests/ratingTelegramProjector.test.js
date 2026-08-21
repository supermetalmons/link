const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldRequestEventRatingProgress,
  requestEventRatingProgress,
  projectRatingUpdateRecord,
  projectRatingTelegramUpdates,
} = require("../functions/ratingTelegramProjector");
const {
  isEventRatingUpdate,
  mergeRatingResultFragment,
  shouldProjectRatingTelegramUpdate,
} = require("../functions/telegram/projectionCore");
const { getRatingEventMetadata } = require("@mons/shared/ratings");

const inviteId = "auto_example";
const makeSource = (overrides = {}) => ({
  version: 2,
  lifecycle: "matched",
  matchedText: "Alice vs. Bob https://mons.link/auto_example",
  matchedInstanceKey: `matched:${inviteId}`,
  updatedAtMs: 100,
  generation: 2,
  ...overrides,
});
const makeRatingUpdate = (overrides = {}) => ({
  telegramDeliveryVersion: 2,
  status: "done",
  inviteId,
  matchId: inviteId,
  updateRatingMessage: "Alice 1523↑ Bob 1476↓ (7 - 3)",
  isEventMatch: false,
  eventId: null,
  completedAtMs: 200,
  ...overrides,
});

const makeEventRatingUpdate = (overrides = {}) =>
  makeRatingUpdate({
    telegramDeliveryVersion: null,
    isEventMatch: true,
    eventOwned: true,
    eventId: "event_example",
    ...overrides,
  });

test("only completed v2 non-event rating updates are projectable", () => {
  assert.equal(shouldProjectRatingTelegramUpdate(makeRatingUpdate()), true);
  assert.equal(
    shouldProjectRatingTelegramUpdate(
      makeRatingUpdate({ telegramDeliveryVersion: 1 }),
    ),
    false,
  );
  assert.equal(
    shouldProjectRatingTelegramUpdate(
      makeRatingUpdate({ status: "processing" }),
    ),
    false,
  );
  assert.equal(
    shouldProjectRatingTelegramUpdate(
      makeRatingUpdate({ isEventMatch: true, eventId: "event" }),
    ),
    false,
  );
  assert.equal(
    shouldProjectRatingTelegramUpdate(
      makeRatingUpdate({ updateRatingMessage: "" }),
    ),
    false,
  );
});

test("rating metadata keeps broad event classification and strict ownership separate", () => {
  assert.deepEqual(getRatingEventMetadata({ eventId: "event_example" }), {
    isEventMatch: true,
    eventOwned: false,
    eventId: "event_example",
  });
  assert.deepEqual(getRatingEventMetadata({ eventOwned: true }), {
    isEventMatch: true,
    eventOwned: true,
    eventId: null,
  });
  assert.deepEqual(getRatingEventMetadata({}), {
    isEventMatch: false,
    eventOwned: false,
    eventId: null,
  });
});

test("only adopted completed event records request event progress", () => {
  assert.equal(isEventRatingUpdate(makeEventRatingUpdate()), true);
  assert.equal(shouldRequestEventRatingProgress(makeEventRatingUpdate()), true);
  assert.equal(
    shouldRequestEventRatingProgress(
      makeEventRatingUpdate({ status: "processing" }),
    ),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(
      makeEventRatingUpdate({ isEventMatch: false }),
    ),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(
      makeEventRatingUpdate({ eventOwned: false }),
    ),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(
      makeEventRatingUpdate({ eventOwned: undefined }),
    ),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(makeEventRatingUpdate({ eventId: null })),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(makeEventRatingUpdate({ inviteId: "" })),
    false,
  );
  assert.equal(
    shouldRequestEventRatingProgress(makeEventRatingUpdate({ matchId: "" })),
    false,
  );
});

test("a result fragment is inserted once under its match id", () => {
  const ratingUpdate = makeRatingUpdate();
  const first = mergeRatingResultFragment(makeSource(), ratingUpdate);
  assert.equal(first.changed, true);
  assert.deepEqual(first.source.results, {
    [inviteId]: {
      text: ratingUpdate.updateRatingMessage,
      completedAtMs: 200,
    },
  });
  assert.equal(first.source.updatedAtMs, 200);
  assert.equal(first.source.generation, 3);

  const duplicate = mergeRatingResultFragment(first.source, ratingUpdate);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.source, first.source);
});

test("separate rematch fragments are retained", () => {
  const first = mergeRatingResultFragment(
    makeSource(),
    makeRatingUpdate(),
  ).source;
  const second = mergeRatingResultFragment(
    first,
    makeRatingUpdate({
      matchId: `${inviteId}1`,
      updateRatingMessage: "Bob 1489↑ Alice 1510↓ (9 - 4)",
      completedAtMs: 300,
    }),
  );
  assert.equal(second.changed, true);
  assert.deepEqual(Object.keys(second.source.results).sort(), [
    inviteId,
    `${inviteId}1`,
  ]);
  assert.equal(second.source.updatedAtMs, 300);
  assert.equal(second.source.generation, 4);
});

test("v1 automatch sources remain untouched", () => {
  const source = makeSource({ version: 1 });
  const result = mergeRatingResultFragment(source, makeRatingUpdate());
  assert.equal(result.changed, false);
  assert.equal(result.reason, "skipped");
  assert.equal(result.source, source);
});

test("event records route to deterministic progress without touching RTDB", async () => {
  const requests = [];
  const database = {
    ref() {
      throw new Error("event records must not touch telegramAutomatches");
    },
  };
  const result = await projectRatingUpdateRecord(
    makeEventRatingUpdate({ telegramDeliveryVersion: 2 }),
    {
      database,
      requestEventProgress: async (request) => {
        requests.push(request);
        return {
          ok: true,
          enqueued: true,
          duplicate: false,
          fallbackPersisted: false,
        };
      },
      logger: { warn() {}, error() {} },
    },
  );

  assert.deepEqual(requests, [
    {
      eventId: "event_example",
      sourceKey: `rating:${inviteId}:${inviteId}`,
      reason: "match-rating-updated",
    },
  ]);
  assert.equal(result.status, "event-progress-requested");
  assert.equal(result.eventId, "event_example");
  assert.equal(result.sourceKey, `rating:${inviteId}:${inviteId}`);
});

test("legacy and malformed event records never fall through to RTDB", async () => {
  let requestCount = 0;
  const dependencies = {
    database: {
      ref() {
        throw new Error("unexpected database access");
      },
    },
    requestEventProgress: async () => {
      requestCount += 1;
    },
  };

  assert.deepEqual(
    await projectRatingUpdateRecord(
      makeEventRatingUpdate({ isEventMatch: undefined }),
      dependencies,
    ),
    { status: "skipped" },
  );
  assert.deepEqual(
    await projectRatingUpdateRecord(
      makeEventRatingUpdate({ eventId: null }),
      dependencies,
    ),
    { status: "skipped" },
  );
  assert.deepEqual(
    await projectRatingUpdateRecord(
      makeEventRatingUpdate({ eventOwned: false }),
      dependencies,
    ),
    { status: "skipped" },
  );
  assert.deepEqual(
    await projectRatingUpdateRecord(
      makeEventRatingUpdate({ eventOwned: undefined }),
      dependencies,
    ),
    { status: "skipped" },
  );
  assert.equal(requestCount, 0);
});

test("event progress fallback is handled and logged", async () => {
  const warnings = [];
  const result = await requestEventRatingProgress(makeEventRatingUpdate(), {
    requestEventProgress: async () => ({
      ok: true,
      enqueued: false,
      duplicate: false,
      fallbackPersisted: true,
      fallbackSignalId: "fallback-1",
    }),
    logger: {
      warn(message, metadata) {
        warnings.push({ message, metadata });
      },
      error() {},
    },
  });

  assert.equal(result.status, "event-progress-requested");
  assert.equal(result.result.fallbackPersisted, true);
  assert.deepEqual(warnings, [
    {
      message: "event:progress:fallback:queued",
      metadata: {
        eventId: "event_example",
        inviteId,
        matchId: inviteId,
        reason: "match-rating-updated",
        fallbackSignalId: "fallback-1",
      },
    },
  ]);
});

test("event progress total failure is logged and rethrown", async () => {
  const expectedError = new Error("task and fallback failed");
  const errors = [];
  await assert.rejects(
    requestEventRatingProgress(makeEventRatingUpdate(), {
      requestEventProgress: async () => {
        throw expectedError;
      },
      logger: {
        warn() {},
        error(message, metadata) {
          errors.push({ message, metadata });
        },
      },
    }),
    expectedError,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "event:progress:enqueue:error");
  assert.equal(errors[0].metadata.error, expectedError.message);
});

test("background projector waits for a blocked event task request", async () => {
  let resolveRequest;
  const blockedRequest = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  let settled = false;
  const projection = projectRatingUpdateRecord(makeEventRatingUpdate(), {
    requestEventProgress: () => blockedRequest,
    database: {
      ref() {
        throw new Error("unexpected database access");
      },
    },
    logger: { warn() {}, error() {} },
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveRequest({
    ok: true,
    enqueued: true,
    duplicate: false,
    fallbackPersisted: false,
  });
  const result = await projection;
  assert.equal(settled, true);
  assert.equal(result.status, "event-progress-requested");
});

test("the retained rating trigger ignores non-event Telegram records", async () => {
  assert.deepEqual(
    await projectRatingUpdateRecord(makeRatingUpdate(), {
      database: {
        ref() {
          throw new Error("non-event records must be handled by Cloudflare");
        },
      },
    }),
    { status: "skipped" },
  );
});

test("rating projection retries failed Firestore events", () => {
  assert.equal(
    projectRatingTelegramUpdates.__endpoint.eventTrigger.retry,
    true,
  );
});
