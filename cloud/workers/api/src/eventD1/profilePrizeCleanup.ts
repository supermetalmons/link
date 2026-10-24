import { isMatchingProfileEventPrizeAssignment } from "../../../../runtime/eventPrizeWithdrawalState.js";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";
import { commitEventMutationsInternal } from "./commit.ts";
import {
  eventLeaseGuard,
  eventWriteAdmissionGuard,
  profileRevisionGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import { prepareEventMutations } from "./mutationPreparation.ts";
import { readProfilePrizeAssignmentSnapshot } from "./reads.ts";
import {
  EventD1Conflict,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
  type EventD1Connection,
  type EventTransactionOptions,
} from "./types.ts";
import { cloneJson, safeInteger } from "./validation.ts";

export type ProfilePrizeCleanupInput = {
  profileId: string;
  eventId: string;
  prizeId: string;
};

export async function removeMatchingProfileEventPrizeAssignment(
  db: EventD1Connection,
  { profileId, eventId, prizeId }: ProfilePrizeCleanupInput,
  options: EventTransactionOptions,
): Promise<boolean> {
  const result = await runOptimisticTransaction({
    maxAttempts: MAX_EVENT_TRANSACTION_ATTEMPTS,
    signal: options.signal,
    read: () => readProfilePrizeAssignmentSnapshot(db, profileId, eventId),
    getValue: (snapshot) => cloneJson(snapshot.assignment),
    decide(current) {
      const value = isMatchingProfileEventPrizeAssignment(
        current,
        eventId,
        prizeId,
      )
        ? null
        : current;
      options.signal?.throwIfAborted();
      return { value };
    },
    async write(snapshot, value) {
      const changes = [
        { kind: "profile-prize" as const, profileId, eventId, value },
      ];
      const commitOptions = {
        ...options,
        profilePrizeSnapshot: snapshot,
        expectedProfilePrizeRevisions: { [profileId]: snapshot.revision },
      };
      try {
        if (snapshot.assignment !== null && value === null) {
          await commitEventMutationsInternal(db, changes, commitOptions);
        } else {
          safeInteger((options.now || Date.now)());
          await prepareEventMutations(db, changes, commitOptions);
          const guards = [eventWriteAdmissionGuard(db, options.admission)];
          if (options.eventLease)
            guards.push(eventLeaseGuard(db, options.eventLease));
          guards.push(profileRevisionGuard(db, profileId, snapshot.revision));
          await db
            .batch(guards)
            .catch((error) => rethrowEventBatchFailure(db, error, options));
        }
        return { applied: true, value };
      } catch (error) {
        if (error instanceof EventD1Conflict) {
          options.signal?.throwIfAborted();
          return { applied: false, value };
        }
        throw error;
      }
    },
    conflictError: () => new EventD1Conflict(),
  });
  return result.committed && result.value === null;
}
