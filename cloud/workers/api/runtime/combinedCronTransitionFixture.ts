import { eventIntentFixture } from "../test/transitionIntentFixture.ts";
import { expect } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  createEventTransitionIntent,
  releaseEventWriteAdmission,
  type EventTransitionIntent,
} from "../src/eventD1.ts";
import { readEventTransitionReceipt } from "../src/eventTransitionReceiptsD1.ts";
import {
  createGameSessionTransitions,
  GAME_SESSION_TRANSITION_SWEEP_LIMIT,
  gameSessionOperationResource,
} from "../src/gameSessionTransitions.ts";
import { createInviteSourceD1Store } from "../src/inviteSourceD1.ts";
import { prepareInviteEventIntent } from "../src/inviteEventEffects.ts";
import { createMatchStateSource } from "../src/matchStateSource.ts";

const eventTransitionLimit = 100;
const eventPrefix = "cron-transition-event-";
const sessionPrefix = "cron-transition-session-";

function ids(prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(3, "0")}`,
  );
}

async function seedEventTransitions(env: Env, nowMs: number) {
  const createdAtMs = nowMs - 60_000;
  const eventIds = ids(eventPrefix, eventTransitionLimit + 1);
  const digest = "a".repeat(64);
  await env.PROFILE_GAMES_DB.prepare(
    `UPDATE event_transition_receipt_control
     SET state = 'active', source_count = 0, source_digest = ?,
         import_count = 0, import_digest = ?,
         candidate_version_id = '11111111-1111-4111-8111-111111111111',
         verified_event_freeze_generation = 1, source_exported_at_ms = 1,
         imported_at_ms = 2, verified_at_ms = 3, activated_at_ms = 4
     WHERE singleton = 1 AND state = 'importing'`,
  )
    .bind(digest, digest)
    .run();
  const admission = await acquireEventWriteAdmission(env.EVENT_DB);
  const transitions: Extract<EventTransitionIntent, { schemaVersion: 2 }>[] =
    [];
  try {
    for (const eventId of eventIds) {
      await commitEventMutations(
        env.EVENT_DB,
        [
          {
            kind: "event",
            eventId,
            value: {
              schemaVersion: 2,
              eventId,
              status: "ended",
              createdAtMs,
              updatedAtMs: createdAtMs,
              startAtMs: createdAtMs,
              participants: {},
              rounds: {},
            },
          },
        ],
        { admission },
      );
      const intent = await prepareInviteEventIntent(
        env.PROFILE_GAMES_DB,
        eventIntentFixture({
          schemaVersion: 1,
          transitionId: `intent-${eventId}`,
          eventId,
          expectedRevision: 1,
          canonicalUpdates: { [`events/${eventId}/updatedAtMs`]: nowMs },
          rtdbEffects: {
            [`matchTimerStarts/${eventId}/cron-transition-host`]: null,
          },
          createdAtMs,
          updatedAtMs: createdAtMs,
        }),
      );
      await createEventTransitionIntent(env.EVENT_DB, intent, { admission });
      transitions.push(intent);
    }
  } finally {
    await releaseEventWriteAdmission(env.EVENT_DB, admission);
  }
  await env.PROFILE_GAMES_DB.batch(
    [eventIds[0], eventIds[eventTransitionLimit]].map((matchId) =>
      env.PROFILE_GAMES_DB.prepare(
        `INSERT INTO match_timer_starts
         (player_id, match_id, timer, turn_number, updated_at_ms)
         VALUES ('cron-transition-host', ?, ?, 1, ?)`,
      ).bind(matchId, `1;${nowMs}`, createdAtMs),
    ),
  );
  return transitions;
}

async function seedGameSessionTransitions(env: Env, nowMs: number) {
  const db = env.PROFILE_GAMES_DB;
  const createdAtMs = nowMs - 60_000;
  const sessions = ids(
    sessionPrefix,
    GAME_SESSION_TRANSITION_SWEEP_LIMIT + 1,
  ).map((inviteId) => ({
    inviteId,
    transitionId: `intent-${inviteId}`,
    operationId: `operation-${inviteId}`,
    hostId: `host-${inviteId}`,
  }));
  const source = createInviteSourceD1Store(db, { now: () => createdAtMs });
  await db.batch(
    source.buildCommitStatements(
      await source.prepareChanges(
        sessions.map(({ inviteId, hostId }) => ({
          inviteId,
          value: {
            hostId,
            guestId: `guest-${inviteId}`,
            hostColor: "white",
            hostRematches: "1",
            guestRematches: "1",
          },
        })),
      ),
    ),
  );
  await db.batch(
    sessions.map(({ inviteId, operationId }) =>
      db
        .prepare(
          `INSERT INTO game_session_mutation_locks
         (lock_id, owner_id, operation_id, expires_at_ms, writer_generation)
         VALUES (?, 'cron-transition-owner', ?, ?, 2)`,
        )
        .bind(inviteId, operationId, nowMs - 1),
    ),
  );
  await db
    .prepare(
      `CREATE TRIGGER cron_transition_fixture_interrupt
     BEFORE UPDATE OF status ON game_session_transitions
     WHEN NEW.status = 'completed' AND NEW.invite_id LIKE '${sessionPrefix}%'
     BEGIN SELECT RAISE(ABORT, 'cron-transition-fixture-interrupted'); END`,
    )
    .run();
  try {
    for (const { inviteId, transitionId, operationId, hostId } of sessions) {
      const transitions = createGameSessionTransitions({
        db,
        state: createMatchStateSource(env),
        now: () => createdAtMs,
        createId: () => transitionId,
      });
      await expect(
        transitions.commit(
          [
            { kind: "invite-rematches", inviteId, role: "host", value: "1x" },
            {
              kind: "mutation-receipt",
              operationId,
              value: {
                schemaVersion: 1,
                kind: "rematch-end",
                inviteId,
                operationId,
                requesterUid: hostId,
                fingerprint: `fingerprint-${operationId}`,
                completedAtMs: createdAtMs,
                projectionRequestId: null,
                response: {
                  ok: true,
                  inviteId,
                  actorUid: hostId,
                  rematches: "1x",
                },
              },
              expiration: { completedAtMs: createdAtMs },
            },
          ],
          [{ lockId: inviteId, ownerId: "cron-transition-owner", operationId }],
        ),
      ).rejects.toThrow("cron-transition-fixture-interrupted");
    }
  } finally {
    await db.prepare("DROP TRIGGER cron_transition_fixture_interrupt").run();
  }
  expect(
    await db
      .prepare(
        `SELECT COUNT(*) AS count FROM game_session_transitions
       WHERE invite_id LIKE ? AND status = 'pending' AND attempt_count = 1`,
      )
      .bind(`${sessionPrefix}%`)
      .first("count"),
  ).toBe(sessions.length);
  return sessions;
}

export async function seedCombinedCronTransitions(env: Env, nowMs: number) {
  const eventTransitions = await seedEventTransitions(env, nowMs);
  const gameSessions = await seedGameSessionTransitions(env, nowMs);
  return {
    eventTransitions,
    gameSessions,
    async assertAfterScheduled() {
      const eventRows = await env.EVENT_DB.prepare(
        `SELECT event.event_id, event.revision, event.pending_transition_id,
                event.updated_at_ms, intent.status, intent.attempts, intent.last_error
         FROM event_records AS event
         LEFT JOIN event_transition_intents AS intent ON intent.event_id = event.event_id
         WHERE event.event_id LIKE ? ORDER BY event.event_id`,
      )
        .bind(`${eventPrefix}%`)
        .all();
      expect(eventRows.results).toEqual(
        eventTransitions.map((intent, index) => ({
          event_id: intent.eventId,
          revision: index < eventTransitionLimit ? 2 : 1,
          pending_transition_id:
            index < eventTransitionLimit ? null : intent.transitionId,
          updated_at_ms: index < eventTransitionLimit ? nowMs : nowMs - 60_000,
          status: index < eventTransitionLimit ? null : "pending",
          attempts: index < eventTransitionLimit ? null : 0,
          last_error: null,
        })),
      );
      for (const [index, intent] of eventTransitions.entries()) {
        expect(
          await readEventTransitionReceipt(
            env.PROFILE_GAMES_DB,
            intent.transitionId,
          ),
        ).toEqual(
          index < eventTransitionLimit
            ? {
                schemaVersion: 2,
                transitionId: intent.transitionId,
                eventId: intent.eventId,
                expectedRevision: 1,
                payloadDigest: intent.payloadDigest,
              }
            : null,
        );
      }
      expect(
        (
          await env.PROFILE_GAMES_DB.prepare(
            `SELECT transition_id, event_id, payload_digest FROM invite_event_effect_receipts
         WHERE event_id LIKE ? ORDER BY event_id`,
          )
            .bind(`${eventPrefix}%`)
            .all()
        ).results,
      ).toEqual(
        eventTransitions.slice(0, eventTransitionLimit).map((intent) => ({
          transition_id: intent.transitionId,
          event_id: intent.eventId,
          payload_digest: intent.payloadDigest,
        })),
      );
      expect(
        (
          await env.PROFILE_GAMES_DB.prepare(
            "SELECT match_id FROM match_timer_starts WHERE match_id LIKE ? ORDER BY match_id",
          )
            .bind(`${eventPrefix}%`)
            .all()
        ).results,
      ).toEqual([{ match_id: eventTransitions[eventTransitionLimit].eventId }]);
      for (const [index, session] of gameSessions.entries()) {
        const recovered = index < GAME_SESSION_TRANSITION_SWEEP_LIMIT;
        expect(
          await env.PROFILE_GAMES_DB.prepare(
            `SELECT status, attempt_count, last_error FROM game_session_transitions
           WHERE transition_id = ?`,
          )
            .bind(session.transitionId)
            .first(),
        ).toEqual({
          status: recovered ? "completed" : "pending",
          attempt_count: 1,
          last_error: recovered ? null : "game-session-transition-unavailable",
        });
        expect(
          await createInviteSourceD1Store(env.PROFILE_GAMES_DB).read(
            session.inviteId,
          ),
        ).toMatchObject({
          revision: recovered ? 2 : 1,
          value: {
            hostId: session.hostId,
            hostRematches: recovered ? "1x" : "1",
          },
        });
        const receipt = await env.PROFILE_GAMES_DB.prepare(
          "SELECT payload_json FROM game_session_mutation_receipts WHERE record_key = ?",
        )
          .bind(session.operationId)
          .first<string>("payload_json");
        if (recovered)
          expect(JSON.parse(receipt!)).toMatchObject({
            kind: "rematch-end",
            inviteId: session.inviteId,
            operationId: session.operationId,
            response: { ok: true, rematches: "1x" },
          });
        else expect(receipt).toBeNull();
      }
      const remainder = gameSessions[GAME_SESSION_TRANSITION_SWEEP_LIMIT];
      expect(
        (
          await env.PROFILE_GAMES_DB.prepare(
            `SELECT resource_key FROM game_session_transition_resources
         WHERE transition_id LIKE ? ORDER BY resource_key`,
          )
            .bind(`intent-${sessionPrefix}%`)
            .all()
        ).results,
      ).toEqual(
        [
          remainder.inviteId,
          `automatch-login:${remainder.hostId}`,
          gameSessionOperationResource(remainder.operationId),
        ]
          .sort()
          .map((resource_key) => ({ resource_key })),
      );
      for (const table of ["event_write_admissions", "event_leases"]) {
        expect(
          await env.EVENT_DB.prepare(
            `SELECT COUNT(*) AS count FROM ${table}`,
          ).first("count"),
          table,
        ).toBe(0);
      }
      for (const table of [
        "invite_source_write_admissions",
        "automatch_write_admissions",
        "game_session_mutation_locks",
      ]) {
        expect(
          await env.PROFILE_GAMES_DB.prepare(
            `SELECT COUNT(*) AS count FROM ${table}`,
          ).first("count"),
          table,
        ).toBe(0);
      }
    },
  };
}
