import { isSafeRecordKey } from "./recordKeys.ts";
import { TELEGRAM_PROJECTION_SCHEMA_VERSION } from "./telegramProjectionTasks.ts";

export const EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION = 1;

type AutomatchProjectionOutbox = {
  requestId: string;
  schemaVersion: number;
  status: string;
  updatedAtMs: number;
};

type EventProjectionOutbox = AutomatchProjectionOutbox & {
  firstQueuedAtMs: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAutomatchTelegramProjectionOutbox(
  value: unknown,
): AutomatchProjectionOutbox | null {
  const record = toRecord(value);
  const updatedAtMs = record?.updatedAtMs;
  return record?.schemaVersion === TELEGRAM_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeRecordKey(record.requestId) &&
    typeof updatedAtMs === "number" &&
    Number.isFinite(updatedAtMs) &&
    updatedAtMs >= 0
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        updatedAtMs: Math.floor(updatedAtMs),
      }
    : null;
}

export function parseEventProjectionOutbox(
  value: unknown,
): EventProjectionOutbox | null {
  const record = toRecord(value);
  const updatedAtMs = record?.updatedAtMs;
  const firstQueuedAtMs = record?.firstQueuedAtMs ?? updatedAtMs;
  return record?.schemaVersion === EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeRecordKey(record.requestId) &&
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    typeof firstQueuedAtMs === "number" &&
    Number.isSafeInteger(firstQueuedAtMs) &&
    firstQueuedAtMs >= 0
    ? {
        schemaVersion: EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
        status: "pending",
        requestId: record.requestId,
        firstQueuedAtMs,
        updatedAtMs,
      }
    : null;
}
