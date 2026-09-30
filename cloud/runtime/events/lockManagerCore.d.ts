// Generated from src/events/lockManagerCore.ts. Run npm run generate:runtime.
import type {
  EventLeaseKey,
  EventLeaseKind,
  EventLeaseRecord,
} from "../eventLeases.js";
export type EventLockTransactionDecision =
  | {
      commit: false;
      decision?: string;
    }
  | {
      value: EventLeaseRecord | null;
      decision?: string;
    };
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
    options?: {
      attempts?: number;
      delayMs?: number;
    },
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
declare const EVENT_LOCK_ROOT = "eventLocks";
declare const EVENT_LOCK_TTL_MS = 30000;
declare const EVENT_LOCK_REFRESH_INTERVAL_MS = 10000;
declare const resolveLockKind: (value?: EventLeaseKind) => EventLeaseKind;
declare const getOwnershipDecision: (
  current: EventLeaseRecord | null,
  lockHandle: EventLockHandle,
  nowMs: number,
) => "missing" | "foreign" | "expired" | "owned";
declare const createEventLockManagerCore: Signature_createEventLockManagerCore;
export {
  EVENT_LOCK_ROOT,
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
  createEventLockManagerCore,
  getOwnershipDecision,
  resolveLockKind,
};
