"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  addEventTelegramProjectionGuard,
  buildEventSignature,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  createEventTelegramProjector,
  renderUpcomingMessage,
} = require("../functions/eventTelegramAnnouncements");
const {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_TTL_MS,
  createEventLockManager,
} = require("../functions/eventLocks");
const firebaseAdmin = require("../functions/firebaseAdmin");

const EVENT_ID = "EV2026";
const NOW_MS = Date.UTC(2026, 7, 7, 12, 0, 0);
const START_AT_MS = Date.UTC(2026, 7, 8, 17, 0, 0);
const databaseRulesPath = path.resolve(__dirname, "..", "database.rules.json");
const ALICE_EMOJI =
  '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji>';
const BOB_EMOJI =
  '<tg-emoji emoji-id="5273897076990696847">&#11088;</tg-emoji>';

const buildEvent = (overrides = {}) => ({
  telegramDeliveryVersion: 2,
  announceOnTelegram: true,
  status: "scheduled",
  startAtMs: START_AT_MS,
  participants: {
    alice: {
      profileId: "alice",
      username: "<Alice>",
      emojiId: 1,
      joinedAtMs: 100,
    },
  },
  rounds: {},
  ...overrides,
});

const project = (eventData, state = null, nowMs = NOW_MS) =>
  buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData,
    state,
    nowMs,
  });

const operationFor = (projection, channel) =>
  projection.operations.find((operation) => operation.channel === channel);

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

const createSnapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => clone(value),
});

const createRuntimeDatabase = (initial = {}) => {
  const values = new Map(
    Object.entries(initial).map(([path, value]) => [path, clone(value)]),
  );
  const readHooks = new Map();
  const updateHooks = new Map();
  let updateError = null;
  let serverNowMs = 1_000;
  const validateGuardedUpdate = (path, value) => {
    const guard = value && value[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
    if (!guard || guard.lockRoot !== EVENT_TELEGRAM_PROJECTION_LOCK_ROOT) {
      return false;
    }
    if (path.startsWith("eventTelegramProjections/")) {
      const eventId = path.slice("eventTelegramProjections/".length);
      if (guard.eventId !== eventId) {
        return false;
      }
    } else if (
      path.startsWith("telegramMessages/") &&
      path.endsWith("/desired")
    ) {
      const messageKey = path.slice(
        "telegramMessages/".length,
        -"/desired".length,
      );
      if (
        guard.messageKey !== messageKey ||
        value.destination !== "events" ||
        ![
          `event:${guard.eventId}:upcoming`,
          `event:${guard.eventId}:started`,
        ].includes(messageKey)
      ) {
        return false;
      }
    } else {
      return false;
    }
    const lock = values.get(`${guard.lockRoot}/${guard.eventId}`);
    return (
      lock &&
      lock.lockId === guard.lockId &&
      lock.ownerUid === guard.ownerUid &&
      typeof lock.expiresAtMs === "number" &&
      lock.expiresAtMs > serverNowMs
    );
  };
  return {
    onceCalls: [],
    transactionCalls: [],
    updateCalls: [],
    ref(path = "") {
      if (path === "") {
        return {
          update: async (updates) => {
            const firstGuard =
              Object.values(updates)[0]?.[
                EVENT_TELEGRAM_PROJECTION_GUARD_FIELD
              ];
            const updateHook = updateHooks.get(firstGuard?.lockId);
            if (updateHook) {
              await updateHook(clone(updates));
            }
            if (updateError) {
              const error = updateError;
              updateError = null;
              throw error;
            }
            if (
              !Object.entries(updates).every(([updatePath, value]) =>
                validateGuardedUpdate(updatePath, value),
              )
            ) {
              const error = new Error("PERMISSION_DENIED: Permission denied");
              error.code = "PERMISSION_DENIED";
              throw error;
            }
            this.updateCalls.push(clone(updates));
            for (const [updatePath, value] of Object.entries(updates)) {
              if (value === null || value === undefined) {
                values.delete(updatePath);
              } else {
                values.set(updatePath, clone(value));
              }
            }
          },
        };
      }
      return {
        path,
        once: async () => {
          this.onceCalls.push(path);
          const hook = readHooks.get(path);
          if (hook) {
            await hook();
          }
          return createSnapshot(values.get(path) ?? null);
        },
        transaction: async (update, _onComplete, applyLocally) => {
          this.transactionCalls.push({ path, applyLocally });
          let output = update(undefined);
          const authoritative = clone(values.get(path) ?? null);
          if (authoritative !== null) {
            output = update(authoritative);
          }
          if (output === undefined) {
            return {
              committed: false,
              snapshot: createSnapshot(authoritative),
            };
          }
          if (output === null) {
            values.delete(path);
          } else {
            values.set(path, clone(output));
          }
          return {
            committed: true,
            snapshot: createSnapshot(output),
          };
        },
      };
    },
    read(path) {
      return clone(values.get(path) ?? null);
    },
    write(path, value) {
      if (value === null || value === undefined) {
        values.delete(path);
      } else {
        values.set(path, clone(value));
      }
    },
    onRead(path, hook) {
      readHooks.set(path, hook);
    },
    onGuardedUpdate(lockId, hook) {
      updateHooks.set(lockId, hook);
    },
    setServerNow(nowMs) {
      serverNowMs = nowMs;
    },
    failNextUpdate(error) {
      updateError = error;
    },
  };
};

const createRuntimeLockManager = (
  database,
  now = () => 1_000,
  lockRoot = EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
) => {
  let lockIndex = 0;
  return createEventLockManager({
    database,
    now,
    createLockId: () => `runtime-lock-${++lockIndex}`,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    logger: { error() {} },
    lockRoot,
  });
};

const expectProjectionError = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
};

