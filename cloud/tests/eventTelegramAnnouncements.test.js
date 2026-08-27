"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  addEventTelegramProjectionGuard,
  buildEndedState,
  buildEventSignature,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  buildEventTelegramDispatches,
  loadEndedMatchResults,
  renderUpcomingMessage,
  splitEventTelegramProjectionUpdates,
} = require("../functions/telegram/eventProjectionCore");
const {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_TTL_MS,
  createEventLockManager,
} = require("../functions/eventLocks");

const EVENT_ID = "EV2026";
const NOW_MS = Date.UTC(2026, 7, 7, 12, 0, 0);
const START_AT_MS = Date.UTC(2026, 7, 8, 17, 0, 0);
const databaseRulesPath = path.resolve(__dirname, "..", "database.rules.json");
const ALICE_EMOJI =
  '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji>';
const BOB_EMOJI =
  '<tg-emoji emoji-id="5273897076990696847">&#11088;</tg-emoji>';
const CAROL_EMOJI =
  '<tg-emoji emoji-id="5274259447676427346">&#11088;</tg-emoji>';
const DAN_EMOJI =
  '<tg-emoji emoji-id="5274175124583505560">&#11088;</tg-emoji>';

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

const buildEndedEvent = (overrides = {}) =>
  buildEvent({
    status: "ended",
    winnerProfileId: "alice",
    participants: {
      alice: {
        profileId: "alice",
        loginUid: "alice-login",
        username: "<Alice>",
        emojiId: 1,
        joinedAtMs: 100,
      },
      bob: {
        profileId: "bob",
        loginUid: "bob-login",
        username: "Bob & Co",
        emojiId: 2,
        joinedAtMs: 200,
      },
      carol: {
        profileId: "carol",
        loginUid: "carol-login",
        username: "Carol",
        emojiId: 3,
        joinedAtMs: 300,
      },
      dan: {
        profileId: "dan",
        loginUid: "dan-login",
        username: "Dan",
        emojiId: 4,
        joinedAtMs: 400,
      },
    },
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          "0_0": {
            inviteId: "auto_1",
            status: "host",
            hostProfileId: "alice",
            hostLoginUid: "alice-login",
            guestProfileId: "dan",
            guestLoginUid: "dan-login",
            winnerProfileId: "alice",
            loserProfileId: "dan",
          },
          "0_1": {
            inviteId: "auto_2",
            status: "guest",
            hostProfileId: "bob",
            hostLoginUid: "bob-login",
            guestProfileId: "carol",
            guestLoginUid: "carol-login",
            winnerProfileId: "carol",
            loserProfileId: "bob",
          },
          "0_2": {
            inviteId: null,
            status: "bye",
            hostProfileId: "alice",
            winnerProfileId: "alice",
            loserProfileId: null,
          },
        },
      },
      1: {
        roundIndex: 1,
        matches: {
          "1_0": {
            inviteId: "auto_3",
            status: "host",
            hostProfileId: "alice",
            hostLoginUid: "alice-login",
            guestProfileId: "carol",
            guestLoginUid: "carol-login",
            winnerProfileId: "alice",
            loserProfileId: "carol",
          },
        },
      },
    },
    thirdPlaceMatch: {
      inviteId: "auto_4",
      status: "host",
      hostProfileId: "bob",
      hostLoginUid: "bob-login",
      guestProfileId: "dan",
      guestLoginUid: "dan-login",
      winnerProfileId: "bob",
      loserProfileId: "dan",
    },
    ...overrides,
  });

const ENDED_MATCH_RESULTS = {
  "round:0:0_0": { status: "scored", hostScore: 12, guestScore: 5 },
  "round:0:0_1": { status: "scored", hostScore: 3, guestScore: 8 },
  "round:1:1_0": { status: "scored", hostScore: 9, guestScore: 7 },
  third_place: { status: "scored", hostScore: 6, guestScore: 4 },
};
const ARMED_PROJECTION_STATE = { endedAnnouncementArmed: true };

const createProjectionError = (eventId, code) => {
  const error = new Error(`${code}:${eventId}`);
  error.code = code;
  return error;
};

