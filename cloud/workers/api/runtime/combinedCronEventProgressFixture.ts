import { requiredFixture } from "../test/requiredFixture.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import {
  canonicalRatingFixture,
  canonicalRatingInsert,
} from "./canonicalRatingFixture.ts";
import { expect } from "vitest";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
  type EventProgressWorkflowParams,
} from "../src/eventProgressCodec.ts";
import {
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT,
} from "../src/eventScheduledRecoveryD1.ts";

const progressLaneSize = 10;
const scheduledPageSize = SCHEDULED_EVENT_RECOVERY_PAGE_SIZE;
const urgentLimit = SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT;
const recoveredUrgentOrdinaryCount = (4_500 - 50) / 10;
const recoveredBackgroundCount = 1_000 / 50;
const initialCursorRevision = 7;
const prefix = "cron-progress-";
const hourMs = 60 * 60 * 1_000;
const recoveryIntervalMs = 5 * 60 * 1_000;

type RecordedStatus = InstanceStatus["status"];
type PersistedProgress = {
  plan: EventProgressPlan;
  initialStatus: RecordedStatus | null;
};
type ScheduledProgress = {
  eventId: string;
  startAtMs: number;
  plans: EventProgressPlan[];
};
type RatingProgress = {
  operationId: string;
  plan: EventProgressPlan;
};

export type CombinedCronEventProgressSeed = {
  scheduled: ScheduledProgress[];
  persisted: PersistedProgress[];
  rating: RatingProgress[];
};

async function writeBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let offset = 0; offset < statements.length; offset += 100)
    await db.batch(statements.slice(offset, offset + 100));
}

function numberedId(family: string, index: number): string {
  return `${prefix}${family}-${String(index).padStart(3, "0")}`;
}