test("renders the exact upcoming template with DST-aware times and UTC date", () => {
  const eventData = buildEvent({
    participants: {
      bob: {
        profileId: "bob",
        username: "Bob & Co",
        emojiId: 2,
        joinedAtMs: 200,
      },
      alice: {
        profileId: "alice",
        username: "<Alice>",
        emojiId: 1,
        joinedAtMs: 100,
      },
    },
  });
  assert.equal(
    renderUpcomingMessage(EVENT_ID, eventData, NOW_MS),
    [
      "upcoming event alert",
      "",
      "https://mons.link/event/EV2026",
      "",
      "10 AM PT / 1 PM ET / 5 PM UTC",
      "",
      "Sat, Aug 8",
      "",
      `${ALICE_EMOJI} &lt;Alice&gt; ${BOB_EMOJI} Bob &amp; Co`,
    ].join("\n"),
  );
});

test("omits the date and participant line when they are not applicable", () => {
  const sameDayStartAtMs = Date.UTC(2026, 7, 7, 17, 0, 0);
  assert.equal(
    renderUpcomingMessage(
      EVENT_ID,
      buildEvent({ startAtMs: sameDayStartAtMs }),
      NOW_MS,
    ),
    [
      "upcoming event alert",
      "",
      "https://mons.link/event/EV2026",
      "",
      "10 AM PT / 1 PM ET / 5 PM UTC",
    ].join("\n"),
  );
});

test("ignores Telegram-enabled v1 events without adopting them", () => {
  const eventData = buildEvent();
  delete eventData.telegramDeliveryVersion;
  assert.equal(buildEventSignature(eventData, NOW_MS), "skip");
  assert.deepEqual(project(eventData), {
    action: "skip",
    reason: "not-v2",
  });
});

