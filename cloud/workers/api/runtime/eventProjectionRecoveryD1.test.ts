import { claimRecoveryFixture } from "../test/eventProjectionRecoveryFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEventProjectionRecoveryStore,
  type EventProjectionRecoveryKind,
} from "../src/eventProjectionRecoveryD1.ts";
import { EventWritesDisabled, type EventD1Connection } from "../src/eventD1.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;
const families = [
  {
    kind: "profile-game",
    table: "event_profile_game_projection_outboxes",
  },
  { kind: "telegram", table: "event_telegram_projection_outboxes" },
] as const;

function outbox(kind: EventProjectionRecoveryKind, timestamp: number) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "request",
    ...(kind === "profile-game"
      ? { lastQueuedAtMs: timestamp, cleanupOwnerProfileIds: {} }
      : { firstQueuedAtMs: timestamp, updatedAtMs: timestamp }),
  };
}

async function seed(
  kind: EventProjectionRecoveryKind,
  eventId: string,
  timestamp = 100,
  recordJson = JSON.stringify(outbox(kind, timestamp)),
) {
  await db
    .prepare(
      `INSERT INTO event_records
       (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
       VALUES (?, 'active', 1, 1, 1, '{}')`,
    )
    .bind(eventId)
    .run();
  const statement =
    kind === "profile-game"
      ? db
          .prepare(
            `INSERT INTO event_profile_game_projection_outboxes
             (event_id, request_id, status, last_queued_at_ms, record_json)
             VALUES (?, 'request', 'pending', ?, ?)`,
          )
          .bind(eventId, timestamp, recordJson)
      : db
          .prepare(
            `INSERT INTO event_telegram_projection_outboxes
             (event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json)
             VALUES (?, 'request', 'pending', ?, ?, ?)`,
          )
          .bind(eventId, timestamp, timestamp, recordJson);
  await statement.run();
}

function observe() {
  const queries: string[] = [];
  const database: EventD1Connection = {
    prepare(query) {
      queries.push(query);
      return db.prepare(query);
    },
    batch: db.batch.bind(db),
    withSession: db.withSession.bind(db),
  };
  return { database, queries };
}

function admissionCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM event_write_admissions")
    .first<number>("count");
}

async function freezeWrites() {
  await db
    .prepare(
      `UPDATE event_runtime_control
       SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1`,
    )
    .run();
}

