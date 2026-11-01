import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import { LEGACY_CORE_PRIZES_EVENT_ID } from "@mons/shared/event-prizes";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { sweepEventProgress } from "../src/eventProgressRecovery.ts";
import { buildEventAnnouncementPlan } from "../src/eventPrizeAnnouncementSchedule.ts";
import { createCombinedCronWorkflowRecorder } from "./combinedCronEventProgressFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & {
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
};
const db = testEnv.EVENT_DB;
const nowMs = 1_800_000_000_000;
const hourMs = 60 * 60 * 1_000;
const marginMs = 10 * 60 * 1_000;

function eventRecord(eventId: string, startAtMs: number, isSundayMons = false) {
  return eventDocumentFixture({
    schemaVersion: 3,
    eventId,
    status: "scheduled" as const,
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs,
    createdByProfileId: "deadline-profile",
    createdByLoginUid: "deadline-login",
    createdByUsername: "deadline-fixture",
    isSundayMons,
    participants: {},
    rounds: {},
  });
}

function ordinaryId(index: number) {
  return `deadline-ordinary-${String(index).padStart(3, "0")}`;
}

async function seedEvents(records: ReturnType<typeof eventRecord>[]) {
  for (let index = 0; index < records.length; index += 100)
    await db.batch(
      records.slice(index, index + 100).map((record) =>
        db
          .prepare(
            `INSERT INTO event_records_canonical
             (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
             VALUES (?, 'scheduled', ?, 100, 1, ?)`,
          )
          .bind(record.eventId, record.startAtMs, JSON.stringify(record)),
      ),
    );
}

async function storedOutboxes() {
  return (
    await db
      .prepare(
        `SELECT outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
           record_json FROM event_progress_outboxes_canonical ORDER BY outbox_id`,
      )
      .all<{
        outbox_id: string;
        event_id: string;
        status: string;
        run_at_ms: number;
        last_queued_at_ms: number;
        record_json: string;
      }>()
  ).results;
}

async function storedCursor() {
  return db
    .prepare(
      `SELECT start_at_ms, event_id, revision, updated_at_ms
       FROM event_scheduled_recovery_cursor WHERE singleton = 1`,
    )
    .first();
}

beforeAll(async () => {
  await Promise.all([
    applyStrictMatchStateTestMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    ),
    applyEventTestMigrations(db, testEnv.TEST_EVENT_D1_MIGRATIONS),
  ]);
}, 30_000);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM event_progress_outboxes_canonical"),
    db.prepare("DELETE FROM event_write_admissions"),
    db.prepare("DELETE FROM event_records_canonical"),
    db.prepare(
      `UPDATE event_scheduled_recovery_cursor
       SET start_at_ms = NULL, event_id = NULL, revision = 0, updated_at_ms = 0`,
    ),
  ]);
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { kind: "reminder" as const, eventId: "deadline-sunday", leadMs: 4 * hourMs },
  {
    kind: "prizes" as const,
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    leadMs: hourMs,
  },
])(
  "creates $kind and start workflows before their deadlines behind 800 earlier ordinary events",
  async ({ kind, eventId, leadMs }) => {
    const time = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-deadline-test-network-call"));
    const ordinaryStartAtMs = nowMs + leadMs;
    const target = eventRecord(eventId, ordinaryStartAtMs + marginMs, true);
    await seedEvents([
      ...Array.from({ length: 800 }, (_, index) =>
        eventRecord(ordinaryId(index), ordinaryStartAtMs),
      ),
      target,
    ]);
    expect(await storedCursor()).toEqual({
      start_at_ms: null,
      event_id: null,
      revision: 0,
      updated_at_ms: 0,
    });
    const announcement = await buildEventAnnouncementPlan(
      eventId,
      target,
      nowMs,
      kind,
    );
    expect(announcement).not.toBeNull();
    const start = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: `start:${eventId}:${target.startAtMs}`,
        reason: "scheduled-start-reconciliation",
        runAtMs: target.startAtMs,
      },
      nowMs,
    );
    const plans = [announcement!, start];
    const workflows = createCombinedCronWorkflowRecorder({
      scheduled: [],
      persisted: [],
      rating: [],
    });
    const measuredEnv: Env = {
      ...testEnv,
      EVENT_PROGRESS_WORKFLOW: workflows.workflow,
    };
    await sweepEventProgress(measuredEnv, { ratingRepository: null });
    expect(
      workflows.creations.filter(({ params }) => params?.eventId === eventId),
    ).toEqual(
      expect.arrayContaining(
        plans.map((plan) => ({
          id: plan.workflowId,
          params: plan.params,
          retention: { successRetention: "1 day", errorRetention: "30 days" },
        })),
      ),
    );
    const firstOutboxes = await storedOutboxes();
    expect(firstOutboxes.filter((row) => row.event_id === eventId)).toEqual(
      plans
        .map((plan) => ({
          outbox_id: plan.outboxId,
          event_id: eventId,
          status: "pending",
          run_at_ms: plan.params.runAtMs,
          last_queued_at_ms: nowMs,
          record_json: JSON.stringify(plan.outbox),
        }))
        .toSorted((left, right) =>
          left.outbox_id.localeCompare(right.outbox_id),
        ),
    );
    expect(await storedCursor()).toEqual({
      start_at_ms: ordinaryStartAtMs,
      event_id: ordinaryId(99),
      revision: 1,
      updated_at_ms: nowMs,
    });

    time.mockReturnValue(nowMs + 5 * 60_000);
    await sweepEventProgress(measuredEnv, { ratingRepository: null });
    const secondOutboxes = await storedOutboxes();
    expect(secondOutboxes).toEqual(expect.arrayContaining(firstOutboxes));
    for (const plan of plans)
      expect(
        workflows.creations.filter(({ id }) => id === plan.workflowId),
      ).toHaveLength(1);
    expect(await storedCursor()).toEqual({
      start_at_ms: ordinaryStartAtMs,
      event_id: ordinaryId(199),
      revision: 2,
      updated_at_ms: nowMs + 5 * 60_000,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM event_records_canonical")
        .first("count"),
    ).toBe(801);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM event_write_admissions")
        .first("count"),
    ).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  },
  60_000,
);

