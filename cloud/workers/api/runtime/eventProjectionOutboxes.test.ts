import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  acknowledgeEventProfileGameProjectionOutbox,
  acknowledgeEventTelegramProjectionOutbox,
  claimEventProfileGameProjectionOutbox,
  claimEventTelegramProjectionOutbox,
  EventD1Conflict,
  EventWritesDisabled,
  releaseEventWriteAdmission,
  transactEventProfileGameProjectionOutbox,
  transactEventTelegramProjectionOutbox,
  type EventD1Connection,
} from "../src/eventD1.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;
const families = [
  {
    kind: "profile",
    table: "event_profile_game_projection_outboxes",
    claim: claimEventProfileGameProjectionOutbox,
    acknowledge: acknowledgeEventProfileGameProjectionOutbox,
    transact: transactEventProfileGameProjectionOutbox,
  },
  {
    kind: "telegram",
    table: "event_telegram_projection_outboxes",
    claim: claimEventTelegramProjectionOutbox,
    acknowledge: acknowledgeEventTelegramProjectionOutbox,
    transact: transactEventTelegramProjectionOutbox,
  },
] as const;

function outbox(kind: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "request",
    ...(kind === "profile"
      ? { lastQueuedAtMs: 100, cleanupOwnerProfileIds: { owner: true } }
      : { updatedAtMs: 100 }),
    future: { retained: [true, "value", 1e2] },
    ...extra,
  };
}

async function seed(kind: string, value = outbox(kind)) {
  const encoded = JSON.stringify(value);
  const statement =
    kind === "profile"
      ? db.prepare(
          `INSERT INTO event_profile_game_projection_outboxes
           (event_id, request_id, status, last_queued_at_ms, record_json)
           VALUES ('event', 'request', 'pending', 100, ?)`,
        )
      : db.prepare(
          `INSERT INTO event_telegram_projection_outboxes
           (event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json)
           VALUES ('event', 'request', 'pending', 100, 100, ?)`,
        );
  await statement.bind(encoded).run();
}

function observe(options: Parameters<typeof observeD1FailureDatabase>[1] = {}) {
  const observed = observeD1FailureDatabase(db, options);
  const queries: string[] = [];
  const database: EventD1Connection = {
    prepare(query) {
      queries.push(query);
      return observed.database.prepare(query);
    },
    batch: observed.database.batch.bind(observed.database),
    withSession: observed.database.withSession.bind(observed.database),
  };
  return { ...observed, database, queries };
}