const createEventTelegramProjector = (dependencies = {}) => {
  const database = dependencies.database;
  const commitDatabase = dependencies.commitDatabase || database;
  const lockManager =
    dependencies.lockManager || createRuntimeLockManager(database);
  const resolveEndedMatchResults =
    dependencies.loadEndedMatchResults || loadEndedMatchResults;
  const dispatchDelivery =
    dependencies.dispatchDelivery || (async () => ({ enqueued: true }));
  return async (eventId, nowMs = Date.now()) => {
    const lockHandle = await lockManager.acquireEventLock(
      eventId,
      "event-telegram-projector",
    );
    if (!lockHandle) {
      throw createProjectionError(eventId, "event-telegram-lock-busy");
    }
    const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
    try {
      const eventData = (await database.ref(`events/${eventId}`).once()).val();
      const rawState = (
        await database.ref(`eventTelegramProjections/${eventId}`).once()
      ).val();
      const endedMatchResults =
        eventData?.announceOnTelegram === true &&
        eventData?.status === "ended" &&
        rawState?.endedAnnouncementArmed === true &&
        !rawState?.endedText
          ? await resolveEndedMatchResults(eventData, {
              readRatingUpdate: async () => null,
            })
          : {};
      const projection = buildEventTelegramProjection({
        eventId,
        eventData,
        endedMatchResults,
        state: rawState,
        nowMs,
      });
      if (projection.action !== "project") {
        return projection;
      }
      const updates = addEventTelegramProjectionGuard({
        updates: buildEventTelegramProjectionUpdates({ eventId, projection }),
        guard: lockManager.getEventLockGuard(lockHandle),
      });
      const { desiredUpdates, stateUpdates } =
        splitEventTelegramProjectionUpdates({ eventId, updates });
      const refreshLock = async () => {
        if (!(await lockManager.refreshEventLock(lockHandle))) {
          throw createProjectionError(eventId, "event-telegram-lock-lost");
        }
      };
      try {
        if (Object.keys(desiredUpdates).length > 0) {
          await refreshLock();
          await commitDatabase.ref().update(desiredUpdates);
          const dispatches = buildEventTelegramDispatches({
            eventId,
            desiredUpdates,
          });
          await Promise.all(dispatches.map(dispatchDelivery));
        }
        await refreshLock();
        await commitDatabase.ref().update(stateUpdates);
      } catch (error) {
        if (String(error?.code).includes("PERMISSION_DENIED")) {
          throw createProjectionError(eventId, "event-telegram-lock-lost");
        }
        throw error;
      }
      return projection;
    } finally {
      stopHeartbeat();
      await lockManager.releaseEventLock(lockHandle);
    }
  };
};

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
        value.destination !== "community" ||
        ![
          `event:${guard.eventId}:upcoming`,
          `event:${guard.eventId}:started`,
          `event:${guard.eventId}:ended`,
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
      "join sunday mons",
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
      "join sunday mons",
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
  assert.equal(desired.destination, "community");
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

test("sends the exact ended template with ordered scores and podium", () => {
  const projection = buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData: buildEndedEvent(),
    endedMatchResults: ENDED_MATCH_RESULTS,
    state: ARMED_PROJECTION_STATE,
    nowMs: NOW_MS,
  });
  const ended = operationFor(projection, "ended");

  assert.equal(projection.operations.length, 1);
  assert.equal(ended.operation, "send");
  assert.equal(ended.messageKey, `event:${EVENT_ID}:ended`);
  assert.equal(ended.instanceKey, `event:${EVENT_ID}:ended:v2`);
  assert.equal(
    ended.text,
    [
      "event ended",
      "",
      "https://mons.link/event/EV2026",
      "",
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${DAN_EMOJI} Dan (12 - 5)`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${CAROL_EMOJI} Carol (3 - 8)`,
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${CAROL_EMOJI} Carol (9 - 7)`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${DAN_EMOJI} Dan (6 - 4)`,
      "",
      `1. ${ALICE_EMOJI} &lt;Alice&gt;`,
      `2. ${CAROL_EMOJI} Carol`,
      `3. ${BOB_EMOJI} Bob &amp; Co`,
    ].join("\n"),
  );
  assert.equal(projection.state.endedText, ended.text);
  const updates = buildEventTelegramProjectionUpdates({
    eventId: EVENT_ID,
    projection,
  });
  const desired = updates[`telegramMessages/event:${EVENT_ID}:ended/desired`];
  assert.equal(desired.operation, "send");
  assert.equal(desired.destination, "community");
  assert.equal(desired.parseMode, "HTML");
  assert.equal(desired.text, ended.text);
  assert.equal(
    buildEventTelegramProjection({
      eventId: EVENT_ID,
      eventData: buildEndedEvent(),
      endedMatchResults: ENDED_MATCH_RESULTS,
      state: projection.state,
      nowMs: NOW_MS,
    }).action,
    "unchanged",
  );
  assert.equal(
    buildEventTelegramProjection({
      eventId: EVENT_ID,
      eventData: buildEndedEvent({
        participants: {
          ...buildEndedEvent().participants,
          alice: {
            ...buildEndedEvent().participants.alice,
            username: "Renamed after ending",
          },
        },
      }),
      endedMatchResults: {},
      state: projection.state,
      nowMs: NOW_MS,
    }).action,
    "unchanged",
  );
});

