import {
  applyPreCleanupTestMigrations,
  applyCanonicalCleanupTestMigrations,
} from "./canonicalTestMigrations.ts";
import { createHash } from "node:crypto";
import { requiredFixture } from "../test/requiredFixture.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  listDueEventProgressOutboxes,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "../src/eventProgressCodec.ts";
import {
  createEventProgressRecoveryStore,
  type EventProgressRecoveryStore,
} from "../src/eventProgressRecoveryD1.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "recovery-deadline-event";

function scheduledStartPlan(queuedAtMs = 100, id = eventId) {
  return buildEventProgressPlan(
    {
      eventId: id,
      reason: "scheduled-start-reconciliation",
      sourceKey: `start:${id}:20000000`,
      runAtMs: 20_000_000,
    },
    queuedAtMs,
  );
}

async function seedEvent(id = eventId) {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await commitEventMutations(
      testEnv.EVENT_DB,
      [
        {
          kind: "event",
          eventId: id,
          value: eventDocumentFixture({
            schemaVersion: 3,
            eventId: id,
            status: "scheduled",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 20_000_000,
            createdByProfileId: "profile-one",
            createdByLoginUid: "login-one",
            createdByUsername: "ivan",
            participants: {},
          }),
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
    `INSERT INTO event_progress_outboxes_canonical (
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

async function seedMalformedOutbox() {
  const plan = await seedOutbox();
  const record = { ...plan.outbox, sourceKey: "mismatched-source" };
  await testEnv.EVENT_DB.prepare(
    "UPDATE event_progress_outboxes_canonical SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
  )
    .bind(JSON.stringify(record, null, 2), plan.outboxId)
    .run();
  return { ...plan, invalidRecord: record };
}

async function storedOutboxes() {
  return (
    await testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes_canonical ORDER BY status, outbox_id",
    ).all<Record<string, unknown>>()
  ).results;
}

async function seedDeadOutbox(outboxId: string) {
  await testEnv.EVENT_DB.prepare(
    `INSERT INTO event_progress_outboxes_canonical (
       status, outbox_id, event_id, run_at_ms, last_queued_at_ms, record_json
     ) VALUES ('dead', ?, NULL, NULL, 50, ?)`,
  )
    .bind(
      outboxId,
      JSON.stringify({
        schemaVersion: 1,
        dataEpoch: 1,
        sourceDigest: "a".repeat(64),
        originalRecord: null,
        deadAtMs: 50,
        reason: "invalid-event-progress-outbox",
      }),
    )
    .run();
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
    await testEnv.EVENT_DB.prepare(
      "INSERT INTO event_records(event_id,status,start_at_ms,updated_at_ms,record_json) VALUES (?, 'scheduled', 100, 100, '{}')",
    )
      .bind(eventId)
      .run();
    const plan = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: "migration-fixture",
        reason: "scheduled-start",
        runAtMs: 100,
      },
      100,
    );
    await testEnv.EVENT_DB.prepare(
      "INSERT INTO event_progress_outboxes(outbox_id,event_id,status,run_at_ms,last_queued_at_ms,record_json) VALUES (?,?,'pending',100,100,?)",
    )
      .bind(plan.outboxId, eventId, JSON.stringify(plan.outbox))
      .run();
    legacyBefore = await testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes WHERE outbox_id = ?",
    )
      .bind(plan.outboxId)
      .first();
    await applyPreCleanupTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS.slice(migrationIndex),
    );
    legacyAfter = await testEnv.EVENT_DB.prepare(
      "SELECT * FROM event_progress_outboxes WHERE outbox_id = ?",
    )
      .bind(plan.outboxId)
      .first();
    await applyCanonicalCleanupTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes_canonical"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records_canonical"),
      testEnv.EVENT_DB.prepare(
        "UPDATE event_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
    ]);
    await seedEvent();
  });

  it("adds an immediately eligible checkpoint without rewriting historical payloads", () => {
    expect(legacyAfter).toEqual({ ...legacyBefore, next_reconcile_at_ms: 0 });
  });

  describe("scheduled start initialization", () => {
    it("creates and returns a canonical outbox in one batch under the existing admission", async () => {
      const plan = await scheduledStartPlan();
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      const reads: string[] = [];
      const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
        afterRead: async (query) => {
          reads.push(query);
        },
      });
      try {
        const store = createEventProgressRecoveryStore(
          observed.database,
          admission,
        );
        expect(await store.ensureScheduledStart(plan)).toEqual({
          outboxId: plan.outboxId,
          record: plan.outbox,
          recordJson: JSON.stringify(plan.outbox),
          nextReconcileAtMs: 0,
        });
        expect(observed.batches).toHaveLength(1);
        expect(observed.writeBatches[0]).toHaveLength(3);
        expect(reads).toEqual([]);
        expect(await storedOutboxes()).toEqual([
          {
            outbox_id: plan.outboxId,
            event_id: eventId,
            status: "pending",
            run_at_ms: plan.params.runAtMs,
            last_queued_at_ms: 100,
            record_json: JSON.stringify(plan.outbox),
            next_reconcile_at_ms: 0,
          },
        ]);
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT admission_id FROM event_write_admissions",
          ).all(),
        ).toMatchObject({ results: [{ admission_id: admission.admissionId }] });
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
    });

    it.each(["valid", "malformed"] as const)(
      "preserves an existing %s payload, archive, and future checkpoint exactly",
      async (kind) => {
        const plan = await scheduledStartPlan();
        await seedOutbox(plan.params.sourceKey);
        await seedDeadOutbox(plan.outboxId);
        const record =
          kind === "valid"
            ? plan.outbox
            : { ...plan.outbox, sourceKey: "mismatched-source" };
        const recordJson = JSON.stringify(record, null, 2);
        await testEnv.EVENT_DB.batch([
          testEnv.EVENT_DB.prepare(
            "UPDATE event_progress_outboxes_canonical SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
          ).bind(recordJson, plan.outboxId),
          testEnv.EVENT_DB.prepare(
            "UPDATE event_progress_outboxes_canonical SET next_reconcile_at_ms = 3600000 WHERE status = 'pending' AND outbox_id = ?",
          ).bind(plan.outboxId),
        ]);
        const before = await storedOutboxes();
        await withStore(async (store) => {
          expect(
            await store.ensureScheduledStart(await scheduledStartPlan(200)),
          ).toEqual({
            outboxId: plan.outboxId,
            record,
            recordJson,
            nextReconcileAtMs: 3_600_000,
          });
          expect(await store.listDue(3_599_999, 10)).toEqual([]);
        });
        expect(await storedOutboxes()).toEqual(before);
      },
    );

    it("returns the same winning payload when overlapping initializations race", async () => {
      const plans = await Promise.all([
        scheduledStartPlan(100),
        scheduledStartPlan(200),
      ]);
      await withStore(async (store) => {
        const snapshots = await Promise.all(
          plans.map((plan) => store.ensureScheduledStart(plan)),
        );
        expect(requiredFixture(snapshots[0])).toEqual(snapshots[1]);
        expect(plans.map((plan) => plan.outbox)).toContainEqual(
          requiredFixture(snapshots[0]).record,
        );
        expect(await store.read(plans[0].outboxId)).toEqual(
          requiredFixture(snapshots[0]),
        );
      });
      expect(await storedOutboxes()).toHaveLength(1);
    });

    it.each(["released", "expired", "generation", "frozen"] as const)(
      "rejects initialization under a %s admission without changing existing or absent rows",
      async (condition) => {
        const existing = await scheduledStartPlan();
        await seedOutbox(existing.params.sourceKey);
        const absent = await buildEventProgressPlan(
          {
            eventId,
            reason: "scheduled-start-reconciliation",
            sourceKey: `start:${eventId}:21000000`,
            runAtMs: 21_000_000,
          },
          100,
        );
        const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
        const store = createEventProgressRecoveryStore(testEnv.EVENT_DB, {
          ...admission,
          freezeGeneration:
            admission.freezeGeneration + Number(condition === "generation"),
        });
        try {
          if (condition === "released" || condition === "frozen")
            await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
          if (condition === "expired")
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_write_admissions SET created_at_ms = 0, expires_at_ms = 1 WHERE admission_id = ?",
            )
              .bind(admission.admissionId)
              .run();
          if (condition === "frozen")
            await testEnv.EVENT_DB.prepare(
              "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
            ).run();
          const before = await storedOutboxes();
          await expect(store.ensureScheduledStart(existing)).rejects.toThrow();
          await expect(store.ensureScheduledStart(absent)).rejects.toThrow();
          expect(await storedOutboxes()).toEqual(before);
        } finally {
          await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
        }
      },
    );

    it("retains the event foreign key when initializing an absent outbox", async () => {
      const plan = await scheduledStartPlan(100, "missing-scheduled-event");
      await withStore(async (store) => {
        await expect(store.ensureScheduledStart(plan)).rejects.toThrow();
      });
      expect(await storedOutboxes()).toEqual([]);
    });

    it.each([
      "reason",
      "source-key",
      "missing-run-time",
      "outbox-identity",
      "workflow-identity",
      "parameters",
      "queued-time",
    ] as const)(
      "rejects a plan with invalid %s before writing",
      async (kind) => {
        let plan: EventProgressPlan;
        if (
          kind === "reason" ||
          kind === "source-key" ||
          kind === "missing-run-time"
        ) {
          plan = await buildEventProgressPlan(
            {
              eventId,
              reason:
                kind === "reason"
                  ? "sunday-mons-reminder"
                  : "scheduled-start-reconciliation",
              sourceKey:
                kind === "source-key"
                  ? "other-source"
                  : `start:${eventId}:20000000`,
              runAtMs: kind === "missing-run-time" ? null : 20_000_000,
            },
            100,
          );
        } else {
          plan = await scheduledStartPlan();
          if (kind === "outbox-identity")
            plan.outboxId = `ep_${"a".repeat(64)}`;
          if (kind === "workflow-identity")
            plan.workflowId = `event-progress-${"a".repeat(64)}`;
          if (kind === "parameters") plan.params.eventId = "other-event";
          if (kind === "queued-time") plan.outbox.lastQueuedAtMs = -1;
        }
        await withStore(async (store) => {
          await expect(store.ensureScheduledStart(plan)).rejects.toThrow();
        });
        expect(await storedOutboxes()).toEqual([]);
      },
    );
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
          "SELECT record_json, last_queued_at_ms FROM event_progress_outboxes_canonical WHERE outbox_id = ?",
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
         FROM event_progress_outboxes_canonical
         WHERE status = 'pending' AND next_reconcile_at_ms <= ?
         ORDER BY next_reconcile_at_ms, last_queued_at_ms, outbox_id LIMIT ?`,
      )
        .bind(100, 10)
        .all<{ detail: string }>();
      const details = explained.results.map((row) => row.detail).join("\n");
      expect(details).toContain(
        "idx_event_progress_outboxes_canonical_reconcile",
      );
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
        "UPDATE event_progress_outboxes_canonical SET record_json = ? WHERE outbox_id = ?",
      )
        .bind(
          JSON.stringify({ ...plan.outbox, firstQueuedAtMs: 50 }),
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
    "valid",
    "malformed",
    "reformatted",
    "reordered",
    "deleted",
  ] as const)(
    "does not quarantine a snapshot concurrently %s or overwrite its archive",
    async (replacement) => {
      const plan = await seedMalformedOutbox();
      const malformed = plan.invalidRecord;
      await seedDeadOutbox(plan.outboxId);
      const previousDead = requiredFixture((await storedOutboxes())[0]);
      const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
      const recordJson =
        replacement === "valid"
          ? JSON.stringify(plan.outbox)
          : replacement === "malformed"
            ? JSON.stringify({ ...malformed, firstQueuedAtMs: 50 })
            : replacement === "reordered"
              ? JSON.stringify(
                  Object.fromEntries(Object.entries(malformed).reverse()),
                )
              : JSON.stringify(malformed);
      try {
        const observed = observeD1FailureDatabase(testEnv.EVENT_DB, {
          async beforeWriteBatch() {
            await testEnv.EVENT_DB.prepare(
              replacement === "deleted"
                ? "DELETE FROM event_progress_outboxes_canonical WHERE status = 'pending' AND outbox_id = ?"
                : "UPDATE event_progress_outboxes_canonical SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
            )
              .bind(
                ...(replacement === "deleted"
                  ? [plan.outboxId]
                  : [recordJson, plan.outboxId]),
              )
              .run();
          },
        });
        const store = createEventProgressRecoveryStore(
          observed.database,
          admission,
        );
        const snapshot = (await store.read(plan.outboxId))!;
        expect(snapshot.recordJson).toBe(JSON.stringify(malformed, null, 2));
        expect(await store.deadLetter(snapshot, 500)).toBe(false);
        expect(observed.writeBatches).toHaveLength(1);
        const rows = await storedOutboxes();
        expect(rows[0]).toEqual(previousDead);
        if (replacement === "deleted") {
          expect(rows).toHaveLength(1);
        } else {
          expect(rows).toHaveLength(2);
          expect(requiredFixture(rows[1]).record_json).toBe(recordJson);
        }
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
      }
    },
  );

  it.each([false, true])(
    "quarantines an exact snapshot atomically with an existing archive: %s",
    async (existingArchive) => {
      const plan = await seedMalformedOutbox();
      const originalRecord = plan.invalidRecord;
      if (existingArchive) {
        await seedDeadOutbox(plan.outboxId);
        await testEnv.EVENT_DB.prepare(
          "UPDATE event_progress_outboxes_canonical SET next_reconcile_at_ms = 3_600_000 WHERE status = 'dead' AND outbox_id = ?",
        )
          .bind(plan.outboxId)
          .run();
      }
      await withStore(async (store) => {
        const snapshot = (await store.read(plan.outboxId))!;
        expect(await store.deadLetter(snapshot, 500)).toBe(true);
        expect(await store.read(plan.outboxId)).toBeNull();
        const [archived] = await storedOutboxes();
        expect(archived).toEqual({
          outbox_id: plan.outboxId,
          event_id: eventId,
          status: "dead",
          run_at_ms: null,
          last_queued_at_ms: 500,
          record_json: JSON.stringify({
            schemaVersion: 1,
            dataEpoch: 1,
            deadAtMs: 500,
            sourceDigest: createHash("sha256")
              .update(snapshot.recordJson)
              .digest("hex"),
            originalRecord,
            reason: "invalid-event-progress-outbox",
          }),
          next_reconcile_at_ms: 0,
        });
        expect(await store.deadLetter(snapshot, 600)).toBe(false);
        expect(await storedOutboxes()).toEqual([archived]);
      });
    },
  );

  it("preserves the canonical event association when archiving an identity-mismatched pending row", async () => {
    await seedEvent("other-event");
    const plan = await seedMalformedOutbox();
    const record = { ...plan.invalidRecord, eventId: "other-event" };
    await testEnv.EVENT_DB.prepare(
      "UPDATE event_progress_outboxes_canonical SET event_id='other-event',record_json=? WHERE outbox_id=? AND status='pending'",
    )
      .bind(JSON.stringify(record), plan.outboxId)
      .run();
    await withStore(async (store) => {
      expect(
        await store.deadLetter((await store.read(plan.outboxId))!, 500),
      ).toBe(true);
    });
    expect(requiredFixture((await storedOutboxes())[0]).event_id).toBe(
      "other-event",
    );
  });

  it.each([" padded-id ", "bad#key", "bad\nkey"])(
    "rejects malformed outbox ID %j without changing or normalizing it",
    async (outboxId) => {
      const plan = await seedMalformedOutbox();
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes_canonical SET outbox_id = ? WHERE outbox_id = ?",
      )
        .bind(outboxId, plan.outboxId)
        .run();
      const before = await storedOutboxes();
      await withStore(async (store) => {
        const snapshot = requiredFixture((await store.listDue(0, 1))[0]);
        expect(snapshot.outboxId).toBe(outboxId);
        await expect(store.deadLetter(snapshot, 500)).rejects.toThrow(
          "invalid-event-path",
        );
      });
      expect(await storedOutboxes()).toEqual(before);
    },
  );

  it("rolls back archive replacement when pending deletion fails", async () => {
    const plan = await seedMalformedOutbox();
    await seedDeadOutbox(plan.outboxId);
    const before = await storedOutboxes();
    await testEnv.EVENT_DB.prepare(
      `CREATE TRIGGER reject_progress_quarantine_delete
       BEFORE DELETE ON event_progress_outboxes_canonical
       WHEN OLD.status = 'pending'
       BEGIN SELECT RAISE(ABORT, 'test-quarantine-delete-failed'); END`,
    ).run();
    try {
      await withStore(async (store) => {
        await expect(
          store.deadLetter((await store.read(plan.outboxId))!, 500),
        ).rejects.toThrow("test-quarantine-delete-failed");
      });
      expect(await storedOutboxes()).toEqual(before);
    } finally {
      await testEnv.EVENT_DB.prepare(
        "DROP TRIGGER reject_progress_quarantine_delete",
      ).run();
    }
  });

  it.each([
    ["event_id", "another-event"],
    ["status", "dead"],
    ["run_at_ms", 30_000_000],
    ["last_queued_at_ms", 200],
    ["record_json", '{"schemaVersion":2}'],
  ] as const)(
    "rejects incoherent %s changes and preserves the checkpoint",
    async (column, value) => {
      await seedEvent("another-event");
      const plan = await seedOutbox();
      await withStore(async (store) => {
        await store.checkpoint((await store.read(plan.outboxId))!, 3_600_000);
        await expect(
          testEnv.EVENT_DB.prepare(
            `UPDATE event_progress_outboxes_canonical SET ${column} = ? WHERE outbox_id = ?`,
          )
            .bind(value, plan.outboxId)
            .run(),
        ).rejects.toThrow();
        expect(
          await testEnv.EVENT_DB.prepare(
            "SELECT next_reconcile_at_ms FROM event_progress_outboxes_canonical WHERE outbox_id = ?",
          )
            .bind(plan.outboxId)
            .first("next_reconcile_at_ms"),
        ).toBe(3_600_000);
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

  it("rejects recovery writes after the admission is released", async () => {
    const plan = await seedOutbox();
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    const store = createEventProgressRecoveryStore(testEnv.EVENT_DB, admission);
    const observed = (await store.read(plan.outboxId))!;
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    await expect(store.checkpoint(observed, 3_600_000)).rejects.toThrow();
    await expect(store.remove(observed)).rejects.toThrow();
    await expect(store.deadLetter(observed, 500)).rejects.toThrow();
    expect(await store.read(plan.outboxId)).toEqual(observed);
  });

  it("rejects stale recovery writes after the event store freezes", async () => {
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
    await expect(store.deadLetter(observed, 500)).rejects.toThrow();
    expect(await store.read(plan.outboxId)).toEqual(observed);
  });

  it("rejects quarantine after its admission expires", async () => {
    const plan = await seedMalformedOutbox();
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB, {
      nowMs: 0,
      ttlMs: 1,
    });
    const store = createEventProgressRecoveryStore(testEnv.EVENT_DB, admission);
    const snapshot = (await store.read(plan.outboxId))!;
    const before = await storedOutboxes();
    try {
      await expect(store.deadLetter(snapshot, 500)).rejects.toThrow();
      expect(await storedOutboxes()).toEqual(before);
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });
});