describe("native event projection outbox mutations", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(db, testEnv.TEST_EVENT_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM event_write_admissions"),
      db.prepare("DELETE FROM event_leases"),
      db.prepare("DELETE FROM event_records"),
      db.prepare(
        "UPDATE event_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
      db.prepare(
        `INSERT INTO event_records
         (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
         VALUES ('event', 'active', 1, 1, 1, '{}')`,
      ),
    ]);
  });

  describe.each(families)(
    "$kind",
    ({ kind, table, claim, acknowledge, transact }) => {
      it("claims with one read and an in-place JSON update, then acknowledges", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe();
        expect(
          await claim(observed.database, "event", "request", 100, 200, {
            admission,
          }),
        ).toBe(true);
        expect(
          observed.queries.filter((sql) => /^SELECT/.test(sql)),
        ).toHaveLength(1);
        expect(observed.writeBatches).toHaveLength(1);
        expect(
          observed.queries.some((sql) => sql.includes("json_set(record_json")),
        ).toBe(true);
        expect(
          observed.queries.some((sql) =>
            sql.startsWith(`INSERT INTO ${table}`),
          ),
        ).toBe(false);
        const row = await db
          .prepare(`SELECT * FROM ${table} WHERE event_id = 'event'`)
          .first<{
            record_json: string;
            last_queued_at_ms?: number;
            updated_at_ms?: number;
            first_queued_at_ms?: number;
          }>();
        expect(JSON.parse(row!.record_json)).toEqual(
          outbox(
            kind,
            kind === "profile"
              ? { lastQueuedAtMs: 200 }
              : { firstQueuedAtMs: 100, updatedAtMs: 200 },
          ),
        );
        if (kind === "profile") expect(row!.last_queued_at_ms).toBe(200);
        else
          expect(row).toMatchObject({
            first_queued_at_ms: 100,
            updated_at_ms: 200,
          });
        expect(await acknowledge(db, "event", "request", { admission })).toBe(
          true,
        );
        expect(await acknowledge(db, "event", "request", { admission })).toBe(
          false,
        );
      });

      it.each([undefined, null, 50])(
        "remains compatible with legacy callbacks after a claim with firstQueuedAtMs=%s",
        async (firstQueuedAtMs) => {
          await seed(
            kind,
            outbox(
              kind,
              firstQueuedAtMs === undefined ? {} : { firstQueuedAtMs },
            ),
          );
          const admission = await acquireEventWriteAdmission(db);
          expect(
            await claim(db, "event", "request", 100, 1_900_000_000_001, {
              admission,
            }),
          ).toBe(true);
          const result = await transact(
            db,
            "event",
            (current) => ({ value: { ...current, roundTrip: true } }),
            { admission },
          );
          expect(result.committed).toBe(true);
          expect(result.value?.roundTrip).toBe(true);
        },
      );

      it("normalizes noncanonical JSON only when needed for legacy callback compatibility", async () => {
        const original = outbox(kind);
        await seed(kind, original);
        await db
          .prepare(`UPDATE ${table} SET record_json = ?`)
          .bind(JSON.stringify(original, null, 2).replace("100", "1e2"))
          .run();
        const admission = await acquireEventWriteAdmission(db);
        expect(
          await claim(db, "event", "request", 100, 200, { admission }),
        ).toBe(true);
        expect(
          (
            await transact(
              db,
              "event",
              (current) => ({ value: { ...current, roundTrip: true } }),
              { admission },
            )
          ).committed,
        ).toBe(true);
      });

      it("does not run write guards or validate proposed times for stale and malformed rows", async () => {
        await seed(
          kind,
          outbox(
            kind,
            kind === "profile"
              ? { cleanupOwnerProfileIds: { owner: false } }
              : { firstQueuedAtMs: -1 },
          ),
        );
        const admission = await acquireEventWriteAdmission(db);
        await releaseEventWriteAdmission(db, admission);
        const observed = observe();
        expect(
          await claim(observed.database, "event", "request", 100, NaN, {
            admission,
          }),
        ).toBe(false);
        expect(
          await acknowledge(observed.database, "event", "request", {
            admission,
          }),
        ).toBe(false);
        await db
          .prepare(`UPDATE ${table} SET record_json = ?`)
          .bind(JSON.stringify(outbox(kind)))
          .run();
        expect(
          await claim(observed.database, "event", "other", 100, NaN, {
            admission,
          }),
        ).toBe(false);
        expect(
          await claim(observed.database, "event", "request", 99, 200, {
            admission,
          }),
        ).toBe(false);
        expect(
          await claim(observed.database, "event", "request", 100, 99, {
            admission,
          }),
        ).toBe(false);
        await db.prepare(`UPDATE ${table} SET status = 'dead'`).run();
        expect(
          await acknowledge(observed.database, "event", "request", {
            admission,
          }),
        ).toBe(false);
        expect(observed.writeBatches).toHaveLength(0);
      });

      it("rejects invalid claim timestamps only after a matching parsed row", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe();
        await expect(
          claim(observed.database, "event", "request", 100, 200.5, {
            admission,
          }),
        ).rejects.toThrow("invalid-event-integer");
        expect(observed.writeBatches).toHaveLength(0);
      });

      it("retries unrelated payload changes and preserves their data", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe({
          async beforeWriteBatch(attempt) {
            if (attempt === 1)
              await db
                .prepare(
                  `UPDATE ${table} SET record_json = json_set(record_json, '$.concurrent', 1)`,
                )
                .run();
          },
        });
        expect(
          await claim(observed.database, "event", "request", 100, 200, {
            admission,
          }),
        ).toBe(true);
        expect(observed.writeBatches).toHaveLength(2);
        const row = await db
          .prepare(`SELECT record_json FROM ${table}`)
          .first<{ record_json: string }>();
        expect(JSON.parse(row!.record_json).concurrent).toBe(1);
      });

      it("does not claim a replaced request after a race", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe({
          async beforeWriteBatch(attempt) {
            if (attempt === 1)
              await db
                .prepare(
                  `UPDATE ${table} SET request_id = 'new', record_json = json_set(record_json, '$.requestId', 'new')`,
                )
                .run();
          },
        });
        expect(
          await claim(observed.database, "event", "request", 100, 200, {
            admission,
          }),
        ).toBe(false);
        expect(observed.writeBatches).toHaveLength(1);
        expect(await acknowledge(db, "event", "request", { admission })).toBe(
          false,
        );
      });

      it("acknowledges the same request after a concurrent timestamp refresh", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe({
          async beforeWriteBatch(attempt) {
            if (attempt === 1)
              expect(
                await claim(db, "event", "request", 100, 200, { admission }),
              ).toBe(true);
          },
        });
        expect(
          await acknowledge(observed.database, "event", "request", {
            admission,
          }),
        ).toBe(true);
        expect(observed.writeBatches).toHaveLength(2);
      });

      it("retains the twelve-attempt contention limit", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const observed = observe({
          async beforeWriteBatch(attempt) {
            await db
              .prepare(
                `UPDATE ${table} SET record_json = json_set(record_json, '$.racing', ?)`,
              )
              .bind(attempt)
              .run();
          },
        });
        await expect(
          claim(observed.database, "event", "request", 100, 200, { admission }),
        ).rejects.toBeInstanceOf(EventD1Conflict);
        expect(observed.writeBatches).toHaveLength(12);
      });

      it("maps invalid admission, lease, and frozen guards without changing data", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        await expect(
          claim(db, "event", "request", 100, 200, {
            admission,
            eventLease: {
              eventId: "event",
              lockId: "missing",
              ownerUid: "owner",
            },
          }),
        ).rejects.toThrow("event-lease-lost");
        await releaseEventWriteAdmission(db, admission);
        await expect(
          acknowledge(db, "event", "request", { admission }),
        ).rejects.toThrow("event-write-admission-invalid");
        await db
          .prepare(
            "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1",
          )
          .run();
        await expect(
          claim(db, "event", "request", 100, 200, { admission }),
        ).rejects.toBeInstanceOf(EventWritesDisabled);
        expect(
          await db
            .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
            .first("count"),
        ).toBe(1);
      });

      it("honors cancellation after the validation read", async () => {
        await seed(kind);
        const admission = await acquireEventWriteAdmission(db);
        const controller = new AbortController();
        const reason = new Error("aborted");
        const observed = observe({
          afterRead: async () => {
            controller.abort(reason);
          },
        });
        await expect(
          acknowledge(observed.database, "event", "request", {
            admission,
            signal: controller.signal,
          }),
        ).rejects.toBe(reason);
        expect(observed.writeBatches).toHaveLength(0);
      });
    },
  );
});
