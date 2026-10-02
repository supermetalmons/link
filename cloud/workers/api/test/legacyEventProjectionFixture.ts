import {} from "../src/eventTelegramProjectionProducer.ts";
import { isSafeRecordKey } from "../src/recordKeys.ts";
import { STATE_FAILURE_MESSAGES } from "../src/stateCompatibility.ts";
export function getEventTelegramProjectionOutboxPath(eventId: string): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidEventId);
  }
  return `telegramProjectionOutbox/event/${eventId}`;
}

export function getEventTelegramProjectionGenerationPath(
  eventId: string,
): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidEventId);
  }
  return `eventTelegramProjectionGenerations/${eventId}`;
}