describe("event projection recovery scopes", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(db, testEnv.TEST_EVENT_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM event_write_admissions"),
      db.prepare("DELETE FROM event_records"),
      db.prepare(
        "UPDATE event_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
    ]);
  });

  describe.each(families)("$kind", ({ kind, table }) => {
    it("excludes visited identities before the page limit without changing stored snapshots", async () => {
      for (let index = 0; index < 21; index++)
        await seed(kind, `event-${String(index).padStart(2, "0")}`);
      const store = createEventProjectionRecoveryStore(db, kind);
      const first = await store.listDuePage(100, 10);
      expect(first.entries).toHaveLength(10);
      await store.withAdmission(async (writer) => {
        for (const snapshot of first.entries)
          expect(
            await claimRecoveryFixture(writer, snapshot, "request", 100, 100),
          ).toBe(true);
      });
      const second = await store.listDuePage(
        100,
        10,
        first.scannedIdentities.filter((key): key is string => key !== null),
      );
      expect(second.entries.map(({ eventId }) => eventId)).toEqual(
        Array.from({ length: 10 }, (_, index) => `event-${index + 10}`),
      );
      expect(
        second.entries.every(
          ({ recordJson }) => recordJson === JSON.stringify(outbox(kind, 100)),
        ),
      ).toBe(true);
      expect(await admissionCount()).toBe(0);
    });

    it("returns ordered due snapshots with exact stored JSON and the requested limit", async () => {
      const noncanonical = JSON.stringify(outbox(kind, 100), null, 2).replace(
        "100",
        "1e2",
      );
      await seed(kind, "event-b");
      await seed(kind, "event-a", 100, noncanonical);
      await seed(kind, "future", 200);
      await seed(kind, "dead", 50);
      await db
        .prepare(`UPDATE ${table} SET status = 'dead' WHERE event_id = 'dead'`)
        .run();
      const store = createEventProjectionRecoveryStore(db, kind);
      expect(await store.listDue(100, 1)).toEqual([
        {
          kind,
          eventId: "event-a",
          record: outbox(kind, 100),
          recordJson: noncanonical,
        },
      ]);
      expect(
        (await store.listDue(100, 10)).map(({ eventId }) => eventId),
      ).toEqual(["event-a", "event-b"]);
      expect(await admissionCount()).toBe(0);
    });

    it("shares one admission across claims and repair work until the callback settles", async () => {
      await seed(kind, "event-a");
      await seed(kind, "event-b");
      await seed(
        kind,
        "event-repair",
        500,
        JSON.stringify({ schemaVersion: 0, updatedAtMs: 100 }),
      );
      const observed = observe();
      const store = createEventProjectionRecoveryStore(observed.database, kind);
      const snapshots = await store.listDue(100, 10);
      const ready = Promise.withResolvers<void>();
      const complete = Promise.withResolvers<void>();
      const operation = store.withAdmission(async (writer) => {
        for (const snapshot of snapshots) {
          expect(
            await claimRecoveryFixture(writer, snapshot, "request", 100, 200),
          ).toBe(true);
        }
        expect(
          (
            await ("repairInvalid" in writer
              ? writer.repairInvalid("event-repair", {
                  eventId: "event-repair",
                  safeEventId: true,
                  requestId: "repair-request",
                  nowMs: 200,
                })
              : writer.markInvalid("event-repair", 200))
          ).committed,
        ).toBe(true);
        ready.resolve();
        await complete.promise;
        return snapshots.length;
      });
      await Promise.race([ready.promise, operation]);
      try {
        expect(await admissionCount()).toBe(1);
        expect(
          observed.queries.filter((sql) =>
            sql.startsWith("INSERT INTO event_write_admissions"),
          ),
        ).toHaveLength(1);
        expect(
          observed.queries.filter((sql) =>
            sql.startsWith("DELETE FROM event_write_admissions"),
          ),
        ).toHaveLength(0);
      } finally {
        complete.resolve();
      }
      expect(await operation).toBe(2);
      expect(await admissionCount()).toBe(0);
      expect(
        observed.queries.filter((sql) =>
          sql.startsWith("DELETE FROM event_write_admissions"),
        ),
      ).toHaveLength(1);
    });

    it("releases admission after a callback failure without reverting claimed outboxes", async () => {
      await seed(kind, "event");
      const store = createEventProjectionRecoveryStore(db, kind);
      const [snapshot] = await store.listDue(100, 10);
      const failure = new Error("enqueue-failed");
      await expect(
        store.withAdmission(async (writer) => {
          expect(
            await claimRecoveryFixture(writer, snapshot, "request", 100, 200),
          ).toBe(true);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await admissionCount()).toBe(0);
      expect(await store.listDue(100, 10)).toEqual([]);
      expect(await store.listDue(200, 10)).toHaveLength(1);
    });

    it("does not begin admitted work while frozen", async () => {
      await seed(kind, "event");
      await freezeWrites();
      const store = createEventProjectionRecoveryStore(db, kind);
      const snapshots = await store.listDue(100, 10);
      let started = false;
      await expect(
        store.withAdmission(async () => {
          started = true;
        }),
      ).rejects.toBeInstanceOf(EventWritesDisabled);
      expect(started).toBe(false);
      expect(await store.listDue(100, 10)).toEqual(snapshots);
      expect(await admissionCount()).toBe(0);
    });

    it("prevents freezing until the admission scope finishes", async () => {
      await seed(kind, "event-a");
      await seed(kind, "event-b");
      const store = createEventProjectionRecoveryStore(db, kind);
      const snapshots = await store.listDue(100, 10);
      await store.withAdmission(async (writer) => {
        expect(
          await claimRecoveryFixture(writer, snapshots[0], "request", 100, 200),
        ).toBe(true);
        await expect(freezeWrites()).rejects.toThrow(
          "event write admissions are active",
        );
        expect(
          await claimRecoveryFixture(writer, snapshots[1], "request", 100, 200),
        ).toBe(true);
      });
      expect(await admissionCount()).toBe(0);
      await freezeWrites();
      expect(await store.listDue(100, 10)).toEqual([]);
    });

    it("rechecks admission expiry for later claims in the scope", async () => {
      await seed(kind, "event-a");
      await seed(kind, "event-b");
      const store = createEventProjectionRecoveryStore(db, kind);
      const snapshots = await store.listDue(100, 10);
      await expect(
        store.withAdmission(async (writer) => {
          expect(
            await claimRecoveryFixture(
              writer,
              snapshots[0],
              "request",
              100,
              200,
            ),
          ).toBe(true);
          await db
            .prepare(
              "UPDATE event_write_admissions SET created_at_ms = 1, expires_at_ms = 2",
            )
            .run();
          await claimRecoveryFixture(writer, snapshots[1], "request", 100, 200);
        }),
      ).rejects.toThrow("event-write-admission-invalid");
      expect(await admissionCount()).toBe(0);
      expect(
        (await store.listDue(100, 10)).map(({ eventId }) => eventId),
      ).toEqual(["event-b"]);
    });

    it("rejects a snapshot from the other projection family", async () => {
      await seed(kind, "event");
      const store = createEventProjectionRecoveryStore(db, kind);
      const [snapshot] = await store.listDue(100, 10);
      await expect(
        store.withAdmission((writer) =>
          claimRecoveryFixture(
            writer,
            {
              ...snapshot,
              kind: kind === "profile-game" ? "telegram" : "profile-game",
            },
            "request",
            100,
            200,
          ),
        ),
      ).rejects.toThrow("event-projection-recovery-kind-mismatch");
      expect(await store.listDue(100, 10)).toEqual([snapshot]);
      expect(await admissionCount()).toBe(0);
    });
  });
});
