import {
  createEventProfileGameProjectionRequest,
  retainEventProjectionOutbox,
  type EventProjectionOutboxDocument,
} from "../../../runtime/eventProjectionOutboxRecords.js";
import type { TransactionDecision } from "../../../runtime/transactions.js";
import { isSafeRecordKey } from "./recordKeys.ts";
import { parseEventProfileGameProjectionOutbox } from "./profileGameProjectionOutbox.ts";
import { parseEventProjectionOutbox } from "./telegramProjectionOutbox.ts";
import { PROFILE_GAME_PROJECTION_SCHEMA_VERSION } from "./profileGameProjectionTasks.ts";

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function salvageEventCleanupOwnerProfileIds(value: unknown): string[] {
  return Array.from(
    new Set(
      Object.entries(
        toRecord(toRecord(value)?.cleanupOwnerProfileIds) || {},
      ).flatMap(([profileId, included]) =>
        included === true && isSafeRecordKey(profileId) ? [profileId] : [],
      ),
    ),
  );
}

export type EventProfileProjectionRepair = {
  eventId: string;
  safeEventId: boolean;
  requestId: string;
  nowMs: number;
};

export function repairEventProfileProjectionRecord(
  current: EventProjectionOutboxDocument<"profile-game"> | null,
  { eventId, safeEventId, requestId, nowMs }: EventProfileProjectionRepair,
): TransactionDecision<EventProjectionOutboxDocument<"profile-game">> {
  if (
    current === null ||
    current === undefined ||
    (parseEventProfileGameProjectionOutbox(current) && isSafeRecordKey(eventId))
  )
    return { commit: false, decision: "changed" };
  if (!safeEventId) return { value: null, decision: "removed-invalid" };
  const cleanupOwnerProfileIds = salvageEventCleanupOwnerProfileIds(current);
  return {
    value: createEventProfileGameProjectionRequest({
      schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
      status: "pending",
      requestId,
      lastQueuedAtMs: nowMs,
      cleanupOwnerProfileIds: Object.fromEntries(
        cleanupOwnerProfileIds.map((profileId) => [profileId, true as const]),
      ),
    }),
    decision: "repaired-invalid",
  };
}

export function markInvalidEventTelegramProjectionRecord(
  current: EventProjectionOutboxDocument<"telegram"> | null,
  eventId: string,
  nowMs: number,
): TransactionDecision<EventProjectionOutboxDocument<"telegram">> {
  const record = toRecord(current);
  const updatedAtMs = record?.updatedAtMs;
  if (
    !record ||
    (parseEventProjectionOutbox(current) && isSafeRecordKey(eventId)) ||
    typeof updatedAtMs !== "number" ||
    !Number.isFinite(updatedAtMs) ||
    updatedAtMs > nowMs
  )
    return { commit: false, decision: "changed" };
  return {
    value: retainEventProjectionOutbox("telegram", {
      ...record,
      status: "dead",
      reason: "invalid-record",
      updatedAtMs: null,
      deadAtMs: nowMs,
    }),
    decision: "dead",
  };
}
