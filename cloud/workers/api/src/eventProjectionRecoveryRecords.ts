import {
  retainEventProjectionOutbox,
  type EventProjectionOutboxDocument,
} from "../../../runtime/eventProjectionOutboxRecords.js";
import type { TransactionDecision } from "../../../runtime/transactions.js";
import { isSafeRecordKey } from "./recordKeys.ts";

export type EventProfileProjectionRepair = {
  eventId: string;
  safeEventId: boolean;
  requestId: string;
  nowMs: number;
};
export function repairEventProfileProjectionRecord(
  current: EventProjectionOutboxDocument<"profile-game"> | null,
  input: EventProfileProjectionRepair,
): TransactionDecision<EventProjectionOutboxDocument<"profile-game">> {
  if (
    !input.safeEventId ||
    !isSafeRecordKey(input.eventId) ||
    !isSafeRecordKey(input.requestId) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0
  )
    throw new TypeError("invalid-event-projection-outbox");
  if (current !== null) retainEventProjectionOutbox("profile-game", current);
  return { commit: false, decision: "changed" };
}
export function markInvalidEventTelegramProjectionRecord(
  current: EventProjectionOutboxDocument<"telegram"> | null,
  eventId: string,
  nowMs: number,
): TransactionDecision<EventProjectionOutboxDocument<"telegram">> {
  if (!isSafeRecordKey(eventId) || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new TypeError("invalid-event-projection-outbox");
  if (current !== null) retainEventProjectionOutbox("telegram", current);
  return { commit: false, decision: "changed" };
}
