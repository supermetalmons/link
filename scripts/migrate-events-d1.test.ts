import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertImportAllowed,
  assertMigrationSource,
  buildImportSql,
  canonicalize,
  eventProgressOutboxId,
  firebaseDatabaseGetArgs,
  migrateEvents,
  normalizeSnapshot,
  parseArgs,
  snapshotDigest,
  summarize,
  verifyImportedSnapshot,
  type EventMigrationSnapshot,
  type EventStorageControl,
  type MigrationDependencies,
} from "./migrate-events-d1.ts";

const EVENT_ID = "NN3eRzoZo80";
const PRIZE_ID = "1092";
const PROGRESS_SOURCE_KEY = "source1";
const DEAD_PROGRESS_SOURCE_KEY = "source2";
const PROGRESS_OUTBOX_ID = eventProgressOutboxId(EVENT_ID, PROGRESS_SOURCE_KEY);
const DEAD_PROGRESS_OUTBOX_ID = eventProgressOutboxId(
  EVENT_ID,
  DEAD_PROGRESS_SOURCE_KEY,
);

function storageControl(
  storageMode: EventStorageControl["storageMode"],
  previousStorageMode: EventStorageControl["previousStorageMode"],
  freezeGeneration = storageMode === "firebase" ? 0 : 1,
): EventStorageControl {
  return {
    storageMode,
    previousStorageMode,
    freezeGeneration,
    verifiedImportGeneration: null,
  };
}

function fixture(): EventMigrationSnapshot {
  return normalizeSnapshot({
    events: {
      [EVENT_ID]: {
        eventId: EVENT_ID,
        status: "ended",
        startAtMs: 100,
        updatedAtMs: 200,
        participants: {},
        rounds: {},
        prizeAssignments: {
          1: {
            eventId: EVENT_ID,
            profileId: "profile1",
            prizeId: PRIZE_ID,
            place: 1,
            assignedAtMs: 190,
          },
        },
        title: "sensitive 🌟 event",
      },
    },
    eventPrizeSelections: { [EVENT_ID]: { profile1: PRIZE_ID } },
    profileEventPrizes: {
      profile1: {
        [EVENT_ID]: {
          eventId: EVENT_ID,
          profileId: "profile1",
          prizeId: PRIZE_ID,
          place: 1,
          assignedAtMs: 190,
        },
      },
    },
    eventProgressOutbox: {
      [PROGRESS_OUTBOX_ID]: {
        schemaVersion: 1,
        eventId: EVENT_ID,
        sourceKey: PROGRESS_SOURCE_KEY,
        reason: "scheduled-start",
        runAtMs: null,
        firstQueuedAtMs: 100,
        lastQueuedAtMs: 110,
      },
    },
    eventProgressOutboxDead: {
      [DEAD_PROGRESS_OUTBOX_ID]: {
        deadAtMs: 150,
        reason: "invalid-event-progress-outbox",
        originalRecord: {
          schemaVersion: 1,
          eventId: EVENT_ID,
          sourceKey: DEAD_PROGRESS_SOURCE_KEY,
          reason: "match-rating-updated",
          runAtMs: 140,
          firstQueuedAtMs: 120,
          lastQueuedAtMs: 130,
        },
      },
    },
    eventProfileGameProjectionOutboxes: {
      [EVENT_ID]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request1",
        lastQueuedAtMs: 200,
        cleanupOwnerProfileIds: { profile1: true },
      },
    },
    eventTelegramProjectionOutboxes: {
      [EVENT_ID]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request2",
        firstQueuedAtMs: 200,
        updatedAtMs: 210,
      },
    },
    eventTelegramProjections: { [EVENT_ID]: { endedText: "secret text" } },
    eventTelegramProjectionGenerations: { [EVENT_ID]: 3 },
  });
}

function emptyInput() {
  return {
    events: {},
    eventPrizeSelections: {},
    profileEventPrizes: {},
    eventProgressOutbox: {},
    eventProgressOutboxDead: {},
    eventProfileGameProjectionOutboxes: {},
    eventTelegramProjectionOutboxes: {},
    eventTelegramProjections: {},
    eventTelegramProjectionGenerations: {},
  };
}

