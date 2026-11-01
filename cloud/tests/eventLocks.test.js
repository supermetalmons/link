"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
  withEventLease,
} = require("../runtime/events/lockManagerCore");
const {
  EVENT_LOCK_ROOT,
  runStateDecisionTransaction,
} = require("./legacyStateFixture");

const { eventTestLeasePath } = require("../workers/api/test/eventTestPorts.ts");

/** @template Value @param {Value} value @returns {Value} */
const clone = (value) => (value === undefined ? value : structuredClone(value));

/**
 * @typedef {import("../runtime/eventLeases").EventLeaseRecord} CurrentLease
 * @typedef {Partial<CurrentLease> & {expiresAtMs: number}} RawLease
 * @typedef {import("../runtime/events/lockManagerCore").EventLockHandle} LockHandle
 */
/** @param {unknown} value @returns {value is CurrentLease} */
function isCurrentLease(value) {
  if (!value || typeof value !== "object") return false;
  const row = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof row.lockId === "string" &&
    typeof row.ownerUid === "string" &&
    typeof row.acquiredAtMs === "number" &&
    typeof row.refreshedAtMs === "number" &&
    typeof row.expiresAtMs === "number"
  );
}
/** @param {unknown} output @returns {import("../runtime/transactions").TransactionDecision<CurrentLease>} */
function leaseDecision(output) {
  assert.ok(output && typeof output === "object");
  const row = /** @type {Record<string, unknown>} */ (output);
  assert.ok(row.decision === undefined || typeof row.decision === "string");
  const decision = row.decision === undefined ? {} : { decision: row.decision };
  if (row.commit === false) return { commit: false, ...decision };
  assert.ok(row.value === null || isCurrentLease(row.value));
  return { value: row.value, ...decision };
}
/** @param {string} eventId @returns {LockHandle} */
function leaseHandle(eventId) {
  return {
    eventId,
    key: { kind: "event", id: eventId },
    lockId: "fixture-lock",
    ownerUid: "fixture-owner",
    lockRoot: EVENT_LOCK_ROOT,
  };
}
/** @param {ReturnType<typeof createColdDatabase>} database @param {string} path */
function leaseAt(database, path) {
  const value = database.read(path);
  assert.ok(value);
  return value;
}
/** @param {Record<string, RawLease>} [initial] */
const createColdDatabase = (initial = {}) => {
  const values = new Map(
    Object.entries(initial).map(([path, value]) => [path, clone(value)]),
  );
  /** @type {Map<string, unknown>} */
  const failures = new Map();
  /** @type {{path: string, argumentCount: number}[]} */
  const transactionCalls = [];
  return {
    transactionCalls,
    /** @param {string} path */
    ref(path) {
      return {
        path,
        /** @param {(current: RawLease | null | undefined) => RawLease | null | undefined} update @param {unknown[]} extra */
        async transaction(update, ...extra) {
          transactionCalls.push({ path, argumentCount: 1 + extra.length });
          if (failures.has(path)) {
            throw failures.get(path);
          }
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
    /** @param {string} path @param {RawLease | null | undefined} value */
    write(path, value) {
      if (value === null || value === undefined) {
        values.delete(path);
      } else {
        values.set(path, clone(value));
      }
    },
    /** @param {string} path @param {unknown} error */
    fail(path, error) {
      failures.set(path, error);
    },
  };
};

/** @param {Omit<Parameters<typeof createEventLockManagerCore>[0], "transactEventLease" | "createLockId"> & {database: ReturnType<typeof createColdDatabase>, ids?: string[]}} input */
const createManager = ({ database, ids = ["lock-1"], ...options }) => {
  let idIndex = 0;
  return createEventLockManagerCore({
    ...options,
    createLockId: () => ids[idIndex++] || `lock-${idIndex}`,
    logger: options.logger || { error() {} },
    async transactEventLease(key, updater) {
      const result = await runStateDecisionTransaction(
        database.ref(eventTestLeasePath(key)),
        (current) =>
          leaseDecision(
            /** @type {unknown} */ (
              Reflect.apply(updater, undefined, [current])
            ),
          ),
      );
      const value = result.committed ? result.value : null;
      assert.ok(value === null || isCurrentLease(value));
      return {
        committed: result.committed,
        value,
        ...(result.decision === undefined ? {} : { decision: result.decision }),
      };
    },
  });
};

test("lease scopes preserve work outcomes and await release after stopping the heartbeat", async (t) => {
  for (const outcome of ["returned", "thrown"]) {
    await t.test(outcome, async () => {
      const handle = leaseHandle("event-1");
      const failure = new Error("work-failed");
      const value = { status: "complete" };
      /** @type {string[]} */
      const lifecycle = [];
      /** @type {PromiseWithResolvers<void>} */
      const releaseStarted = Promise.withResolvers();
      /** @type {PromiseWithResolvers<boolean>} */
      const releaseFinished = Promise.withResolvers();
      const manager = {
        /** @param {LockHandle} actual */
        startEventLockHeartbeat(actual) {
          assert.equal(actual, handle);
          lifecycle.push("start");
          return () => lifecycle.push("stop");
        },
        /** @param {LockHandle} actual */
        async releaseEventLock(actual) {
          assert.equal(actual, handle);
          lifecycle.push("release");
          releaseStarted.resolve();
          return releaseFinished.promise;
        },
      };
      let settled = false;
      const pending = withEventLease(manager, handle, async () => {
        lifecycle.push("work");
        if (outcome === "thrown") throw failure;
        return value;
      }).then(
        (result) => {
          settled = true;
          return { result };
        },
        (/** @type {unknown} */ error) => {
          settled = true;
          return { error };
        },
      );
      await releaseStarted.promise;
      assert.equal(settled, false);
      assert.deepEqual(lifecycle, ["start", "work", "stop", "release"]);
      releaseFinished.resolve(false);
      const result = await pending;
      assert.equal(settled, true);
      if (outcome === "thrown") {
        assert.ok("error" in result);
        assert.equal(result.error, failure);
      } else {
        assert.ok("result" in result);
        assert.equal(result.result, value);
      }
    });
  }
});

test("lease scopes always attempt release and preserve cleanup error precedence", async (t) => {
  for (const failurePoint of ["start", "stop", "release", "stop-and-release"]) {
    await t.test(failurePoint, async () => {
      const workFailure = new Error("work-failed");
      const heartbeatFailure = new Error("heartbeat-failed");
      const releaseFailure = new Error("release-failed");
      /** @type {string[]} */
      const lifecycle = [];
      const manager = {
        startEventLockHeartbeat() {
          lifecycle.push("start");
          if (failurePoint === "start") throw heartbeatFailure;
          return () => {
            lifecycle.push("stop");
            if (failurePoint.includes("stop")) throw heartbeatFailure;
          };
        },
        async releaseEventLock() {
          lifecycle.push("release");
          if (failurePoint.includes("release")) throw releaseFailure;
          return true;
        },
      };
      await assert.rejects(
        withEventLease(manager, leaseHandle("event-1"), async () => {
          lifecycle.push("work");
          throw workFailure;
        }),
        (error) =>
          error ===
          (failurePoint.includes("release")
            ? releaseFailure
            : heartbeatFailure),
      );
      assert.deepEqual(
        lifecycle,
        failurePoint === "start"
          ? ["start", "release"]
          : ["start", "work", "stop", "release"],
      );
    });
  }
});

test("validates lease domains and preserves the core default", () => {
  for (const lockKind of [
    "",
    "/locks",
    "locks/nested",
    "locks//nested",
    "locks\u0001child",
  ]) {
    assert.throws(
      () =>
        Reflect.apply(createEventLockManagerCore, undefined, [
          {
            createLockId: () => "lock",
            lockKind,
            transactEventLease: async () => ({ committed: false, value: null }),
          },
        ]),
      /invalid event lease kind/,
    );
  }
  for (const lockKind of /** @type {const} */ ([
    "event",
    "profile-game-projection",
    "telegram-projection",
    "transition",
  ]))
    assert.ok(
      createEventLockManagerCore({
        createLockId: () => "lock",
        lockKind,
        transactEventLease: async () => ({ committed: false, value: null }),
      }),
    );
  assert.equal(EVENT_LOCK_ROOT, "eventLocks");
});

test("acquires an event lock through a cold transaction", async () => {
  const database = createColdDatabase();
  const manager = createManager({ database, now: () => 1_000 });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);
  assert.equal(handle.eventId, "event-1");
  assert.equal(handle.lockId, "lock-1");
  assert.equal(handle.ownerUid, "owner-1");
  assert.equal(handle.lockRoot, EVENT_LOCK_ROOT);
  assert.deepEqual(manager.getEventLockGuard(handle), {
    lockRoot: EVENT_LOCK_ROOT,
    eventId: "event-1",
    lockId: "lock-1",
    ownerUid: "owner-1",
  });
  assert.deepEqual(database.read("eventLocks/event-1"), {
    lockId: "lock-1",
    ownerUid: "owner-1",
    expiresAtMs: 1_000 + EVENT_LOCK_TTL_MS,
    acquiredAtMs: 1_000,
    refreshedAtMs: 1_000,
  });
  assert.ok(database.transactionCalls[0]);
  assert.equal(database.transactionCalls[0].argumentCount, 1);
});

test("core and projection roots coexist while projection contenders exclude each other", async () => {
  const database = createColdDatabase();
  const coreManager = createManager({
    database,
    now: () => 1_000,
    ids: ["core-lock"],
  });
  const projectionManager = createManager({
    database,
    now: () => 1_000,
    ids: ["projection-lock"],
    lockKind: "telegram-projection",
  });
  const projectionContender = createManager({
    database,
    now: () => 1_000,
    ids: ["projection-contender"],
    lockKind: "telegram-projection",
  });

  const coreHandle = await coreManager.acquireEventLock("event-1", "domain");
  assert.ok(coreHandle);
  const projectionHandle = await projectionManager.acquireEventLock(
    "event-1",
    "projector",
  );

  assert.ok(coreHandle);
  assert.ok(projectionHandle);
  assert.equal(leaseAt(database, "eventLocks/event-1").lockId, "core-lock");
  assert.equal(
    leaseAt(database, "eventTelegramProjectionLocks/event-1").lockId,
    "projection-lock",
  );
  assert.equal(
    await projectionContender.acquireEventLock("event-1", "contender"),
    null,
  );
  assert.throws(
    () => coreManager.getEventLockGuard(projectionHandle),
    /lockHandle must identify an owned lock/,
  );
});

test("blocks an active foreign lease and takes it over only after expiry", async () => {
  let nowMs = 1_000;
  const database = createColdDatabase({
    "eventLocks/event-1": {
      lockId: "foreign-lock",
      ownerUid: "foreign-owner",
      acquiredAtMs: 500,
      refreshedAtMs: 500,
      expiresAtMs: 2_000,
    },
  });
  const manager = createManager({
    database,
    now: () => nowMs,
    ids: ["first-attempt", "replacement"],
  });
  assert.equal(await manager.acquireEventLock("event-1", "owner-1"), null);
  assert.equal(leaseAt(database, "eventLocks/event-1").lockId, "foreign-lock");

  nowMs = 2_001;
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);
  assert.equal(handle.lockId, "replacement");
  assert.equal(leaseAt(database, "eventLocks/event-1").lockId, "replacement");
});

test("retries acquisition with the existing attempt and delay semantics", async () => {
  let nowMs = 1_000;
  /** @type {number[]} */
  const delays = [];
  const database = createColdDatabase({
    "eventLocks/event-1": {
      lockId: "foreign-lock",
      ownerUid: "foreign-owner",
      expiresAtMs: 2_000,
    },
  });
  const manager = createManager({
    database,
    now: () => nowMs,
    ids: ["first-attempt", "second-attempt"],
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs = 2_001;
    },
  });
  const handle = await manager.acquireEventLockWithRetry("event-1", "owner-1", {
    attempts: 2,
    delayMs: 10,
  });
  assert.ok(handle);
  assert.equal(handle.lockId, "second-attempt");
  assert.deepEqual(delays, [25]);
});