test("queues the first upcoming post as an HTML send", () => {
  const projection = project(buildEvent());
  assert.equal(projection.action, "project");
  assert.equal(projection.operations.length, 1);
  const upcoming = operationFor(projection, "upcoming");
  assert.equal(upcoming.operation, "send");
  assert.equal(upcoming.messageKey, "event:EV2026:upcoming");
  assert.equal(upcoming.instanceKey, "event:EV2026:upcoming:v2");

  const updates = buildEventTelegramProjectionUpdates({
    eventId: EVENT_ID,
    projection,
  });
  assert.deepEqual(
    updates[`eventTelegramProjections/${EVENT_ID}`],
    projection.state,
  );
  const desired =
    updates[`telegramMessages/event:${EVENT_ID}:upcoming/desired`];
  assert.equal(desired.operation, "send");
  assert.equal(desired.destination, "events");
  assert.equal(desired.parseMode, "HTML");
  assert.equal(desired.silent, false);
  assert.equal(desired.disableWebPagePreview, true);
  assert.equal(desired.text, projection.state.upcomingText);
});

test("participant changes edit the upcoming post and replace it if missing", () => {
  const first = project(buildEvent());
  const eventData = buildEvent({
    participants: {
      ...buildEvent().participants,
      bob: {
        profileId: "bob",
        displayName: "Bob",
        joinedAtMs: 200,
      },
    },
  });
  const second = project(eventData, first.state);
  const upcoming = operationFor(second, "upcoming");
  assert.equal(upcoming.operation, "edit");
  assert.equal(upcoming.ifMissing, "send");
  assert.match(upcoming.text, /&lt;Alice&gt; Bob$/);
  assert.notEqual(second.signature, first.signature);
  assert.equal(project(eventData, second.state).action, "unchanged");
});

