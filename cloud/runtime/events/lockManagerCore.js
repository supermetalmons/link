// Generated from src/events/lockManagerCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLockKind =
  exports.getOwnershipDecision =
  exports.createEventLockManagerCore =
  exports.EVENT_LOCK_TTL_MS =
  exports.EVENT_LOCK_REFRESH_INTERVAL_MS =
  exports.EVENT_LOCK_ROOT =
    void 0;
const EVENT_LOCK_ROOT = "eventLocks";
exports.EVENT_LOCK_ROOT = EVENT_LOCK_ROOT;
const EVENT_LOCK_TTL_MS = 30_000;
exports.EVENT_LOCK_TTL_MS = EVENT_LOCK_TTL_MS;
const EVENT_LOCK_REFRESH_INTERVAL_MS = 10_000;
exports.EVENT_LOCK_REFRESH_INTERVAL_MS = EVENT_LOCK_REFRESH_INTERVAL_MS;
const LOCK_ROOTS = {
  event: "eventLocks",
  "telegram-projection": "eventTelegramProjectionLocks",
  "profile-game-projection": "profileGameProjectionLocks/event",
  transition: "eventLocks",
};
const resolveLockKind = (value = "event") => {
  if (!Object.hasOwn(LOCK_ROOTS, value))
    throw new TypeError("invalid event lease kind");
  return value;
};
exports.resolveLockKind = resolveLockKind;
const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getOwnershipDecision = (current, lockHandle, nowMs) => {
  if (!current || typeof current !== "object") {
    return "missing";
  }
  if (
    current.ownerUid !== lockHandle.ownerUid ||
    current.lockId !== lockHandle.lockId
  ) {
    return "foreign";
  }
  if (typeof current.expiresAtMs !== "number" || current.expiresAtMs <= nowMs) {
    return "expired";
  }
  return "owned";
};
exports.getOwnershipDecision = getOwnershipDecision;
const createEventLockManagerCore = (dependencies) => {
  if (!dependencies || typeof dependencies.transactEventLease !== "function") {
    throw new TypeError("transactEventLease is required");
  }
  const lockKind = resolveLockKind(dependencies.lockKind);
  const lockRoot = LOCK_ROOTS[lockKind];
  const transactLease = dependencies.transactEventLease;
  const releaseTransactLease =
    dependencies.releaseTransactEventLease || transactLease;
  const now = dependencies.now || Date.now;
  const createLockId = dependencies.createLockId;
  if (typeof createLockId !== "function") {
    throw new TypeError("createLockId is required");
  }
  const wait = dependencies.sleep || sleep;
  const setIntervalFn = dependencies.setInterval || setInterval;
  const clearIntervalFn = dependencies.clearInterval || clearInterval;
  const logger = dependencies.logger || console;
  const includeLegacyOwnerId = dependencies.includeLegacyOwnerId === true;
  const acquireEventLock = async (eventId, ownerUid) => {
    const key = { kind: lockKind, id: eventId };
    const lockId = createLockId();
    const result = await transactLease(key, (current) => {
      const nowMs = now();
      if (
        current &&
        typeof current === "object" &&
        typeof current.expiresAtMs === "number" &&
        current.expiresAtMs > nowMs
      ) {
        return { commit: false, decision: "locked" };
      }
      return {
        value: {
          lockId,
          ownerUid,
          ...(includeLegacyOwnerId ? { ownerId: ownerUid } : {}),
          expiresAtMs: nowMs + EVENT_LOCK_TTL_MS,
          acquiredAtMs: nowMs,
          refreshedAtMs: nowMs,
        },
        decision: "acquired",
      };
    });
    const value = result.value;
    if (
      !result.committed ||
      result.decision !== "acquired" ||
      !value ||
      value.ownerUid !== ownerUid ||
      value.lockId !== lockId
    ) {
      return null;
    }
    return { eventId, key, lockId, ownerUid, lockRoot };
  };
  const getEventLockGuard = (lockHandle) => {
    if (
      !lockHandle ||
      lockHandle.lockRoot !== lockRoot ||
      typeof lockHandle.eventId !== "string" ||
      lockHandle.eventId.trim() === "" ||
      typeof lockHandle.lockId !== "string" ||
      lockHandle.lockId.trim() === "" ||
      typeof lockHandle.ownerUid !== "string" ||
      lockHandle.ownerUid.trim() === ""
    ) {
      throw new TypeError("lockHandle must identify an owned lock");
    }
    return {
      lockRoot,
      eventId: lockHandle.eventId,
      lockId: lockHandle.lockId,
      ownerUid: lockHandle.ownerUid,
    };
  };
  const acquireEventLockWithRetry = async (eventId, ownerUid, options = {}) => {
    const attempts = Math.max(1, toFiniteInteger(options.attempts, 1));
    const delayMs = Math.max(25, toFiniteInteger(options.delayMs, 100));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const lockHandle = await acquireEventLock(eventId, ownerUid);
      if (lockHandle) {
        return lockHandle;
      }
      if (attempt < attempts - 1) {
        await wait(delayMs);
      }
    }
    return null;
  };
  const refreshEventLock = async (lockHandle) => {
    if (!lockHandle) {
      return false;
    }
    const result = await transactLease(lockHandle.key, (current) => {
      const refreshedAtMs = now();
      const ownership = getOwnershipDecision(
        current,
        lockHandle,
        refreshedAtMs,
      );
      if (ownership !== "owned") {
        return { commit: false, decision: ownership };
      }
      return {
        value: {
          ...current,
          expiresAtMs: refreshedAtMs + EVENT_LOCK_TTL_MS,
          refreshedAtMs,
        },
        decision: "refreshed",
      };
    });
    return (
      result.committed &&
      result.decision === "refreshed" &&
      getOwnershipDecision(result.value, lockHandle, now()) === "owned"
    );
  };
  const isEventLockStillOwned = (lockHandle) => refreshEventLock(lockHandle);
  const startEventLockHeartbeat = (lockHandle) => {
    if (!lockHandle) {
      return () => {};
    }
    let isDisposed = false;
    const heartbeatInterval = setIntervalFn(() => {
      if (isDisposed) {
        return undefined;
      }
      return refreshEventLock(lockHandle).catch((error) => {
        if (typeof logger.error === "function") {
          logger.error(
            "event:lock:heartbeat:error",
            error && error.message ? error.message : error,
          );
        }
      });
    }, EVENT_LOCK_REFRESH_INTERVAL_MS);
    if (typeof heartbeatInterval.unref === "function") {
      heartbeatInterval.unref();
    }
    return () => {
      isDisposed = true;
      clearIntervalFn(heartbeatInterval);
    };
  };
  const releaseEventLock = async (lockHandle) => {
    if (!lockHandle) {
      return false;
    }
    try {
      const result = await releaseTransactLease(lockHandle.key, (current) => {
        if (!current || typeof current !== "object") {
          return { commit: false, decision: "missing" };
        }
        if (
          current.ownerUid !== lockHandle.ownerUid ||
          current.lockId !== lockHandle.lockId
        ) {
          return { commit: false, decision: "foreign" };
        }
        return { value: null, decision: "released" };
      });
      return result.committed && result.decision === "released";
    } catch (error) {
      if (typeof logger.error === "function") {
        logger.error(
          "event:lock:release:error",
          error && error.message ? error.message : error,
        );
      }
      return false;
    }
  };
  return {
    acquireEventLock,
    acquireEventLockWithRetry,
    getEventLockGuard,
    isEventLockStillOwned,
    refreshEventLock,
    releaseEventLock,
    startEventLockHeartbeat,
  };
};
exports.createEventLockManagerCore = createEventLockManagerCore;
