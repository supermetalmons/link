"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  event: eventFixture,
  participant: participantFixture,
} = require("./fixtures/canonicalEvents");
const { resolveEventTelegramAnnouncements } = require("@mons/shared/events");
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
} = require("./eventProjectionChangesFixture");
const {
  buildTelegramEditDesired,
} = require("../runtime/telegram/desiredStateCore");
const {
  buildSundayMonsReminder,
} = require("../runtime/telegram/sundayMonsReminder");
const {
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
} = require("../runtime/events/lockManagerCore");
const {
  EVENT_LOCK_ROOT,
  runStateDecisionTransaction,
} = require("./legacyStateFixture");

const { readTelegramDesired } = require("../runtime/telegram/recordCodec");
const {
  readEventTelegramProjectionDocument,
} = require("../runtime/telegram/eventProjectionRecords");
/**
 * @typedef {import("./fixtures/canonicalEvents").EventPatch} EventPatch
 * @typedef {import("../runtime/telegram/eventProjectionCore").EventTelegramProjection} Projection
 * @typedef {import("../runtime/telegram/eventProjectionCore").EventTelegramProjectionOperation} Operation
 * @typedef {Record<string, unknown>} RawRecord
 * @typedef {import("../runtime/events/lockManagerCore").EventLockHandle} LockHandle
 * @typedef {import("../runtime/events/lockManagerCore").EventLockManager} LockManager
 * @typedef {{update(updates: RawRecord): Promise<void>}} RootReference
 * @typedef {{path: string, once(): Promise<ReturnType<typeof createSnapshot>>, transaction(update: (value: unknown) => unknown, ...extra: unknown[]): Promise<{committed: boolean, value: unknown}>}} ValueReference
 */
/** @param {unknown} value @returns {RawRecord | null} */
function rawRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {RawRecord} */ (value)
    : null;
}
/** @param {unknown} value */
function storedFields(value) {
  const fields = rawRecord(value);
  assert.ok(fields);
  return fields;
}
/** @param {unknown} value */
function textDesired(value) {
  const desired = readTelegramDesired(value);
  assert.ok(desired && desired.operation !== "delete");
  return desired;
}
const EVENT_ID = "EV2026";
const NOW_MS = Date.UTC(2026, 7, 7, 12, 0, 0);
const START_AT_MS = Date.UTC(2026, 7, 8, 17, 0, 0);
const ALICE_EMOJI =
  '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji>';
const BOB_EMOJI =
  '<tg-emoji emoji-id="5273897076990696847">&#11088;</tg-emoji>';
const CAROL_EMOJI =
  '<tg-emoji emoji-id="5274259447676427346">&#11088;</tg-emoji>';
const DAN_EMOJI =
  '<tg-emoji emoji-id="5274175124583505560">&#11088;</tg-emoji>';

/** @param {EventPatch} [overrides] */
const buildEvent = (overrides = {}) =>
  eventFixture({
    eventId: EVENT_ID,
    telegramDeliveryVersion: 2,
    telegramAnnouncements: { invite: true, matches: true, results: true },
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
    ...(overrides.participants
      ? {
          participants: Object.fromEntries(
            Object.entries(overrides.participants).map(([id, value]) => [
              id,
              participantFixture(id, {
                emojiId: 0,
                username: value.username ?? "",
                displayName: value.displayName ?? value.username ?? "anon",
                ...value,
              }),
            ]),
          ),
        }
      : {}),
  });