test("normalizes and hashes event snapshots canonically", () => {
  const snapshot = fixture();
  assert.deepEqual(canonicalize({ b: 2, a: { d: 4, c: 3 } }), {
    a: { c: 3, d: 4 },
    b: 2,
  });
  assert.equal(
    snapshotDigest(snapshot),
    snapshotDigest({
      ...snapshot,
      events: Object.fromEntries(Object.entries(snapshot.events).reverse()),
    }),
  );
  assert.deepEqual(summarize(snapshot), {
    events: 1,
    selections: 1,
    assignedPrizes: 1,
    supportRecords: 5,
    digest: snapshotDigest(snapshot),
  });
});

test("normalizes legacy null event containers without accepting malformed data", () => {
  const normalized = normalizeSnapshot({
    ...emptyInput(),
    events: {
      event1: {
        eventId: "event1",
        status: "scheduled",
        startAtMs: 100,
        updatedAtMs: 100,
        participants: null,
        rounds: [null, { roundIndex: 1 }],
        prizeAssignments: [null, { place: 1 }],
      },
    },
  });
  assert.deepEqual(normalized.events.event1.participants, {});
  assert.deepEqual(normalized.events.event1.rounds, {
    "1": { roundIndex: 1 },
  });
  assert.deepEqual(normalized.events.event1.prizeAssignments, {
    "1": { place: 1 },
  });
  assert.throws(
    () =>
      normalizeSnapshot({
        ...emptyInput(),
        events: {
          event1: {
            eventId: "event1",
            status: "scheduled",
            startAtMs: 100,
            updatedAtMs: 100,
            rounds: "invalid",
          },
        },
      }),
    /invalid event record/,
  );
});

test("rejects event aggregates that the D1 runtime cannot read", () => {
  const event = {
    eventId: "event1",
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 100,
    participants: {},
    rounds: {},
  };
  for (const invalidEvent of [
    { ...event, participants: { profile1: 1 } },
    {
      ...event,
      participants: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`profile${index}`, {}]),
      ),
    },
    { ...event, rounds: { 1: "invalid" } },
    { ...event, participants: { " padded ": {} } },
  ]) {
    assert.throws(
      () =>
        normalizeSnapshot({
          ...emptyInput(),
          events: { event1: invalidEvent },
        }),
      /invalid event record/,
    );
  }
});

test("normalizes legacy immediate progress records with an explicit null run time", () => {
  const sourceKey = "rating:invite:match";
  const outboxId = eventProgressOutboxId("event1", sourceKey);
  const normalized = normalizeSnapshot({
    ...emptyInput(),
    events: {
      event1: {
        eventId: "event1",
        status: "active",
        startAtMs: 100,
        updatedAtMs: 100,
      },
    },
    eventProgressOutbox: {
      [outboxId]: {
        schemaVersion: 1,
        eventId: "event1",
        sourceKey,
        reason: "match-rating-updated",
        firstQueuedAtMs: 100,
        lastQueuedAtMs: 100,
      },
    },
  });
  assert.equal(
    (normalized.eventProgressOutbox[outboxId] as Record<string, unknown>)
      .runAtMs,
    null,
  );
});

test("keeps pending progress schemas and identities strict", () => {
  assert.equal(
    PROGRESS_OUTBOX_ID,
    "ep_894a85008e923dfe53e3135dceb985259ce6f7b977c19fba756b6fe4a689e459",
  );
  const event = {
    eventId: "event1",
    status: "active",
    startAtMs: 100,
    updatedAtMs: 100,
    participants: {},
    rounds: {},
  };
  const sourceKey = "rating:invite:match";
  const outboxId = eventProgressOutboxId(event.eventId, sourceKey);
  const progress = {
    schemaVersion: 1,
    eventId: event.eventId,
    sourceKey,
    reason: "match-rating-updated",
    runAtMs: null,
    firstQueuedAtMs: 100,
    lastQueuedAtMs: 100,
  };
  for (const eventProgressOutbox of [
    { [outboxId]: { ...progress, schemaVersion: 2 } },
    { [`${outboxId}x`]: progress },
  ]) {
    assert.throws(
      () =>
        normalizeSnapshot({
          ...emptyInput(),
          events: { [event.eventId]: event },
          eventProgressOutbox,
        }),
      /invalid event progress record/,
    );
  }
});

