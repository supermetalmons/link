import { readProfileEventPrizeAssignment } from "./eventD1/reads.ts";
import { transactProfileEventPrize } from "./eventD1/transactions.ts";
import {
  removeMatchingProfileEventPrizeAssignment,
  type ProfilePrizeCleanupInput,
} from "./eventD1/profilePrizeCleanup.ts";
import type { EventD1Connection } from "./eventD1/types.ts";
import type { EventStore } from "./eventStoreContracts.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import type { ProfileOwnershipReader } from "./profileOwnership.ts";
import { createD1ProfileOwnershipReader } from "./profileOwnershipD1.ts";

export type EventPrizeRepository = ProfileOwnershipReader &
  Pick<
    EventStore,
    "readProfileEventPrizeAssignment" | "transactProfileEventPrize"
  > & {
    removeMatchingProfileEventPrizeAssignment(
      input: ProfilePrizeCleanupInput,
    ): Promise<boolean>;
  };

export function transactProfileEventPrizeWithAdmission(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: Parameters<EventStore["transactProfileEventPrize"]>[2],
  signal?: AbortSignal,
): ReturnType<EventStore["transactProfileEventPrize"]> {
  return withEventWriteAdmission(
    db,
    { kind: "mutation", context: "event-path-transaction" },
    (admission) =>
      transactProfileEventPrize(db, profileId, eventId, updater, {
        admission,
        signal,
      }),
  );
}

export function createEventPrizeRepository(
  profileDb: D1Database,
  eventDb: EventD1Connection,
): EventPrizeRepository {
  return {
    ...createD1ProfileOwnershipReader(profileDb),
    readProfileEventPrizeAssignment: (profileId, eventId) =>
      readProfileEventPrizeAssignment(eventDb, profileId, eventId),
    transactProfileEventPrize: (profileId, eventId, updater, signal) =>
      transactProfileEventPrizeWithAdmission(
        eventDb,
        profileId,
        eventId,
        updater,
        signal,
      ),
    removeMatchingProfileEventPrizeAssignment: (input) =>
      withEventWriteAdmission(
        eventDb,
        { kind: "mutation", context: "event-path-transaction" },
        (admission) =>
          removeMatchingProfileEventPrizeAssignment(eventDb, input, {
            admission,
          }),
      ),
  };
}
