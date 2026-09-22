import { jsonValuesEqual, encodeJson } from "./validation.ts";
import {
  EventD1Conflict,
  type EventD1Connection,
  type ProfilePrizeMutationState,
  type EventMutationOptions,
} from "./types.ts";
import { profileRevisionGuard } from "./guards.ts";

export function buildProfilePrizeStatements(
  db: EventD1Connection,
  profileStates: ReadonlyMap<string, ProfilePrizeMutationState>,
  options: EventMutationOptions,
  nowMs: number,
) {
  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];
  const profilePrizeRevisions: Record<string, number> = {};

  for (const [profileId, state] of profileStates) {
    const expected =
      options.expectedProfilePrizeRevisions?.[profileId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(profileRevisionGuard(db, profileId, expected));
    for (const eventId of Object.keys(state.originalPrizes)) {
      if (!Object.hasOwn(state.prizes, eventId)) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM profile_event_prizes WHERE profile_id = ? AND event_id = ?",
            )
            .bind(profileId, eventId),
        );
      }
    }
    for (const [eventId, assignment] of Object.entries(state.prizes)) {
      if (
        Object.hasOwn(state.originalPrizes, eventId) &&
        jsonValuesEqual(state.originalPrizes[eventId], assignment)
      ) {
        continue;
      }
      mutations.push(
        db
          .prepare(
            `INSERT INTO profile_event_prizes (
               profile_id, event_id, assignment_json, updated_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (profile_id, event_id) DO UPDATE SET
               assignment_json = excluded.assignment_json,
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(profileId, eventId, encodeJson(assignment), nowMs),
      );
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO profile_event_prize_revisions (
             profile_id, revision, updated_at_ms
           ) VALUES (?, 1, ?)
           ON CONFLICT (profile_id) DO UPDATE SET
             revision = profile_event_prize_revisions.revision + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(profileId, nowMs),
    );
    profilePrizeRevisions[profileId] = state.revision + 1;
  }

  return { guards, mutations, profilePrizeRevisions };
}