test("preserves quarantined progress records without trusting invalid fields", () => {
  const deadOutboxId = "quarantined-progress";
  const deadRecord = {
    deadAtMs: 200,
    reason: "invalid-event-progress-outbox",
    originalRecord: {
      schemaVersion: 99,
      eventId: EVENT_ID,
      sourceKey: 12,
      runAtMs: "invalid",
      lastQueuedAtMs: "invalid",
      payload: { keep: true },
    },
  };
  const unscopedDeadRecords = {
    "quarantined-null": {
      deadAtMs: 201,
      reason: "invalid-event-progress-outbox",
      originalRecord: null,
    },
    "quarantined-primitive": {
      deadAtMs: 202,
      reason: "invalid-event-progress-outbox",
      originalRecord: "invalid",
    },
    "quarantined-missing-event": {
      deadAtMs: 203,
      reason: "invalid-event-progress-outbox",
      originalRecord: { sourceKey: "missing-event" },
    },
    "quarantined-deleted-event": {
      deadAtMs: 204,
      reason: "invalid-event-progress-outbox",
      originalRecord: { eventId: "deleted-event" },
    },
  };
  const snapshot = normalizeSnapshot({
    ...emptyInput(),
    events: { [EVENT_ID]: fixture().events[EVENT_ID] },
    eventProgressOutboxDead: {
      [deadOutboxId]: deadRecord,
      ...unscopedDeadRecords,
    },
  });
  assert.deepEqual(snapshot.eventProgressOutboxDead[deadOutboxId], deadRecord);
  for (const [outboxId, record] of Object.entries(unscopedDeadRecords)) {
    assert.deepEqual(snapshot.eventProgressOutboxDead[outboxId], record);
  }

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync("cloud/workers/api/event-migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(
        resolve("cloud/workers/api/event-migrations", migration),
        "utf8",
      ),
    );
  }
  database.exec(buildImportSql(snapshot, 1_000, "stage"));
  const imported = database
    .prepare(
      `SELECT event_id, run_at_ms, last_queued_at_ms, record_json
       FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'`,
    )
    .get(deadOutboxId) as {
    event_id: string;
    last_queued_at_ms: number;
    record_json: string;
    run_at_ms: null;
  };
  assert.equal(imported.event_id, EVENT_ID);
  assert.equal(imported.run_at_ms, null);
  assert.equal(imported.last_queued_at_ms, deadRecord.deadAtMs);
  assert.deepEqual(JSON.parse(imported.record_json), deadRecord);
  const unscopedRows = database
    .prepare(
      `SELECT outbox_id, event_id, record_json FROM event_progress_outboxes
       WHERE status = 'dead' AND outbox_id != ? ORDER BY outbox_id`,
    )
    .all(deadOutboxId) as Array<{
    event_id: null;
    outbox_id: string;
    record_json: string;
  }>;
  assert.deepEqual(
    unscopedRows.map((row) => ({
      eventId: row.event_id,
      outboxId: row.outbox_id,
      record: JSON.parse(row.record_json),
    })),
    Object.entries(unscopedDeadRecords)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([outboxId, record]) => ({ eventId: null, outboxId, record })),
  );
  assert.throws(() =>
    database.exec(
      `INSERT INTO event_progress_outboxes (
         outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json
       ) VALUES ('pending-without-event', NULL, 'pending', NULL, 1, '{}')`,
    ),
  );
  database.close();
});

test("rejects malformed and orphaned event records", () => {
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        events: { event1: { eventId: "other", status: "ended" } },
      }),
    /invalid event record/,
  );
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        eventPrizeSelections: { missing: { profile1: "prize1" } },
      }),
    /invalid event prize selections record/,
  );
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        profileEventPrizes: {
          profile1: {
            event1: {
              eventId: "event1",
              profileId: "other",
              prizeId: "prize1",
              place: 1,
              assignedAtMs: 190,
            },
          },
        },
      }),
    /invalid profile event prize assignment/,
  );
});

test("rejects prize selections and assignments outside the event catalog", () => {
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        eventPrizeSelections: { [EVENT_ID]: { profile1: "invalid-prize" } },
      }),
    /invalid event prize selection/,
  );
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        profileEventPrizes: {
          profile1: {
            [EVENT_ID]: {
              ...fixture().profileEventPrizes.profile1[EVENT_ID],
              place: 4,
            },
          },
        },
      }),
    /invalid profile event prize assignment/,
  );
});

test("rejects pending Telegram outboxes with an incompatible schema", () => {
  assert.throws(
    () =>
      normalizeSnapshot({
        ...fixture(),
        eventTelegramProjectionOutboxes: {
          [EVENT_ID]: {
            schemaVersion: 2,
            status: "pending",
            requestId: "request2",
            firstQueuedAtMs: 200,
            updatedAtMs: 210,
          },
        },
      }),
    /invalid event Telegram projection outbox record/,
  );
});

