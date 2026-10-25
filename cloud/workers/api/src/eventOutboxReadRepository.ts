import type { EventProgressDocument } from "../../../runtime/eventProgressRecords.js";
import type { EventProjectionOutboxDocument } from "../../../runtime/eventProjectionOutboxRecords.js";
import {
  listDueEventProgressOutboxes,
  listDueEventProfileGameProjectionOutboxes,
  listDueEventTelegramProjectionOutboxes,
  type EventD1Connection,
} from "./eventD1.ts";

export type EventOutboxReads = {
  listDueEventProgressOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<
    Array<{ outboxId: string; record: EventProgressDocument<"pending"> }>
  >;
  listDueEventProfileGameProjectionOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<
    Array<{
      eventId: string;
      record: EventProjectionOutboxDocument<"profile-game">;
    }>
  >;
  listDueEventTelegramProjectionOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<
    Array<{
      eventId: string;
      record: EventProjectionOutboxDocument<"telegram">;
    }>
  >;
};

export function createEventOutboxReadRepository(
  db: EventD1Connection,
): EventOutboxReads {
  return {
    listDueEventProgressOutboxes: (beforeMs, limit) =>
      listDueEventProgressOutboxes(db, beforeMs, limit),
    listDueEventProfileGameProjectionOutboxes: (beforeMs, limit) =>
      listDueEventProfileGameProjectionOutboxes(db, beforeMs, limit),
    listDueEventTelegramProjectionOutboxes: (beforeMs, limit) =>
      listDueEventTelegramProjectionOutboxes(db, beforeMs, limit),
  };
}
