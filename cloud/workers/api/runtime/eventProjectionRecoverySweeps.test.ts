import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventWritesDisabled, type EventD1Connection } from "../src/eventD1.ts";
import {
  createEventProjectionRecoveryStore,
  type EventProjectionRecoveryKind,
  type EventProjectionRecoveryStore,
} from "../src/eventProjectionRecoveryD1.ts";
import { sweepEventTelegramProjections } from "../src/eventTelegramProjection.ts";
import { sweepEventProfileGameProjections } from "../src/profileGameProjection/recovery.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;
const nowMs = 1_000_000;
const initialTimestamp = 100;
const families = [
  {
    kind: "profile-game",
    table: "event_profile_game_projection_outboxes",
    timestampColumn: "last_queued_at_ms",
    limit: 20,
    pageSize: 10,
  },
  {
    kind: "telegram",
    table: "event_telegram_projection_outboxes",
    timestampColumn: "updated_at_ms",
    limit: 100,
    pageSize: 100,
  },
] as const;

async function seed(
  kind: EventProjectionRecoveryKind,
  eventIds: readonly string[],
) {
  const statements = eventIds.flatMap((eventId) => {
    const requestId = `request-${eventId}`;
    const recordJson = JSON.stringify({
      schemaVersion: 1,
      status: "pending",
      requestId,
      ...(kind === "profile-game"
        ? { lastQueuedAtMs: initialTimestamp, cleanupOwnerProfileIds: {} }
        : { firstQueuedAtMs: initialTimestamp, updatedAtMs: initialTimestamp }),
    });
    return [
      db
        .prepare(
          `INSERT INTO event_records
         (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
         VALUES (?, 'active', 1, 1, 1, '{}')`,
        )
        .bind(eventId),
      kind === "profile-game"
        ? db
            .prepare(
              `INSERT INTO event_profile_game_projection_outboxes
             (event_id, request_id, status, last_queued_at_ms, record_json)
             VALUES (?, ?, 'pending', ?, ?)`,
            )
            .bind(eventId, requestId, initialTimestamp, recordJson)
        : db
            .prepare(
              `INSERT INTO event_telegram_projection_outboxes
             (event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json)
             VALUES (?, ?, 'pending', ?, ?, ?)`,
            )
            .bind(
              eventId,
              requestId,
              initialTimestamp,
              initialTimestamp,
              recordJson,
            ),
    ];
  });
  for (let index = 0; index < statements.length; index += 100) {
    await db.batch(statements.slice(index, index + 100));
  }
}