test("rejects projection outboxes that their runtimes cannot process", () => {
  for (const eventProfileGameProjectionOutboxes of [
    {
      [EVENT_ID]: {
        status: "pending",
        requestId: "request1",
        lastQueuedAtMs: 200,
      },
    },
    {
      [EVENT_ID]: {
        schemaVersion: 1,
        status: "pending",
        requestId: 123,
        lastQueuedAtMs: 200,
      },
    },
    {
      [EVENT_ID]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "request1",
        lastQueuedAtMs: 200,
        cleanupOwnerProfileIds: { profile1: false },
      },
    },
  ]) {
    assert.throws(
      () =>
        normalizeSnapshot({
          ...fixture(),
          eventProfileGameProjectionOutboxes,
        }),
      /invalid event profile-game projection record/,
    );
  }
  for (const outbox of [
    {
      schemaVersion: 1,
      status: "pending",
      requestId: 123,
      firstQueuedAtMs: 200,
      updatedAtMs: 210,
    },
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "request2",
      firstQueuedAtMs: 210,
      updatedAtMs: 200,
    },
  ]) {
    assert.throws(
      () =>
        normalizeSnapshot({
          ...fixture(),
          eventTelegramProjectionOutboxes: { [EVENT_ID]: outbox },
        }),
      /invalid event Telegram projection outbox record/,
    );
  }
});

test("preserves malformed Telegram dead letters with safe indexed columns", () => {
  const dead = {
    status: "dead",
    requestId: null,
    firstQueuedAtMs: "invalid",
    updatedAtMs: null,
    deadAtMs: 300,
    reason: "invalid-record",
    malformed: { retained: true },
  };
  const snapshot = normalizeSnapshot({
    ...fixture(),
    eventTelegramProjectionOutboxes: { [EVENT_ID]: dead },
  });
  assert.deepEqual(snapshot.eventTelegramProjectionOutboxes[EVENT_ID], dead);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync("cloud/workers/api/event-migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(
        resolve("cloud/workers/api/event-migrations", migration),
        "utf8",
      ),
    );
  }
  database.exec(buildImportSql(snapshot, 1_000, "stage"));
  const row = database
    .prepare(
      `SELECT request_id, status, first_queued_at_ms, updated_at_ms, record_json
       FROM event_telegram_projection_outboxes WHERE event_id = ?`,
    )
    .get(EVENT_ID) as {
    first_queued_at_ms: number;
    record_json: string;
    request_id: string;
    status: string;
    updated_at_ms: number;
  };
  assert.deepEqual(
    {
      requestId: row.request_id,
      status: row.status,
      firstQueuedAtMs: row.first_queued_at_ms,
      updatedAtMs: row.updated_at_ms,
      record: JSON.parse(row.record_json),
    },
    {
      requestId: EVENT_ID,
      status: "dead",
      firstQueuedAtMs: 300,
      updatedAtMs: 300,
      record: dead,
    },
  );
  database.close();
});

test("builds exact-replacement import SQL with encoded payloads", () => {
  const stage = buildImportSql(fixture(), 1_000, "stage");
  const final = buildImportSql(fixture(), 1_000, "final", 7);
  for (const table of [
    "event_transition_intents",
    "event_leases",
    "event_sync_throttles",
    "event_prize_selections",
    "profile_event_prizes",
    "profile_event_prize_revisions",
    "event_progress_outboxes",
    "event_profile_game_projection_outboxes",
    "event_telegram_projection_outboxes",
    "event_telegram_projection_state",
    "event_records",
  ]) {
    assert.match(stage, new RegExp(`DELETE FROM ${table}`));
  }
  assert.match(stage, /storage_mode = 'firebase'/);
  assert.match(stage, /previous_storage_mode IS NULL/);
  assert.match(final, /storage_mode = 'frozen'/);
  assert.match(final, /previous_storage_mode IS 'firebase'/);
  assert.equal((final.match(/freeze_generation = 7/g) || []).length, 2);
  assert.equal(stage.includes("sensitive"), false);
  assert.equal(stage.includes("secret text"), false);
  assert.equal(stage.includes("🌟"), false);
});