/** @param {EventPatch} [overrides] */
const buildEndedEvent = (overrides = {}) =>
  buildEvent({
    status: "ended",
    winnerProfileId: overrides.status === "active" ? null : "alice",
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

/** @type {import("../runtime/telegram/eventProjectionRecords").EventTelegramEndedResultsDocument} */
const ENDED_MATCH_RESULTS = {
  "round:0:0_0": { status: "scored", hostScore: 12, guestScore: 5 },
  "round:0:0_1": { status: "scored", hostScore: 3, guestScore: 8 },
  "round:1:1_0": { status: "scored", hostScore: 9, guestScore: 7 },
  third_place: { status: "scored", hostScore: 6, guestScore: 4 },
};
const ARMED_PROJECTION_STATE = { endedAnnouncementArmed: true };

/** @param {string} eventId @param {string} code */
const createProjectionError = (eventId, code) => {
  return Object.assign(new Error(`${code}:${eventId}`), { code });
};

/** @param {{database: ReturnType<typeof createRuntimeDatabase>, commitDatabase?: ReturnType<typeof createRuntimeDatabase>, lockManager?: LockManager, loadEndedMatchResults?: typeof loadEndedMatchResults, dispatchDelivery?: (input: ReturnType<typeof buildEventTelegramDispatches>[number]) => Promise<unknown>}} dependencies */
const createEventTelegramProjector = (dependencies) => {
  const database = dependencies.database;
  const commitDatabase = dependencies.commitDatabase || database;
  const lockManager =
    dependencies.lockManager || createRuntimeLockManager(database);
  const resolveEndedMatchResults =
    dependencies.loadEndedMatchResults || loadEndedMatchResults;
  const dispatchDelivery =
    dependencies.dispatchDelivery || (async () => ({ enqueued: true }));
  return async (/** @type {string} */ eventId, nowMs = Date.now()) => {
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
        resolveEventTelegramAnnouncements(rawRecord(eventData) ?? {}).results &&
        rawRecord(eventData)?.status === "ended" &&
        rawRecord(rawState)?.endedAnnouncementArmed === true &&
        !rawRecord(rawState)?.endedText
          ? await resolveEndedMatchResults(eventData, {
              readRatingUpdates: async (operationIds) =>
                operationIds.map(() => null),
            })
          : {};
      const projection = buildEventTelegramProjection({
        eventId,
        eventData,
        endedMatchResults,
        state: rawState,
        upcomingMessage: (
          await database
            .ref(`telegramMessages/event:${eventId}:upcoming`)
            .once()
        ).val(),
        nowMs,
      });
      if (projection.action !== "project") {
        return projection;
      }
      const guard = lockManager.getEventLockGuard(lockHandle);
      assert.ok(guard.lockRoot === EVENT_TELEGRAM_PROJECTION_LOCK_ROOT);
      const updates = addEventTelegramProjectionGuard({
        updates: buildEventTelegramProjectionUpdates({ eventId, projection }),
        guard: { ...guard, lockRoot: guard.lockRoot },
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
        if (String(rawRecord(error)?.code).includes("PERMISSION_DENIED")) {
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

/** @param {unknown} eventData @param {unknown} [state] @param {number} [nowMs] @param {unknown} [upcomingMessage] @param {unknown} [reminderMessage] */
const project = (
  eventData,
  state = null,
  nowMs = NOW_MS,
  upcomingMessage,
  reminderMessage,
) =>
  buildEventTelegramProjection({
    eventId: EVENT_ID,
    eventData,
    state,
    nowMs,
    upcomingMessage,
    reminderMessage,
  });

/** @param {Parameters<typeof project>} args */
function projected(...args) {
  const result = project(...args);
  assert.ok(result.action === "project");
  return result;
}
/** @param {Projection} projection @param {string} channel */
function operationFor(projection, channel) {
  assert.ok(projection.action === "project");
  return projection.operations.find(
    (operation) => operation.channel === channel,
  );
}
/** @param {Projection} projection @param {string} channel */
function requiredOperation(projection, channel) {
  const operation = operationFor(projection, channel);
  assert.ok(operation);
  return operation;
}
/** @param {Projection} projection */
const publishedUpcomingMessage = (projection) => {
  const desired = textDesired(
    buildEventTelegramProjectionUpdates({
      eventId: EVENT_ID,
      projection,
    })[`telegramMessages/event:${EVENT_ID}:upcoming/desired`],
  );
  return {
    desired,
    applied: {
      destination: desired.destination,
      instanceKey: desired.instanceKey,
      messageId: 42,
      contentHash: desired.contentHash,
      revision: desired.revision,
    },
  };
};

const publishedReminderMessage = (
  text = buildSundayMonsReminder({ eventId: EVENT_ID }).text,
) => {
  const desired = buildTelegramEditDesired({
    destination: "community",
    instanceKey: `event:${EVENT_ID}:reminder:v2`,
    text,
    parseMode: "HTML",
    ifMissing: "skip",
    sourceRevision: "sent-reminder-receipt",
  });
  return {
    desired,
    applied: {
      destination: desired.destination,
      instanceKey: desired.instanceKey,
      chatId: "-100123",
      messageId: 23001,
      contentHash: desired.contentHash,
      revision: desired.revision,
    },
  };
};

/** @template Value @param {Value} value @returns {Value} */
const clone = (value) => (value === undefined ? value : structuredClone(value));

/** @param {unknown} value */
const createSnapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => clone(value),
});

/** @param {RawRecord} [initial] */
const createRuntimeDatabase = (initial = {}) => {
  const values = new Map(
    Object.entries(initial).map(([path, value]) => [path, clone(value)]),
  );
  /** @type {Map<string, () => void | Promise<void>>} */
  const readHooks = new Map();
  /** @type {Map<string, (updates: RawRecord) => void | Promise<void>>} */
  const updateHooks = new Map();
  /** @type {unknown} */
  let updateError = null;
  let serverNowMs = 1_000;
  /** @param {string} path @param {unknown} value */
  const validateGuardedUpdate = (path, value) => {
    const fields = rawRecord(value);
    const guard = rawRecord(fields?.[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD]);
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
        fields?.destination !== "community" ||
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
    const lock = rawRecord(values.get(`${guard.lockRoot}/${guard.eventId}`));
    return (
      lock &&
      lock.lockId === guard.lockId &&
      lock.ownerUid === guard.ownerUid &&
      typeof lock.expiresAtMs === "number" &&
      lock.expiresAtMs > serverNowMs
    );
  };
  return {
    onceCalls: /** @type {string[]} */ ([]),
    transactionCalls:
      /** @type {{path: string, argumentCount: number}[]} */ ([]),
    updateCalls: /** @type {RawRecord[]} */ ([]),
    /** @overload @param {""} [path] @returns {RootReference} */
    /** @overload @param {string} path @returns {ValueReference} */
    /** @param {string} [path] @returns {RootReference | ValueReference} */
    ref(path = "") {
      if (path === "") {
        return {
          update: async (/** @type {RawRecord} */ updates) => {
            const firstGuard = rawRecord(
              rawRecord(Object.values(updates)[0])?.[
                EVENT_TELEGRAM_PROJECTION_GUARD_FIELD
              ],
            );
            const updateHook =
              typeof firstGuard?.lockId === "string"
                ? updateHooks.get(firstGuard.lockId)
                : undefined;
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
              const error = Object.assign(
                new Error("PERMISSION_DENIED: Permission denied"),
                { code: "PERMISSION_DENIED" },
              );
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
        transaction: async (
          /** @type {(value: unknown) => unknown} */ update,
          .../** @type {unknown[]} */ extra
        ) => {
          this.transactionCalls.push({ path, argumentCount: 1 + extra.length });
          let output = update(undefined);
          const authoritative = clone(values.get(path) ?? null);
          if (authoritative !== null) {
            output = update(authoritative);
          }
          if (output === undefined) {
            return {
              committed: false,
              value: clone(authoritative),
            };
          }
          if (output === null) {
            values.delete(path);
          } else {
            values.set(path, clone(output));
          }
          return {
            committed: true,
            value: clone(output),
          };
        },
      };
    },
    /** @param {string} path */
    read(path) {
      return clone(values.get(path) ?? null);
    },
    /** @param {string} path @param {unknown} value */
    write(path, value) {
      if (value === null || value === undefined) {
        values.delete(path);
      } else {
        values.set(path, clone(value));
      }
    },
    /** @param {string} path @param {() => void | Promise<void>} hook */
    onRead(path, hook) {
      readHooks.set(path, hook);
    },
    /** @param {string} lockId @param {(updates: RawRecord) => void | Promise<void>} hook */
    onGuardedUpdate(lockId, hook) {
      updateHooks.set(lockId, hook);
    },
    /** @param {number} nowMs */
    setServerNow(nowMs) {
      serverNowMs = nowMs;
    },
    /** @param {unknown} error */
    failNextUpdate(error) {
      updateError = error;
    },
  };
};

/** @param {unknown} value @returns {value is import("../runtime/eventLeases").EventLeaseRecord} */
function currentLease(value) {
  const row = rawRecord(value);
  return (
    row !== null &&
    typeof row.lockId === "string" &&
    typeof row.ownerUid === "string" &&
    typeof row.acquiredAtMs === "number" &&
    typeof row.refreshedAtMs === "number" &&
    typeof row.expiresAtMs === "number" &&
    (row.ownerId === undefined || typeof row.ownerId === "string")
  );
}
/** @param {unknown} value @returns {import("../runtime/transactions").TransactionDecision<import("../runtime/eventLeases").EventLeaseRecord>} */
function leaseDecision(value) {
  const row = storedFields(value);
  assert.ok(row.decision === undefined || typeof row.decision === "string");
  const decision = row.decision === undefined ? {} : { decision: row.decision };
  if (row.commit === false) return { commit: false, ...decision };
  assert.ok(row.value === null || currentLease(row.value));
  return { value: row.value, ...decision };
}
/** @param {ReturnType<typeof createRuntimeDatabase>} database @param {() => number} [now] @param {string} [lockRoot] */
const createRuntimeLockManager = (
  database,
  now = () => 1_000,
  lockRoot = EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
) => {
  let lockIndex = 0;
  const timer = globalThis.setInterval(() => {}, 2 ** 31 - 1);
  globalThis.clearInterval(timer);
  const timers = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  test.mock.method(timers, "setInterval", () => timer);
  test.mock.method(timers, "clearInterval", () => {});
  return createEventLockManagerCore({
    now,
    createLockId: () => `runtime-lock-${++lockIndex}`,
    ...timers,
    logger: { error() {} },
    lockKind:
      lockRoot === EVENT_TELEGRAM_PROJECTION_LOCK_ROOT
        ? "telegram-projection"
        : "event",
    async transactEventLease(key, updater) {
      const result = await runStateDecisionTransaction(
        database.ref(`${lockRoot}/${key.id}`),
        (value) =>
          leaseDecision(
            /** @type {unknown} */ (Reflect.apply(updater, undefined, [value])),
          ),
      );
      const value = result.committed ? result.value : null;
      assert.ok(value === null || currentLease(value));
      return {
        committed: result.committed,
        value,
        ...(result.decision === undefined ? {} : { decision: result.decision }),
      };
    },
  });
};

/** @param {Promise<unknown> | (() => Promise<unknown>)} operation @param {string} code */
const expectProjectionError = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, code);
    return true;
  });
};

test("renders the exact upcoming template with DST-aware times and UTC date", () => {
  const eventData = buildEvent({
    isSundayMons: true,
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
      "sunday mons soon",
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
      "upcoming event",
      "",
      "https://mons.link/event/EV2026",
      "",
      "10 AM PT / 1 PM ET / 5 PM UTC",
    ].join("\n"),
  );
});

test("only an explicit Sunday Mons flag selects the Sunday headings", () => {
  for (const isSundayMons of [undefined, null, "true", 1]) {
    assert.throws(() =>
      Reflect.apply(buildEvent, undefined, [{ isSundayMons }]),
    );
  }
  for (const isSundayMons of [true, false]) {
    const scheduled = projected(buildEvent({ isSundayMons }));
    assert.equal(
      requiredOperation(scheduled, "upcoming").text.split("\n", 1)[0],
      isSundayMons === true ? "sunday mons soon" : "upcoming event",
    );
    const active = projected(
      buildEndedEvent({ isSundayMons, status: "active" }),
      scheduled.state,
    );
    assert.equal(
      requiredOperation(active, "started").text.split("\n", 1)[0],
      isSundayMons === true ? "sunday mons starting now!" : "event started",
    );
    const ended = project(buildEndedEvent({ isSundayMons }), active.state);
    assert.equal(
      requiredOperation(ended, "ended").text.split("\n", 1)[0],
      isSundayMons === true ? "good games" : "event complete",
    );
  }
});

test("published headings survive flag changes and ordinary event edits", async (t) => {
  for (const isSundayMons of [true, false]) {
    await t.test(String(isSundayMons), () => {
      const eventData = buildEvent({ isSundayMons });
      const first = projected(eventData);
      const message = publishedUpcomingMessage(first);
      const changedType = { ...eventData, isSundayMons: !isSundayMons };
      assert.equal(
        project(changedType, first.state, NOW_MS, message).action,
        "unchanged",
      );
      const changedEvent = {
        ...changedType,
        startAtMs: START_AT_MS + 30 * 60_000,
        participants: {
          ...eventData.participants,
          bob: participantFixture("bob", {
            username: "Bob",
            displayName: "Bob",
            emojiId: 0,
            joinedAtMs: 200,
          }),
        },
      };
      const edited = projected(changedEvent, first.state, NOW_MS, message);
      const operation = requiredOperation(edited, "upcoming");
      assert.equal(operation.operation, "edit");
      assert.equal(
        operation.text.split("\n", 1)[0],
        isSundayMons ? "sunday mons soon" : "upcoming event",
      );
      assert.match(operation.text, /10:30 AM PT \/ 1:30 PM ET \/ 5:30 PM UTC/);
      assert.match(operation.text, /&lt;Alice&gt; Bob$/);
      assert.equal(
        project(changedEvent, edited.state, NOW_MS, message).action,
        "unchanged",
      );
    });
  }
});

test("backfilling a legacy published event does not create Telegram work", () => {
  const legacy = projected(buildEvent({ isSundayMons: true }));
  const message = publishedUpcomingMessage(legacy);
  assert.equal(
    project(buildEvent(), legacy.state, NOW_MS, message).action,
    "unchanged",
  );
  assert.equal(
    project(buildEvent({ isSundayMons: true }), legacy.state, NOW_MS, message)
      .action,
    "unchanged",
  );
});

test("an unsent invitation adopts the current event type", () => {
  const pending = projected(buildEvent({ isSundayMons: true }));
  const { desired } = publishedUpcomingMessage(pending);
  const next = project(buildEvent(), pending.state, NOW_MS, { desired });
  const operation = requiredOperation(next, "upcoming");
  assert.equal(operation.text.split("\n", 1)[0], "upcoming event");
  assert.equal(operation.ifMissing, "send");
});

test("published desired text restores missing projection state with an edit", () => {
  const original = project(buildEvent({ isSundayMons: true }));
  const message = publishedUpcomingMessage(original);
  const recovered = projected(buildEvent(), null, NOW_MS, message);
  const operation = requiredOperation(recovered, "upcoming");
  assert.equal(operation.operation, "edit");
  assert.equal(operation.text, message.desired.text);
  assert.equal(
    project(buildEvent(), recovered.state, NOW_MS, message).action,
    "unchanged",
  );
});

test("a confirmed desired heading wins over stale projection state", () => {
  const stale = projected(buildEvent({ isSundayMons: true }));
  const sent = project(buildEvent());
  const message = publishedUpcomingMessage(sent);
  for (const confirmation of /** @type {const} */ ([
    "contentHash",
    "revision",
  ])) {
    const applied = {
      destination: message.applied.destination,
      instanceKey: message.applied.instanceKey,
      messageId: message.applied.messageId,
      [confirmation]: message.applied[confirmation],
    };
    const recovered = project(
      buildEvent({ isSundayMons: true }),
      stale.state,
      NOW_MS,
      { desired: message.desired, applied },
    );
    const operation = requiredOperation(recovered, "upcoming");
    assert.equal(operation.operation, "edit");
    assert.equal(operation.text, message.desired.text);
  }
});

test("unconfirmed desired text cannot replace a published projection heading", () => {
  const original = projected(buildEvent({ isSundayMons: true }));
  const pending = project(buildEvent());
  const message = {
    applied: publishedUpcomingMessage(original).applied,
    desired: publishedUpcomingMessage(pending).desired,
  };
  assert.equal(
    project(buildEvent(), original.state, NOW_MS, message).action,
    "unchanged",
  );
  const recovered = project(
    buildEvent({ isSundayMons: true }),
    null,
    NOW_MS,
    message,
  );
  assert.equal(
    requiredOperation(recovered, "upcoming").text.split("\n", 1)[0],
    "upcoming event",
  );
});

test("a legacy receipt without text preserves the Sunday heading", () => {
  const { applied } = publishedUpcomingMessage(
    project(buildEvent({ isSundayMons: true })),
  );
  const recovered = project(buildEvent(), null, NOW_MS, { applied });
  const operation = requiredOperation(recovered, "upcoming");
  assert.equal(operation.operation, "edit");
  assert.equal(operation.text.split("\n", 1)[0], "join sunday mons");
});

test("invalid applied receipts do not preserve a queued Sunday heading", () => {
  const pending = projected(buildEvent({ isSundayMons: true }));
  const message = publishedUpcomingMessage(pending);
  for (const applied of /** @type {Partial<ReturnType<typeof publishedUpcomingMessage>["applied"]>[]} */ ([
    {},
    { ...message.applied, messageId: 0 },
    { ...message.applied, destination: "events" },
    { ...message.applied, instanceKey: "event:other:upcoming:v2" },
  ])) {
    if (
      !applied.instanceKey ||
      typeof applied.messageId !== "number" ||
      applied.messageId <= 0
    ) {
      assert.throws(
        () =>
          project(buildEvent(), pending.state, NOW_MS, {
            desired: message.desired,
            applied,
          }),
        /invalid-event-telegram-message/,
      );
      continue;
    }
    const next = project(buildEvent(), pending.state, NOW_MS, {
      desired: message.desired,
      applied,
    });
    assert.equal(
      requiredOperation(next, "upcoming").text.split("\n", 1)[0],
      "upcoming event",
    );
  }
});

test("ignores Telegram-enabled v1 events without adopting them", () => {
  /** @type {RawRecord} */
  const eventData = { ...buildEvent() };
  delete eventData.telegramDeliveryVersion;
  assert.equal(buildEventSignature(eventData, NOW_MS), "skip");
  assert.deepEqual(project(eventData), {
    action: "skip",
    reason: "not-v2",
  });
});

test("queues the first upcoming post as an HTML send", () => {
  const projection = projected(buildEvent());
  assert.equal(projection.action, "project");
  assert.equal(projection.operations.length, 1);
  const upcoming = requiredOperation(projection, "upcoming");
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
  const desired = textDesired(
    updates[`telegramMessages/event:${EVENT_ID}:upcoming/desired`],
  );
  assert.equal(desired.operation, "send");
  assert.equal(desired.destination, "community");
  assert.equal(desired.parseMode, "HTML");
  assert.equal(desired.silent, false);
  assert.equal(desired.disableWebPagePreview, true);
  assert.equal(desired.text, projection.state.upcomingText);
});

test("participant changes edit the upcoming post and replace it if missing", () => {
  const first = projected(buildEvent());
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
  const second = projected(eventData, first.state);
  const upcoming = requiredOperation(second, "upcoming");
  assert.equal(upcoming.operation, "edit");
  assert.equal(upcoming.ifMissing, "send");
  assert.match(upcoming.text, /&lt;Alice&gt; Bob$/);
  assert.notEqual(second.signature, first.signature);
  assert.equal(project(eventData, second.state).action, "unchanged");
});

test("announcement preferences independently control each event stage", async (t) => {
  for (let mask = 0; mask < 8; mask += 1) {
    const telegramAnnouncements = {
      invite: Boolean(mask & 1),
      matches: Boolean(mask & 2),
      results: Boolean(mask & 4),
    };
    await t.test(JSON.stringify(telegramAnnouncements), () => {
      const scheduled = projected(buildEvent({ telegramAnnouncements }));
      assert.deepEqual(
        scheduled.operations.map(({ channel }) => channel),
        telegramAnnouncements.invite ? ["upcoming"] : [],
      );
      assert.equal(
        scheduled.state.endedAnnouncementArmed,
        telegramAnnouncements.results,
      );
      const started = projected(
        buildEndedEvent({ telegramAnnouncements, status: "active" }),
        scheduled.state,
      );
      assert.equal(
        Boolean(operationFor(started, "started")),
        telegramAnnouncements.matches,
      );
      assert.equal(
        operationFor(started, "upcoming")?.ifMissing,
        telegramAnnouncements.invite ? "skip" : undefined,
      );
      const ended = project(
        buildEndedEvent({ telegramAnnouncements }),
        started.state,
      );
      assert.equal(
        Boolean(operationFor(ended, "ended")),
        telegramAnnouncements.results,
      );
      assert.equal(
        operationFor(ended, "started")?.ifMissing,
        telegramAnnouncements.matches ? "skip" : undefined,
      );
    });
  }
});

test("withheld invites stay silent through joins and postponements", () => {
  const telegramAnnouncements = { invite: false, matches: true, results: true };
  const scheduled = projected(buildEvent({ telegramAnnouncements }));
  const joinedEvent = buildEvent({
    telegramAnnouncements,
    participants: buildEndedEvent().participants,
  });
  assert.equal(project(joinedEvent, scheduled.state).action, "unchanged");
  const postponed = projected(
    { ...joinedEvent, startAtMs: START_AT_MS + 15 * 60_000 },
    scheduled.state,
  );
  assert.deepEqual(postponed.operations, []);
  assert.equal(postponed.state.upcomingText, "");
});

test("confirmed reminders acquire live participants independently of invitation settings", () => {
  const eventData = buildEvent({
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: buildEndedEvent().participants,
  });
  const hidden = projected(eventData);
  assert.deepEqual(hidden.operations, []);
  const reminderMessage = publishedReminderMessage();
  const announced = projected(
    eventData,
    hidden.state,
    NOW_MS,
    undefined,
    reminderMessage,
  );
  assert.deepEqual(
    announced.operations.map(({ channel }) => channel),
    ["reminder"],
  );
  const reminder = requiredOperation(announced, "reminder");
  assert.equal(reminder.operation, "edit");
  assert.equal(reminder.ifMissing, "skip");
  assert.equal(reminder.messageKey, `event:${EVENT_ID}:reminder`);
  assert.equal(reminder.instanceKey, `event:${EVENT_ID}:reminder:v2`);
  assert.equal(
    reminder.text,
    buildSundayMonsReminder({ eventId: EVENT_ID, eventData }).text,
  );
  assert.ok(reminder.text.startsWith(reminderMessage.desired.text));
  assert.equal(announced.state.reminderText, reminder.text);
  assert.notEqual(announced.signature, hidden.signature);
  assert.equal(
    project(eventData, announced.state, NOW_MS, undefined, reminderMessage)
      .action,
    "unchanged",
  );
  const desired = textDesired(
    buildEventTelegramProjectionUpdates({
      eventId: EVENT_ID,
      projection: announced,
    })[`telegramMessages/event:${EVENT_ID}:reminder/desired`],
  );
  assert.equal(desired.operation, "edit");
  assert.equal(desired.ifMissing, "skip");
  assert.equal(desired.parseMode, "HTML");
  assert.equal(desired.disableWebPagePreview, true);
});

test("reminders update for joins, participant edits, and drops below the invitation threshold", () => {
  const eventData = buildEvent({
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: {},
  });
  const reminderMessage = publishedReminderMessage();
  const empty = projected(eventData, null, NOW_MS, undefined, reminderMessage);
  const singleEvent = { ...eventData, participants: buildEvent().participants };
  assert.equal(
    project(singleEvent, empty.state, NOW_MS, undefined, reminderMessage)
      .action,
    "unchanged",
  );
  const joinedEvent = {
    ...singleEvent,
    participants: {
      ...singleEvent.participants,
      bob: participantFixture("bob", {
        username: "",
        displayName: "Bob",
        emojiId: 0,
        joinedAtMs: 200,
      }),
    },
  };
  const joined = projected(
    joinedEvent,
    empty.state,
    NOW_MS,
    undefined,
    reminderMessage,
  );
  assert.match(
    requiredOperation(joined, "reminder").text,
    /&lt;Alice&gt; Bob$/,
  );
  const changedEvent = {
    ...joinedEvent,
    participants: {
      ...joinedEvent.participants,
      bob: participantFixture("bob", {
        username: "Bobby & Co",
        displayName: "Bobby & Co",
        emojiId: 2,
        joinedAtMs: 200,
      }),
    },
  };
  const changed = projected(
    changedEvent,
    joined.state,
    NOW_MS,
    undefined,
    reminderMessage,
  );
  assert.notEqual(changed.signature, joined.signature);
  assert.ok(
    requiredOperation(changed, "reminder").text.endsWith(
      `${BOB_EMOJI} Bobby &amp; Co`,
    ),
  );
  const left = project(
    singleEvent,
    changed.state,
    NOW_MS,
    undefined,
    reminderMessage,
  );
  assert.equal(
    requiredOperation(left, "reminder").text,
    reminderMessage.desired.text,
  );
  for (const projection of [empty, joined, changed, left]) {
    assert.ok(projection.action === "project");
    assert.ok(
      projection.operations.every(
        ({ operation, ifMissing }) =>
          operation === "edit" && ifMissing === "skip",
      ),
    );
  }
});

test("legacy reminder participant edits preserve the sent or persisted three-hour heading", () => {
  const eventData = buildEvent({
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: buildEndedEvent().participants,
  });
  const legacyText = buildSundayMonsReminder({
    eventId: EVENT_ID,
    leadMs: 10_800_000,
  }).text;
  const legacyMessage = publishedReminderMessage(legacyText);
  const pendingMessage = {
    ...legacyMessage,
    desired: publishedReminderMessage().desired,
  };
  for (const [message, state] of [
    [legacyMessage, null],
    [pendingMessage, { reminderText: legacyText }],
  ]) {
    const joined = projected(eventData, state, NOW_MS, undefined, message);
    const expectedText = buildSundayMonsReminder({
      eventId: EVENT_ID,
      eventData,
      leadMs: 10_800_000,
    }).text;
    assert.equal(requiredOperation(joined, "reminder").text, expectedText);
    const published = publishedReminderMessage(expectedText);
    const left = project(
      { ...eventData, participants: {} },
      joined.state,
      NOW_MS,
      undefined,
      published,
    );
    assert.equal(requiredOperation(left, "reminder").text, legacyText);
    const stopped = projected(
      buildEvent({
        telegramAnnouncements: eventData.telegramAnnouncements,
        isSundayMons: eventData.isSundayMons,
        status: "active",
        participants: eventData.participants,
      }),
      joined.state,
      NOW_MS,
      undefined,
      published,
    );
    assert.equal(stopped.state.reminderText, expectedText);
  }
});

test("unconfirmed or missing reminder targets never create a reminder", () => {
  const eventData = buildEvent({
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: buildEndedEvent().participants,
  });
  const message = publishedReminderMessage();
  for (const reminderMessage of /** @type {({desired: ReturnType<typeof publishedReminderMessage>["desired"], applied?: Partial<ReturnType<typeof publishedReminderMessage>["applied"]>} | undefined)[]} */ ([
    undefined,
    { desired: message.desired },
    { ...message, applied: {} },
    { ...message, applied: { ...message.applied, messageId: 0 } },
    { ...message, applied: { ...message.applied, messageId: 1.5 } },
    { ...message, applied: { ...message.applied, destination: "events" } },
    {
      ...message,
      applied: { ...message.applied, instanceKey: "event:other:reminder:v2" },
    },
  ])) {
    if (
      reminderMessage?.applied &&
      (!reminderMessage.applied.instanceKey ||
        !Number.isSafeInteger(reminderMessage.applied.messageId) ||
        (typeof reminderMessage.applied.messageId === "number" &&
          reminderMessage.applied.messageId <= 0))
    ) {
      assert.throws(
        () =>
          project(
            eventData,
            { reminderText: message.desired.text },
            NOW_MS,
            undefined,
            reminderMessage,
          ),
        /invalid-event-telegram-message/,
      );
      continue;
    }
    const projection = projected(
      eventData,
      { reminderText: message.desired.text },
      NOW_MS,
      undefined,
      reminderMessage,
    );
    assert.deepEqual(projection.operations, []);
  }
});

test("reminder target identity changes force an edit even when participant text is unchanged", () => {
  const eventData = buildEvent({
    telegramAnnouncements: { invite: false, matches: false, results: false },
  });
  const reminderMessage = publishedReminderMessage();
  const first = projected(eventData, null, NOW_MS, undefined, reminderMessage);
  const replacement = projected(eventData, first.state, NOW_MS, undefined, {
    ...reminderMessage,
    applied: { ...reminderMessage.applied, messageId: 23002 },
  });
  assert.notEqual(replacement.signature, first.signature);
  assert.equal(requiredOperation(replacement, "reminder").operation, "edit");
  assert.equal(requiredOperation(replacement, "reminder").ifMissing, "skip");
});

test("reminder participant text freezes after registration and retains its original heading", () => {
  const eventData = buildEvent({
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: buildEndedEvent().participants,
  });
  const message = publishedReminderMessage();
  const scheduled = projected(eventData, null, NOW_MS, undefined, message);
  const published = publishedReminderMessage(scheduled.state.reminderText);
  for (const status of /** @type {const} */ ([
    "active",
    "ended",
    "dismissed",
  ])) {
    const changed = buildEvent({
      telegramAnnouncements: eventData.telegramAnnouncements,
      status,
      isSundayMons: false,
      participants: {},
    });
    const stopped = projected(
      changed,
      scheduled.state,
      NOW_MS,
      undefined,
      published,
    );
    const reminder = requiredOperation(stopped, "reminder");
    assert.equal(reminder.operation, "edit");
    assert.equal(reminder.ifMissing, "skip");
    assert.equal(reminder.text, scheduled.state.reminderText);
    assert.ok(reminder.text.startsWith("sunday mons in 4 hours!\n\n"));
    assert.equal(
      project(changed, stopped.state, NOW_MS, undefined, published).action,
      "unchanged",
    );
  }
});

test("a confirmed manual invite unlocks edit-only participant updates", () => {
  const eventData = buildEvent({
    telegramAnnouncements: { invite: false, matches: false, results: false },
    participants: buildEndedEvent().participants,
  });
  const hidden = projected(eventData);
  const applied = {
    destination: "community",
    instanceKey: `event:${EVENT_ID}:upcoming:v2`,
    messageId: 42,
  };
  const upcomingMessage = { applied, delivery: { status: "pending" } };
  const announced = projected(eventData, hidden.state, NOW_MS, upcomingMessage);
  const operation = requiredOperation(announced, "upcoming");
  assert.equal(operation.operation, "edit");
  assert.equal(operation.ifMissing, "skip");
  assert.match(operation.text, /&lt;Alice&gt;/);
  assert.match(operation.text, /Bob &amp; Co/);
  assert.equal(
    project(eventData, announced.state, NOW_MS, upcomingMessage).action,
    "unchanged",
  );
  const missing = projected(eventData, announced.state);
  assert.equal(requiredOperation(missing, "upcoming").operation, "edit");
  assert.equal(requiredOperation(missing, "upcoming").ifMissing, "skip");
  assert.equal(project(eventData, missing.state).action, "unchanged");
  for (const invalid of /** @type {Partial<ReturnType<typeof publishedUpcomingMessage>["applied"]>[]} */ ([
    {},
    { ...applied, messageId: 0 },
    { ...applied, instanceKey: "event:other:upcoming:v2" },
    { ...applied, destination: "events" },
  ])) {
    if (
      !invalid.instanceKey ||
      typeof invalid.messageId !== "number" ||
      invalid.messageId <= 0
    )
      assert.throws(
        () => project(eventData, hidden.state, NOW_MS, { applied: invalid }),
        /invalid-event-telegram-message/,
      );
    else
      assert.equal(
        project(eventData, hidden.state, NOW_MS, { applied: invalid }).action,
        "unchanged",
      );
  }
});

test("pending manual invites stay hidden until sent and are suppressed after registration", () => {
  const eventData = buildEvent({
    telegramAnnouncements: { invite: false, matches: false, results: false },
  });
  const upcomingMessage = {
    desired: {
      destination: "community",
      instanceKey: `event:${EVENT_ID}:upcoming:v2`,
      operation: "send",
      text: "manually queued event invitation",
    },
  };
  const hidden = projected(eventData, null, NOW_MS, upcomingMessage);
  assert.deepEqual(hidden.operations, []);
  assert.equal(hidden.state.upcomingText, "");
  for (const status of /** @type {const} */ ([
    "active",
    "ended",
    "dismissed",
  ])) {
    const stopped = projected(
      buildEvent({
        telegramAnnouncements: eventData.telegramAnnouncements,
        isSundayMons: eventData.isSundayMons,
        status,
        participants: eventData.participants,
      }),
      hidden.state,
      NOW_MS,
      upcomingMessage,
    );
    const operation = requiredOperation(stopped, "upcoming");
    assert.equal(operation.operation, "edit");
    assert.equal(operation.ifMissing, "skip");
    assert.equal(operation.text, upcomingMessage.desired.text);
    assert.equal(
      project(
        buildEvent({
          telegramAnnouncements: eventData.telegramAnnouncements,
          isSundayMons: eventData.isSundayMons,
          status,
          participants: eventData.participants,
        }),
        stopped.state,
        NOW_MS,
        upcomingMessage,
      ).action,
      "unchanged",
    );
  }
});

test("starting an event suppresses an undelivered upcoming post and sends the match thread", () => {
  const scheduled = projected(buildEvent());
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
          "0_0": {
            status: "pending",
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const active = project(activeEvent, scheduled.state);
  const upcoming = requiredOperation(active, "upcoming");
  const started = requiredOperation(active, "started");
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
          "0_0": {
            status: "pending",
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const first = projected(firstEvent);
  assert.ok(firstEvent.rounds[0]);
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
          "1_0": {
            status: "pending",
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  const second = projected(secondEvent, first.state);
  const started = requiredOperation(second, "started");
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
    "round:0:0_0",
    "round:1:1_0",
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
  assert.ok(projection.action === "project");
  const ended = requiredOperation(projection, "ended");

  assert.equal(projection.operations.length, 1);
  assert.equal(ended.operation, "send");
  assert.equal(ended.messageKey, `event:${EVENT_ID}:ended`);
  assert.equal(ended.instanceKey, `event:${EVENT_ID}:ended:v2`);
  assert.equal(
    ended.text,
    [
      "event complete",
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
  const desired = textDesired(
    updates[`telegramMessages/event:${EVENT_ID}:ended/desired`],
  );
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
    eventData: buildEndedEvent({
      telegramAnnouncements: { invite: false, matches: false, results: false },
    }),
    endedMatchResults: ENDED_MATCH_RESULTS,
    state: ARMED_PROJECTION_STATE,
    nowMs: NOW_MS,
  });
  assert.ok(projection.action === "project");
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
  assert.ok(projection.action === "project");
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

  const completedEvent = buildEndedEvent();
  assert.ok(
    completedEvent.participants.alice && completedEvent.participants.bob,
  );
  const twoPlayerEvent = buildEvent({
    status: "ended",
    winnerProfileId: "alice",
    participants: {
      alice: completedEvent.participants.alice,
      bob: completedEvent.participants.bob,
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
  assert.deepEqual(
    requiredOperation(projection, "ended").text.split("\n").slice(4, 8),
    [
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${DAN_EMOJI} Dan`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${CAROL_EMOJI} Carol`,
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${CAROL_EMOJI} Carol`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${DAN_EMOJI} Dan`,
    ],
  );
});

test("loads and renders valid completed scores or matchup-only fallbacks", async (t) => {
  const completedEvent = buildEndedEvent();
  assert.ok(completedEvent.rounds[0]?.matches["0_0"]);
  const eventData = buildEndedEvent({
    rounds: {
      0: {
        roundIndex: 0,
        matches: {
          "0_0": completedEvent.rounds[0].matches["0_0"],
        },
      },
    },
    thirdPlaceMatch: null,
  });
  const completedResult = {
    status: "done",
    inviteId: "auto_1",
    matchId: "auto_1",
    playerId: "dan-login",
    opponentId: "alice-login",
    playerManaPoints: 4,
    opponentManaPoints: 9,
  };
  const matchup = `${ALICE_EMOJI} &lt;Alice&gt; vs. ${DAN_EMOJI} Dan`;
  /** @type {[string, unknown, [number, number]?][]} */
  const cases = [
    ["guest is rating player", completedResult, [9, 4]],
    [
      "host is rating player and guest has zero points",
      {
        ...completedResult,
        playerId: "alice-login",
        opponentId: "dan-login",
        playerManaPoints: 9,
        opponentManaPoints: 0,
      },
      [9, 0],
    ],
    ["missing result", null],
    ["incomplete result", { ...completedResult, status: "pending" }],
    ["missing score", { ...completedResult, playerManaPoints: undefined }],
    ["non-numeric score", { ...completedResult, opponentManaPoints: "9" }],
    ["non-finite score", { ...completedResult, playerManaPoints: Infinity }],
    ["mismatched invite", { ...completedResult, inviteId: "other-invite" }],
    ["mismatched match", { ...completedResult, matchId: "other-match" }],
    ["mismatched player", { ...completedResult, playerId: "other-login" }],
    ["mismatched opponent", { ...completedResult, opponentId: "other-login" }],
  ];

  for (const [name, ratingResult, scores] of cases) {
    await t.test(name, async () => {
      /** @type {(readonly string[])[]} */
      /** @type {(readonly string[])[]} */
      const reads = [];
      /** @type {Awaited<ReturnType<typeof loadEndedMatchResults>>} */
      const result = await Reflect.apply(loadEndedMatchResults, undefined, [
        eventData,
        {
          readRatingUpdates: async (/** @type {readonly string[]} */ ids) => {
            reads.push(ids);
            return ids.map(() => ratingResult);
          },
        },
      ]);

      assert.deepEqual(reads, [["auto_1__auto_1"]]);
      assert.deepEqual(result, {
        "round:0:0_0": scores
          ? { status: "scored", hostScore: scores[0], guestScore: scores[1] }
          : { status: "unavailable" },
      });
      assert.deepEqual(
        buildEndedState(EVENT_ID, eventData, result).matchLines,
        [scores ? `${matchup} (${scores[0]} - ${scores[1]})` : matchup],
      );
    });
  }
});

test("loads all eligible round and third-place scores in one batch", async () => {
  const eventData = buildEndedEvent();
  const ratings = new Map(
    /** @type {[string, string, string, number, number][]} */ ([
      ["auto_1", "alice-login", "dan-login", 12, 5],
      ["auto_2", "carol-login", "bob-login", 8, 3],
      ["auto_3", "alice-login", "carol-login", 9, 7],
      ["auto_4", "dan-login", "bob-login", 4, 6],
    ]).map(
      ([
        inviteId,
        playerId,
        opponentId,
        playerManaPoints,
        opponentManaPoints,
      ]) => [
        `${inviteId}__${inviteId}`,
        {
          status: /** @type {const} */ ("done"),
          inviteId,
          matchId: inviteId,
          playerId,
          opponentId,
          playerManaPoints,
          opponentManaPoints,
        },
      ],
    ),
  );
  /** @type {(readonly string[])[]} */
  const reads = [];
  const results = await loadEndedMatchResults(eventData, {
    readRatingUpdates: async (operationIds) => {
      reads.push(operationIds);
      return operationIds.map(
        (operationId) => ratings.get(operationId) ?? null,
      );
    },
  });
  assert.deepEqual(reads, [
    ["auto_1__auto_1", "auto_2__auto_2", "auto_3__auto_3", "auto_4__auto_4"],
  ]);
  assert.deepEqual(results, {
    ...ENDED_MATCH_RESULTS,
  });
});

test("does not load rating results for disqualified matches", async () => {
  const disqualified = await loadEndedMatchResults(
    buildEvent({
      status: "ended",
      rounds: {
        0: {
          roundIndex: 0,
          matches: {
            "0_0": {
              inviteId: "auto_dq",
              status: "pending",
              hostProfileId: "alice",
              guestProfileId: "bob",
              winnerDisqualified: true,
            },
          },
        },
      },
    }),
    {
      readRatingUpdates() {
        throw new Error("DQ matches must not load rating results");
      },
    },
  );
  assert.deepEqual(disqualified, {
    "round:0:0_0": { status: "disqualified" },
  });
});

for (const status of /** @type {const} */ (["ended", "dismissed"])) {
  test(`${status} events retain delivered posts and suppress missing posts`, () => {
    const scheduled = projected(buildEvent());
    const active = projected(
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
              "0_0": {
                status: "pending",
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
    const terminal = projected(buildEvent({ status }), active.state);
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
      assert.ok(ended);
      assert.equal(ended.operation, "send");
      assert.equal(
        ended.text,
        "event complete\n\nhttps://mons.link/event/EV2026",
      );
    } else {
      assert.equal(ended, undefined);
    }
    assert.equal(terminal.state.upcomingText, scheduled.state.upcomingText);
    assert.equal(terminal.state.startedText, active.state.startedText);
    assert.equal(
      terminal.operations.some((operation) =>
        ["delete"].includes(operation.operation),
      ),
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
  const desired = textDesired(
    database.read(`telegramMessages/event:${EVENT_ID}:ended/desired`),
  );
  assert.equal(desired.operation, "send");
  assert.equal(desired.text, projection.state.endedText);
  const desiredGuard = desired[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
  assert.ok(desiredGuard);
  assert.equal(desiredGuard.messageKey, `event:${EVENT_ID}:ended`);
  assert.equal((await projector(EVENT_ID, NOW_MS)).action, "unchanged");
  assert.equal(scoreLoadCount, 1);
});

test("the runtime projector dispatches persisted desired state before advancing projection state", async () => {
  const database = createRuntimeDatabase({
    [`events/${EVENT_ID}`]: buildEvent(),
  });
  /** @type {ReturnType<typeof buildEventTelegramDispatches>} */
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
  assert.ok(dispatches[0]);
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
  /** @type {ReturnType<typeof buildEventTelegramDispatches>} */
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
    path.resolve(__dirname, "../runtime/telegram/eventProjectionCore.js"),
    "utf8",
  );
  assert.equal(source.includes("firebase-admin"), false);
  assert.equal(source.includes("firebase-functions"), false);
  assert.equal(source.includes("queueBridge"), false);
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
  /** @type {import("../runtime/telegram/eventProjectionRecords").EventTelegramProjectionGuard} */
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
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "PERMISSION_DENIED");
        return true;
      });
    });
  }
});

test("projection locking stays isolated from the domain lock and commits desired state atomically", async () => {
  /** @type {PromiseWithResolvers<void>} */
  const { promise: eventReadStarted, resolve: markEventRead } =
    Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const { promise: eventReadBlocked, resolve: continueEventRead } =
    Promise.withResolvers();
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
    ...storedFields(updates[`eventTelegramProjections/${EVENT_ID}`]),
  };
  const projectionGuard =
    persistedProjection[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
  persistedProjection[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD] = null;
  assert.deepEqual(persistedProjection, projection.state);
  assert.deepEqual(projectionGuard, {
    lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    eventId: EVENT_ID,
    lockId: "runtime-lock-1",
    generation: 0,
    ownerUid: "event-telegram-projector",
  });
  const upcomingDesired = textDesired(
    updates[`telegramMessages/event:${EVENT_ID}:upcoming/desired`],
  );
  const upcomingGuard = upcomingDesired[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD];
  assert.ok(upcomingGuard);
  assert.equal(upcomingDesired.operation, "send");
  assert.equal(upcomingGuard.messageKey, `event:${EVENT_ID}:upcoming`);
  assert.equal(
    storedFields(database.read(`${EVENT_LOCK_ROOT}/${EVENT_ID}`)).lockId,
    domainLock.lockId,
  );
  assert.equal(
    database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
    null,
  );
  await domainLockManager.releaseEventLock(domainLock);
});

test("a domain-held lock does not block terminal projection", async () => {
  const scheduled = projected(buildEvent());
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
  assert.ok(domainLock);
  database.write(`events/${EVENT_ID}`, buildEvent({ status: "ended" }));

  const terminal = await projector(EVENT_ID, NOW_MS);
  assert.equal(terminal.action, "project");
  assert.equal(database.updateCalls.length, 2);
  const desired = textDesired(database.read(desiredPath));
  assert.equal(desired.operation, "edit");
  assert.equal(desired.ifMissing, "skip");
  assert.equal(
    terminal.operations.some((operation) =>
      ["delete"].includes(operation.operation),
    ),
    false,
  );
  assert.equal(
    storedFields(database.read(`${EVENT_LOCK_ROOT}/${EVENT_ID}`)).lockId,
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
      /** @param {LockHandle} lockHandle */
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
        storedFields(
          database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
        ).lockId,
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
          "0_0": {
            status: "pending",
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
          "1_0": {
            status: "pending",
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  let nowMs = 1_000;
  /** @type {PromiseWithResolvers<void>} */
  const { promise: staleCommitStarted, resolve: markStaleCommit } =
    Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const { promise: staleCommitBlocked, resolve: continueStaleCommit } =
    Promise.withResolvers();
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

  const state = readEventTelegramProjectionDocument(
    database.read(`eventTelegramProjections/${EVENT_ID}`),
  );
  assert.deepEqual(state.startedMatchKeys, ["round:0:0_0", "round:1:1_0"]);
  assert.equal((state.startedText.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((state.startedText.match(/Carol vs\. Dan/g) || []).length, 1);
  const desired = textDesired(
    database.read(`telegramMessages/event:${EVENT_ID}:started/desired`),
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
  assert.deepEqual(
    textDesired(
      database.read(`telegramMessages/event:${EVENT_ID}:ended/desired`),
    )
      .text.split("\n")
      .slice(4, 8),
    [
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${DAN_EMOJI} Dan`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${CAROL_EMOJI} Carol`,
      `${ALICE_EMOJI} &lt;Alice&gt; vs. ${CAROL_EMOJI} Carol`,
      `${BOB_EMOJI} Bob &amp; Co vs. ${DAN_EMOJI} Dan`,
    ],
  );
  assert.equal(
    database.read(`${EVENT_TELEGRAM_PROJECTION_LOCK_ROOT}/${EVENT_ID}`),
    null,
  );
  assert.equal(
    readEventTelegramProjectionDocument(
      database.read(`eventTelegramProjections/${EVENT_ID}`),
    ).endedText,
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
          "0_0": {
            status: "pending",
            inviteId: "auto_1",
            hostProfileId: "alice",
            guestProfileId: "bob",
          },
        },
      },
    },
  });
  const first = projected(firstEvent);
  const latestEvent = buildEvent({
    status: "active",
    participants,
    rounds: {
      ...firstEvent.rounds,
      1: {
        roundIndex: 1,
        matches: {
          "1_0": {
            status: "pending",
            inviteId: "auto_2",
            hostProfileId: "carol",
            guestProfileId: "dan",
          },
        },
      },
    },
  });
  /** @type {PromiseWithResolvers<void>} */
  const { promise: eventReadStarted, resolve: markEventRead } =
    Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const { promise: eventReadBlocked, resolve: continueEventRead } =
    Promise.withResolvers();
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
  const state = readEventTelegramProjectionDocument(
    database.read(`eventTelegramProjections/${EVENT_ID}`),
  );
  assert.deepEqual(state.startedMatchKeys, ["round:0:0_0", "round:1:1_0"]);
  assert.equal((state.startedText.match(/Alice vs\. Bob/g) || []).length, 1);
  assert.equal((state.startedText.match(/Carol vs\. Dan/g) || []).length, 1);
});
