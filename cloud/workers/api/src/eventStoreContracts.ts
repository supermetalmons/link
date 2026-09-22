import type { EventCommitPlan } from "../../../runtime/eventCommands.js";
import type {
  EventReads,
  EventJsonRecord,
  EventPrizeAssignmentRecord,
} from "../../../runtime/eventReads.js";
import type { EventLeaseStore } from "../../../runtime/eventLeases.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import type { EventOutboxReads } from "./eventOutboxReadRepository.ts";
import type { EventSyncThrottleRecord } from "./eventD1.ts";
export type EventLockGuard = {
  eventId: string;
  lockRoot: string;
  lockId: string;
  ownerUid: string;
};
export type EventRecordTransaction = (
  id: string,
  updater: (
    current: EventJsonRecord | null,
  ) => TransactionDecision<EventJsonRecord>,
  signal?: AbortSignal,
) => Promise<TransactionResult<EventJsonRecord>>;
export type EventStore = EventReads &
  EventOutboxReads &
  EventLeaseStore & {
    putEventProgressOutbox(
      outboxId: string,
      record: EventJsonRecord,
      signal?: AbortSignal,
    ): Promise<void>;
    commitEventPlan(
      plan: readonly EventCommitPlan[number][],
      signal?: AbortSignal,
    ): Promise<void>;
    transactEventSyncThrottle(
      eventId: string,
      updater: (
        current: EventSyncThrottleRecord | null,
      ) => TransactionDecision<EventSyncThrottleRecord>,
      signal?: AbortSignal,
    ): Promise<TransactionResult<EventSyncThrottleRecord>>;
    transactEventPrizeSelection(
      eventId: string,
      profileId: string,
      updater: (current: string | null) => TransactionDecision<string>,
      signal?: AbortSignal,
    ): Promise<TransactionResult<string>>;
    transactProfileEventPrize(
      profileId: string,
      eventId: string,
      updater: (
        current: EventPrizeAssignmentRecord | null,
      ) => TransactionDecision<EventPrizeAssignmentRecord>,
      signal?: AbortSignal,
    ): Promise<TransactionResult<EventPrizeAssignmentRecord>>;
    transactStoredProfileEventPrizeWithEventLease(
      profileId: string,
      eventId: string,
      updater: (
        current: EventPrizeAssignmentRecord | null,
      ) => TransactionDecision<EventPrizeAssignmentRecord>,
      guard: EventLockGuard,
      signal?: AbortSignal,
    ): Promise<TransactionResult<EventPrizeAssignmentRecord>>;
    readEventProgressOutbox(
      outboxId: string,
      signal?: AbortSignal,
    ): Promise<EventJsonRecord | null>;
    readEventProfileGameProjectionOutbox(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<EventJsonRecord | null>;
    readEventTelegramProjectionOutbox(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<EventJsonRecord | null>;
    readEventTelegramProjectionState(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<{
      generation: number;
      revision: number;
      state: EventJsonRecord;
    } | null>;
    transactEventProgressOutbox: EventRecordTransaction;
    transactEventProgressDeadOutbox: EventRecordTransaction;
    transactEventProfileGameProjectionOutbox: EventRecordTransaction;
    transactEventTelegramProjectionOutbox: EventRecordTransaction;
    transactEventTelegramProjectionState: EventRecordTransaction;
  };

export type EventProgressOutboxWriter = Pick<
  EventStore,
  "putEventProgressOutbox"
>;
