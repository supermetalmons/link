"use strict";

const EVENT_LOCK_ROOT = "eventLocks";
const EVENT_LOCK_TTL_MS = 30 * 1000;
const EVENT_LOCK_REFRESH_INTERVAL_MS = 10 * 1000;

const resolveLockRoot = (value) => {
  if (value === undefined) {
    return EVENT_LOCK_ROOT;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("lockRoot must be a non-empty string");
  }
  const normalized = value.trim();
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    segments.some(
      (segment) =>
        segment === "" || /[.#$\[\]\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new TypeError("lockRoot must be a valid RTDB path");
  }
  return normalized;
};

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

const createEventLockManagerCore = (dependencies) => {
  if (!dependencies || typeof dependencies.transactPath !== "function") {
    throw new TypeError("transactPath is required");
  }
  const lockRoot = resolveLockRoot(dependencies.lockRoot);
  const transactPath = dependencies.transactPath;
  const releaseTransactPath = dependencies.releaseTransactPath || transactPath;
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
    const path = `${lockRoot}/${eventId}`;
    const lockId = createLockId();
    const result = await transactPath(path, (current) => {
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
    return { eventId, path, lockId, ownerUid, lockRoot };
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
    const result = await transactPath(lockHandle.path, (current) => {
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
      const result = await releaseTransactPath(lockHandle.path, (current) => {
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

module.exports = {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
  getOwnershipDecision,
  resolveLockRoot,
};
