"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManager,
} = require("../functions/eventLocks");

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

const createSnapshot = (value) => ({
  exists: () => value !== null && value !== undefined,
  val: () => clone(value),
});

const createColdDatabase = (initial = {}) => {
  const values = new Map(
    Object.entries(initial).map(([path, value]) => [path, clone(value)]),
  );
  const failures = new Map();
  const transactionCalls = [];
  return {
    transactionCalls,
    ref(path) {
      return {
        path,
        async transaction(update, _onComplete, applyLocally) {
          transactionCalls.push({ path, applyLocally });
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
    fail(path, error) {
      failures.set(path, error);
    },
  };
};

const createManager = ({
  database,
  now,
  ids = ["lock-1"],
  sleep,
  setInterval,
  clearInterval,
  logger,
  lockRoot,
}) => {
  let idIndex = 0;
  return createEventLockManager({
    database,
    now,
    createLockId: () => ids[idIndex++] || `lock-${idIndex}`,
    sleep,
    setInterval,
    clearInterval,
    logger: logger || { error() {} },
    lockRoot,
  });
};

test("validates configured lock roots and preserves the core default", () => {
  const database = createColdDatabase();
  assert.throws(
    () => createEventLockManager({ database, lockRoot: "" }),
    /lockRoot must be a non-empty string/,
  );
  assert.throws(
    () => createEventLockManager({ database, lockRoot: "/locks" }),
    /lockRoot must be a valid RTDB path/,
  );
  assert.throws(
    () => createEventLockManager({ database, lockRoot: "locks/nested" }),
    /lockRoot must be a valid RTDB path/,
  );
  assert.throws(
    () => createEventLockManager({ database, lockRoot: "locks\u0001child" }),
    /lockRoot must be a valid RTDB path/,
  );
  assert.equal(EVENT_LOCK_ROOT, "eventLocks");
});

test("acquires the legacy-compatible event lock schema through a cold transaction", async () => {
  const database = createColdDatabase();
  const manager = createManager({ database, now: () => 1_000 });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
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
  assert.equal(database.transactionCalls[0].applyLocally, false);
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
    lockRoot: "eventTelegramProjectionLocks",
  });
  const projectionContender = createManager({
    database,
    now: () => 1_000,
    ids: ["projection-contender"],
    lockRoot: "eventTelegramProjectionLocks",
  });

  const coreHandle = await coreManager.acquireEventLock("event-1", "domain");
  const projectionHandle = await projectionManager.acquireEventLock(
    "event-1",
    "projector",
  );

  assert.ok(coreHandle);
  assert.ok(projectionHandle);
  assert.equal(database.read("eventLocks/event-1").lockId, "core-lock");
  assert.equal(
    database.read("eventTelegramProjectionLocks/event-1").lockId,
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
  assert.equal(database.read("eventLocks/event-1").lockId, "foreign-lock");

  nowMs = 2_001;
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  assert.equal(handle.lockId, "replacement");
  assert.equal(database.read("eventLocks/event-1").lockId, "replacement");
});

test("retries acquisition with the existing attempt and delay semantics", async () => {
  let nowMs = 1_000;
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
  assert.equal(handle.lockId, "second-attempt");
  assert.deepEqual(delays, [25]);
});

test("ownership checks authoritatively refresh live leases and reject expired or foreign leases", async () => {
  let nowMs = 1_000;
  const database = createColdDatabase();
  const manager = createManager({ database, now: () => nowMs });
  const handle = await manager.acquireEventLock("event-1", "owner-1");

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

  nowMs = 5_000;
  assert.equal(await manager.refreshEventLock(handle), true);
  assert.equal(
    database.read("eventLocks/event-1").expiresAtMs,
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
  assert.equal(database.read("eventLocks/event-1").lockId, "foreign-lock");
});

test("heartbeat refreshes at ten seconds and stops cleanly", async () => {
  let nowMs = 1_000;
  let heartbeat;
  let cleared = false;
  const timer = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  };
  const database = createColdDatabase();
  const manager = createManager({
    database,
    now: () => nowMs,
    setInterval(callback, delayMs) {
      heartbeat = callback;
      assert.equal(delayMs, EVENT_LOCK_REFRESH_INTERVAL_MS);
      return timer;
    },
    clearInterval(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  const stop = manager.startEventLockHeartbeat(handle);
  assert.equal(timer.unrefCalled, true);

  nowMs = 9_000;
  await heartbeat();
  assert.equal(
    database.read("eventLocks/event-1").expiresAtMs,
    9_000 + EVENT_LOCK_TTL_MS,
  );
  stop();
  assert.equal(cleared, true);
  assert.equal(await heartbeat(), undefined);
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
  assert.equal(await manager.releaseEventLock(first), true);
  assert.equal(database.read("eventLocks/event-1"), null);

  const stale = await manager.acquireEventLock("event-1", "owner-1");
  nowMs += EVENT_LOCK_TTL_MS + 1;
  const successor = await manager.acquireEventLock("event-1", "owner-2");
  assert.equal(successor.lockId, "successor-lock");
  assert.equal(await manager.releaseEventLock(stale), false);
  assert.equal(database.read("eventLocks/event-1").lockId, "successor-lock");
});

test("release logs and swallows transaction failures", async () => {
  const errors = [];
  const database = createColdDatabase();
  const manager = createManager({
    database,
    now: () => 1_000,
    logger: { error: (...args) => errors.push(args) },
  });
  const handle = await manager.acquireEventLock("event-1", "owner-1");
  database.fail("eventLocks/event-1", new Error("offline"));
  assert.equal(await manager.releaseEventLock(handle), false);
  assert.equal(errors[0][0], "event:lock:release:error");
  assert.equal(errors[0][1], "offline");
});
