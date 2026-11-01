import { env } from "cloudflare:workers";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_PRIZE_CONFIGS } from "@mons/shared/event-prizes";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  type EventD1Connection,
} from "../src/eventD1.ts";
import {
  createEventScheduledRecoveryStore,
  SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT,
} from "../src/eventScheduledRecoveryD1.ts";
import {
  EVENT_ANNOUNCEMENT_SPECS,
  type EventAnnouncementKind,
} from "../src/eventAnnouncementKinds.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;

async function seedEvents(
  entries: Array<{
    eventId: string;
    startAtMs: number;
    isSundayMons?: boolean;
  }>,
) {
  for (let index = 0; index < entries.length; index += 100) {
    await db.batch(
      entries.slice(index, index + 100).map((entry) =>
        db
          .prepare(
            `INSERT INTO event_records_canonical (
               event_id, status, start_at_ms, updated_at_ms, revision, record_json
             ) VALUES (?, 'scheduled', ?, 1, 1, ?)`,
          )
          .bind(
            entry.eventId,
            entry.startAtMs,
            JSON.stringify(
              eventDocumentFixture({
                ...entry,
                status: "scheduled",
                isSundayMons: entry.isSundayMons === true,
              }),
            ),
          ),
      ),
    );
  }
}

async function seedAnnouncementOutboxes(
  events: Array<{ eventId: string; startAtMs: number }>,
  kind: EventAnnouncementKind,
  nextReconcileAtMs: number,
) {
  const spec = EVENT_ANNOUNCEMENT_SPECS[kind];
  const plans = await Promise.all(
    events.map(({ eventId, startAtMs }) =>
      buildEventProgressPlan(
        {
          eventId,
          sourceKey: `${kind}:${eventId}:${startAtMs}`,
          reason: spec.reason,
          runAtMs: startAtMs - spec.leadMs,
        },
        0,
      ),
    ),
  );
  for (let index = 0; index < plans.length; index += 100) {
    await db.batch(
      plans.slice(index, index + 100).map((plan) =>
        db
          .prepare(
            `INSERT INTO event_progress_outboxes_canonical (
               status, outbox_id, event_id, run_at_ms, last_queued_at_ms,
               record_json, next_reconcile_at_ms
             ) VALUES ('pending', ?, ?, ?, 0, ?, ?)`,
          )
          .bind(
            plan.outboxId,
            plan.params.eventId,
            plan.params.runAtMs,
            JSON.stringify(plan.outbox),
            nextReconcileAtMs,
          ),
      ),
    );
  }
  return plans;
}

async function recoveryStore() {
  const admission = await acquireEventWriteAdmission(db);
  return { admission, store: createEventScheduledRecoveryStore(db, admission) };
}

