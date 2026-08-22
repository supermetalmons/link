export type EventLockTransactionDecision =
  { commit: false; decision?: string } | { value: unknown; decision?: string };

export type EventLockTransactionResult = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

export type EventLockHandle = {
  eventId: string;
  path: string;
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

export const EVENT_LOCK_ROOT: "eventLocks";
export const EVENT_LOCK_REFRESH_INTERVAL_MS: 10000;
export const EVENT_LOCK_TTL_MS: 30000;

export function createEventLockManagerCore(dependencies: {
  transactPath(
    path: string,
    updater: (current: unknown) => EventLockTransactionDecision,
  ): Promise<EventLockTransactionResult>;
  releaseTransactPath?: (
    path: string,
    updater: (current: unknown) => EventLockTransactionDecision,
  ) => Promise<EventLockTransactionResult>;
  createLockId(): string;
  lockRoot?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  logger?: Pick<Console, "error">;
}): EventLockManager;
