import type { EventAnnouncementKind } from "./eventAnnouncementKinds.ts";
import {
  readTelegramAnnouncementPayloadDocument,
  parseTelegramAnnouncementPayload,
  type TelegramAnnouncementPayloadDocument,
} from "./telegramAnnouncementRecords.ts";
function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new TypeError("invalid-telegram-announcement-integer");
  return value;
}
function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    throw new TypeError("invalid-telegram-announcement-json");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("invalid-telegram-announcement-json");
  return parsed as Record<string, unknown>;
}
export type TelegramAnnouncementRecord = {
  schemaVersion: 1;
  kind: EventAnnouncementKind;
  createdAtMs: number;
  messageIds: number[] | null;
  payloadDigest: string;
  status:
    "sending" | "sent" | "retryable" | "terminal" | "uncertain" | "blocked";
  updatedAtMs: number;
  eventId: string | null;
  startAtMs: number | null;
  runAtMs: number | null;
  firstQueuedAtMs: number | null;
  payload: TelegramAnnouncementPayloadDocument | null;
  attemptId: string | null;
  attemptCount: number | null;
  retryAtMs: number | null;
  errorCode: string | null;
};

export type AnnouncementRow = {
  schema_version: number;
  announcement_kind: EventAnnouncementKind;
  created_at_ms: number;
  message_ids_json: string | null;
  payload_digest: string;
  status: string;
  updated_at_ms: number;
  event_id: string | null;
  start_at_ms: number | null;
  run_at_ms: number | null;
  first_queued_at_ms: number | null;
  payload_json: string | null;
  attempt_id: string | null;
  attempt_count: number | null;
  retry_at_ms: number | null;
  error_code: string | null;
};

function parseMessageIds(value: string | null): number[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("invalid-telegram-announcement", { cause: error });
  }
  return Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (messageId) => Number.isSafeInteger(messageId) && messageId > 0,
    )
    ? parsed
    : null;
}

export function decodeAnnouncement(
  row: AnnouncementRow,
): TelegramAnnouncementRecord {
  if (
    row.schema_version !== 1 ||
    !row.payload_digest ||
    ![
      "sending",
      "sent",
      "retryable",
      "terminal",
      "uncertain",
      "blocked",
    ].includes(row.status) ||
    (row.announcement_kind !== "prizes" && row.announcement_kind !== "reminder")
  )
    throw new TypeError("invalid-telegram-announcement");
  const result: TelegramAnnouncementRecord = {
    schemaVersion: 1,
    kind: row.announcement_kind,
    createdAtMs: safeInteger(row.created_at_ms),
    messageIds: parseMessageIds(row.message_ids_json),
    payloadDigest: row.payload_digest,
    status: row.status as TelegramAnnouncementRecord["status"],
    updatedAtMs: safeInteger(row.updated_at_ms),
    eventId: row.event_id,
    startAtMs: row.start_at_ms,
    runAtMs: row.run_at_ms,
    firstQueuedAtMs: row.first_queued_at_ms,
    payload:
      row.payload_json === null
        ? null
        : readTelegramAnnouncementPayloadDocument(
            parseJsonRecord(row.payload_json),
          )!,
    attemptId: row.attempt_id,
    attemptCount: row.attempt_count,
    retryAtMs: row.retry_at_ms,
    errorCode: row.error_code,
  };
  if (
    (row.message_ids_json !== null && result.messageIds === null) ||
    (row.payload_json !== null && result.payload === null)
  )
    throw new TypeError("invalid-telegram-announcement");
  for (const field of [
    result.startAtMs,
    result.runAtMs,
    result.firstQueuedAtMs,
    result.attemptCount,
    result.retryAtMs,
  ])
    if (field !== null) safeInteger(field);
  for (const field of [result.eventId, result.attemptId, result.errorCode])
    if (
      field !== null &&
      (typeof field !== "string" || !field || field.trim() !== field)
    )
      throw new TypeError("invalid-telegram-announcement");
  if (
    (result.eventId === null) !== (result.startAtMs === null) ||
    (result.eventId === null) !== (result.runAtMs === null) ||
    (result.eventId === null) !== (result.firstQueuedAtMs === null) ||
    (result.eventId === null) !== (result.attemptId === null) ||
    (result.eventId === null) !== (result.attemptCount === null) ||
    (result.eventId === null) !== (result.payload === null)
  )
    throw new TypeError("invalid-telegram-announcement");
  if (
    result.status === "sent"
      ? result.messageIds === null
      : result.messageIds !== null
  )
    throw new TypeError("invalid-telegram-announcement");
  if (
    result.status === "retryable"
      ? result.retryAtMs === null || result.eventId === null
      : result.retryAtMs !== null
  )
    throw new TypeError("invalid-telegram-announcement");
  if (
    result.payload &&
    !parseTelegramAnnouncementPayload(result.payload, result.kind)
  )
    throw new TypeError("invalid-telegram-announcement");
  return result;
}
