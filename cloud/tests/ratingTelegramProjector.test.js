const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isEventRatingUpdate,
  shouldProjectRatingTelegramUpdate,
  shouldRequestEventRatingProgress,
  mergeRatingResultFragment,
  projectRatingTelegramUpdate,
  requestEventRatingProgress,
  projectRatingUpdateRecord,
  projectRatingTelegramUpdates,
} = require("../functions/ratingTelegramProjector");
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

const createSnapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => value,
});

const createRatingDatabase = (initialState, { coldStart = false } = {}) => {
  let source = initialState;
  let transactionCount = 0;
  return {
    database: {
      ref(path) {
        assert.equal(path, `telegramAutomatches/${inviteId}`);
        return {
          async transaction(updater) {
            transactionCount += 1;
            if (coldStart) {
              updater(undefined);
            }
            const next = updater(source);
            if (next === undefined) {
              return { committed: false, snapshot: createSnapshot(source) };
            }
            source = next;
            return { committed: true, snapshot: createSnapshot(source) };
          },
        };
      },
    },
    getSource: () => source,
    getTransactionCount: () => transactionCount,
  };
};

const createConcurrentRatingDatabase = (initialState) => {
  let source = initialState;
  let tail = Promise.resolve();
  return {
    database: {
      ref(path) {
        assert.equal(path, `telegramAutomatches/${inviteId}`);
        return {
          async transaction(updater) {
            updater(undefined);
            const previous = tail;
            let release;
            tail = new Promise((resolve) => {
              release = resolve;
            });
            await previous;
            try {
              const next = updater(source);
              source = next;
              return { committed: true, snapshot: createSnapshot(source) };
            } finally {
              release();
            }
          },
        };
      },
    },
    getSource: () => source,
  };
};

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

test("transaction projection is idempotent", async () => {
  const store = createRatingDatabase(makeSource());

  const first = await projectRatingTelegramUpdate(makeRatingUpdate(), {
    database: store.database,
  });
  const duplicate = await projectRatingTelegramUpdate(makeRatingUpdate(), {
    database: store.database,
  });

  assert.deepEqual(first, { status: "inserted", committed: true });
  assert.deepEqual(duplicate, { status: "duplicate", committed: false });
  assert.equal(store.getTransactionCount(), 2);
  assert.equal(Object.keys(store.getSource().results).length, 1);
  assert.equal(store.getSource().generation, 3);
});

test("cold-cache transaction reaches authoritative source before deciding", async () => {
  const store = createRatingDatabase(makeSource(), { coldStart: true });

  const inserted = await projectRatingTelegramUpdate(makeRatingUpdate(), {
    database: store.database,
  });
  const duplicate = await projectRatingTelegramUpdate(makeRatingUpdate(), {
    database: store.database,
  });

  assert.deepEqual(inserted, { status: "inserted", committed: true });
  assert.deepEqual(duplicate, { status: "duplicate", committed: false });
  assert.equal(Object.keys(store.getSource().results).length, 1);
  assert.equal(store.getSource().generation, 3);
});

test("cold-cache missing and legacy sources remain untouched", async () => {
  const missingStore = createRatingDatabase(null, { coldStart: true });
  assert.deepEqual(
    await projectRatingTelegramUpdate(makeRatingUpdate(), {
      database: missingStore.database,
    }),
    { status: "skipped", committed: false },
  );
  assert.equal(missingStore.getSource(), null);

  const legacySource = makeSource({ version: 1 });
  const legacyStore = createRatingDatabase(legacySource, { coldStart: true });
  assert.deepEqual(
    await projectRatingTelegramUpdate(makeRatingUpdate(), {
      database: legacyStore.database,
    }),
    { status: "skipped", committed: false },
  );
  assert.equal(legacyStore.getSource(), legacySource);
});

test("concurrent result fragment transactions retain both matches", async () => {
  const store = createConcurrentRatingDatabase(makeSource());
  const rematchId = `${inviteId}1`;

  const [first, second] = await Promise.all([
    projectRatingTelegramUpdate(makeRatingUpdate(), {
      database: store.database,
    }),
    projectRatingTelegramUpdate(
      makeRatingUpdate({
        matchId: rematchId,
        updateRatingMessage: "Bob 1489↑ Alice 1510↓ (9 - 4)",
        completedAtMs: 300,
      }),
      { database: store.database },
    ),
  ]);

  assert.deepEqual(first, { status: "inserted", committed: true });
  assert.deepEqual(second, { status: "inserted", committed: true });
  assert.deepEqual(Object.keys(store.getSource().results).sort(), [
    inviteId,
    rematchId,
  ]);
  assert.equal(store.getSource().generation, 4);
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

test("non-v2 rating records do not access RTDB", async () => {
  const database = {
    ref() {
      throw new Error("unexpected database access");
    },
  };
  assert.deepEqual(
    await projectRatingTelegramUpdate(
      makeRatingUpdate({ telegramDeliveryVersion: null }),
      { database },
    ),
    { status: "skipped" },
  );
});

test("rating projection retries failed Firestore events", () => {
  assert.equal(
    projectRatingTelegramUpdates.__endpoint.eventTrigger.retry,
    true,
  );
});
