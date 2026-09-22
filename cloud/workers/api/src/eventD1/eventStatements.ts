import { validateEventAggregate, encodeJson } from "./validation.ts";
import {
  EventD1Failure,
  EventD1Conflict,
  type EventD1Connection,
  type EventMutationState,
  type EventMutationOptions,
} from "./types.ts";
import { eventMutationGuard, guardStatement } from "./guards.ts";

function eventRecordStatement(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
  pendingTransitionId: string | null,
): D1PreparedStatement {
  if (!state.next) {
    return db
      .prepare("DELETE FROM event_records WHERE event_id = ?")
      .bind(eventId);
  }
  const event = validateEventAggregate(eventId, state.next);
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = excluded.status,
         start_at_ms = excluded.start_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         revision = event_records.revision + 1,
         pending_transition_id = excluded.pending_transition_id,
         record_json = excluded.record_json`,
    )
    .bind(
      eventId,
      event.status,
      event.startAtMs,
      event.updatedAtMs,
      pendingTransitionId,
      encodeJson(event),
    );
}

export function buildEventStatements(
  db: EventD1Connection,
  eventStates: ReadonlyMap<string, EventMutationState>,
  options: EventMutationOptions,
  nowMs: number,
) {
  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];
  const eventRevisions: Record<string, number> = {};

  for (const [eventId, state] of eventStates) {
    if (
      state.pendingTransitionId &&
      (options.transition?.eventId !== eventId ||
        options.transition.transitionId !== state.pendingTransitionId)
    ) {
      throw new EventD1Failure("event-transition-pending");
    }
    const expected =
      options.expectedEventRevisions?.[eventId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(eventMutationGuard(db, eventId, state));
    const transitionApplies = options.transition?.eventId === eventId;
    if (transitionApplies) {
      guards.push(
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM event_transition_intents
             WHERE transition_id = ? AND event_id = ?
               AND expected_revision = ? AND status = 'pending'
           )`,
          [options.transition!.transitionId, eventId, expected],
          "invariant",
        ),
      );
    }
    mutations.push(
      eventRecordStatement(
        db,
        eventId,
        state,
        transitionApplies ? null : state.pendingTransitionId,
      ),
    );
    if (state.selectionsChanged) {
      const originalSelections = state.originalSelections || {};
      const selections = state.selections || {};
      for (const profileId of Object.keys(originalSelections)) {
        if (!Object.hasOwn(selections, profileId)) {
          mutations.push(
            db
              .prepare(
                "DELETE FROM event_prize_selections WHERE event_id = ? AND profile_id = ?",
              )
              .bind(eventId, profileId),
          );
        }
      }
      for (const [profileId, prizeId] of Object.entries(selections)) {
        if (
          Object.hasOwn(originalSelections, profileId) &&
          originalSelections[profileId] === prizeId
        ) {
          continue;
        }
        mutations.push(
          db
            .prepare(
              `INSERT INTO event_prize_selections (
                 event_id, profile_id, prize_id, updated_at_ms
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT (event_id, profile_id) DO UPDATE SET
                 prize_id = excluded.prize_id,
                 updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(eventId, profileId, prizeId, nowMs),
        );
      }
    }
    eventRevisions[eventId] = state.revision + 1;
  }

  return { guards, mutations, eventRevisions };
}