function eventStatement(
  db: D1Database,
  eventId: string,
  status: "scheduled" | "active",
  startAtMs: number,
  isSundayMons = false,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO event_records_canonical
       (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
       VALUES (?, ?, ?, 100, 1, ?)`,
    )
    .bind(
      eventId,
      status,
      startAtMs,
      JSON.stringify(
        eventDocumentFixture({
          schemaVersion: 3,
          eventId,
          status,
          createdAtMs: 100,
          updatedAtMs: 100,
          startAtMs,
          createdByProfileId: `${prefix}profile`,
          createdByLoginUid: `${prefix}login`,
          createdByUsername: "cron-fixture",
          isSundayMons,
          participants: {},
          rounds: {},
          ...(status === "active" ? { startedAtMs: 100 } : {}),
        }),
      ),
    );
}

export async function seedCombinedCronEventProgress(
  env: Env,
  nowMs: number,
): Promise<CombinedCronEventProgressSeed> {
  const events: D1PreparedStatement[] = [];
  const ratings: D1PreparedStatement[] = [];
  const scheduled: ScheduledProgress[] = [];
  const persisted: PersistedProgress[] = [];
  const rating: RatingProgress[] = [];
  for (let index = 0; index < urgentLimit + scheduledPageSize + 2; index++) {
    const eventId = numberedId("scheduled", index);
    const startAtMs =
      index < urgentLimit - 1
        ? nowMs + 6 * 60_000 + (index + 1) * 100
        : index <= urgentLimit
          ? nowMs + 4 * hourMs + (index - urgentLimit + 6) * 60_000
          : nowMs + 24 * hourMs + (index - urgentLimit - 1) * 60_000;
    const isSundayMons = index === urgentLimit - 1 || index > urgentLimit;
    const plans = [
      await buildEventProgressPlan(
        {
          eventId,
          sourceKey: `start:${eventId}:${startAtMs}`,
          reason: "scheduled-start-reconciliation",
          runAtMs: startAtMs,
        },
        nowMs,
      ),
    ];
    if (isSundayMons)
      plans.push(
        await buildEventProgressPlan(
          {
            eventId,
            sourceKey: `reminder:${eventId}:${startAtMs}`,
            reason: "sunday-mons-reminder",
            runAtMs: startAtMs - 4 * hourMs,
          },
          nowMs,
        ),
      );
    scheduled.push({ eventId, startAtMs, plans });
    events.push(
      eventStatement(
        env.EVENT_DB,
        eventId,
        "scheduled",
        startAtMs,
        isSundayMons,
      ),
    );
  }
  events.push(
    env.EVENT_DB.prepare(
      `UPDATE event_scheduled_recovery_cursor
       SET start_at_ms = ?, event_id = ?, revision = ?, updated_at_ms = 100
       WHERE singleton = 1`,
    ).bind(
      requiredFixture(scheduled[urgentLimit]).startAtMs,
      requiredFixture(scheduled[urgentLimit]).eventId,
      initialCursorRevision,
    ),
  );
  const statuses: Array<RecordedStatus | null> = [
    null,
    "waiting",
    "complete",
    "errored",
    "terminated",
    "running",
    "queued",
    "paused",
    "waiting",
    "waiting",
    "waiting",
  ];
  for (let index = 0; index <= progressLaneSize; index++) {
    const eventId = numberedId("persisted", index);
    const runAtMs = index === 1 ? nowMs + 2 * hourMs : null;
    const plan = await buildEventProgressPlan(
      {
        eventId,
        sourceKey: `timer:${eventId}`,
        reason: "timer-claimed",
        runAtMs,
      },
      100 + index,
    );
    persisted.push({ plan, initialStatus: requiredFixture(statuses[index]) });
    events.push(
      eventStatement(env.EVENT_DB, eventId, "active", 100),
      env.EVENT_DB.prepare(
        `INSERT INTO event_progress_outboxes_canonical
         (status, outbox_id, event_id, run_at_ms, last_queued_at_ms,
          next_reconcile_at_ms, record_json)
         VALUES ('pending', ?, ?, ?, ?, 0, ?)`,
      ).bind(
        plan.outboxId,
        eventId,
        runAtMs,
        plan.outbox.lastQueuedAtMs,
        JSON.stringify(plan.outbox),
      ),
    );
    const ratingEventId = numberedId("rating", index);
    const inviteId = numberedId("invite", index);
    const matchId = numberedId("match", index);
    const operationId = `${inviteId}__${matchId}`;
    const ratingPlan = await buildEventProgressPlan(
      {
        eventId: ratingEventId,
        sourceKey: `rating:${inviteId}:${matchId}`,
        reason: "match-rating-updated",
      },
      nowMs,
    );
    rating.push({ operationId, plan: ratingPlan });
    events.push(eventStatement(env.EVENT_DB, ratingEventId, "active", 100));
    const value = canonicalRatingFixture(inviteId, {
      matchId,
      eventId: ratingEventId,
      profileState: "done",
      telegramState: "done",
    });
    ratings.push(
      canonicalRatingInsert(env.PROFILE_DB, {
        ...value,
        eventProgressUpdatedAtMs: 100,
        telegramProjectionUpdatedAtMs: 100,
        profileGameProjectionUpdatedAtMs: 100,
      }),
    );
  }
  await Promise.all([
    writeBatches(env.EVENT_DB, events),
    writeBatches(env.PROFILE_DB, ratings),
  ]);
  return { scheduled, persisted, rating };
}

export function createCombinedCronWorkflowRecorder(
  seed: CombinedCronEventProgressSeed,
  onCall: () => void = () => {},
  {
    scheduledWorkflow = "missing",
  }: {
    scheduledWorkflow?: "missing" | "terminal";
  } = {},
) {
  const creations: WorkflowInstanceCreateOptions<EventProgressWorkflowParams>[] =
    [];
  const operations: Array<{ operation: string; id: string }> = [];
  const instances = new Map<string, WorkflowInstance>();
  const initialScheduledInstances = new Map<string, WorkflowInstance>();
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected-cron-workflow-operation");
  };
  const addInstance = (
    id: string,
    status: RecordedStatus,
  ): WorkflowInstance => {
    const instance: WorkflowInstance = {
      id,
      async delete() {
        onCall();
        operations.push({ operation: "delete", id });
        instances.delete(id);
      },
      async status() {
        onCall();
        operations.push({ operation: "status", id });
        return { status };
      },
      pause: unexpected,
      restart: unexpected,
      resume: unexpected,
      terminate: unexpected,
      sendEvent: unexpected,
    };
    instances.set(id, instance);
    return instance;
  };
  for (const { plan, initialStatus } of seed.persisted)
    if (initialStatus) addInstance(plan.workflowId, initialStatus);
  if (scheduledWorkflow === "terminal")
    for (const [index, plan] of seed.scheduled
      .flatMap(({ plans }) => plans)
      .entries())
      initialScheduledInstances.set(
        plan.workflowId,
        addInstance(
          plan.workflowId,
          index % 2 === 0 ? "errored" : "terminated",
        ),
      );
  const workflow: Env["EVENT_PROGRESS_WORKFLOW"] = {
    create: unexpected,
    deleteBatch: unexpected,
    async createBatch(items) {
      onCall();
      return items.map((item) => {
        if (!item.id || !item.params || instances.has(item.id))
          throw new Error("unexpected-cron-workflow-creation");
        creations.push(structuredClone(item));
        operations.push({ operation: "createBatch", id: item.id });
        return addInstance(item.id, "waiting");
      });
    },
    async get(id) {
      onCall();
      operations.push({ operation: "get", id });
      const instance = instances.get(id);
      if (!instance) throw new Error("cron-workflow-instance-missing");
      return instance;
    },
  };
  return {
    workflow,
    creations,
    operations,
    scheduledWorkflow,
    instances,
    initialScheduledInstances,
  };
}

function nextCheckpoint(
  plan: EventProgressPlan,
  status: RecordedStatus,
  nowMs: number,
): number {
  return status === "waiting" &&
    plan.params.runAtMs !== null &&
    plan.params.runAtMs > nowMs + 10 * 60_000
    ? Math.min(nowMs + hourMs, plan.params.runAtMs - 10 * 60_000)
    : (Math.floor(nowMs / recoveryIntervalMs) + 1) * recoveryIntervalMs;
}

export async function assertCombinedCronEventProgress(
  env: Env,
  nowMs: number,
  seed: CombinedCronEventProgressSeed,
  recorder: ReturnType<typeof createCombinedCronWorkflowRecorder>,
): Promise<void> {
  const scheduledPlans = [
    requiredFixture(seed.scheduled[urgentLimit - 1]),
    ...seed.scheduled.slice(0, recoveredUrgentOrdinaryCount),
    ...seed.scheduled.slice(
      urgentLimit + 1,
      urgentLimit + 1 + recoveredBackgroundCount,
    ),
  ].flatMap(({ plans }) => plans);
  const ratingPlans = seed.rating
    .slice(0, progressLaneSize)
    .map(({ plan }) => plan);
  const persisted = seed.persisted.slice(0, progressLaneSize);
  const createdPlans = [
    ...scheduledPlans,
    ...ratingPlans,
    ...persisted
      .filter(
        ({ initialStatus }) =>
          initialStatus === null ||
          initialStatus === "errored" ||
          initialStatus === "terminated",
      )
      .map(({ plan }) => plan),
  ];
  const sortById = <T extends { id?: string }>(values: T[]): T[] =>
    values.toSorted((left, right) =>
      (left.id || "").localeCompare(right.id || ""),
    );
  expect(sortById(recorder.creations)).toEqual(
    sortById(
      createdPlans.map((plan) => ({
        id: plan.workflowId,
        params: plan.params,
        retention: { successRetention: "1 day", errorRetention: "30 days" },
      })),
    ),
  );
  expect(
    recorder.operations
      .filter(({ operation }) => operation === "delete")
      .map(({ id }) => id)
      .sort(),
  ).toEqual(
    [
      ...(recorder.scheduledWorkflow === "terminal" ? scheduledPlans : []),
      ...persisted
        .filter(
          ({ initialStatus }) =>
            initialStatus === "errored" || initialStatus === "terminated",
        )
        .map(({ plan }) => plan),
    ]
      .map(({ workflowId }) => workflowId)
      .sort(),
  );
  const processedScheduledIds = new Set(
    scheduledPlans.map(({ workflowId }) => workflowId),
  );
  for (const [id, initial] of recorder.initialScheduledInstances)
    if (processedScheduledIds.has(id))
      expect(recorder.instances.get(id), id).not.toBe(initial);
    else expect(recorder.instances.get(id), id).toBe(initial);
  const processedPlans = [
    ...scheduledPlans,
    ...ratingPlans,
    ...persisted.map(({ plan }) => plan),
  ];
  expect(
    recorder.operations
      .filter(({ operation }) => operation === "status")
      .map(({ id }) => id)
      .sort(),
  ).toEqual(processedPlans.map(({ workflowId }) => workflowId).sort());
  expect(
    recorder.operations
      .filter(({ operation }) => operation === "get")
      .map(({ id }) => id)
      .sort(),
  ).toEqual(processedPlans.map(({ workflowId }) => workflowId).sort());
  const rows = await env.EVENT_DB.prepare(
    `SELECT outbox_id, status, next_reconcile_at_ms, last_queued_at_ms, record_json
     FROM event_progress_outboxes_canonical WHERE event_id LIKE ? ORDER BY outbox_id`,
  )
    .bind(`${prefix}%`)
    .all<{
      outbox_id: string;
      status: string;
      next_reconcile_at_ms: number;
      last_queued_at_ms: number;
      record_json: string;
    }>();
  const expectedRows = [
    ...scheduledPlans.map((plan) => ({
      plan,
      status:
        recorder.scheduledWorkflow === "terminal"
          ? ("errored" as const)
          : ("waiting" as const),
    })),
    ...ratingPlans.map((plan) => ({ plan, status: "waiting" as const })),
    ...persisted
      .filter(({ initialStatus }) => initialStatus !== "complete")
      .map(({ plan, initialStatus }) => ({
        plan,
        status: initialStatus || "waiting",
      })),
  ].map(({ plan, status }) => ({
    outbox_id: plan.outboxId,
    status: "pending",
    next_reconcile_at_ms: nextCheckpoint(plan, status, nowMs),
    last_queued_at_ms: plan.outbox.lastQueuedAtMs,
    record: plan.outbox,
  }));
  const remainder = requiredFixture(seed.persisted[progressLaneSize]).plan;
  expectedRows.push({
    outbox_id: remainder.outboxId,
    status: "pending",
    next_reconcile_at_ms: 0,
    last_queued_at_ms: remainder.outbox.lastQueuedAtMs,
    record: remainder.outbox,
  });
  expect(
    rows.results.map(({ record_json, ...row }) => ({
      ...row,
      record: JSON.parse(record_json),
    })),
  ).toEqual(
    expectedRows.toSorted((left, right) =>
      left.outbox_id.localeCompare(right.outbox_id),
    ),
  );
  expect(
    await env.EVENT_DB.prepare(
      "SELECT start_at_ms, event_id, revision, updated_at_ms FROM event_scheduled_recovery_cursor WHERE singleton = 1",
    ).first(),
  ).toEqual({
    start_at_ms: requiredFixture(
      seed.scheduled[urgentLimit + recoveredBackgroundCount],
    ).startAtMs,
    event_id: requiredFixture(
      seed.scheduled[urgentLimit + recoveredBackgroundCount],
    ).eventId,
    revision: initialCursorRevision + 1,
    updated_at_ms: nowMs,
  });
  const ratingRows = await env.PROFILE_DB.prepare(
    `SELECT operation_id, revision, event_progress_state, event_progress_updated_at_ms,
       lease_expires_at_ms, payload_json FROM rating_updates_canonical
     WHERE operation_id LIKE ? ORDER BY operation_id`,
  )
    .bind(`${prefix}%`)
    .all<{
      operation_id: string;
      revision: number;
      event_progress_state: string;
      event_progress_updated_at_ms: number;
      lease_expires_at_ms: number;
      payload_json: string;
    }>();
  expect(ratingRows.results).toHaveLength(progressLaneSize + 1);
  for (const [
    index,
    { payload_json, ...row },
  ] of ratingRows.results.entries()) {
    const processed = index < progressLaneSize;
    expect(row).toEqual({
      operation_id: requiredFixture(seed.rating[index]).operationId,
      revision: processed ? 3 : 1,
      event_progress_state: processed ? "done" : "pending",
      event_progress_updated_at_ms: processed ? nowMs : 100,
      lease_expires_at_ms: 100,
    });
    expect(JSON.parse(payload_json)).toEqual(
      canonicalRatingFixture("fixture", {
        eventId: requiredFixture(seed.rating[index]).plan.params.eventId,
      }).payload,
    );
  }
  for (const table of ["event_write_admissions", "event_leases"])
    expect(
      await env.EVENT_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first("count"),
      table,
    ).toBe(0);
}
