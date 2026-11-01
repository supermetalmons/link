import type {
  EventPrizeAssignmentRecord,
  EventReads,
} from "../../../runtime/eventReads.js";
import { eventDocumentFixture } from "./eventCompatibilityFixture.ts";
import type { StateQuery } from "../test/stateRepositoryTestTypes.ts";
import type { EventOutboxReads } from "../src/eventOutboxReadRepository.ts";

export function eventReadFixture(
  read: (
    path: string,
    query?: StateQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): EventReads & EventOutboxReads {
  const event = (value: unknown, eventId: string) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value))
      throw new TypeError("invalid event fixture");
    return eventDocumentFixture({
      eventId,
      ...Object.fromEntries(Object.entries(value)),
    });
  };
  const unexpectedOutboxRead = async () => {
    throw new Error("unexpected-event-outbox-read");
  };
  return {
    listDueEventProgressOutboxes: unexpectedOutboxRead,
    listDueEventProfileGameProjectionOutboxes: unexpectedOutboxRead,
    listDueEventTelegramProjectionOutboxes: unexpectedOutboxRead,
    readEvent: async (eventId, signal) =>
      event(await read(`events/${eventId}`, undefined, signal), eventId),
    readEventPrizeSelections: async (eventId, signal) =>
      ((await read(`eventPrizeSelections/${eventId}`, undefined, signal)) ??
        {}) as Record<string, string>,
    readProfileEventPrizeAssignment: async (profileId, eventId, signal) =>
      (await read(
        `profileEventPrizes/${profileId}/${eventId}`,
        undefined,
        signal,
      )) as EventPrizeAssignmentRecord | null,
    async readEventSnapshot(eventId, signal) {
      const [eventValue, prizeSelections] = await Promise.all([
        read(`events/${eventId}`, undefined, signal),
        read(`eventPrizeSelections/${eventId}`, undefined, signal),
      ]);
      return {
        event: event(eventValue, eventId),
        eventId,
        prizeSelections: (prizeSelections ?? {}) as Record<string, string>,
        revision: eventValue ? 1 : 0,
      };
    },
    async readProfileEventPrizes(profileId, signal) {
      const prizes = await read(
        `profileEventPrizes/${profileId}`,
        undefined,
        signal,
      );
      return {
        prizes: (prizes ?? {}) as Record<string, EventPrizeAssignmentRecord>,
        profileId,
        revision: prizes ? 1 : 0,
      };
    },
    listProfileEventPrizeAssignments: async (profileId, query = {}, signal) =>
      ((await read(
        `profileEventPrizes/${profileId}`,
        {
          orderBy: "$key",
          ...(query.startAt !== undefined ? { startAt: query.startAt } : {}),
          ...(query.limit !== undefined ? { limitToFirst: query.limit } : {}),
        },
        signal,
      )) ?? {}) as Record<string, EventPrizeAssignmentRecord>,
  };
}