test("does not send ended results for an event that did not opt in", () => {
  const projection = buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData: buildEndedEvent({ announceOnTelegram: false }),
    endedMatchResults: ENDED_MATCH_RESULTS,
    state: ARMED_PROJECTION_STATE,
    nowMs: NOW_MS,
  });
  assert.equal(operationFor(projection, "ended"), undefined);
  assert.equal(projection.state.endedText, "");
});

test("does not backfill an already-ended event that was never armed", () => {
  const projection = buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData: buildEndedEvent(),
    endedMatchResults: ENDED_MATCH_RESULTS,
    state: null,
    nowMs: NOW_MS,
  });
  assert.equal(operationFor(projection, "ended"), undefined);
  assert.equal(projection.state.endedAnnouncementArmed, false);
});

test("renders available podium places and DQ matches without a score", () => {
  const eventData = buildEndedEvent({
    thirdPlaceMatch: {
      ...buildEndedEvent().thirdPlaceMatch,
      winnerDisqualified: true,
    },
  });
  const results = { ...ENDED_MATCH_RESULTS };
  delete results.third_place;
  const ended = buildEndedState(EVENT_ID, eventData, results);

  assert.equal(
    ended.matchLines[ended.matchLines.length - 1],
    `${BOB_EMOJI} Bob &amp; Co vs. ${DAN_EMOJI} Dan (DQ)`,
  );
  assert.deepEqual(ended.placementLines, [
    `1. ${ALICE_EMOJI} &lt;Alice&gt;`,
    `2. ${CAROL_EMOJI} Carol`,
  ]);
});

test("uses fallback placements and limits two-player events to two places", () => {
  const noThirdPlace = buildEndedState(
    EVENT_ID,
    buildEndedEvent({ thirdPlaceMatch: null }),
    ENDED_MATCH_RESULTS,
  );
  assert.equal(noThirdPlace.placementLines[2], `3. ${BOB_EMOJI} Bob &amp; Co`);

  const twoPlayerEvent = buildEvent({
    status: "ended",
    winnerProfileId: "alice",
    participants: {
      alice: buildEndedEvent().participants.alice,
      bob: buildEndedEvent().participants.bob,
    },
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          "0_0": {
            inviteId: "auto_final",
            status: "host",
            hostProfileId: "alice",
            hostLoginUid: "alice-login",
            guestProfileId: "bob",
            guestLoginUid: "bob-login",
            winnerProfileId: "alice",
            loserProfileId: "bob",
          },
        },
      },
    },
  });
  const twoPlayer = buildEndedState(EVENT_ID, twoPlayerEvent, {
    "round:0:0_0": { status: "scored", hostScore: 10, guestScore: 4 },
  });
  assert.deepEqual(twoPlayer.placementLines, [
    `1. ${ALICE_EMOJI} &lt;Alice&gt;`,
    `2. ${BOB_EMOJI} Bob &amp; Co`,
  ]);
});

