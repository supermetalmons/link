import type {
  EventLeaseKey,
  EventLeaseKind,
  EventLeaseRecord,
} from "../eventLeases.js";
export type EventLockTransactionDecision =
  | { commit: false; decision?: string }
  | { value: EventLeaseRecord | null; decision?: string };
export type EventLockTransactionResult = {
  committed: boolean;
  decision?: string;
  value: EventLeaseRecord | null;
};
export type EventLockHandle = {
  eventId: string;
  key: EventLeaseKey;
  lockId: string;
  ownerUid: string;
  lockRoot: string;
};
export type EventLockManager = {
  acquireEventLock(
    eventId: string,
    ownerUid: string,
  ): Promise<EventLockHandle | null>;
  acquireEventLockWithRetry(
    eventId: string,
    ownerUid: string,
    options?: { attempts?: number; delayMs?: number },
  ): Promise<EventLockHandle | null>;
  getEventLockGuard(handle: EventLockHandle): {
    lockRoot: string;
    eventId: string;
    lockId: string;
    ownerUid: string;
  };
  isEventLockStillOwned(handle: EventLockHandle): Promise<boolean>;
  refreshEventLock(handle: EventLockHandle): Promise<boolean>;
  releaseEventLock(handle: EventLockHandle): Promise<boolean>;
  startEventLockHeartbeat(handle: EventLockHandle): () => void;
};
type Signature_createEventLockManagerCore = (dependencies: {
  transactEventLease(
    key: EventLeaseKey,
    updater: (current: EventLeaseRecord | null) => EventLockTransactionDecision,
  ): Promise<EventLockTransactionResult>;
  releaseTransactEventLease?: (
    key: EventLeaseKey,
    updater: (current: EventLeaseRecord | null) => EventLockTransactionDecision,
  ) => Promise<EventLockTransactionResult>;
  createLockId(): string;
  includeLegacyOwnerId?: boolean;
  lockKind?: EventLeaseKind;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  logger?: Pick<Console, "error">;
}) => EventLockManager;

const EVENT_LOCK_ROOT = "eventLocks";
const EVENT_LOCK_TTL_MS = 30_000;
const EVENT_LOCK_REFRESH_INTERVAL_MS = 10_000;

const LOCK_ROOTS = {
  event: "eventLocks",
  "telegram-projection": "eventTelegramProjectionLocks",
  "profile-game-projection": "profileGameProjectionLocks/event",
  transition: "eventLocks",
};
const resolveLockKind = (value: EventLeaseKind = "event") => {
  if (!Object.hasOwn(LOCK_ROOTS, value))
    throw new TypeError("invalid event lease kind");
  return value;
};

const toFiniteInteger = (value: unknown, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const getOwnershipDecision = (
  current: EventLeaseRecord | null,
  lockHandle: EventLockHandle,
  nowMs: number,
) => {
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

const createEventLockManagerCore: Signature_createEventLockManagerCore = (
  dependencies,
) => {
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

  const acquireEventLock: EventLockManager["acquireEventLock"] = async (
    eventId,
    ownerUid,
  ) => {
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

  const getEventLockGuard: EventLockManager["getEventLockGuard"] = (
    lockHandle,
  ) => {
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

  const acquireEventLockWithRetry: EventLockManager["acquireEventLockWithRetry"] =
    async (eventId, ownerUid, options = {}) => {
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

  const refreshEventLock: EventLockManager["refreshEventLock"] = async (
    lockHandle,
  ) => {
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
          ...current!,
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

  const isEventLockStillOwned: EventLockManager["isEventLockStillOwned"] = (
    lockHandle,
  ) => refreshEventLock(lockHandle);

  const startEventLockHeartbeat: EventLockManager["startEventLockHeartbeat"] = (
    lockHandle,
  ) => {
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
            error && (error as { message?: unknown }).message
              ? (error as { message?: unknown }).message
              : error,
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

  const releaseEventLock: EventLockManager["releaseEventLock"] = async (
    lockHandle,
  ) => {
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
          error && (error as { message?: unknown }).message
            ? (error as { message?: unknown }).message
            : error,
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

export {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
  getOwnershipDecision,
  resolveLockKind,
};
