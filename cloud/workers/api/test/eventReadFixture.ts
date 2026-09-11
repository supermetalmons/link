import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
  EventReads,
} from "../../../runtime/eventReads.js";
import type { StateQuery } from "../src/stateRepositoryTypes.ts";

export function eventReadFixture(
  read: (
    path: string,
    query?: StateQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): EventReads {
  return {
    readEvent: async (eventId, signal) =>
      (await read(
        `events/${eventId}`,
        undefined,
        signal,
      )) as EventJsonRecord | null,
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
      const [event, prizeSelections] = await Promise.all([
        read(`events/${eventId}`, undefined, signal),
        read(`eventPrizeSelections/${eventId}`, undefined, signal),
      ]);
      return {
        event: event as EventJsonRecord | null,
        eventId,
        prizeSelections: (prizeSelections ?? {}) as Record<string, string>,
        revision: event ? 1 : 0,
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
    listEventsByStatus: async (status, limit, signal) =>
      ((await read(
        "events",
        { orderBy: "status", equalTo: status, limitToFirst: limit },
        signal,
      )) ?? {}) as Record<string, EventJsonRecord>,
    listProfileEventPrizeAssignments: async (profileId, query = {}, signal) =>
      ((await read(
        `profileEventPrizes/${profileId}`,
        {
          orderBy: "$key",
          startAt: query.startAt,
          limitToFirst: query.limit,
        },
        signal,
      )) ?? {}) as Record<string, EventPrizeAssignmentRecord>,
  };
}