test("renders an ended projection when a normal match score is unavailable", () => {
  const projection = buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData: buildEndedEvent(),
    endedMatchResults: {},
    state: ARMED_PROJECTION_STATE,
    nowMs: NOW_MS,
  });
  assert.match(
    operationFor(projection, "ended").text,
    /Alice&gt; vs\..*Dan \(score unavailable\)/,
  );
});

test("loads host and guest scores from the completed rating result", async () => {
  const eventData = buildEvent({
    status: "ended",
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          "0_0": {
            inviteId: "auto_final",
            hostLoginUid: "host-login",
            guestLoginUid: "guest-login",
          },
        },
      },
    },
  });
  const values = {
    auto_final__auto_final: {
      status: "done",
      inviteId: "auto_final",
      matchId: "auto_final",
      playerId: "guest-login",
      opponentId: "host-login",
      playerManaPoints: 4,
      opponentManaPoints: 9,
    },
  };
  const paths = [];
  const readRatingUpdate = async (id) => {
    paths.push(id);
    return values[id] || null;
  };
  const result = await loadEndedMatchResults(eventData, {
    readRatingUpdate,
  });

  assert.deepEqual(paths, ["auto_final__auto_final"]);
  assert.deepEqual(result, {
    "round:0:0_0": { status: "scored", hostScore: 9, guestScore: 4 },
  });
  delete values.auto_final__auto_final;
  assert.deepEqual(
    await loadEndedMatchResults(eventData, { readRatingUpdate }),
    { "round:0:0_0": { status: "unavailable" } },
  );

  const disqualified = await loadEndedMatchResults(
    buildEvent({
      status: "ended",
      rounds: {
        0: {
          roundIndex: 0,
          matches: {
            "0_0": {
              inviteId: "auto_dq",
              winnerDisqualified: true,
            },
          },
        },
      },
    }),
    {
      readRatingUpdate() {
        throw new Error("DQ matches must not load rating results");
      },
    },
  );
  assert.deepEqual(disqualified, {
    "round:0:0_0": { status: "disqualified" },
  });
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
    assert.equal(active.state.endedAnnouncementArmed, true);
    const terminal = project(buildEvent({ status }), active.state);
    const retainedOperations = terminal.operations.filter(
      (operation) => operation.channel !== "ended",
    );
    assert.equal(retainedOperations.length, 2);
    for (const operation of retainedOperations) {
      assert.equal(operation.operation, "edit");
      assert.equal(operation.ifMissing, "skip");
    }
    const ended = operationFor(terminal, "ended");
    if (status === "ended") {
      assert.equal(ended.operation, "send");
      assert.equal(ended.text, "event ended\n\nhttps://mons.link/event/EV2026");
    } else {
      assert.equal(ended, undefined);
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

test("the runtime projector persists the ended post through the guarded channel", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEndedEvent(),
    [`eventTelegramProjections/${EVENT_ID}`]: ARMED_PROJECTION_STATE,
  });
  let scoreLoadCount = 0;
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    loadEndedMatchResults: async () => {
      scoreLoadCount += 1;
      return ENDED_MATCH_RESULTS;
    },
  });

  const projection = await projector(EVENT_ID, NOW_MS);

  assert.equal(projection.action, "project");
  assert.equal(scoreLoadCount, 1);
  const desired = database.read(
    `telegramMessages/event:${EVENT_ID}:ended/desired`,
  );
  assert.equal(desired.operation, "send");
  assert.equal(desired.text, projection.state.endedText);
  assert.equal(
    desired[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD].messageKey,
    `event:${EVENT_ID}:ended`,
  );
  assert.equal((await projector(EVENT_ID, NOW_MS)).action, "unchanged");
  assert.equal(scoreLoadCount, 1);
});