test("ownership checks authoritatively refresh live leases and reject expired or foreign leases", async () => {
  let nowMs = 1_000;
  const database = createColdDatabase();
  const manager = createManager({ database, now: () => nowMs });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);

  nowMs = 5_000;
  assert.equal(await manager.isEventLockStillOwned(handle), true);
  assert.deepEqual(database.read("eventLocks/event-1"), {
    lockId: handle.lockId,
    ownerUid: handle.ownerUid,
    acquiredAtMs: 1_000,
    refreshedAtMs: 5_000,
    expiresAtMs: 5_000 + EVENT_LOCK_TTL_MS,
  });

  const foreign = {
    lockId: "foreign-lock",
    ownerUid: "foreign-owner",
    acquiredAtMs: 4_000,
    refreshedAtMs: 4_000,
    expiresAtMs: 50_000,
  };
  database.write("eventLocks/event-1", foreign);
  assert.equal(await manager.isEventLockStillOwned(handle), false);
  assert.deepEqual(database.read("eventLocks/event-1"), foreign);

  const expired = {
    lockId: handle.lockId,
    ownerUid: handle.ownerUid,
    acquiredAtMs: 1_000,
    refreshedAtMs: 5_000,
    expiresAtMs: 6_000,
  };
  database.write("eventLocks/event-1", expired);
  nowMs = 6_000;
  assert.equal(await manager.isEventLockStillOwned(handle), false);
  assert.deepEqual(database.read("eventLocks/event-1"), expired);
});

