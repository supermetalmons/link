import type { TransactionDecision, TransactionResult } from "./transactions.js";
export type EventLeaseKind =
  "event" | "telegram-projection" | "profile-game-projection" | "transition";
export type EventLeaseKey = { kind: EventLeaseKind; id: string };
export type EventLeaseRecord = {
  lockId: string;
  ownerUid: string;
  acquiredAtMs: number;
  refreshedAtMs: number;
  expiresAtMs: number;
  ownerId?: string;
};
export type EventLeaseStore = {
  transactEventLease(
    key: EventLeaseKey,
    updater: (
      current: EventLeaseRecord | null,
    ) => TransactionDecision<EventLeaseRecord>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<EventLeaseRecord>>;
};