test("rejects oversized D1 statements before artifact persistence", () => {
  const snapshot = fixture();
  snapshot.events[EVENT_ID] = {
    ...snapshot.events[EVENT_ID],
    title: "x".repeat(60_000),
  };
  const state = dependencies(snapshot);
  assert.throws(
    () => migrateEvents({ phase: "preview", project: "demo" }, state.value),
    /SQL statement exceeds D1 limit/,
  );
  assert.equal(state.artifacts, 0);
  assert.equal(state.imports, 0);
});

test("generated import SQL applies to the event migration schema", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(buildImportSql(fixture(), 1_000, "stage"));
  assert.equal(
    Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM event_records")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM profile_event_prizes")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    database
      .prepare(
        "SELECT verified_import_generation FROM event_runtime_control WHERE singleton = 1",
      )
      .get()?.verified_import_generation,
    null,
  );
  database.close();
});

test("safety migration preserves existing progress rows and invalidates staged proof", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    readFileSync(
      resolve("cloud/workers/api/event-migrations/0001_event_store.sql"),
      "utf8",
    ),
  );
  const event = fixture().events[EVENT_ID];
  database
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, 'ended', 100, 200, 1, NULL, ?)`,
    )
    .run(EVENT_ID, JSON.stringify(event));
  const progress = fixture().eventProgressOutbox[PROGRESS_OUTBOX_ID];
  database
    .prepare(
      `INSERT INTO event_progress_outboxes (
         outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
         record_json
       ) VALUES (?, ?, 'pending', NULL, 110, ?)`,
    )
    .run(PROGRESS_OUTBOX_ID, EVENT_ID, JSON.stringify(progress));
  database.exec(
    `UPDATE event_runtime_control
     SET source_digest = '${"a".repeat(64)}', source_exported_at_ms = 1000
     WHERE singleton = 1`,
  );
  database.exec(
    readFileSync(
      resolve("cloud/workers/api/event-migrations/0002_event_store_safety.sql"),
      "utf8",
    ),
  );
  assert.equal(
    Number(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'pending'",
          )
          .get(PROGRESS_OUTBOX_ID) as { count: number }
      ).count,
    ),
    1,
  );
  const control = database
    .prepare(
      "SELECT freeze_generation, verified_import_generation FROM event_runtime_control WHERE singleton = 1",
    )
    .get() as {
    freeze_generation: number;
    verified_import_generation: number | null;
  };
  assert.equal(control.freeze_generation, 0);
  assert.equal(control.verified_import_generation, null);
  database.close();
});

test("staged metadata cannot activate D1 after a later freeze", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(buildImportSql(fixture(), 1_000, "stage"));
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1,
         verified_import_generation = NULL, updated_at_ms = 1_001
     WHERE singleton = 1`,
  );
  assert.throws(() =>
    database.exec(
      `UPDATE event_runtime_control
       SET storage_mode = 'd1', previous_storage_mode = NULL,
           cutover_at_ms = 1_002, updated_at_ms = 1_002
       WHERE singleton = 1`,
    ),
  );
  database.close();
});

test("activation requires complete verified import metadata", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(
    `UPDATE event_runtime_control
     SET source_digest = '${"a".repeat(64)}', source_exported_at_ms = 1000
     WHERE singleton = 1`,
  );
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1
     WHERE singleton = 1`,
  );
  database.exec(
    `UPDATE event_runtime_control
     SET verified_import_generation = 1
     WHERE singleton = 1`,
  );
  assert.throws(() =>
    database.exec(
      `UPDATE event_runtime_control
       SET storage_mode = 'd1', previous_storage_mode = NULL,
           cutover_at_ms = 1001
       WHERE singleton = 1`,
    ),
  );
  database.close();
});

test("activation cannot clear verified import metadata", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(buildImportSql(fixture(), 1_000, "stage"));
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1
     WHERE singleton = 1`,
  );
  database.exec(
    `UPDATE event_runtime_control
     SET verified_import_generation = freeze_generation
     WHERE singleton = 1`,
  );
  assert.throws(() =>
    database.exec(
      `UPDATE event_runtime_control
       SET storage_mode = 'd1', previous_storage_mode = NULL,
           source_event_count = NULL, verified_import_generation = NULL,
           cutover_at_ms = 1001
       WHERE singleton = 1`,
    ),
  );
  database.close();
});