test("refresh extends only an unexpired owned lease and never resurrects it", async () => {
  let nowMs = 1_000;
  const database = createColdDatabase();
  const manager = createManager({ database, now: () => nowMs });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);

  nowMs = 5_000;
  assert.equal(await manager.refreshEventLock(handle), true);
  assert.equal(
    leaseAt(database, "eventLocks/event-1").expiresAtMs,
    5_000 + EVENT_LOCK_TTL_MS,
  );

  nowMs = 5_000 + EVENT_LOCK_TTL_MS;
  const expired = database.read("eventLocks/event-1");
  assert.equal(await manager.refreshEventLock(handle), false);
  assert.deepEqual(database.read("eventLocks/event-1"), expired);

  database.write("eventLocks/event-1", {
    lockId: "foreign-lock",
    ownerUid: "foreign-owner",
    expiresAtMs: 100_000,
  });
  assert.equal(await manager.refreshEventLock(handle), false);
  assert.equal(leaseAt(database, "eventLocks/event-1").lockId, "foreign-lock");
});

test("heartbeat refreshes at ten seconds and stops cleanly", async (t) => {
  let nowMs = 1_000;
  /** @type {{callback?: () => void}} */
  const heartbeat = {};
  let cleared = false;
  const timer = Object.assign(
    globalThis.setInterval(() => {}, 2 ** 31 - 1),
    { unrefCalled: false },
  );
  globalThis.clearInterval(timer);
  timer.unref = () => {
    timer.unrefCalled = true;
    return timer;
  };
  const database = createColdDatabase();
  const timers = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  t.mock.method(
    timers,
    "setInterval",
    /** @param {() => void} callback @param {number} delayMs */ (
      callback,
      delayMs,
    ) => {
      heartbeat.callback = callback;
      assert.equal(delayMs, EVENT_LOCK_REFRESH_INTERVAL_MS);
      return timer;
    },
  );
  t.mock.method(
    timers,
    "clearInterval",
    /** @param {unknown} value */ (value) => {
      assert.equal(value, timer);
      cleared = true;
    },
  );
  const manager = createManager({ database, now: () => nowMs, ...timers });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);
  const stop = manager.startEventLockHeartbeat(handle);
  assert.equal(timer.unrefCalled, true);

  nowMs = 9_000;
  assert.ok(heartbeat.callback);
  await heartbeat.callback();
  assert.equal(
    leaseAt(database, "eventLocks/event-1").expiresAtMs,
    9_000 + EVENT_LOCK_TTL_MS,
  );
  stop();
  assert.equal(cleared, true);
  assert.equal(await heartbeat.callback(), undefined);
});

