import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  type EventD1Connection,
} from "../src/eventD1.ts";
import {
  createEventScheduledRecoveryStore,
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
} from "../src/eventScheduledRecoveryD1.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;

async function seedEvents(
  entries: Array<{
    eventId: string;
    startAtMs: number;
    isSundayMons?: unknown;
  }>,
) {
  for (let index = 0; index < entries.length; index += 100) {
    await db.batch(
      entries.slice(index, index + 100).map((entry) =>
        db
          .prepare(
            `INSERT INTO event_records (
               event_id, status, start_at_ms, updated_at_ms, revision, record_json
             ) VALUES (?, 'scheduled', ?, 1, 1, ?)`,
          )
          .bind(
            entry.eventId,
            entry.startAtMs,
            JSON.stringify({ ...entry, status: "scheduled" }),
          ),
      ),
    );
  }
}

async function recoveryStore() {
  const admission = await acquireEventWriteAdmission(db);
  return { admission, store: createEventScheduledRecoveryStore(db, admission) };
}

async function observedRecoveryStore() {
  const rowsRead: number[] = [];
  const observeStatement = (
    statement: D1PreparedStatement,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            observeStatement(target.bind(...values));
        }
        if (property === "all") {
          return async <T>() => {
            const result = await target.all<T>();
            rowsRead.push(result.meta.rows_read);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const observedDb: EventD1Connection = {
    batch: db.batch.bind(db),
    prepare: (sql) => observeStatement(db.prepare(sql)),
  };
  const admission = await acquireEventWriteAdmission(db);
  return {
    rowsRead,
    store: createEventScheduledRecoveryStore(observedDb, admission),
  };
}

describe("scheduled event recovery D1 cursor", () => {
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
      db.prepare(
        `UPDATE event_scheduled_recovery_cursor
         SET start_at_ms = NULL, event_id = NULL, revision = 0, updated_at_ms = 0`,
      ),
    ]);
  });

  it("bounds urgent reads and keyset pages while reaching events beyond the old limit", async () => {
    await seedEvents(
      Array.from({ length: 1_005 }, (_, index) => ({
        eventId: `event-${String(index).padStart(4, "0")}`,
        startAtMs: 100,
      })),
    );
    const { store } = await recoveryStore();
    expect(await store.readCursor()).toEqual({ cursor: null, revision: 0 });
    expect(await store.listUrgent(99)).toHaveLength(0);
    expect(await store.listUrgent(100)).toHaveLength(1_000);
    const visited: string[] = [];
    for (let pageNumber = 0; pageNumber < 11; pageNumber += 1) {
      const snapshot = await store.readCursor();
      const rows = await store.listPage(snapshot.cursor);
      expect(rows.length).toBeLessThanOrEqual(101);
      const page = rows.slice(0, 100);
      visited.push(...page.map((row) => row.cursor.eventId));
      expect(
        await store.checkpoint(
          snapshot.revision,
          rows.length > 100 ? page[99].cursor : null,
          1,
        ),
      ).toBe(true);
    }
    expect(new Set(visited).size).toBe(1_005);
    expect(visited).toHaveLength(1_005);
    expect((await store.readCursor()).cursor).toBeNull();
  });

  it("bounds rows read after deep cursors, including equal start times", async () => {
    await seedEvents(
      Array.from({ length: 2_005 }, (_, index) => ({
        eventId: `event-${String(index).padStart(4, "0")}`,
        startAtMs: index < 1_500 ? 100 : index,
      })),
    );
    const { store, rowsRead } = await observedRecoveryStore();
    for (const [cursor, firstEventId] of [
      [null, "event-0000"],
      [{ startAtMs: 100, eventId: "event-1400" }, "event-1401"],
      [{ startAtMs: 1_900, eventId: "event-1900" }, "event-1901"],
    ] as const) {
      const page = await store.listPage(cursor);
      expect(page).toHaveLength(SCHEDULED_EVENT_RECOVERY_PAGE_SIZE + 1);
      expect(page[0].cursor.eventId).toBe(firstEventId);
    }
    expect(rowsRead).toHaveLength(3);
    for (const count of rowsRead) {
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(
        4 * (SCHEDULED_EVENT_RECOVERY_PAGE_SIZE + 1),
      );
    }
  });

  it("bounds empty and sparse urgent reads despite many future events", async () => {
    await seedEvents([
      { eventId: "before-cutoff", startAtMs: 99 },
      { eventId: "at-cutoff", startAtMs: 100 },
      { eventId: "after-cutoff", startAtMs: 101 },
      ...Array.from({ length: 2_005 }, (_, index) => ({
        eventId: `future-${String(index).padStart(4, "0")}`,
        startAtMs: 1_000 + index,
      })),
    ]);
    const { store, rowsRead } = await observedRecoveryStore();
    for (const [throughMs, expectedIds] of [
      [98, []],
      [99, ["before-cutoff"]],
      [100, ["before-cutoff", "at-cutoff"]],
    ] as const) {
      const rows = await store.listUrgent(throughMs);
      expect(rows.map((row) => row.cursor.eventId)).toEqual(expectedIds);
      expect(rowsRead.at(-1)).toBeLessThanOrEqual(4 * (rows.length + 1));
    }
    expect(rowsRead).toHaveLength(3);
  });

  it("caps urgent eligibility at the largest safe integer", async () => {
    await seedEvents([
      { eventId: "before-maximum", startAtMs: Number.MAX_SAFE_INTEGER - 1 },
      { eventId: "at-maximum", startAtMs: Number.MAX_SAFE_INTEGER },
      { eventId: "beyond-maximum", startAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ]);
    const { store } = await recoveryStore();
    expect(
      (await store.listUrgent(Number.MAX_SAFE_INTEGER - 1)).map(
        (row) => row.cursor.eventId,
      ),
    ).toEqual(["before-maximum"]);
    expect(
      (await store.listUrgent(Number.MAX_SAFE_INTEGER + 100)).map(
        (row) => row.cursor.eventId,
      ),
    ).toEqual(["before-maximum", "at-maximum"]);
  });

  it("keeps a cursor usable after its event is deleted and detects rescheduling through urgency", async () => {
    await seedEvents([
      { eventId: "first", startAtMs: 100 },
      { eventId: "second", startAtMs: 200 },
      { eventId: "third", startAtMs: 300 },
    ]);
    const { store } = await recoveryStore();
    const cursor = { eventId: "second", startAtMs: 200 };
    await store.checkpoint(0, cursor, 1);
    await db.batch([
      db.prepare("DELETE FROM event_records WHERE event_id = 'second'"),
      db.prepare(
        `UPDATE event_records SET start_at_ms = 50,
         record_json = json_set(record_json, '$.startAtMs', 50)
         WHERE event_id = 'third'`,
      ),
    ]);
    expect(await store.listPage(cursor)).toEqual([]);
    expect(
      (await store.listUrgent(100)).map((row) => row.cursor.eventId),
    ).toEqual(["third", "first"]);
    await store.checkpoint(1, null, 2);
    expect(await store.listPage(null)).toHaveLength(2);
  });

  it("does not let overlapping checkpoints rewind or skip the cursor", async () => {
    const { store } = await recoveryStore();
    const other = (await recoveryStore()).store;
    const snapshots = await Promise.all([
      store.readCursor(),
      other.readCursor(),
    ]);
    const first = { eventId: "first", startAtMs: 100 };
    const later = { eventId: "later", startAtMs: 200 };
    expect(await store.checkpoint(snapshots[0].revision, first, 1)).toBe(true);
    expect(await other.checkpoint(snapshots[1].revision, later, 2)).toBe(false);
    expect(await store.readCursor()).toEqual({ cursor: first, revision: 1 });
  });

  it("leaves the cursor unchanged when the write admission expires or storage freezes", async () => {
    const { store, admission } = await recoveryStore();
    await db
      .prepare(
        `UPDATE event_write_admissions SET created_at_ms = 0, expires_at_ms = 1
         WHERE admission_id = ?`,
      )
      .bind(admission.admissionId)
      .run();
    await expect(
      store.checkpoint(0, { eventId: "first", startAtMs: 100 }, 2),
    ).rejects.toThrow();
    expect(await store.readCursor()).toEqual({ cursor: null, revision: 0 });
    await releaseEventWriteAdmission(db, admission);
    await db
      .prepare(
        `UPDATE event_runtime_control SET storage_mode = 'frozen',
         freeze_generation = freeze_generation + 1 WHERE singleton = 1`,
      )
      .run();
    await expect(
      store.checkpoint(0, { eventId: "first", startAtMs: 100 }, 3),
    ).rejects.toThrow();
    expect(await store.readCursor()).toEqual({ cursor: null, revision: 0 });
  });

  it("isolates malformed snapshots and distinguishes JSON booleans from numeric flags", async () => {
    await seedEvents([
      { eventId: "fraction", startAtMs: 1.5 },
      { eventId: "mismatch", startAtMs: 2 },
      { eventId: "numeric-flag", startAtMs: 3, isSundayMons: 1 },
      { eventId: "valid", startAtMs: 4, isSundayMons: true },
      { eventId: "bad-ordering-key", startAtMs: 5 },
    ]);
    await db
      .prepare(
        `UPDATE event_records SET record_json = json_set(record_json, '$.startAtMs', 'bad')
         WHERE event_id = 'mismatch'`,
      )
      .run();
    await db
      .prepare(
        "UPDATE event_records SET start_at_ms = 'invalid' WHERE event_id = 'bad-ordering-key'",
      )
      .run();
    const { store } = await recoveryStore();
    const rows = await store.listPage(null);
    expect(rows.map((row) => row.event?.isSundayMons ?? null)).toEqual([
      null,
      null,
      false,
      true,
    ]);
    expect(await store.checkpoint(0, rows[0].cursor, 1)).toBe(true);
    expect(await store.listPage(rows[0].cursor)).toHaveLength(3);
  });
});