test("generated import SQL aborts before replacement when storage mode drifts", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(buildImportSql(fixture(), 1_000, "stage"));
  database
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, 'ended', 1, 1, 1, NULL, ?)`,
    )
    .run(
      "sentinel",
      JSON.stringify({
        eventId: "sentinel",
        status: "ended",
        startAtMs: 1,
        updatedAtMs: 1,
        participants: {},
        rounds: {},
      }),
    );
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1,
         verified_import_generation = NULL
     WHERE singleton = 1`,
  );
  assert.throws(() => database.exec(buildImportSql(fixture(), 2_000, "stage")));
  assert.equal(
    Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM event_records")
          .get() as { count: number }
      ).count,
    ),
    2,
  );
  database.close();
});

test("generated final SQL rejects a later Firebase freeze generation", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1
     WHERE singleton = 1`,
  );
  const sql = buildImportSql(fixture(), 1_000, "final", 1);
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'firebase', previous_storage_mode = NULL,
         verified_import_generation = NULL
     WHERE singleton = 1`,
  );
  database.exec(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
         freeze_generation = freeze_generation + 1
     WHERE singleton = 1`,
  );
  assert.throws(() => database.exec(sql));
  assert.equal(
    Number(
      (
        database
          .prepare(
            "SELECT freeze_generation FROM event_runtime_control WHERE singleton = 1",
          )
          .get() as { freeze_generation: number }
      ).freeze_generation,
    ),
    2,
  );
  database.close();
});

test("generated import SQL rejects every write admission regardless of expiry", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = resolve("cloud/workers/api/event-migrations");
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(resolve(migrationsDirectory, migration), "utf8"),
    );
  }
  database
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES ('sentinel', 'ended', 1, 1, 1, NULL, ?)`,
    )
    .run(
      JSON.stringify({
        eventId: "sentinel",
        status: "ended",
        startAtMs: 1,
        updatedAtMs: 1,
        participants: {},
        rounds: {},
      }),
    );
  database.exec(
    `INSERT INTO event_write_admissions (
       admission_id, admitted_storage_mode, created_at_ms, expires_at_ms
     ) VALUES ('stale-admission', 'firebase', 1, 2)`,
  );
  assert.throws(() =>
    database.exec(buildImportSql(fixture(), 10_000, "stage")),
  );
  assert.equal(
    Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM event_records")
          .get() as { count: number }
      ).count,
    ),
    1,
  );
  database.close();
});

test("migration phases are explicit", () => {
  assert.deepEqual(parseArgs([]), { phase: "preview", project: "mons-link" });
  assert.deepEqual(parseArgs(["--preview", "--project", "demo"]), {
    phase: "preview",
    project: "demo",
  });
  assert.deepEqual(parseArgs(["--stage"]), {
    phase: "stage",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--final"]), {
    phase: "final",
    project: "mons-link",
  });
  assert.throws(
    () => parseArgs(["--stage", "--project", "demo"]),
    /canonical source/,
  );
  assert.throws(() => parseArgs(["--preview", "--final"]));
  assert.throws(() => parseArgs(["--delete-firebase"]));
});