it("reaches deferred reminders by their deadline without background recovery rescuing them", async () => {
  const time = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected-deadline-test-network-call"));
  const deadlineMs = nowMs + 5 * 60_000;
  const backgroundStartAtMs = nowMs + 24 * hourMs;
  const targets = Array.from({ length: 100 }, (_, index) =>
    eventRecord(
      `deadline-burst-${String(index).padStart(3, "0")}`,
      deadlineMs + 4 * hourMs,
      true,
    ),
  );
  const targetIds = new Set(targets.map(({ eventId }) => eventId));
  await seedEvents([
    ...targets,
    ...Array.from({ length: 201 }, (_, index) =>
      eventRecord(ordinaryId(index), backgroundStartAtMs),
    ),
  ]);
  await db
    .prepare(
      `UPDATE event_scheduled_recovery_cursor
       SET start_at_ms = ?, event_id = 'deadline-background-start'
       WHERE singleton = 1`,
    )
    .bind(nowMs + 20 * hourMs)
    .run();
  const workflows = createCombinedCronWorkflowRecorder({
    scheduled: [],
    persisted: [],
    rating: [],
  });
  const measuredEnv: Env = {
    ...testEnv,
    EVENT_PROGRESS_WORKFLOW: workflows.workflow,
  };
  const createdReminders = () =>
    workflows.creations.filter(
      ({ params }) =>
        params?.reason === "sunday-mons-reminder" &&
        targetIds.has(params.eventId),
    );

  await sweepEventProgress(measuredEnv, { ratingRepository: null });
  expect(createdReminders()).toHaveLength(90);
  const firstOutboxes = await storedOutboxes();
  expect(await storedCursor()).toEqual({
    start_at_ms: backgroundStartAtMs,
    event_id: ordinaryId(99),
    revision: 1,
    updated_at_ms: nowMs,
  });

  time.mockReturnValue(deadlineMs);
  await sweepEventProgress(measuredEnv, { ratingRepository: null });
  expect(createdReminders()).toHaveLength(100);
  expect(
    createdReminders()
      .map(({ params }) => params!.eventId)
      .sort(),
  ).toEqual([...targetIds].sort());
  const secondOutboxes = await storedOutboxes();
  expect(secondOutboxes).toEqual(expect.arrayContaining(firstOutboxes));
  const reminders = secondOutboxes.filter(
    (row) =>
      targetIds.has(row.event_id) &&
      JSON.parse(row.record_json).reason === "sunday-mons-reminder",
  );
  expect(reminders).toHaveLength(100);
  for (const row of reminders) {
    expect(row.status).toBe("pending");
    expect(row.run_at_ms).toBe(deadlineMs);
    expect(row.last_queued_at_ms).toBeLessThanOrEqual(deadlineMs);
    expect(JSON.parse(row.record_json)).toMatchObject({
      eventId: row.event_id,
      sourceKey: `reminder:${row.event_id}:${deadlineMs + 4 * hourMs}`,
      runAtMs: deadlineMs,
      firstQueuedAtMs: row.last_queued_at_ms,
      lastQueuedAtMs: row.last_queued_at_ms,
    });
  }
  expect(await storedCursor()).toEqual({
    start_at_ms: backgroundStartAtMs,
    event_id: ordinaryId(199),
    revision: 2,
    updated_at_ms: deadlineMs,
  });
  expect(fetch).not.toHaveBeenCalled();
}, 60_000);
