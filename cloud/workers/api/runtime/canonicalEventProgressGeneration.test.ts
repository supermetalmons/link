import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  commitEventMutations,
} from "../src/eventD1.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { createEventProgressRecoveryStore } from "../src/eventProgressRecoveryD1.ts";
import { readEventProgressDeadLetter } from "../../../runtime/eventProgressRecords.js";
const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.EVENT_DB;
describe("canonical event progress generation", () => {
  beforeAll(() =>
    applyEventTestMigrations(db, testEnv.TEST_EVENT_D1_MIGRATIONS),
  );
  it("persists epoch-bound pending work and archives exact typed schedule evidence", async () => {
    const eventId = `progress-${crypto.randomUUID()}`;
    const admission = await acquireEventWriteAdmission(db);
    try {
      const event = eventDocumentFixture({ eventId });
      const plan = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: "progress-source",
          reason: "progress-test",
          runAtMs: 2000,
        },
        1000,
      );
      await commitEventMutations(
        db,
        [
          { kind: "event", eventId, value: event },
          {
            kind: "progress-outbox",
            outboxId: plan.outboxId,
            value: plan.outbox,
          },
        ],
        { admission },
      );
      const recovery = createEventProgressRecoveryStore(db, admission);
      const current = await recovery.read(plan.outboxId);
      expect(current?.record).toEqual(plan.outbox);
      if (!current) throw new Error("missing-progress");
      expect(await recovery.deadLetter(current, 3000)).toBe(true);
      expect(await recovery.read(plan.outboxId)).toBeNull();
      const row = await db
        .prepare(
          "SELECT record_json FROM event_progress_outboxes_canonical WHERE status='dead' AND outbox_id=?",
        )
        .bind(plan.outboxId)
        .first<{ record_json: string }>();
      expect(
        readEventProgressDeadLetter(JSON.parse(row!.record_json)),
      ).toMatchObject({
        schemaVersion: 1,
        dataEpoch: 1,
        deadAtMs: 3000,
        originalRecord: plan.outbox,
      });
      expect(
        await db
          .prepare(
            "SELECT count(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'event_progress_outboxes'",
          )
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      await releaseEventWriteAdmission(db, admission);
    }
  });
  it("rejects the old pending schema at the canonical SQL boundary", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO event_progress_outboxes_canonical(outbox_id,event_id,status,run_at_ms,last_queued_at_ms,record_json) VALUES('invalid','event','pending',NULL,1,'{\"schemaVersion\":1}')",
        )
        .run(),
    ).rejects.toThrow();
  });
});