test("mutating migrations reject source redirects and pin canonical RTDB", () => {
  assert.doesNotThrow(() =>
    assertMigrationSource({ phase: "stage", project: "mons-link" }, {}),
  );
  assert.throws(
    () =>
      assertMigrationSource(
        { phase: "final", project: "mons-link" },
        { FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000" },
      ),
    /source override/,
  );
  assert.throws(
    () =>
      assertMigrationSource(
        { phase: "stage", project: "mons-link" },
        { FIREBASE_REALTIME_URL: "https://example.invalid" },
      ),
    /source override/,
  );
  assert.throws(
    () =>
      assertMigrationSource(
        { phase: "stage", project: "mons-link" },
        { FIREBASE_RTDB_URL: "https://example.invalid" },
      ),
    /source override/,
  );
  assert.doesNotThrow(() =>
    assertMigrationSource(
      { phase: "preview", project: "demo" },
      { FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000" },
    ),
  );
  assert.deepEqual(firebaseDatabaseGetArgs("mons-link", "/events"), [
    "database:get",
    "/events",
    "--project",
    "mons-link",
    "--instance",
    "mons-link-default-rtdb",
  ]);
  assert.equal(
    firebaseDatabaseGetArgs("demo", "/events").includes("--instance"),
    false,
  );
});

test("stage and final imports enforce their storage and lease gates", () => {
  const clearInspection = {
    activeEventLeases: 0,
    activeProfileGameProjectionLeases: 0,
    activeTelegramProjectionLeases: 0,
    eventSyncThrottles: 1,
  };
  assert.doesNotThrow(() =>
    assertImportAllowed("stage", {
      eventControl: storageControl("firebase", null),
      eventWriteAdmissions: 0,
      expectedFreezeGeneration: null,
      inspection: clearInspection,
      profileControl: "active",
      withdrawalPendingCount: 1,
      withdrawalControl: storageControl("d1", null),
    }),
  );
  const finalInput = {
    eventControl: storageControl("frozen", "firebase"),
    eventWriteAdmissions: 0,
    expectedFreezeGeneration: 1,
    inspection: clearInspection,
    profileControl: "frozen",
    withdrawalPendingCount: 0,
    withdrawalControl: storageControl("frozen", "d1"),
  };
  assert.doesNotThrow(() => assertImportAllowed("final", finalInput));
  assert.throws(
    () =>
      assertImportAllowed("final", {
        ...finalInput,
        eventControl: storageControl("frozen", "firebase", 2),
      }),
    /freeze generation changed/,
  );
  assert.throws(
    () =>
      assertImportAllowed("final", {
        ...finalInput,
        inspection: { ...clearInspection, activeEventLeases: 1 },
      }),
    /not quiescent/,
  );
  assert.throws(
    () =>
      assertImportAllowed("final", {
        ...finalInput,
        profileControl: "active",
      }),
    /frozen profile/,
  );
});

function dependencies(
  snapshot: EventMigrationSnapshot,
  overrides: Partial<MigrationDependencies> = {},
) {
  const logs: string[] = [];
  let imports = 0;
  let artifacts = 0;
  let finalVerifications = 0;
  const inspection = {
    activeEventLeases: 0,
    activeProfileGameProjectionLeases: 0,
    activeTelegramProjectionLeases: 0,
    eventSyncThrottles: 0,
  };
  const value: MigrationDependencies = {
    eventWriteAdmissions: () => 0,
    importSql: () => {
      imports += 1;
    },
    log: (message) => logs.push(message),
    markFinalVerified: () => {
      finalVerifications += 1;
    },
    now: () => 1_000,
    persistArtifacts: () => {
      artifacts += 1;
      return "/secure/event-migration/run";
    },
    readCompletedWithdrawalPrizeIdentities: () => [],
    readEventControl: () => storageControl("firebase", null),
    readImportedSnapshot: () => snapshot,
    readProfileControl: () => "active",
    readSourceInspection: () => inspection,
    readSource: () => ({
      snapshot,
      inspection,
    }),
    readWithdrawalPendingCount: () => 0,
    readWithdrawalControl: () => storageControl("d1", null),
    ...overrides,
  };
  return {
    value,
    get artifacts() {
      return artifacts;
    },
    get imports() {
      return imports;
    },
    get finalVerifications() {
      return finalVerifications;
    },
    get logs() {
      return logs;
    },
  };
}

test("preview remains offline from D1 and stage verifies its import", () => {
  const snapshot = fixture();
  const preview = dependencies(snapshot, {
    readEventControl: () => assert.fail("preview must not read D1"),
    readImportedSnapshot: () => assert.fail("preview must not read D1"),
  });
  migrateEvents({ phase: "preview", project: "demo" }, preview.value);
  assert.equal(preview.artifacts, 1);
  assert.equal(preview.imports, 0);
  assert.equal(preview.logs.length, 1);

  const stage = dependencies(snapshot);
  migrateEvents({ phase: "stage", project: "mons-link" }, stage.value);
  assert.equal(stage.artifacts, 1);
  assert.equal(stage.imports, 1);
  assert.equal(stage.finalVerifications, 0);
  assert.equal(JSON.parse(stage.logs[1]).verified, true);
});

test("final import records verification only after the imported reread matches", () => {
  const snapshot = fixture();
  const final = dependencies(snapshot, {
    readEventControl: () => storageControl("frozen", "firebase"),
    readProfileControl: () => "frozen",
    readWithdrawalControl: () => storageControl("frozen", "d1"),
  });
  migrateEvents({ phase: "final", project: "mons-link" }, final.value);
  assert.equal(final.imports, 1);
  assert.equal(final.finalVerifications, 1);
});

test("final import rejects visible assignments for completed withdrawals", () => {
  const snapshot = fixture();
  const final = dependencies(snapshot, {
    readCompletedWithdrawalPrizeIdentities: () => [
      { eventId: EVENT_ID, prizeId: PRIZE_ID },
    ],
    readEventControl: () => storageControl("frozen", "firebase"),
    readProfileControl: () => "frozen",
    readWithdrawalControl: () => storageControl("frozen", "d1"),
  });
  assert.throws(
    () => migrateEvents({ phase: "final", project: "mons-link" }, final.value),
    /completed withdrawal assignment/,
  );
  assert.equal(final.artifacts, 0);
  assert.equal(final.imports, 0);
  assert.equal(final.finalVerifications, 0);
});

test("final import rejects pending withdrawals before reading source data", () => {
  const snapshot = fixture();
  let sourceReads = 0;
  const final = dependencies(snapshot, {
    readEventControl: () => storageControl("frozen", "firebase"),
    readProfileControl: () => "frozen",
    readSource: () => {
      sourceReads += 1;
      return {
        snapshot,
        inspection: {
          activeEventLeases: 0,
          activeProfileGameProjectionLeases: 0,
          activeTelegramProjectionLeases: 0,
          eventSyncThrottles: 0,
        },
      };
    },
    readWithdrawalControl: () => storageControl("frozen", "d1"),
    readWithdrawalPendingCount: () => 1,
  });
  assert.throws(
    () => migrateEvents({ phase: "final", project: "mons-link" }, final.value),
    /not quiescent/,
  );
  assert.equal(sourceReads, 0);
  assert.equal(final.artifacts, 0);
});

test("final import rejects return-to-Firebase and re-freeze interleaving", () => {
  const snapshot = fixture();
  let control = storageControl("frozen", "firebase", 1);
  const final = dependencies(snapshot, {
    readEventControl: () => control,
    readProfileControl: () => "frozen",
    readSource: () => {
      control = storageControl("frozen", "firebase", 2);
      return {
        snapshot,
        inspection: {
          activeEventLeases: 0,
          activeProfileGameProjectionLeases: 0,
          activeTelegramProjectionLeases: 0,
          eventSyncThrottles: 0,
        },
      };
    },
    readWithdrawalControl: () => storageControl("frozen", "d1"),
  });
  assert.throws(
    () => migrateEvents({ phase: "final", project: "mons-link" }, final.value),
    /freeze generation changed/,
  );
  assert.equal(final.imports, 0);
  assert.equal(final.finalVerifications, 0);
});

test("final import rejects every event write admission", () => {
  const snapshot = fixture();
  const final = dependencies(snapshot, {
    eventWriteAdmissions: () => 1,
    readEventControl: () => storageControl("frozen", "firebase"),
    readProfileControl: () => "frozen",
    readWithdrawalControl: () => storageControl("frozen", "d1"),
  });
  assert.throws(
    () => migrateEvents({ phase: "final", project: "mons-link" }, final.value),
    /write admissions/,
  );
  assert.equal(final.imports, 0);
  assert.equal(final.artifacts, 0);
});

test("final import rejects active leases before reading source data", () => {
  const snapshot = fixture();
  let sourceReads = 0;
  const final = dependencies(snapshot, {
    readEventControl: () => storageControl("frozen", "firebase"),
    readProfileControl: () => "frozen",
    readSource: () => {
      sourceReads += 1;
      return {
        snapshot,
        inspection: {
          activeEventLeases: 0,
          activeProfileGameProjectionLeases: 0,
          activeTelegramProjectionLeases: 0,
          eventSyncThrottles: 0,
        },
      };
    },
    readSourceInspection: () => ({
      activeEventLeases: 1,
      activeProfileGameProjectionLeases: 0,
      activeTelegramProjectionLeases: 0,
      eventSyncThrottles: 0,
    }),
    readWithdrawalControl: () => storageControl("frozen", "d1"),
  });
  assert.throws(
    () => migrateEvents({ phase: "final", project: "mons-link" }, final.value),
    /not quiescent/,
  );
  assert.equal(sourceReads, 0);
  assert.equal(final.artifacts, 0);
});

test("verification rejects stale imported rows", () => {
  const expected = fixture();
  const actual = normalizeSnapshot({
    ...expected,
    eventPrizeSelections: {},
  });
  assert.throws(
    () => verifyImportedSnapshot(expected, actual),
    /verification mismatch/,
  );
});
