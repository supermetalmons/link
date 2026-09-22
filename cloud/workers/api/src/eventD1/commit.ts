import {
  type EventD1Connection,
  type EventMutationOptions,
  type EventMutationResult,
  EventD1Conflict,
  type PublicEventMutationOptions,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
} from "./types.ts";
import type { EventMutation } from "../../../../runtime/eventCommands.js";
import {
  eventWriteAdmissionGuard,
  eventLeaseGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import { safeInteger } from "./validation.ts";
import { prepareEventMutations } from "./mutationPreparation.ts";
import { buildEventStatements } from "./eventStatements.ts";
import { buildProfilePrizeStatements } from "./profilePrizeStatements.ts";
import { buildOutboxStatements } from "./outboxStatements.ts";

export async function commitEventMutationsInternal(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: EventMutationOptions,
): Promise<EventMutationResult> {
  const now = options.now || Date.now;
  const nowMs = safeInteger(now());
  const prepared = await prepareEventMutations(db, changes, options);
  const guards = [eventWriteAdmissionGuard(db, options.admission)];
  if (options.eventLease) {
    guards.push(eventLeaseGuard(db, options.eventLease));
  }

  const events = buildEventStatements(db, prepared.eventStates, options, nowMs);
  const prizes = buildProfilePrizeStatements(
    db,
    prepared.profileStates,
    options,
    nowMs,
  );
  const outboxes = await buildOutboxStatements(db, prepared, options, nowMs);
  guards.push(...events.guards, ...prizes.guards, ...outboxes.guards);
  const mutations = [
    ...events.mutations,
    ...prizes.mutations,
    ...outboxes.mutations,
  ];
  const { eventRevisions } = events;
  const { profilePrizeRevisions } = prizes;

  if (options.transition) {
    mutations.push(
      db
        .prepare(
          `DELETE FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ? AND status = 'pending'`,
        )
        .bind(options.transition.transitionId, options.transition.eventId),
    );
  }
  if (mutations.length === 0) return { eventRevisions, profilePrizeRevisions };
  try {
    await db.batch([...guards, ...mutations]);
  } catch (error) {
    await rethrowEventBatchFailure(db, error, options);
  }
  return { eventRevisions, profilePrizeRevisions };
}

export async function commitEventMutations(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: PublicEventMutationOptions,
): Promise<EventMutationResult> {
  const canRetry =
    changes.length > 0 &&
    changes.every(
      (change) => change.kind === "progress-outbox" && change.value !== null,
    ) &&
    !options.expectedRecords &&
    !options.expectedEventRevisions &&
    !options.expectedProfilePrizeRevisions &&
    !options.expectedTelegramStateRevisions &&
    !options.eventLease &&
    !options.transition;
  const attempts = canRetry ? MAX_EVENT_TRANSACTION_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await commitEventMutationsInternal(db, changes, options);
    } catch (error) {
      if (!(error instanceof EventD1Conflict) || attempt + 1 === attempts)
        throw error;
    }
  }
  throw new EventD1Conflict();
}
