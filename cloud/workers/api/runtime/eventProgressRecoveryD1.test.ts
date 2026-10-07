import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  listDueEventProgressOutboxes,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import {
  createEventProgressRecoveryStore,
  type EventProgressRecoveryStore,
} from "../src/eventProgressRecoveryD1.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "recovery-deadline-event";

async function seedEvent(id = eventId) {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await commitEventMutations(
      testEnv.EVENT_DB,
      [
        {
          kind: "event",
          eventId: id,
          value: {
            schemaVersion: 2,
            eventId: id,
            status: "scheduled",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 20_000_000,
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
}

async function seedOutbox(sourceKey = "scheduled:first", queuedAtMs = 100) {
  const plan = await buildEventProgressPlan(
    {
      eventId,
      reason: "scheduled-start-reconciliation",
      sourceKey,
      runAtMs: 20_000_000,
    },
    queuedAtMs,
  );
  await testEnv.EVENT_DB.prepare(
    `INSERT INTO event_progress_outboxes (
       status, outbox_id, event_id, run_at_ms, last_queued_at_ms, record_json
     ) VALUES ('pending', ?, ?, ?, ?, ?)`,
  )
    .bind(
      plan.outboxId,
      eventId,
      plan.outbox.runAtMs,
      plan.outbox.lastQueuedAtMs,
      JSON.stringify(plan.outbox),
    )
    .run();
  return plan;
}

async function withStore(
  work: (store: EventProgressRecoveryStore) => Promise<void>,
) {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await work(createEventProgressRecoveryStore(testEnv.EVENT_DB, admission));
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
}

describe("event progress recovery checkpoints", () => {
  let legacyBefore: Record<string, unknown> | null;
  let legacyAfter: Record<string, unknown> | null;

  beforeAll(async () => {
    const migrationIndex = testEnv.TEST_EVENT_D1_MIGRATIONS.findIndex((entry) =>
      entry.name.startsWith("0006_"),
    );
    expect(migrationIndex).toBeGreaterThan(0);
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS.slice(0, migrationIndex),
    );
    await seedEvent();
    const plan = await seedOutbox();
    legacyBefore = await testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes WHERE outbox_id = ?",
    )
      .bind(plan.outboxId)
      .first();
    await applyD1Migrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS.slice(migrationIndex),
    );
    legacyAfter = await testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes WHERE outbox_id = ?",
    )
      .bind(plan.outboxId)
      .first();
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
    await seedEvent();
  });

  it("adds an immediately eligible checkpoint without rewriting historical payloads", () => {
    expect(legacyAfter).toEqual({ ...legacyBefore, next_reconcile_at_ms: 0 });
  });

  it("keeps metadata separate from JSON, queued time, and old readers", async () => {
    const plan = await seedOutbox();
    await withStore(async (store) => {
      const original = await store.read(plan.outboxId);
      expect(original?.nextReconcileAtMs).toBe(0);
      expect(await store.listDue(100, 10)).toEqual([original]);
      expect(await store.checkpoint(original!, 3_600_000)).toBe(true);
      expect(await store.listDue(3_599_999, 10)).toEqual([]);
      expect(await store.listDue(3_600_000, 10)).toEqual([
        { ...original, nextReconcileAtMs: 3_600_000 },
      ]);
      expect(await listDueEventProgressOutboxes(testEnv.EVENT_DB, 100)).toEqual(
        [{ outboxId: plan.outboxId, record: plan.outbox }],
      );
      expect(
        await testEnv.EVENT_DB.prepare(
          "SELECT record_json, last_queued_at_ms FROM event_progress_outboxes WHERE outbox_id = ?",
        )
          .bind(plan.outboxId)
          .first(),
      ).toEqual({
        record_json: original!.recordJson,
        last_queued_at_ms: 100,
      });
    });
  });

  it("uses the due index and preserves bounded timestamp ordering", async () => {
    const first = await seedOutbox("first", 200);
    const second = await seedOutbox("second", 100);
    const third = await seedOutbox("third", 300);
    await withStore(async (store) => {
      expect((await store.listDue(0, 1)).map((row) => row.outboxId)).toEqual([
        second.outboxId,
      ]);
      await store.checkpoint((await store.read(second.outboxId))!, 100);
      await store.checkpoint((await store.read(first.outboxId))!, 500);
      expect((await store.listDue(100, 10)).map((row) => row.outboxId)).toEqual(
        [third.outboxId, second.outboxId],
      );
      const explained = await testEnv.EVENT_DB.prepare(
        `EXPLAIN QUERY PLAN SELECT outbox_id, record_json, next_reconcile_at_ms
         FROM event_progress_outboxes
         WHERE status = 'pending' AND next_reconcile_at_ms <= ?
         ORDER BY next_reconcile_at_ms, last_queued_at_ms, outbox_id LIMIT ?`,
      )
        .bind(100, 10)
        .all<{ detail: string }>();
      const details = explained.results.map((row) => row.detail).join("\n");
      expect(details).toContain("idx_event_progress_outboxes_reconcile");
      expect(details).not.toContain("TEMP B-TREE");
    });
  });

  it("allows concurrent shortening but rejects stale extension", async () => {
    const plan = await seedOutbox();
    await withStore(async (store) => {
      const observed = (await store.read(plan.outboxId))!;
      expect(await store.checkpoint(observed, 3_600_000)).toBe(true);
      expect(await store.checkpoint(observed, 300_000)).toBe(true);
      expect(await store.checkpoint(observed, 3_600_000)).toBe(false);
      const fresh = (await store.read(plan.outboxId))!;
      expect(fresh.nextReconcileAtMs).toBe(300_000);
      expect(await store.checkpoint(fresh, 3_900_000)).toBe(true);
    });
  });

  it("ignores checkpoints and removals for replaced or deleted payloads", async () => {
    const plan = await seedOutbox();
    await withStore(async (store) => {
      const observed = (await store.read(plan.outboxId))!;
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE outbox_id = ?",
      )
        .bind(
          JSON.stringify({ ...plan.outbox, firstQueuedAtMs: 200 }),
          plan.outboxId,
        )
        .run();
      expect(await store.checkpoint(observed, 3_600_000)).toBe(false);
      expect(await store.remove(observed)).toBe(false);
      expect((await store.read(plan.outboxId))?.nextReconcileAtMs).toBe(0);
      const fresh = (await store.read(plan.outboxId))!;
      expect(await store.remove(fresh)).toBe(true);
      expect(await store.checkpoint(fresh, 3_600_000)).toBe(false);
      expect(await store.remove(fresh)).toBe(false);
      expect(await store.read(plan.outboxId)).toBeNull();
    });
  });

  it.each([
    ["event_id", "another-event"],
    ["status", "dead"],
    ["run_at_ms", 30_000_000],
    ["last_queued_at_ms", 200],
    ["record_json", '{"schemaVersion":2}'],
  ] as const)(
    "old writers changing %s invalidate the checkpoint",
    async (column, value) => {
      await seedEvent("another-event");
      const plan = await seedOutbox();
      await withStore(async (store) => {
        await store.checkpoint((await store.read(plan.outboxId))!, 3_600_000);
        await testEnv.EVENT_DB.prepare(
          `UPDATE event_progress_outboxes SET ${column} = ? WHERE outbox_id = ?`,
        )
          .bind(value, plan.outboxId)
          .run();
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT next_reconcile_at_ms FROM event_progress_outboxes WHERE outbox_id = ?",
          )
            .bind(plan.outboxId)
            .first("next_reconcile_at_ms"),
        ).toBe(0);
      });
    },
  );

  it("identical old producer upserts preserve a confirmed checkpoint and acknowledgment deletes it", async () => {
    const plan = await seedOutbox();
    await withStore(async (store) => {
      await store.checkpoint((await store.read(plan.outboxId))!, 3_600_000);
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      try {
        await commitEventMutations(
          testEnv.EVENT_DB,
          [
            {
              kind: "progress-outbox",
              outboxId: plan.outboxId,
              value: plan.outbox,
            },
          ],
          { admission },
        );
        expect((await store.read(plan.outboxId))?.nextReconcileAtMs).toBe(
          3_600_000,
        );
        await commitEventMutations(
          testEnv.EVENT_DB,
          [{ kind: "progress-outbox", outboxId: plan.outboxId, value: null }],
          { admission },
        );
        expect(await store.read(plan.outboxId)).toBeNull();
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
    });
  });

  it("rejects checkpoint and removal writes after the admission expires", async () => {
    const plan = await seedOutbox();
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    const store = createEventProgressRecoveryStore(testEnv.EVENT_DB, admission);
    const observed = (await store.read(plan.outboxId))!;
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    await expect(store.checkpoint(observed, 3_600_000)).rejects.toThrow();
    await expect(store.remove(observed)).rejects.toThrow();
    expect(await store.read(plan.outboxId)).toEqual(observed);
  });

  it("rejects stale checkpoint and removal writes after the event store freezes", async () => {
    const plan = await seedOutbox();
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    const store = createEventProgressRecoveryStore(testEnv.EVENT_DB, admission);
    const observed = (await store.read(plan.outboxId))!;
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    await testEnv.EVENT_DB.prepare(
      `UPDATE event_runtime_control
       SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1
       WHERE singleton = 1`,
    ).run();
    await expect(store.checkpoint(observed, 3_600_000)).rejects.toThrow();
    await expect(store.remove(observed)).rejects.toThrow();
    expect(await store.read(plan.outboxId)).toEqual(observed);
  });
});