test("starting an event suppresses an undelivered upcoming post and sends the match thread", () => {
  const scheduled = project(buildEvent());
  const activeEvent = buildEvent({
    status: "active",
    participants: {
      alice: {
        profileId: "alice",
        username: "Alice",
        joinedAtMs: 100,
      },
      bob: {
        profileId: "bob",
        username: "Bob",
        joinedAtMs: 200,
      },
    },
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          match_0: {
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const active = project(activeEvent, scheduled.state);
  const upcoming = operationFor(active, "upcoming");
  const started = operationFor(active, "started");
  assert.equal(upcoming.operation, "edit");
  assert.equal(upcoming.ifMissing, "skip");
  assert.equal(upcoming.text, scheduled.state.upcomingText);
  assert.equal(started.operation, "send");
  assert.equal(
    started.text,
    [
      "event started",
      "",
      "https://mons.link/event/EV2026",
      "",
      "Alice vs. Bob",
    ].join("\n"),
  );
});

test("retains existing match lines and appends later-round matches once", () => {
  const firstEvent = buildEvent({
    status: "active",
    participants: {
      alice: { username: "Alice", joinedAtMs: 100 },
      bob: { username: "Bob", joinedAtMs: 200 },
    },
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          match_0: {
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const first = project(firstEvent);
  const secondEvent = buildEvent({
    status: "active",
    participants: {
      alice: { username: "Alice renamed", joinedAtMs: 100 },
      bob: { username: "Bob", joinedAtMs: 200 },
      carol: { username: "Carol", joinedAtMs: 300 },
      dan: { username: "Dan", joinedAtMs: 400 },
    },
    rounds: {
      0: firstEvent.rounds[0],
      1: {
        roundIndex: 1,
        matches: {
          match_0: {
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  const second = project(secondEvent, first.state);
  const started = operationFor(second, "started");
  assert.equal(started.operation, "edit");
  assert.equal(started.ifMissing, "send");
  assert.equal(
    started.text,
    [
      "event started",
      "",
      "https://mons.link/event/EV2026",
      "",
      "Alice vs. Bob",
      "Carol vs. Dan",
    ].join("\n"),
  );
  assert.deepEqual(second.state.startedMatchKeys, [
    "round:0:match_0",
    "round:1:match_0",
  ]);
  assert.equal(project(secondEvent, second.state).action, "unchanged");
});

for (const status of ["ended", "dismissed"]) {
  test(`${status} events retain delivered posts and suppress missing posts`, () => {
    const scheduled = project(buildEvent());
    const active = project(
      buildEvent({
        status: "active",
        participants: {
          alice: { username: "Alice", joinedAtMs: 100 },
          bob: { username: "Bob", joinedAtMs: 200 },
        },
        rounds: {
          0: {
            roundIndex: 0,
            matches: {
              match_0: {
                inviteId: "auto_1",
                hostProfileId: "alice",
                guestProfileId: "bob",
              },
            },
          },
        },
      }),
      scheduled.state,
    );
    const terminal = project(buildEvent({ status }), active.state);
    assert.equal(terminal.operations.length, 2);
    for (const operation of terminal.operations) {
      assert.equal(operation.operation, "edit");
      assert.equal(operation.ifMissing, "skip");
    }
    assert.equal(terminal.state.upcomingText, scheduled.state.upcomingText);
    assert.equal(terminal.state.startedText, active.state.startedText);
    assert.equal(
      terminal.operations.some((operation) => operation.operation === "delete"),
      false,
    );
  });
}

test("the default projector uses the dedicated projection lock root", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
  });

  const projection = await projector(EVENT_ID, NOW_MS);

  assert.equal(projection.action, "project");
  assert.equal(
    database.transactionCalls.some(
      ({ path }) =>
        path === `${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`,
    ),
    true,
  );
  assert.equal(
    database.transactionCalls.some(
      ({ path }) => path === `${EVENT_LOCK_ROOT}/${EVENT_ID}`,
    ),
    false,
  );
});

test("the default projection commit uses the down-scoped RTDB writer", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  const originalDatabaseWithAuthOverride =
    firebaseAdmin.databaseWithAuthOverride;
  let writerConfig = null;
  firebaseAdmin.databaseWithAuthOverride = (appName, authOverride) => {
    writerConfig = { appName, authOverride };
    return database;
  };
  try {
    const projector = createEventTelegramProjector({ database });
    const projection = await projector(EVENT_ID, NOW_MS);
    assert.equal(projection.action, "project");
  } finally {
    firebaseAdmin.databaseWithAuthOverride = originalDatabaseWithAuthOverride;
  }
  assert.deepEqual(writerConfig, {
    appName: "event-telegram-projection-writer",
    authOverride: {
      uid: "event-telegram-projector",
      token: { eventTelegramProjectionWriter: true },
    },
  });
});

test("RTDB rules bind desired message keys to the guarded event and channel", () => {
  const rules = JSON.parse(fs.readFileSync(databaseRulesPath, "utf8"));
  const writeRule =
    rules.rules.telegramMessages["$messageKey"].desired[".write"];
  const eventIdExpression =
    "newData.child('eventTelegramProjectionGuard').child('eventId').val()";

  assert.equal(
    writeRule.includes(
      `$messageKey === 'event:' + ${eventIdExpression} + ':upcoming'`,
    ),
    true,
  );
  assert.equal(
    writeRule.includes(
      `$messageKey === 'event:' + ${eventIdExpression} + ':started'`,
    ),
    true,
  );
});

test("guarded writes reject cross-event and unsupported-channel message keys", async (t) => {
  const lockId = "runtime-lock-1";
  const ownerUid = "event-telegram-projector";
  const database = createRuntimeDatabase({
    [`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`]: {
      lockId,
      ownerUid,
      expiresAtMs: 10_000,
    },
  });
  const guard = {
    lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    eventId: EVENT_ID,
    lockId,
    ownerUid,
  };

  for (const messageKey of [
    "event:OTHER:upcoming",
    `event:${EVENT_ID}:results`,
  ]) {
    await t.test(messageKey, async () => {
      const updates = addEventTelegramProjectionGuard({
        updates: {
          [`telegramMessages/${messageKey}/desired`]: {
            destination: "events",
          },
        },
        guard,
      });
      await assert.rejects(database.ref().update(updates), (error) => {
        assert.equal(error.code, "PERMISSION_DENIED");
        return true;
      });
    });
  }
});

test("projection locking stays isolated from the domain lock and commits desired state atomically", async () => {
  let markEventRead;
  let continueEventRead;
  const eventReadStarted = new Promise((resolve) => {
    markEventRead = resolve;
  });
  const eventReadBlocked = new Promise((resolve) => {
    continueEventRead = resolve;
  });
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  database.onRead(`events/${EVENT_ID}`, async () => {
    markEventRead();
    await eventReadBlocked;
  });
  const projectionLockManager = createRuntimeLockManager(database);
  const domainLockManager = createRuntimeLockManager(
    database,
    () => 1_000,
    EVENT_LOCK_ROOT,
  );
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    lockManager: projectionLockManager,
  });

  const projectionPromise = projector(EVENT_ID, NOW_MS);
  await eventReadStarted;
  const domainLock = await domainLockManager.acquireEventLock(
    EVENT_ID,
    "domain-writer",
  );
  assert.ok(domainLock);
  assert.equal(
    await projectionLockManager.acquireEventLock(EVENT_ID, "second-projector"),
    null,
  );
  continueEventRead();
  const projection = await projectionPromise;
  assert.equal(projection.action, "project");
  assert.equal(database.updateCalls.length, 1);
  const updates = database.updateCalls[0];
  const persistedProjection = {
    ...updates[`eventTelegramProjections/${EVENT_ID}`],
  };
  const projectionGuard =
    persistedProjection[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
  delete persistedProjection[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
  assert.deepEqual(persistedProjection, projection.state);
  assert.deepEqual(projectionGuard, {
    lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    eventId: EVENT_ID,
    lockId: "runtime-lock-1",
    ownerUid: "event-telegram-projector",
  });
  assert.equal(
    updates[`telegramMessages/event:${EVENT_ID}:upcoming/desired`].operation,
    "send",
  );
  assert.equal(
    updates[`telegramMessages/event:${EVENT_ID}:upcoming/desired`][
      EVENT_TELEGRAM_PROJECTION_GUARD_FIELD
    ].messageKey,
    `event:${EVENT_ID}:upcoming`,
  );
  assert.equal(
    database.read(`${EVENT_LOCK_ROOT}/${EVENT_ID}`).lockId,
    domainLock.lockId,
  );
  assert.equal(
    database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
    null,
  );
  await domainLockManager.releaseEventLock(domainLock);
});

test("a domain-held lock does not block terminal projection", async () => {
  const scheduled = project(buildEvent());
  const scheduledUpdates = buildEventTelegramProjectionUpdates({
    eventId: EVENT_ID,
    projection: scheduled,
  });
  const desiredPath = `telegramMessages/event:${EVENT_ID}:upcoming/desired`;
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
    [`eventTelegramProjections/${EVENT_ID}`]: scheduled.state,
    [desiredPath]: scheduledUpdates[desiredPath],
  });
  const projectionLockManager = createRuntimeLockManager(database);
  const domainLockManager = createRuntimeLockManager(
    database,
    () => 1_000,
    EVENT_LOCK_ROOT,
  );
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    lockManager: projectionLockManager,
  });
  const domainLock = await domainLockManager.acquireEventLock(
    EVENT_ID,
    "domain-writer",
  );
  database.write(`events/${EVENT_ID}`, buildEvent({ status: "ended" }));

  const terminal = await projector(EVENT_ID, NOW_MS);
  assert.equal(terminal.action, "project");
  assert.equal(database.updateCalls.length, 1);
  const desired = database.read(desiredPath);
  assert.equal(desired.operation, "edit");
  assert.equal(desired.ifMissing, "skip");
  assert.equal(
    terminal.operations.some((operation) => operation.operation === "delete"),
    false,
  );
  assert.equal(
    database.read(`${EVENT_LOCK_ROOT}/${EVENT_ID}`).lockId,
    domainLock.lockId,
  );
  await domainLockManager.releaseEventLock(domainLock);
});

for (const leaseLoss of ["expired", "foreign"]) {
  const article = leaseLoss === "expired" ? "an" : "a";
  test(`${article} ${leaseLoss} lease prevents a stale projection write`, async () => {
    let nowMs = 1_000;
    const database = createRuntimeDatabase({
      [`events/${EVENT_ID}`]: buildEvent(),
    });
    const baseLockManager = createRuntimeLockManager(database, () => nowMs);
    const lockManager = {
      ...baseLockManager,
      async refreshEventLock(lockHandle) {
        if (leaseLoss === "expired") {
          nowMs += EVENT_LOCK_TTL_MS;
        } else {
          database.write(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`, {
            lockId: "foreign-lock",
            ownerUid: "foreign-owner",
            acquiredAtMs: nowMs,
            refreshedAtMs: nowMs,
            expiresAtMs: nowMs + EVENT_LOCK_TTL_MS,
          });
        }
        return baseLockManager.refreshEventLock(lockHandle);
      },
    };
    const projector = createEventTelegramProjector({
      database,
      commitDatabase: database,
      lockManager,
    });

    await expectProjectionError(
      () => projector(EVENT_ID, NOW_MS),
      "event-telegram-lock-lost",
    );
    assert.equal(database.updateCalls.length, 0);
    if (leaseLoss === "foreign") {
      assert.equal(
        database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`)
          .lockId,
        "foreign-lock",
      );
    } else {
      assert.equal(
        database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
        null,
      );
    }
  });
}

for (const commitLeaseLoss of ["missing", "expired", "foreign-owner"]) {
  test(`${commitLeaseLoss} ownership at guarded commit prevents every projection write`, async () => {
    const database = createRuntimeDatabase({
      [`events/${EVENT_ID}`]: buildEvent(),
    });
    const lockManager = createRuntimeLockManager(database);
    database.onGuardedUpdate("runtime-lock-1", () => {
      if (commitLeaseLoss === "missing") {
        database.write(
          `${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`,
          null,
        );
      } else if (commitLeaseLoss === "expired") {
        database.setServerNow(1_000 + EVENT_LOCK_TTL_MS);
      } else {
        database.write(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`, {
          lockId: "runtime-lock-1",
          ownerUid: "successor-owner",
          acquiredAtMs: 2_000,
          refreshedAtMs: 2_000,
          expiresAtMs: 100_000,
        });
      }
    });
    const projector = createEventTelegramProjector({
      database,
      commitDatabase: database,
      lockManager,
    });

    await expectProjectionError(
      () => projector(EVENT_ID, NOW_MS),
      "event-telegram-lock-lost",
    );
    assert.equal(database.updateCalls.length, 0);
    assert.equal(database.read(`eventTelegramProjections/${EVENT_ID}`), null);
    assert.equal(
      database.read(`telegramMessages/event:${EVENT_ID}:upcoming/desired`),
      null,
    );
  });
}

test("a delayed stale commit cannot regress a successor projection after lease handoff", async () => {
  const participants = {
    alice: { username: "Alice", joinedAtMs: 100 },
    bob: { username: "Bob", joinedAtMs: 200 },
    carol: { username: "Carol", joinedAtMs: 300 },
    dan: { username: "Dan", joinedAtMs: 400 },
  };
  const firstEvent = buildEvent({
    status: "active",
    participants,
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          match_0: {
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const successorEvent = buildEvent({
    status: "active",
    participants,
    rounds: {
      ...firstEvent.rounds,
      1: {
        roundIndex: 1,
        matches: {
          match_0: {
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  let nowMs = 1_000;
  let markStaleCommit;
  let continueStaleCommit;
  const staleCommitStarted = new Promise((resolve) => {
    markStaleCommit = resolve;
  });
  const staleCommitBlocked = new Promise((resolve) => {
    continueStaleCommit = resolve;
  });
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: firstEvent,
  });
  database.onGuardedUpdate("runtime-lock-1", async () => {
    markStaleCommit();
    await staleCommitBlocked;
  });
  const lockManager = createRuntimeLockManager(database, () => nowMs);
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    lockManager,
  });

  const staleOutcome = projector(EVENT_ID, NOW_MS).then(
    () => null,
    (error) => error,
  );
  await staleCommitStarted;
  nowMs = 1_001 + EVENT_LOCK_TTL_MS;
  database.setServerNow(nowMs);
  database.write(`events/${EVENT_ID}`, successorEvent);

  const successor = await projector(EVENT_ID, NOW_MS);
  assert.equal(successor.action, "project");
  continueStaleCommit();
  const staleError = await staleOutcome;
  assert.equal(staleError.code, "event-telegram-lock-lost");
  assert.equal(database.updateCalls.length, 1);

  const state = database.read(`eventTelegramProjections/${EVENT_ID}`);
  assert.deepEqual(state.startedMatchKeys, [
    "round:0:match_0",
    "round:1:match_0",
  ]);
  assert.equal((state.startedText.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((state.startedText.match(/Carol vs\. Dan/g) || []).length, 1);
  const desired = database.read(
    `telegramMessages/event:${EVENT_ID}:started/desired`,
  );
  assert.equal((desired.text.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((desired.text.match(/Carol vs\. Dan/g) || []).length, 1);
});

test("projection update failure releases its owned event lease without partial state", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  const lockManager = createRuntimeLockManager(database);
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    lockManager,
  });
  database.failNextUpdate(new Error("write-failed"));

  await assert.rejects(() => projector(EVENT_ID, NOW_MS), /write-failed/);
  assert.equal(
    database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
    null,
  );
  assert.equal(database.read(`eventTelegramProjections/${EVENT_ID}`), null);
  assert.equal(
    database.read(`telegramMessages/event:${EVENT_ID}:upcoming/desired`),
    null,
  );
});

test("contending projections retain append-only match history without duplicate lines", async () => {
  const participants = {
    alice: { username: "Alice", joinedAtMs: 100 },
    bob: { username: "Bob", joinedAtMs: 200 },
    carol: { username: "Carol", joinedAtMs: 300 },
    dan: { username: "Dan", joinedAtMs: 400 },
  };
  const firstEvent = buildEvent({
    status: "active",
    participants,
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          match_0: {
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const first = project(firstEvent);
  const latestEvent = buildEvent({
    status: "active",
    participants,
    rounds: {
      ...firstEvent.rounds,
      1: {
        roundIndex: 1,
        matches: {
          match_0: {
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  let markEventRead;
  let continueEventRead;
  const eventReadStarted = new Promise((resolve) => {
    markEventRead = resolve;
  });
  const eventReadBlocked = new Promise((resolve) => {
    continueEventRead = resolve;
  });
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: latestEvent,
    [`eventTelegramProjections/${EVENT_ID}`]: first.state,
  });
  database.onRead(`events/${EVENT_ID}`, async () => {
    markEventRead();
    await eventReadBlocked;
  });
  const lockManager = createRuntimeLockManager(database);
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    lockManager,
  });

  const firstProjection = projector(EVENT_ID, NOW_MS);
  await eventReadStarted;
  await expectProjectionError(
    () => projector(EVENT_ID, NOW_MS),
    "event-telegram-lock-busy",
  );
  continueEventRead();
  await firstProjection;
  const duplicate = await projector(EVENT_ID, NOW_MS);
  assert.equal(duplicate.action, "unchanged");
  assert.equal(database.updateCalls.length, 1);
  const state = database.read(`eventTelegramProjections/${EVENT_ID}`);
  assert.deepEqual(state.startedMatchKeys, [
    "round:0:match_0",
    "round:1:match_0",
  ]);
  assert.equal((state.startedText.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((state.startedText.match(/Carol vs\. Dan/g) || []).length, 1);
});