function observeSweep(
  kind: EventProjectionRecoveryKind,
  options: {
    beforeBatch?: (attempt: number) => Promise<void>;
    onSend?: () => Promise<void>;
  } = {},
) {
  const queries: string[] = [];
  const taskBatches: unknown[][] = [];
  let batchCount = 0;
  const database: EventD1Connection = {
    prepare(query) {
      queries.push(query);
      return db.prepare(query);
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      await options.beforeBatch?.(++batchCount);
      return db.batch<T>(statements);
    },
    withSession: db.withSession.bind(db),
  };
  const recovery = createEventProjectionRecoveryStore(database, kind);
  const queue: Queue = {
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    send: async () => {
      throw new Error("unexpected-individual-projection-send");
    },
    async sendBatch(messages) {
      taskBatches.push(Array.from(messages, ({ body }) => body));
      await options.onSend?.();
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  const logger = { error: () => undefined, info: () => undefined };
  return {
    queries,
    taskBatches,
    run: () =>
      kind === "profile-game"
        ? sweepEventProfileGameProjections(
            { ...testEnv, EVENT_PROFILE_GAME_PROJECTION_QUEUE: queue },
            {
              createEventRecovery: () =>
                recovery as EventProjectionRecoveryStore<"profile-game">,
              now: () => nowMs,
              logger,
            },
          )
        : sweepEventTelegramProjections(
            queue,
            recovery as EventProjectionRecoveryStore<"telegram">,
            nowMs,
            logger,
          ),
  };
}

function expectedTasks(
  kind: EventProjectionRecoveryKind,
  eventIds: readonly string[],
) {
  return eventIds.map((eventId) => ({
    kind:
      kind === "profile-game"
        ? "event-profile-game-projection"
        : "event-telegram-projection",
    eventId,
    requestId: `request-${eventId}`,
  }));
}

function admissionCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM event_write_admissions")
    .first<number>("count");
}

function expectAdmissionQueries(
  queries: readonly string[],
  acquired: number,
  released: number,
) {
  expect(
    queries.filter((query) =>
      query.startsWith("INSERT INTO event_write_admissions"),
    ),
  ).toHaveLength(acquired);
  expect(
    queries.filter((query) =>
      query.startsWith("DELETE FROM event_write_admissions"),
    ),
  ).toHaveLength(released);
}

async function freezeWrites() {
  await db
    .prepare(
      "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1",
    )
    .run();
}

describe("event projection recovery sweep admissions", () => {
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

  describe.each(families)(
    "$kind",
    ({ kind, table, timestampColumn, limit, pageSize }) => {
      const readRows = async () =>
        (
          await db
            .prepare(
              `SELECT event_id, request_id, status, ${timestampColumn} AS timestamp, record_json
       FROM ${table} ORDER BY event_id`,
            )
            .all<{
              event_id: string;
              request_id: string;
              status: string;
              timestamp: number;
              record_json: string;
            }>()
        ).results;

      it("skips admission and queue work for an empty scan even while frozen", async () => {
        await freezeWrites();
        const observed = observeSweep(kind);
        expect(await observed.run()).toBe(0);
        expectAdmissionQueries(observed.queries, 0, 0);
        expect(await admissionCount()).toBe(0);
        expect(observed.taskBatches).toEqual([]);
      });

      it("claims multiple outboxes under one admission and dispatches before release", async () => {
        const eventIds = ["event-a", "event-b", "event-c"];
        await seed(kind, eventIds);
        const observed = observeSweep(kind, {
          async onSend() {
            expect(await admissionCount()).toBe(1);
            expectAdmissionQueries(observed.queries, 1, 0);
          },
        });
        expect(await observed.run()).toBe(3);
        expect(observed.taskBatches).toEqual([expectedTasks(kind, eventIds)]);
        expectAdmissionQueries(observed.queries, 1, 1);
        expect(await admissionCount()).toBe(0);
        expect((await readRows()).map(({ timestamp }) => timestamp)).toEqual([
          nowMs,
          nowMs,
          nowMs,
        ]);
      });

      it("retains admission until a pending queue send settles and prevents an intervening freeze", async () => {
        await seed(kind, ["event"]);
        const sending = Promise.withResolvers<void>();
        const complete = Promise.withResolvers<void>();
        const observed = observeSweep(kind, {
          async onSend() {
            sending.resolve();
            await complete.promise;
          },
        });
        const operation = observed.run();
        await Promise.race([sending.promise, operation]);
        try {
          expect(observed.taskBatches).toEqual([
            expectedTasks(kind, ["event"]),
          ]);
          expect(await admissionCount()).toBe(1);
          expectAdmissionQueries(observed.queries, 1, 0);
          await expect(freezeWrites()).rejects.toThrow(
            "event write admissions are active",
          );
        } finally {
          complete.resolve();
        }
        expect(await operation).toBe(1);
        expect(await admissionCount()).toBe(0);
        expectAdmissionQueries(observed.queries, 1, 1);
        await freezeWrites();
        expect(
          await db
            .prepare("SELECT storage_mode FROM event_runtime_control")
            .first("storage_mode"),
        ).toBe("frozen");
      });

      it("releases admission after queue failure and retains the claimed records", async () => {
        await seed(kind, ["event-a", "event-b"]);
        const failure = new Error("projection-queue-unavailable");
        const observed = observeSweep(kind, {
          async onSend() {
            expect(await admissionCount()).toBe(1);
            throw failure;
          },
        });
        await expect(observed.run()).rejects.toBe(failure);
        expectAdmissionQueries(observed.queries, 1, 1);
        expect(await admissionCount()).toBe(0);
        expect(observed.taskBatches).toEqual([
          expectedTasks(kind, ["event-a", "event-b"]),
        ]);
        expect(
          (await readRows()).map(
            ({ event_id, request_id, status, timestamp }) => ({
              event_id,
              request_id,
              status,
              timestamp,
            }),
          ),
        ).toEqual([
          {
            event_id: "event-a",
            request_id: "request-event-a",
            status: "pending",
            timestamp: nowMs,
          },
          {
            event_id: "event-b",
            request_id: "request-event-b",
            status: "pending",
            timestamp: nowMs,
          },
        ]);
      });

      it("leaves due records unchanged when frozen before admission", async () => {
        await seed(kind, ["event"]);
        const original = await readRows();
        await freezeWrites();
        const observed = observeSweep(kind);
        await expect(observed.run()).rejects.toBeInstanceOf(
          EventWritesDisabled,
        );
        expectAdmissionQueries(observed.queries, 1, 0);
        expect(await admissionCount()).toBe(0);
        expect(observed.taskBatches).toEqual([]);
        expect(await readRows()).toEqual(original);
      });

      it("dispatches earlier claims when the admission expires before a later claim", async () => {
        await seed(kind, ["event-a", "event-b"]);
        const observed = observeSweep(kind, {
          async beforeBatch(attempt) {
            if (attempt === 2) {
              await db
                .prepare(
                  "UPDATE event_write_admissions SET created_at_ms = 1, expires_at_ms = 2",
                )
                .run();
            }
          },
          async onSend() {
            expect(await admissionCount()).toBe(1);
          },
        });
        await expect(observed.run()).rejects.toThrow(
          "event-write-admission-invalid",
        );
        expect(observed.taskBatches).toEqual([
          expectedTasks(kind, ["event-a"]),
        ]);
        expectAdmissionQueries(observed.queries, 1, 1);
        expect(await admissionCount()).toBe(0);
        expect(
          (await readRows()).map(({ event_id, timestamp }) => [
            event_id,
            timestamp,
          ]),
        ).toEqual([
          ["event-a", nowMs],
          ["event-b", initialTimestamp],
        ]);
      });

      it(`claims at most ${limit} due records per sweep`, async () => {
        const eventIds = Array.from(
          { length: limit + 1 },
          (_, index) => `event-${String(index).padStart(3, "0")}`,
        );
        await seed(kind, eventIds);
        const observed = observeSweep(kind);
        expect(await observed.run()).toBe(limit);
        const pageCount = limit / pageSize;
        expect(observed.taskBatches).toEqual(
          Array.from({ length: pageCount }, (_, index) =>
            expectedTasks(
              kind,
              eventIds.slice(index * pageSize, (index + 1) * pageSize),
            ),
          ),
        );
        expectAdmissionQueries(observed.queries, pageCount, pageCount);
        expect(await admissionCount()).toBe(0);
        const rows = await readRows();
        expect(
          rows.filter(({ timestamp }) => timestamp === nowMs),
        ).toHaveLength(limit);
        expect(
          rows
            .filter(({ timestamp }) => timestamp === initialTimestamp)
            .map(({ event_id }) => event_id),
        ).toEqual([eventIds[limit]]);
      });
    },
  );
});