async function observedRecoveryStore() {
  const rowsRead: number[] = [];
  const reads: Array<{
    sql: string;
    values: unknown[];
    count: number;
    rowsRead: number;
  }> = [];
  const observeStatement = (
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[] = [],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...boundValues: unknown[]) =>
            observeStatement(target.bind(...boundValues), sql, boundValues);
        }
        if (property === "all") {
          return async <T>() => {
            const result = await target.all<T>();
            rowsRead.push(result.meta.rows_read);
            reads.push({
              sql,
              values,
              count: result.results.length,
              rowsRead: result.meta.rows_read,
            });
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const observedDb: EventD1Connection = {
    batch: db.batch.bind(db),
    prepare: (sql) => observeStatement(db.prepare(sql), sql),
  };
  const admission = await acquireEventWriteAdmission(db);
  return {
    rowsRead,
    reads,
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
      db.prepare("DELETE FROM event_records_canonical"),
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
    const urgent = await store.listUrgent(100);
    expect(urgent).toHaveLength(800);
    expect(urgent[0]!.cursor.eventId).toBe("event-0000");
    expect(urgent[799]!.cursor.eventId).toBe("event-0799");
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
          rows.length > 100 ? page[99]!.cursor : null,
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
      expect(page[0]!.cursor.eventId).toBe(firstEventId);
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
    ]);
    await expect(
      db
        .prepare(
          "UPDATE event_records_canonical SET start_at_ms = ?, record_json = json_set(record_json, '$.startAtMs', ?) WHERE event_id = 'at-maximum'",
        )
        .bind(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1)
        .run(),
    ).rejects.toThrow();
    const { store, reads } = await observedRecoveryStore();
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
    reads.length = 0;
    expect(
      (
        await store.listUrgent(
          Number.MAX_SAFE_INTEGER + 100,
          Number.MAX_SAFE_INTEGER,
        )
      ).map((row) => row.cursor.eventId),
    ).toEqual(["before-maximum", "at-maximum"]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.values.every(Number.isSafeInteger)).toBe(true);
  });

  it.each([
    { prefix: "future", startOffsetMs: 30 * 60_000 },
    { prefix: "overdue", startOffsetMs: -60_000 },
  ])(
    "discovers reminder and prize deadlines beyond a full $prefix start prefix with bounded indexed reads",
    async ({ startOffsetMs }) => {
      const nowMs = 1_000_000;
      const reminderStart = nowMs + EVENT_ANNOUNCEMENT_SPECS.reminder.leadMs;
      const prizeStart = nowMs + EVENT_ANNOUNCEMENT_SPECS.prizes.leadMs;
      const throughMs = reminderStart + SCHEDULED_EVENT_RECOVERY_MARGIN_MS;
      await seedEvents([
        ...Array.from(
          { length: SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT },
          (_, index) => ({
            eventId: `ordinary-${String(index).padStart(4, "0")}`,
            startAtMs: nowMs + startOffsetMs,
          }),
        ),
        ...Array.from({ length: 2_005 }, (_, index) => ({
          eventId: `ordinary-in-reminder-window-${index}`,
          startAtMs: reminderStart + index,
        })),
        ...Array.from({ length: 2_005 }, (_, index) => ({
          eventId: `future-sunday-${index}`,
          startAtMs: throughMs + 1 + index,
          isSundayMons: true,
        })),
        {
          eventId: "z3oj52Iiime",
          startAtMs: prizeStart + 5 * 60_000,
          isSundayMons: true,
        },
        {
          eventId: "urgent-reminder",
          startAtMs: reminderStart + 5 * 60_000,
          isSundayMons: true,
        },
      ]);
      const { store, reads } = await observedRecoveryStore();
      const rows = await store.listUrgent(throughMs, nowMs);
      expect(rows).toHaveLength(SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT);
      expect(rows.slice(0, 2).map((row) => row.cursor.eventId)).toEqual([
        "z3oj52Iiime",
        "urgent-reminder",
      ]);
      expect(reads).toHaveLength(4);
      for (const read of reads) {
        const plan = await db
          .prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
          .bind(...read.values)
          .all<{ detail: string }>();
        const details = plan.results.map(({ detail }) => detail).join("\n");
        const prizeQuery = read.sql.includes("WHERE event_id IN");
        if (prizeQuery) {
          expect(read.values).toEqual([
            JSON.stringify(Object.keys(EVENT_PRIZE_CONFIGS)),
          ]);
        }
        const reminderQuery = read.sql.includes(
          "INDEXED BY idx_event_records_canonical_scheduled_sunday_start",
        );
        expect(details).toContain(
          prizeQuery
            ? "USING PRIMARY KEY (event_id=?)"
            : reminderQuery
              ? "USING INDEX idx_event_records_canonical_scheduled_sunday_start"
              : "USING INDEX idx_event_records_canonical_status_start",
        );
        expect(details).not.toContain("TEMP B-TREE");
        expect(read.rowsRead).toBeLessThanOrEqual(
          4 *
            (prizeQuery
              ? Object.keys(EVENT_PRIZE_CONFIGS).length + 1
              : read.count + 1),
        );
      }
    },
  );

  it("finds an unattempted reminder after 800 checkpointed reminders", async () => {
    const nowMs = 1_000_000;
    const startAtMs =
      nowMs + EVENT_ANNOUNCEMENT_SPECS.reminder.leadMs + 5 * 60_000;
    const covered = Array.from(
      { length: SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT },
      (_, index) => ({
        eventId: `covered-${String(index).padStart(4, "0")}`,
        startAtMs,
        isSundayMons: true,
      }),
    );
    await seedEvents([
      ...covered,
      { eventId: "zz-missing", startAtMs, isSundayMons: true },
      ...Array.from({ length: 2_005 }, (_, index) => ({
        eventId: `future-sunday-${index}`,
        startAtMs: startAtMs + SCHEDULED_EVENT_RECOVERY_MARGIN_MS + index,
        isSundayMons: true,
      })),
    ]);
    await seedAnnouncementOutboxes(covered, "reminder", nowMs + 60_000);
    const { store, reads } = await observedRecoveryStore();
    const rows = await store.listUrgent(startAtMs, nowMs);
    expect(rows).toHaveLength(SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT);
    expect(rows[0]!.cursor.eventId).toBe("zz-missing");
    expect(
      rows.slice(1).every((row) => row.cursor.eventId.startsWith("covered-")),
    ).toBe(true);
    const missingRead = reads.find((read) =>
      read.sql.includes("AND NOT EXISTS"),
    );
    expect(missingRead).toBeDefined();
    expect(missingRead!.count).toBe(1);
    expect(missingRead!.rowsRead).toBeLessThanOrEqual(8 * (covered.length + 1));
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${missingRead!.sql}`)
      .bind(...missingRead!.values)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    expect(details).toContain(
      "USING INDEX idx_event_records_canonical_scheduled_sunday_start",
    );
    expect(details).toContain(
      "USING INDEX idx_event_progress_outboxes_canonical_event",
    );
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("keeps uncheckpointed, rescheduled, and changed announcements ahead of attempted current and legacy schedules", async () => {
    const nowMs = 1_000_000;
    const startAtMs =
      nowMs + EVENT_ANNOUNCEMENT_SPECS.reminder.leadMs + 5 * 60_000;
    const prizeStartAtMs =
      nowMs + EVENT_ANNOUNCEMENT_SPECS.prizes.leadMs + 5 * 60_000;
    const reminderEvents = [
      "covered",
      "unattempted",
      "rescheduled",
      "changed",
    ].map((eventId) => ({
      eventId,
      startAtMs,
      isSundayMons: true,
    }));
    await seedEvents([
      ...reminderEvents,
      { eventId: "z3oj52Iiime", startAtMs: prizeStartAtMs, isSundayMons: true },
      { eventId: "NN3eRzoZo80", startAtMs: prizeStartAtMs, isSundayMons: true },
    ]);
    const [covered] = await seedAnnouncementOutboxes(
      reminderEvents.slice(0, 1),
      "reminder",
      nowMs + 60_000,
    );
    await db.batch([
      db
        .prepare(
          `UPDATE event_progress_outboxes_canonical
           SET record_json = json_set(record_json, '$.runAtMs', CAST(? AS INTEGER)), run_at_ms = ?
           WHERE status = 'pending' AND outbox_id = ?`,
        )
        .bind(
          startAtMs - 10_800_000,
          startAtMs - 10_800_000,
          covered!.outboxId,
        ),
      db
        .prepare(
          `UPDATE event_progress_outboxes_canonical SET next_reconcile_at_ms = ?
           WHERE status = 'pending' AND outbox_id = ?`,
        )
        .bind(nowMs + 60_000, covered!.outboxId),
    ]);
    await seedAnnouncementOutboxes(reminderEvents.slice(1, 2), "reminder", 0);
    await seedAnnouncementOutboxes(
      [{ eventId: "rescheduled", startAtMs: startAtMs - 1 }],
      "reminder",
      nowMs + 60_000,
    );
    const [changed] = await seedAnnouncementOutboxes(
      reminderEvents.slice(3),
      "reminder",
      nowMs + 60_000,
    );
    await db
      .prepare(
        `UPDATE event_progress_outboxes_canonical
       SET record_json = json_set(record_json, '$.lastQueuedAtMs', 1), last_queued_at_ms = 1
       WHERE status = 'pending' AND outbox_id = ?`,
      )
      .bind(changed!.outboxId)
      .run();
    expect(
      await db
        .prepare(
          "SELECT next_reconcile_at_ms FROM event_progress_outboxes_canonical WHERE status = 'pending' AND outbox_id = ?",
        )
        .bind(changed!.outboxId)
        .first<number>("next_reconcile_at_ms"),
    ).toBe(0);
    await seedAnnouncementOutboxes(
      [{ eventId: "z3oj52Iiime", startAtMs }],
      "reminder",
      nowMs + 60_000,
    );
    await seedAnnouncementOutboxes(
      [{ eventId: "NN3eRzoZo80", startAtMs: prizeStartAtMs }],
      "prizes",
      nowMs + 60_000,
    );
    const { store } = await recoveryStore();
    expect(
      (await store.listUrgent(startAtMs, nowMs)).map(
        (row) => row.cursor.eventId,
      ),
    ).toEqual([
      "z3oj52Iiime",
      "changed",
      "rescheduled",
      "unattempted",
      "NN3eRzoZo80",
      "covered",
    ]);
  });

  it("prioritizes exact and upcoming announcement deadlines without expired or ineligible rows displacing them", async () => {
    const nowMs = 1_000_000;
    const reminderStart = nowMs + EVENT_ANNOUNCEMENT_SPECS.reminder.leadMs;
    const prizeStart = nowMs + EVENT_ANNOUNCEMENT_SPECS.prizes.leadMs;
    const margin = SCHEDULED_EVENT_RECOVERY_MARGIN_MS;
    await seedEvents([
      ...Array.from(
        { length: SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT },
        (_, index) => ({
          eventId: `ordinary-${String(index).padStart(4, "0")}`,
          startAtMs: nowMs + 15 * 60_000,
        }),
      ),
      {
        eventId: "reminder-at-deadline",
        startAtMs: reminderStart,
        isSundayMons: true,
      },
      { eventId: "z3oj52Iiime", startAtMs: prizeStart, isSundayMons: true },
      {
        eventId: "reminder-at-window-end",
        startAtMs: reminderStart + margin,
        isSundayMons: true,
      },
      {
        eventId: "RpPjMNyrJJa",
        startAtMs: prizeStart + margin,
        isSundayMons: true,
      },
      {
        eventId: "reminder-expired",
        startAtMs: reminderStart - 1,
        isSundayMons: true,
      },
      { eventId: "NN3eRzoZo80", startAtMs: prizeStart - 1, isSundayMons: true },
      {
        eventId: "reminder-too-far",
        startAtMs: reminderStart + margin + 1,
        isSundayMons: true,
      },
      {
        eventId: "FRkdorMWaYW",
        startAtMs: prizeStart + margin + 1,
        isSundayMons: true,
      },
      {
        eventId: "reminder-numeric-flag",
        startAtMs: reminderStart,
        isSundayMons: false,
      },
      { eventId: "VOxalSrexcA", startAtMs: prizeStart, isSundayMons: false },
      { eventId: "prize-no-config", startAtMs: prizeStart, isSundayMons: true },
      { eventId: "Q7uRdLXyVKF", startAtMs: prizeStart, isSundayMons: true },
    ]);
    await db.batch([
      db.prepare(
        `UPDATE event_records_canonical SET status = 'active',
         record_json = json_set(record_json, '$.status', 'active')
         WHERE event_id = 'Q7uRdLXyVKF'`,
      ),
    ]);
    const { store } = await recoveryStore();
    const rows = await store.listUrgent(reminderStart + margin, nowMs);
    expect(rows).toHaveLength(SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT);
    expect(rows.slice(0, 4).map((row) => row.cursor.eventId)).toEqual([
      "z3oj52Iiime",
      "reminder-at-deadline",
      "RpPjMNyrJJa",
      "reminder-at-window-end",
    ]);
    expect(
      rows.slice(4).every((row) => row.cursor.eventId.startsWith("ordinary-")),
    ).toBe(true);
  });

  it("deduplicates overlapping discovery and orders deadline ties by binary event IDs", async () => {
    const nowMs = 1_000_000;
    const reminderStart = nowMs + EVENT_ANNOUNCEMENT_SPECS.reminder.leadMs;
    await seedEvents([
      { eventId: "a", startAtMs: reminderStart, isSundayMons: true },
      { eventId: "Z", startAtMs: reminderStart, isSundayMons: true },
      { eventId: "ordinary", startAtMs: nowMs + 10_000 },
      { eventId: "later-ordinary", startAtMs: nowMs + 30 * 60_000 },
      {
        eventId: "z3oj52Iiime",
        startAtMs:
          nowMs +
          EVENT_ANNOUNCEMENT_SPECS.prizes.leadMs +
          SCHEDULED_EVENT_RECOVERY_MARGIN_MS +
          1,
        isSundayMons: true,
      },
    ]);
    const { store } = await recoveryStore();
    expect(
      (await store.listUrgent(reminderStart, nowMs)).map(
        (row) => row.cursor.eventId,
      ),
    ).toEqual(["Z", "a", "ordinary", "later-ordinary", "z3oj52Iiime"]);
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
      db.prepare(
        "DELETE FROM event_records_canonical WHERE event_id = 'second'",
      ),
      db.prepare(
        `UPDATE event_records_canonical SET start_at_ms = 50,
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

  it("rejects a mismatched admission generation without advancing the cursor", async () => {
    const { store, admission } = await recoveryStore();
    const first = { eventId: "first", startAtMs: 100 };
    const next = { eventId: "next", startAtMs: 200 };
    expect(await store.checkpoint(0, first, 1)).toBe(true);
    const mismatched = createEventScheduledRecoveryStore(db, {
      ...admission,
      freezeGeneration: admission.freezeGeneration + 1,
    });

    await expect(mismatched.checkpoint(1, next, 2)).rejects.toThrow();
    expect(await store.readCursor()).toEqual({ cursor: first, revision: 1 });
    expect(await store.checkpoint(1, next, 3)).toBe(true);
    expect(await store.readCursor()).toEqual({ cursor: next, revision: 2 });
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

  it("rejects malformed snapshots and numeric flags before recovery discovery", async () => {
    await seedEvents([
      { eventId: "ordinary", startAtMs: 3, isSundayMons: false },
      { eventId: "valid", startAtMs: 4, isSundayMons: true },
    ]);
    for (const statement of [
      "UPDATE event_records_canonical SET start_at_ms = 1.5, record_json = json_set(record_json, '$.startAtMs', 1.5) WHERE event_id = 'valid'",
      "UPDATE event_records_canonical SET record_json = json_set(record_json, '$.startAtMs', 'bad') WHERE event_id = 'valid'",
      "UPDATE event_records_canonical SET start_at_ms = 'invalid' WHERE event_id = 'valid'",
      "UPDATE event_records_canonical SET record_json = json_set(record_json, '$.isSundayMons', 1) WHERE event_id = 'valid'",
    ]) {
      await expect(db.prepare(statement).run()).rejects.toThrow();
    }
    const { store } = await recoveryStore();
    const rows = await store.listPage(null);
    expect(rows.map((row) => row.event?.isSundayMons ?? null)).toEqual([
      false,
      true,
    ]);
    expect(await store.checkpoint(0, rows[0]!.cursor, 1)).toBe(true);
    expect(await store.listPage(rows[0]!.cursor)).toHaveLength(1);
  });
});
