import {
  isSafeFirebaseKey,
  isSafeFirestoreDocumentId,
} from "./firebaseKeys.ts";

export const TELEGRAM_PROJECTION_QUEUE_NAME = "mons-link-telegram-projection";
export const TELEGRAM_PROJECTION_SCHEMA_VERSION = 1;

export type AutomatchTelegramProjectionTask = {
  kind: "automatch-telegram-projection";
  inviteId: string;
  requestId: string;
};

export type RatingTelegramProjectionTask = {
  kind: "rating-telegram-projection";
  operationId: string;
};

export type EventTelegramProjectionTask = {
  kind: "event-telegram-projection";
  eventId: string;
  requestId: string;
};

export type TelegramProjectionTask =
  | AutomatchTelegramProjectionTask
  | EventTelegramProjectionTask
  | RatingTelegramProjectionTask;

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function validRtdbId(value: unknown): value is string {
  return typeof value === "string" && isSafeFirebaseKey(value);
}

export function parseTelegramProjectionTask(
  value: unknown,
): TelegramProjectionTask | null {
  const task = toRecord(value);
  if (!task) {
    return null;
  }
  if (task.kind === "automatch-telegram-projection") {
    return exactKeys(task, ["kind", "inviteId", "requestId"]) &&
      validRtdbId(task.inviteId) &&
      validRtdbId(task.requestId)
      ? {
          kind: task.kind,
          inviteId: task.inviteId,
          requestId: task.requestId,
        }
      : null;
  }
  if (task.kind === "rating-telegram-projection") {
    return exactKeys(task, ["kind", "operationId"]) &&
      isSafeFirestoreDocumentId(task.operationId)
      ? { kind: task.kind, operationId: task.operationId }
      : null;
  }
  if (task.kind === "event-telegram-projection") {
    return exactKeys(task, ["kind", "eventId", "requestId"]) &&
      validRtdbId(task.eventId) &&
      validRtdbId(task.requestId)
      ? {
          kind: task.kind,
          eventId: task.eventId,
          requestId: task.requestId,
        }
      : null;
  }
  return null;
}
