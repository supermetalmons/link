import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  createEventTransitionIntent,
  EventD1Conflict,
  patchEventOwnedPaths,
  readEventSnapshot,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const db = env.EVENT_DB;
const migrations = (env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] })
  .TEST_EVENT_D1_MIGRATIONS;
const migrationIndex = migrations.findIndex(
  ({ name }) => name === "0004_event_sunday_mons.sql",
);
const prizeEventIds = [
  "NN3eRzoZo80",
  "FRkdorMWaYW",
  "VOxalSrexcA",
  "oXAceF6anag",
  "RpPjMNyrJJa",
  "z3oj52Iiime",
];
const statuses = ["scheduled", "active", "ended", "dismissed"];
const migrate = () => applyD1Migrations(db, [migrations[migrationIndex]]);

function eventRecord(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 200,
    startAtMs: 300,
    participants: {},
    rounds: {},
    futureField: { preserved: true },
    ...overrides,
  };
}

function insertEvent(eventId: string, overrides: Record<string, unknown> = {}) {
  const event = eventRecord(eventId, overrides);
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision, record_json
       ) VALUES (?, ?, ?, ?, 7, ?)`,
    )
    .bind(
      eventId,
      event.status,
      event.startAtMs,
      event.updatedAtMs,
      JSON.stringify(event),
    );
}

async function rows(table: string) {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
}

async function pendingTransition(eventId: string) {
  const admission = await acquireEventWriteAdmission(db);
  try {
    await createEventTransitionIntent(
      db,
      {
        schemaVersion: 1,
        transitionId: `transition-${eventId}`,
        eventId,
        expectedRevision: 7,
        canonicalUpdates: { [`events/${eventId}/status`]: "active" },
        rtdbEffects: { "invites/invite-one/status": "active" },
        createdAtMs: 400,
        updatedAtMs: 400,
      },
      { admission },
    );
  } finally {
    await releaseEventWriteAdmission(db, admission);
  }
}

describe("Sunday Mons event migration", () => {
  beforeAll(async () => {
    expect(migrationIndex).toBeGreaterThan(0);
    await applyEventTestMigrations(db, migrations.slice(0, migrationIndex));
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("UPDATE event_records SET pending_transition_id = NULL"),
      db.prepare("DELETE FROM event_transition_intents"),
      db.prepare("DELETE FROM event_records"),
      db.prepare("DELETE FROM profile_event_prize_revisions"),
      db
        .prepare("DELETE FROM d1_migrations WHERE name = ?")
        .bind(migrations[migrationIndex].name),
    ]);
  });

  it("classifies all six historical prize events and every event status without changing timestamps", async () => {
    const fixtures = [
      ...prizeEventIds.map((eventId, index) => ({
        eventId,
        status: statuses[index % statuses.length],
        isSundayMons: true,
      })),
      ...statuses.map((status) => ({
        eventId: `ordinary-${status}`,
        status,
        isSundayMons: false,
      })),
    ];
    await db.batch(
      fixtures.map(({ eventId, status }) => insertEvent(eventId, { status })),
    );

    await migrate();

    for (const { eventId, status, isSundayMons } of fixtures) {
      await expect(readEventSnapshot(db, eventId)).resolves.toEqual({
        event: eventRecord(eventId, { status, isSundayMons }),
        eventId,
        prizeSelections: {},
        revision: 8,
      });
    }
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count FROM event_records
           WHERE updated_at_ms != 200 OR start_at_ms != 300
             OR json_type(record_json, '$.isSundayMons') NOT IN ('true', 'false')`,
        )
        .first("count"),
    ).toBe(0);
  });

  it("preserves explicit choices and remains idempotent when the SQL is rerun", async () => {
    await db.batch([
      insertEvent(prizeEventIds[0], { isSundayMons: false }),
      insertEvent("explicit-sunday", { isSundayMons: true }),
      insertEvent("missing-flag"),
    ]);
    await pendingTransition(prizeEventIds[0]);

    await migrate();

    expect(await readEventSnapshot(db, prizeEventIds[0])).toMatchObject({
      revision: 7,
      event: { isSundayMons: false },
    });
    expect(await readEventSnapshot(db, "explicit-sunday")).toMatchObject({
      revision: 7,
      event: { isSundayMons: true },
    });
    expect(await readEventSnapshot(db, "missing-flag")).toMatchObject({
      revision: 8,
      event: { isSundayMons: false },
    });
    const after = await rows("event_records");
    await db.batch(
      migrations[migrationIndex].queries.map((query) => db.prepare(query)),
    );
    expect(await rows("event_records")).toEqual(after);
  });

  it("preserves prizes and projection state without enqueuing work", async () => {
    const eventId = prizeEventIds[0];
    const assignment = {
      eventId,
      profileId: "profile-one",
      prizeId: "1092",
      place: 1,
      assignedAtMs: 150,
    };
    await insertEvent(eventId, { prizeAssignments: { 1: assignment } }).run();
    await db.batch([
      db
        .prepare(
          "INSERT INTO event_prize_selections VALUES (?, 'profile-one', '1092', 200)",
        )
        .bind(eventId),
      db
        .prepare(
          "INSERT INTO profile_event_prizes VALUES ('profile-one', ?, ?, 200)",
        )
        .bind(eventId, JSON.stringify(assignment)),
      db.prepare(
        "INSERT INTO profile_event_prize_revisions VALUES ('profile-one', 2, 200)",
      ),
      db
        .prepare(
          `INSERT INTO event_telegram_projection_state
           VALUES (?, 3, 4, '{"upcoming":{"messageId":123}}', 200)`,
        )
        .bind(eventId),
      db
        .prepare(
          `INSERT INTO event_telegram_projection_outboxes (
             event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json
           ) VALUES (?, 'request-one', 'pending', 100, 200, '{"retained":true}')`,
        )
        .bind(eventId),
    ]);
    const preservedTables = [
      "event_prize_selections",
      "profile_event_prizes",
      "profile_event_prize_revisions",
      "event_progress_outboxes",
      "event_profile_game_projection_outboxes",
      "event_telegram_projection_state",
      "event_telegram_projection_outboxes",
      "event_runtime_control",
    ];
    const before = await Promise.all(preservedTables.map(rows));

    await migrate();

    expect(await Promise.all(preservedTables.map(rows))).toEqual(before);
    expect((await readEventSnapshot(db, eventId)).event).toEqual(
      eventRecord(eventId, {
        isSundayMons: true,
        prizeAssignments: { 1: assignment },
      }),
    );
  });

  it("atomically rejects pending target transitions and succeeds after they clear", async () => {
    await db.batch([
      insertEvent(prizeEventIds[0]),
      insertEvent("pending-event"),
    ]);
    await pendingTransition("pending-event");
    const before = await rows("event_records");
    const intents = await rows("event_transition_intents");

    await expect(migrate()).rejects.toThrow();

    expect(await rows("event_records")).toEqual(before);
    expect(await rows("event_transition_intents")).toEqual(intents);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?")
        .bind(migrations[migrationIndex].name)
        .first("count"),
    ).toBe(0);
    await db.batch([
      db.prepare("UPDATE event_records SET pending_transition_id = NULL"),
      db.prepare("DELETE FROM event_transition_intents"),
    ]);
    await migrate();
    expect((await readEventSnapshot(db, "pending-event")).revision).toBe(8);
  });

  it("invalidates stale revisions while allowing later nested mutations to preserve the flag", async () => {
    const eventId = prizeEventIds[0];
    await insertEvent(eventId).run();
    const admission = await acquireEventWriteAdmission(db);
    try {
      await migrate();
      await expect(
        patchEventOwnedPaths(
          db,
          { [`events/${eventId}/status`]: "active" },
          { admission, expectedEventRevisions: { [eventId]: 7 } },
        ),
      ).rejects.toBeInstanceOf(EventD1Conflict);
      await patchEventOwnedPaths(
        db,
        { [`events/${eventId}/status`]: "active" },
        { admission, expectedEventRevisions: { [eventId]: 8 } },
      );
      expect(await readEventSnapshot(db, eventId)).toMatchObject({
        revision: 9,
        event: { status: "active", isSundayMons: true },
      });
    } finally {
      await releaseEventWriteAdmission(db, admission);
    }
  });
});
