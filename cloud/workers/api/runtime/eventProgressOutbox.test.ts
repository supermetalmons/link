import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  EventD1Conflict,
  EventWritesDisabled,
  listDueEventProgressOutboxes,
  readEvent,
  releaseEventWriteAdmission,
  type EventD1Connection,
} from "../src/eventD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { createEventProgressOutboxWriter } from "../src/eventRepository.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "outbox-event";

async function admissionCount(): Promise<number | null> {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

function observeCommitResults() {
  const batches: D1Result<unknown>[][] = [];
  const writes = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const observeWrite = (
    statement: D1PreparedStatement,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => observeWrite(target.bind(...values));
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    writes.set(wrapped, statement);
    return wrapped;
  };
  const db: EventD1Connection = {
    prepare: (query) => {
      const statement = testEnv.EVENT_DB.prepare(query);
      return /^\s*INSERT INTO event_progress_outboxes\b/.test(query)
        ? observeWrite(statement)
        : statement;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      const results = await testEnv.EVENT_DB.batch<T>(
        statements.map((statement) => writes.get(statement) ?? statement),
      );
      if (statements.some((statement) => writes.has(statement)))
        batches.push(results);
      return results;
    },
  };
  return { db, batches };
}

describe("event progress outbox writer", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
      testEnv.EVENT_DB.prepare(
        "UPDATE event_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
    ]);
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      await commitEventMutations(
        testEnv.EVENT_DB,
        [
          {
            kind: "event",
            eventId,
            value: {
              schemaVersion: 2,
              eventId,
              status: "active",
              createdAtMs: 100,
              updatedAtMs: 100,
              startAtMs: 100,
              createdByProfileId: "profile-one",
              createdByLoginUid: "login-one",
              createdByUsername: "ivan",
              participants: {},
              rounds: {},
            },
          },
        ],
        { admission },
      );
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });

  it.each([
    ["match-rating-updated", 300],
    ["event-prize-announcement", 100],
    ["sunday-mons-reminder", 100],
  ] as const)(
    "preserves repeated %s write semantics",
    async (reason, firstQueuedAtMs) => {
      const writer = createEventProgressOutboxWriter(testEnv.EVENT_DB);
      const input = {
        eventId,
        sourceKey: "outbox-source",
        reason,
      };
      const first = await buildEventProgressPlan(input, 100);
      const replacement = await buildEventProgressPlan(input, 300);

      await writer.putEventProgressOutbox(first.outboxId, first.outbox);
      await writer.putEventProgressOutbox(
        replacement.outboxId,
        replacement.outbox,
      );
      await writer.putEventProgressOutbox(
        replacement.outboxId,
        replacement.outbox,
      );

      expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual(
        [
          {
            outboxId: first.outboxId,
            record: { ...replacement.outbox, firstQueuedAtMs },
          },
        ],
      );
      expect(await admissionCount()).toBe(0);
    },
  );

  it.each([
    "event-prize-announcement",
    "sunday-mons-reminder",
    "match-rating-updated",
  ])("does not rewrite identical %s rows", async (reason) => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      { eventId, sourceKey: "unchanged", reason },
      100,
    );
    const observed = observeCommitResults();
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      for (const value of [
        outbox,
        outbox,
        { ...outbox, runAtMs: 1_000 },
        { ...outbox, runAtMs: 1_000 },
        outbox,
        { ...outbox, lastQueuedAtMs: 300 },
        { ...outbox, lastQueuedAtMs: 300, reason: "changed-reason" },
      ]) {
        await commitEventMutations(
          observed.db,
          [{ kind: "progress-outbox", outboxId, value }],
          { admission },
        );
      }
      expect(
        observed.batches.map((batch) => batch.at(-1)!.meta.changes),
      ).toEqual([1, 0, 1, 0, 1, 1, 1]);
      for (const index of [1, 3]) {
        expect(observed.batches[index]).toHaveLength(3);
        expect(observed.batches[index].at(-1)!.meta.rows_written).toBe(0);
      }
      expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual(
        [
          {
            outboxId,
            record: {
              ...outbox,
              lastQueuedAtMs: 300,
              reason: "changed-reason",
            },
          },
        ],
      );
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });

  it.each([
    ["event_id", "other-event"],
    ["run_at_ms", 500],
    ["last_queued_at_ms", 500],
  ] as const)(
    "repairs %s even when the JSON is unchanged",
    async (column, value) => {
      const { outboxId, outbox } = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "indexed-columns",
          reason: "sunday-mons-reminder",
        },
        100,
      );
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      try {
        await commitEventMutations(
          testEnv.EVENT_DB,
          [
            {
              kind: "event",
              eventId: "other-event",
              value: {
                ...(await readEvent(testEnv.EVENT_DB, eventId)),
                eventId: "other-event",
              },
            },
            { kind: "progress-outbox", outboxId, value: outbox },
          ],
          { admission },
        );
        await testEnv.EVENT_DB.prepare(
          `UPDATE event_progress_outboxes SET ${column} = ? WHERE outbox_id = ? AND status = 'pending'`,
        )
          .bind(value, outboxId)
          .run();
        const observed = observeCommitResults();
        await commitEventMutations(
          observed.db,
          [{ kind: "progress-outbox", outboxId, value: outbox }],
          { admission },
        );
        expect(observed.batches[0].at(-1)!.meta.changes).toBe(1);
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT event_id, run_at_ms, last_queued_at_ms, record_json FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'pending'",
          )
            .bind(outboxId)
            .first(),
        ).toEqual({
          event_id: eventId,
          run_at_ms: null,
          last_queued_at_ms: 100,
          record_json: JSON.stringify(outbox),
        });
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
    },
  );

  it("rejects an identical write using a released admission", async () => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "released-admission",
        reason: "sunday-mons-reminder",
      },
      100,
    );
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    const changes = [
      { kind: "progress-outbox" as const, outboxId, value: outbox },
    ];
    try {
      await commitEventMutations(testEnv.EVENT_DB, changes, { admission });
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
    await expect(
      commitEventMutations(testEnv.EVENT_DB, changes, { admission }),
    ).rejects.toThrow("event-write-admission-invalid");
    expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual([
      { outboxId, record: outbox },
    ]);
  });

  it("rejects an unchanged snapshot after a concurrent replacement", async () => {
    const { outboxId, outbox } = await buildEventProgressPlan(
      { eventId, sourceKey: "unchanged-race", reason: "sunday-mons-reminder" },
      100,
    );
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    const changes = [
      { kind: "progress-outbox" as const, outboxId, value: outbox },
    ];
    try {
      await commitEventMutations(testEnv.EVENT_DB, changes, { admission });
      const concurrent = { ...outbox, lastQueuedAtMs: 300 };
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        beforeWriteBatch: async () => {
          await testEnv.EVENT_DB.prepare(
            "UPDATE event_progress_outboxes SET last_queued_at_ms = 300, record_json = ? WHERE outbox_id = ? AND status = 'pending'",
          )
            .bind(JSON.stringify(concurrent), outboxId)
            .run();
        },
      });
      await expect(
        commitEventMutations(observed.database, changes, {
          admission,
          expectedRecords: { progress: { [outboxId]: outbox } },
        }),
      ).rejects.toBeInstanceOf(EventD1Conflict);
      expect(observed.writeBatches).toHaveLength(1);
      expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual(
        [{ outboxId, record: concurrent }],
      );
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });

  it("rejects frozen writes without creating an outbox or admission", async () => {
    const writer = createEventProgressOutboxWriter(testEnv.EVENT_DB);
    const plan = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "rating:invite:match",
        reason: "match-rating-updated",
      },
      100,
    );
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 200,
    });

    await expect(
      writer.putEventProgressOutbox(plan.outboxId, plan.outbox),
    ).rejects.toBeInstanceOf(EventWritesDisabled);
    expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual(
      [],
    );
    expect(await admissionCount()).toBe(0);
  });

  it("releases admission after a failed outbox commit", async () => {
    const writer = createEventProgressOutboxWriter(testEnv.EVENT_DB);
    const plan = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "rating:invite:match",
        reason: "match-rating-updated",
      },
      100,
    );
    await testEnv.EVENT_DB.prepare(
      `CREATE TRIGGER event_progress_outbox_write_failure
       BEFORE INSERT ON event_progress_outboxes
       BEGIN
         SELECT RAISE(ABORT, 'outbox-write-failed');
       END`,
    ).run();

    try {
      await expect(
        writer.putEventProgressOutbox(plan.outboxId, plan.outbox),
      ).rejects.toMatchObject({
        message: "event-d1-integrity",
        cause: expect.objectContaining({
          message: expect.stringContaining("outbox-write-failed"),
        }),
      });
      expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 400)).toEqual(
        [],
      );
      expect(await admissionCount()).toBe(0);
    } finally {
      await testEnv.EVENT_DB.prepare(
        "DROP TRIGGER event_progress_outbox_write_failure",
      ).run();
    }
  });
});