test("release is cold-cache safe and cannot delete a successor", async () => {
  let nowMs = 1_000;
  const database = createColdDatabase();
  const manager = createManager({
    database,
    now: () => nowMs,
    ids: ["first-lock", "stale-lock", "successor-lock"],
  });
  const first = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(first);
  assert.equal(await manager.releaseEventLock(first), true);
  assert.equal(database.read("eventLocks/event-1"), null);

  const stale = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(stale);
  nowMs += EVENT_LOCK_TTL_MS + 1;
  const successor = await manager.acquireEventLock("event-1", "owner-2");
  assert.ok(successor);
  assert.equal(successor.lockId, "successor-lock");
  assert.equal(await manager.releaseEventLock(stale), false);
  assert.equal(
    leaseAt(database, "eventLocks/event-1").lockId,
    "successor-lock",
  );
});

test("release logs and swallows transaction failures", async () => {
  /** @type {unknown[][]} */
  const errors = [];
  const database = createColdDatabase();
  const manager = createManager({
    database,
    now: () => 1_000,
    logger: { error: (...args) => errors.push(args) },
  });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.ok(handle);
  database.fail("eventLocks/event-1", new Error("offline"));
  assert.equal(await manager.releaseEventLock(handle), false);
  assert.ok(errors[0]);
  assert.equal(errors[0][0], "event:lock:release:error");
  assert.equal(errors[0][1], "offline");
});