test("the runtime projector dispatches persisted desired state before advancing projection state", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  const dispatches = [];
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    dispatchDelivery: async (input) => {
      dispatches.push(input);
      assert.ok(database.read(`telegramMessages/${input.messageKey}/desired`));
      assert.equal(database.read(`eventTelegramProjections/${EVENT_ID}`), null);
      return { enqueued: true };
    },
  });

  const projection = await projector(EVENT_ID, NOW_MS);

  assert.equal(projection.action, "project");
  assert.equal(dispatches.length, 1);
  assert.equal(
    dispatches[0].generation,
    `event:${EVENT_ID}:${dispatches[0].revision}`,
  );
  assert.ok(database.read(`eventTelegramProjections/${EVENT_ID}`));
  assert.equal(database.updateCalls.length, 2);
});

test("a bridge failure preserves desired state and retries the same deterministic dispatch", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  const dispatches = [];
  let failDispatch = true;
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    dispatchDelivery: async (input) => {
      dispatches.push(input);
      if (failDispatch) {
        throw new Error("bridge-unavailable");
      }
      return { enqueued: true };
    },
  });

  await assert.rejects(() => projector(EVENT_ID, NOW_MS), /bridge-unavailable/);
  assert.ok(
    database.read(`telegramMessages/event:${EVENT_ID}:upcoming/desired`),
  );
  assert.equal(database.read(`eventTelegramProjections/${EVENT_ID}`), null);

  failDispatch = false;
  await projector(EVENT_ID, NOW_MS);
  assert.deepEqual(dispatches[1], dispatches[0]);
  assert.ok(database.read(`eventTelegramProjections/${EVENT_ID}`));
});

test("the runtime projector does not backfill an unarmed ended event", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEndedEvent(),
  });
  let scoreLoadCount = 0;
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    loadEndedMatchResults: async () => {
      scoreLoadCount += 1;
      return ENDED_MATCH_RESULTS;
    },
  });

  const projection = await projector(EVENT_ID, NOW_MS);

  assert.equal(projection.action, "project");
  assert.equal(scoreLoadCount, 0);
  assert.equal(
    database.read(`telegramMessages/event:${EVENT_ID}:ended/desired`),
    null,
  );
});

test("the shared projection core has no Firebase runtime dependencies", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../functions/telegram/eventProjectionCore.js"),
    "utf8",
  );
  assert.equal(source.includes("firebase-admin"), false);
  assert.equal(source.includes("firebase-functions"), false);
  assert.equal(source.includes("queueBridge"), false);
});

test("RTDB rules retain event outboxes without Telegram delivery records", () => {
  const rules = JSON.parse(fs.readFileSync(databaseRulesPath, "utf8"));
  assert.deepEqual(rules.rules.telegramProjectionOutbox.event[".indexOn"], [
    "updatedAtMs",
  ]);
  assert.equal(rules.rules.eventTelegramProjectionLocks, undefined);
  assert.equal(rules.rules.eventTelegramProjections, undefined);
  assert.equal(rules.rules.telegramMessages, undefined);
  assert.equal(rules.rules.events["$eventId"][".write"], false);
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
            destination: "community",
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
  assert.equal(database.updateCalls.length, 2);
  const updates = {
    ...database.updateCalls[0],
    ...database.updateCalls[1],
  };
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
  assert.equal(database.updateCalls.length, 2);
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
  assert.equal(database.updateCalls.length, 2);

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

test("missing normal scores do not block projection state", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEndedEvent(),
    [`eventTelegramProjections/${EVENT_ID}`]: ARMED_PROJECTION_STATE,
  });
  const projector = createEventTelegramProjector({
    database,
    commitDatabase: database,
    loadEndedMatchResults: async () => ({}),
  });

  const projection = await projector(EVENT_ID, NOW_MS);
  assert.equal(projection.action, "project");
  assert.match(
    database.read(`telegramMessages/event:${EVENT_ID}:ended/desired`).text,
    /score unavailable/,
  );
  assert.equal(
    database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
    null,
  );
  assert.equal(
    database.read(`eventTelegramProjections/${EVENT_ID}`).endedText,
    projection.state.endedText,
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
  assert.equal(database.updateCalls.length, 2);
  const state = database.read(`eventTelegramProjections/${EVENT_ID}`);
  assert.deepEqual(state.startedMatchKeys, [
    "round:0:match_0",
    "round:1:match_0",
  ]);
  assert.equal((state.startedText.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((state.startedText.match(/Carol vs\. Dan/g) || []).length, 1);
});
