"use strict";

const admin = require("./firebaseAdmin");
const { randomAlphanumeric } = require("@mons/shared/ids");
const { runRtdbDecisionTransaction } = require("./rtdbDecisionTransaction");
const {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
} = require("./events/lockManagerCore");

const createEventLockManager = (dependencies = {}) => {
  const getDatabase = dependencies.database
    ? () => dependencies.database
    : dependencies.getDatabase || admin.database;
  const runTransaction =
    dependencies.runTransaction || runRtdbDecisionTransaction;
  return createEventLockManagerCore({
    lockRoot: dependencies.lockRoot,
    now: dependencies.now,
    createLockId: dependencies.createLockId || (() => randomAlphanumeric(16)),
    sleep: dependencies.sleep,
    setInterval: dependencies.setInterval,
    clearInterval: dependencies.clearInterval,
    logger: dependencies.logger,
    transactPath: (path, updater) =>
      runTransaction(getDatabase().ref(path), updater),
  });
};

const eventLockManager = createEventLockManager();

module.exports = {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  acquireEventLock: eventLockManager.acquireEventLock,
  acquireEventLockWithRetry: eventLockManager.acquireEventLockWithRetry,
  createEventLockManager,
  getEventLockGuard: eventLockManager.getEventLockGuard,
  isEventLockStillOwned: eventLockManager.isEventLockStillOwned,
  refreshEventLock: eventLockManager.refreshEventLock,
  releaseEventLock: eventLockManager.releaseEventLock,
  startEventLockHeartbeat: eventLockManager.startEventLockHeartbeat,
};
