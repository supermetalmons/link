import {
  isAutomatchTelegramOutboxRecord,
  type AutomatchTelegramOutboxRecord,
} from "../../../runtime/automatchRecords.js";
import {
  isEventProjectionPending,
  type EventTelegramProjectionRequest,
} from "../../../runtime/eventProjectionOutboxRecords.js";

export const EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION = 1;
export type { EventTelegramProjectionRequest } from "../../../runtime/eventProjectionOutboxRecords.js";

export function parseAutomatchTelegramProjectionOutbox(
  value: unknown,
): Extract<AutomatchTelegramOutboxRecord, { status: "pending" }> | null {
  return isAutomatchTelegramOutboxRecord(value) && value.status === "pending"
    ? value
    : null;
}

export function parseEventProjectionOutbox(
  value: unknown,
): EventTelegramProjectionRequest | null {
  return isEventProjectionPending("telegram", value) ? value : null;
}
