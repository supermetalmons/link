import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  EventWritesDisabled,
  listDueEventProgressOutboxes,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { createEventProgressOutboxWriter } from "../src/eventRepository.ts";
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
