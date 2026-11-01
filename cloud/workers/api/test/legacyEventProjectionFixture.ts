import {} from "../src/eventTelegramProjectionProducer.ts";
import { isSafeRecordKey } from "../src/recordKeys.ts";
export function getEventTelegramProjectionOutboxPath(eventId: string): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError("eventId must be a safe Firebase key");
  }
  return `telegramProjectionOutbox/event/${eventId}`;
}

export function getEventTelegramProjectionGenerationPath(
  eventId: string,
): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError("eventId must be a safe Firebase key");
  }
  return `eventTelegramProjectionGenerations/${eventId}`;
}
