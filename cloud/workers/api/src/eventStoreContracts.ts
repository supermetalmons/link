import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type { EventProgressDocument } from "../../../runtime/eventProgressRecords.js";
import type { EventProjectionOutboxDocument } from "../../../runtime/eventProjectionOutboxRecords.js";
import type { EventCommitPlan } from "../../../runtime/eventCommands.js";
import type { EventTelegramProjectionStateDocument } from "../../../runtime/telegram/eventProjectionRecords.js";
import type {
  EventReads,
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
export type EventCommitOptions = {
  upcomingEventId?: string;
};
export type EventStore = EventReads &
  EventOutboxReads &
  EventLeaseStore & {
    putEventProgressOutbox(
      outboxId: string,
      record: EventProgressOutboxRecord,
      signal?: AbortSignal,
    ): Promise<void>;
    commitEventPlan(
      plan: readonly EventCommitPlan[number][],
      signal?: AbortSignal,
      options?: EventCommitOptions,
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
    ): Promise<EventProgressDocument<"pending"> | null>;
    readEventProfileGameProjectionOutbox(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<EventProjectionOutboxDocument<"profile-game"> | null>;
    readEventTelegramProjectionOutbox(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<EventProjectionOutboxDocument<"telegram"> | null>;
    readEventTelegramProjectionState(
      eventId: string,
      signal?: AbortSignal,
    ): Promise<{
      generation: number;
      revision: number;
      state: EventTelegramProjectionStateDocument;
    } | null>;
    claimEventProfileGameProjectionOutbox(
      eventId: string,
      requestId: string,
      expectedLastQueuedAtMs: number,
      nowMs: number,
      signal?: AbortSignal,
    ): Promise<boolean>;
    acknowledgeEventProfileGameProjectionOutbox(
      eventId: string,
      requestId: string,
      signal?: AbortSignal,
    ): Promise<boolean>;
    claimEventTelegramProjectionOutbox(
      eventId: string,
      requestId: string,
      expectedUpdatedAtMs: number,
      nowMs: number,
      signal?: AbortSignal,
    ): Promise<boolean>;
    acknowledgeEventTelegramProjectionOutbox(
      eventId: string,
      requestId: string,
      signal?: AbortSignal,
    ): Promise<boolean>;
    transactEventTelegramProjectionState(
      eventId: string,
      updater: (
        current: EventTelegramProjectionStateDocument | null,
      ) => TransactionDecision<EventTelegramProjectionStateDocument>,
      signal?: AbortSignal,
    ): Promise<TransactionResult<EventTelegramProjectionStateDocument>>;
  };

export type EventProgressOutboxWriter = Pick<
  EventStore,
  "putEventProgressOutbox"
>;
