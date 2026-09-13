import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventPrizeAnnouncementPlan,
  buildSundayMonsReminderPlan,
} from "../src/eventPrizeAnnouncementSchedule.ts";
import type {
  WorkflowEvent,
  WorkflowInstanceStatus,
  WorkflowStep,
} from "cloudflare:workers";
import {
  buildEventProgressPlan,
  EVENT_PROGRESS_OUTBOX_DEAD_ROOT,
  EventProgressRetryableError,
  runEventProgressWorkflow,
  sweepEventProgress,
  type EventProgressRatingRepository,
  type EventProgressSweepRepository,
  type EventProgressWorkflowParams,
} from "../src/eventProgress.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import {
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT,
  type EventScheduledRecoveryStore,
  type ScheduledEventRecoveryCandidate,
  type ScheduledEventRecoveryCursor,
} from "../src/eventScheduledRecoveryD1.ts";

function scheduledRecovery(
  events: Record<string, { startAtMs: number; isSundayMons?: boolean }>,
): EventScheduledRecoveryStore {
  let cursor: ScheduledEventRecoveryCursor | null = null;
  let revision = 0;
  const rows = (): ScheduledEventRecoveryCandidate[] =>
    Object.entries(events)
      .map(([eventId, event]) => ({
        cursor: { eventId, startAtMs: event.startAtMs },
        event: {
          eventId,
          status: "scheduled" as const,
          startAtMs: event.startAtMs,
          isSundayMons: event.isSundayMons === true,
        },
      }))
      .sort(
        (left, right) =>
          left.cursor.startAtMs - right.cursor.startAtMs ||
          left.cursor.eventId.localeCompare(right.cursor.eventId),
      );
  return {
    readCursor: async () => ({ cursor, revision }),
    listUrgent: async (throughMs) =>
      rows()
        .filter((row) => row.cursor.startAtMs <= throughMs)
        .slice(0, SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT),
    listPage: async (after) =>
      rows()
        .filter(
          ({ cursor: key }) =>
            !after ||
            key.startAtMs > after.startAtMs ||
            (key.startAtMs === after.startAtMs && key.eventId > after.eventId),
        )
        .slice(0, SCHEDULED_EVENT_RECOVERY_PAGE_SIZE + 1),
    checkpoint: async (expected, next) => {
      if (revision !== expected) return false;
      cursor = next;
      revision += 1;
      return true;
    },
  };
}

function workflowEnvironment({
  status = "waiting",
  onCreate = () => undefined,
  onDelete = () => undefined,
}: {
  status?: WorkflowInstanceStatus;
  onCreate?: () => void;
  onDelete?: () => void;
} = {}): Env {
  const instance = {
    id: "event-progress-test",
    delete: async () => onDelete(),
    pause: async () => undefined,
    restart: async () => undefined,
    resume: async () => undefined,
    sendEvent: async () => undefined,
    status: async () => ({ status }),
    terminate: async () => undefined,
  } satisfies WorkflowInstance;
  return {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => instance,
      createBatch: async () => {
        onCreate();
        return [instance];
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async () => instance,
    },
  };
}

function sweepRepository(
  outbox: Record<string, unknown>,
  onPatch?: (updates: Record<string, unknown>) => void | Promise<void>,
) {
  const patches: Record<string, unknown>[] = [];
  const value: EventProgressSweepRepository = {
    readEvent: async () => null,
    getStatePath: async (path) => {
      if (path === "eventProgressOutbox") return outbox;
      return null;
    },
    patchStateRoot: async (updates) => {
      await onPatch?.(updates);
      patches.push(updates);
    },
  };
  return { patches, value };
}

async function validOutbox() {
  const plan = await buildEventProgressPlan(
    {
      eventId: "event-1",
      reason: "test",
      runAtMs: null,
      sourceKey: "timer:invite-1:match-1",
    },
    1_000,
  );
  return { plan, value: { [plan.outboxId]: plan.outbox } };
}

test("scheduled-event sweep discovers both announcements and retains their first scheduling time", async () => {
  const eventId = "z3oj52Iiime";
  const event = {
    status: "scheduled",
    isSundayMons: true,
    startAtMs: 30_000_000,
  };
  let nowMs = 100_000;
  const records = new Map<string, unknown>();
  let creates = 0;
  const recovery = scheduledRecovery({ [eventId]: event });
  const repository: EventProgressSweepRepository = {
    readEvent: async (id) => (id === eventId ? event : null),
    getStatePath: async (path) => {
      if (path === "eventProgressOutbox") return {};
      return records.get(path) ?? null;
    },
    patchStateRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates))
        records.set(path, value);
    },
  };
  const environment = workflowEnvironment({ onCreate: () => creates++ });
  await sweepEventProgress(environment, {
    now: () => nowMs,
    repository,
    ratingRepository: null,
    scheduledRecovery: recovery,
  });
  const plan = await buildEventPrizeAnnouncementPlan(eventId, event, nowMs);
  const reminder = await buildSundayMonsReminderPlan(eventId, event, nowMs);
  assert.ok(plan);
  assert.ok(reminder);
  assert.deepEqual(
    records.get(`eventProgressOutbox/${plan.outboxId}`),
    plan.outbox,
  );
  assert.deepEqual(
    records.get(`eventProgressOutbox/${reminder.outboxId}`),
    reminder.outbox,
  );
  assert.equal(creates, 3);
  nowMs += 60_000;
  await sweepEventProgress(environment, {
    now: () => nowMs,
    repository,
    ratingRepository: null,
    scheduledRecovery: recovery,
  });
  assert.deepEqual(
    records.get(`eventProgressOutbox/${plan.outboxId}`),
    plan.outbox,
  );
  assert.deepEqual(
    records.get(`eventProgressOutbox/${reminder.outboxId}`),
    reminder.outbox,
  );
  assert.equal(creates, 6);
});

test("scheduled recovery rotates beyond 1,000 events in bounded pages", async () => {
  const events = Object.fromEntries(
    Array.from({ length: 1_005 }, (_, index) => [
      `event-${String(index).padStart(4, "0")}`,
      { startAtMs: 50_000_000 },
    ]),
  );
  const recovery = scheduledRecovery(events);
  const environment = workflowEnvironment();
  const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
  const seen = new Set<string>();
  let count = 0;
  environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
    for (const item of items) {
      seen.add(item.params!.eventId);
      count += 1;
    }
    return create(items);
  };
  for (let page = 0; page < 11; page += 1) {
    const before = count;
    await sweepEventProgress(environment, {
      now: () => 1_000,
      repository: sweepRepository({}).value,
      scheduledRecovery: recovery,
      ratingRepository: null,
    });
    assert.equal(count - before, page === 10 ? 5 : 100);
  }
  assert.equal(seen.size, 1_005);
  assert.deepEqual(await recovery.readCursor(), { cursor: null, revision: 11 });
});

test("urgent announcement deadlines are checked independently of the background cursor", async () => {
  const nowMs = 1_000_000;
  const eventId = "z3oj52Iiime";
  const recovery = scheduledRecovery({
    [eventId]: {
      isSundayMons: true,
      startAtMs: nowMs + 14_400_000 + 5 * 60_000,
    },
    distant: { startAtMs: 100_000_000 },
  });
  const started: string[] = [];
  const observeStart = (row: ScheduledEventRecoveryCandidate) => ({
    cursor: row.cursor,
    get event() {
      started.push(row.cursor.eventId);
      return row.event;
    },
  });
  const listUrgent = recovery.listUrgent;
  const listPage = recovery.listPage;
  recovery.listUrgent = async (throughMs) =>
    (await listUrgent(throughMs)).map(observeStart);
  recovery.listPage = async (after) =>
    (await listPage(after)).map(observeStart);
  await recovery.checkpoint(0, { eventId: "middle", startAtMs: 50_000_000 }, 0);
  const environment = workflowEnvironment();
  const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
  const created: Array<{ eventId: string; reason: string }> = [];
  environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
    for (const item of items) created.push(item.params!);
    return create(items);
  };
  await sweepEventProgress(environment, {
    now: () => nowMs,
    repository: sweepRepository({}).value,
    scheduledRecovery: recovery,
    ratingRepository: null,
  });
  assert.deepEqual(
    new Set(
      created
        .filter((plan) => plan.eventId === eventId)
        .map((plan) => plan.reason),
    ),
    new Set([
      "scheduled-start-reconciliation",
      "event-prize-announcement",
      "sunday-mons-reminder",
    ]),
  );
  assert(created.some((plan) => plan.eventId === "distant"));
  assert.deepEqual(started, [eventId, "distant"]);
});

test("recovery deduplicates urgent and background rows and bounds event concurrency", async () => {
  const events = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      `event-${String(index).padStart(4, "0")}`,
      { startAtMs: 10_000 },
    ]),
  );
  const recovery = scheduledRecovery(events);
  const environment = workflowEnvironment();
  const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
  const created: string[] = [];
  let running = 0;
  let maximum = 0;
  environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
    created.push(items[0].params!.eventId);
    running += 1;
    maximum = Math.max(maximum, running);
    await new Promise<void>((resolve) => setImmediate(resolve));
    running -= 1;
    return create(items);
  };
  await sweepEventProgress(environment, {
    now: () => 1_000,
    repository: sweepRepository({}).value,
    scheduledRecovery: recovery,
    ratingRepository: null,
  });
  assert.equal(created.length, 25);
  assert.equal(new Set(created).size, 25);
  assert(maximum > 1 && maximum <= 10);
});

test("a failed or malformed event cannot block later recovery rows or cursor progress", async () => {
  const events = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      `event-${String(index).padStart(4, "0")}`,
      { startAtMs: 50_000_000 },
    ]),
  );
  const recovery = scheduledRecovery(events);
  const listPage = recovery.listPage;
  recovery.listPage = async (after) =>
    (await listPage(after)).map((row) =>
      row.cursor.eventId === "event-0001" ? { ...row, event: null } : row,
    );
  const attempted = new Set<string>();
  const repository = sweepRepository({}, async (updates) => {
    for (const value of Object.values(updates)) {
      if (!value || typeof value !== "object" || !("eventId" in value))
        continue;
      const eventId = String(value.eventId);
      attempted.add(eventId);
      if (eventId === "event-0000") throw new Error("event-persistence-failed");
    }
  });
  await assert.rejects(
    sweepEventProgress(workflowEnvironment(), {
      now: () => 1_000,
      repository: repository.value,
      scheduledRecovery: recovery,
      ratingRepository: null,
    }),
    /scheduled-event-reconciliation-failed/,
  );
  assert.equal(attempted.size, 99);
  assert(attempted.has("event-0099"));
  assert.deepEqual(await recovery.readCursor(), {
    cursor: { eventId: "event-0099", startAtMs: 50_000_000 },
    revision: 1,
  });
  await sweepEventProgress(workflowEnvironment(), {
    now: () => 1_000,
    repository: repository.value,
    scheduledRecovery: recovery,
    ratingRepository: null,
  });
  assert(attempted.has("event-0100"));
  assert.deepEqual(await recovery.readCursor(), { cursor: null, revision: 2 });
  assert(events["event-0000"]);
  assert.equal((await recovery.listPage(null))[0].cursor.eventId, "event-0000");
});

for (const method of ["readCursor", "listPage"] as const) {
  test(
    `urgent recovery proceeds while ${method} stalls and then fails`,
    { timeout: 2_000 },
    async () => {
      const nowMs = 1_000_000;
      const eventId = "z3oj52Iiime";
      const recovery = scheduledRecovery({
        [eventId]: {
          isSundayMons: true,
          startAtMs: nowMs + 14_400_000 + 30_000,
        },
      });
      const dispatched = Promise.withResolvers<void>();
      const environment = workflowEnvironment();
      const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
      const reasons: string[] = [];
      let checkpoints = 0;
      environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
        reasons.push(...items.map((item) => item.params!.reason));
        if (reasons.length === 3) dispatched.resolve();
        return create(items);
      };
      const failing = {
        ...recovery,
        [method]: async () => {
          await dispatched.promise;
          throw new Error(`${method}-failed`);
        },
        checkpoint: async () => {
          checkpoints++;
          return true;
        },
      };
      await assert.rejects(
        sweepEventProgress(environment, {
          now: () => nowMs,
          repository: sweepRepository({}).value,
          scheduledRecovery: failing,
          ratingRepository: null,
        }),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some(
            (cause: unknown) =>
              cause instanceof Error && cause.message === `${method}-failed`,
          ),
      );
      assert.deepEqual(
        new Set(reasons),
        new Set([
          "scheduled-start-reconciliation",
          "event-prize-announcement",
          "sunday-mons-reminder",
        ]),
      );
      assert.equal(checkpoints, 0);
      assert.deepEqual(await recovery.readCursor(), {
        cursor: null,
        revision: 0,
      });
    },
  );
}

test("background recovery continues after an urgent read failure without advancing the cursor", async () => {
  const recovery = scheduledRecovery({ first: { startAtMs: 50_000_000 } });
  let creates = 0;
  await assert.rejects(
    sweepEventProgress(workflowEnvironment({ onCreate: () => creates++ }), {
      now: () => 1_000,
      repository: sweepRepository({}).value,
      scheduledRecovery: {
        ...recovery,
        listUrgent: async () => {
          throw new Error("urgent-read-failed");
        },
      },
      ratingRepository: null,
    }),
    /scheduled-event-reconciliation-failed/,
  );
  assert.equal(creates, 1);
  assert.deepEqual(await recovery.readCursor(), { cursor: null, revision: 0 });
});

test("failed recovery queries and checkpoints preserve the cursor for replay", async () => {
  const recovery = scheduledRecovery({ first: { startAtMs: 50_000_000 } });
  const repository = sweepRepository({});
  const environment = workflowEnvironment();
  const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
  const created: string[] = [];
  environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
    created.push(items[0].id!);
    return create(items);
  };
  for (const failing of [
    {
      ...recovery,
      listPage: async () => {
        throw new Error("list-failed");
      },
    },
    {
      ...recovery,
      checkpoint: async () => {
        throw new Error("checkpoint-failed");
      },
    },
  ]) {
    await assert.rejects(
      sweepEventProgress(environment, {
        now: () => 1_000,
        repository: repository.value,
        scheduledRecovery: failing,
        ratingRepository: null,
      }),
    );
    assert.deepEqual(await recovery.readCursor(), {
      cursor: null,
      revision: 0,
    });
  }
  assert.equal(created.length, 1);
  await sweepEventProgress(environment, {
    now: () => 1_000,
    repository: repository.value,
    scheduledRecovery: recovery,
    ratingRepository: null,
  });
  assert.equal(created.length, 2);
  assert.equal(created[0], created[1]);
});

test("a failed concurrent dispatch keeps its sweep admitted until every other provider call settles", async () => {
  const first = await buildEventProgressPlan(
    { eventId: "event-1", reason: "test", sourceKey: "first" },
    100,
  );
  const second = await buildEventProgressPlan(
    { eventId: "event-1", reason: "test", sourceKey: "second" },
    100,
  );
  const delayed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const environment = workflowEnvironment();
  const originalGet = environment.EVENT_PROGRESS_WORKFLOW.get;
  environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
    if (items[0].id === first.workflowId)
      throw new Error("first-dispatch-failed");
    started.resolve();
    await delayed.promise;
    return [];
  };
  environment.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
    if (id === first.workflowId) {
      failed.resolve();
      throw new Error("first-workflow-missing");
    }
    return originalGet(id);
  };
  let released = false;
  const originalPrepare = environment.EVENT_DB.prepare;
  environment.EVENT_DB = {
    batch: environment.EVENT_DB.batch,
    dump: environment.EVENT_DB.dump,
    exec: environment.EVENT_DB.exec,
    withSession: environment.EVENT_DB.withSession,
    prepare: (query) => {
      if (query.includes("DELETE FROM event_write_admissions")) released = true;
      return originalPrepare(query);
    },
  };
  const repository = sweepRepository({
    [first.outboxId]: first.outbox,
    [second.outboxId]: second.outbox,
  });
  let completed = false;
  const sweep = sweepEventProgress(environment, {
    repository: repository.value,
    ratingRepository: null,
  }).then(
    () => {
      completed = true;
      return null;
    },
    (error: unknown) => {
      completed = true;
      return error;
    },
  );
  await Promise.all([started.promise, failed.promise]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(released, false);
  delayed.resolve();
  const error = await sweep;
  assert(error instanceof Error && error.message === "first-dispatch-failed");
  assert.equal(released, true);
});

test("both announcements survive slow start dispatch and all three jobs can fail independently", async () => {
  for (const scenario of [
    "slow-start",
    "failed-start",
    "failed-prize",
    "failed-reminder",
  ]) {
    const targetMs = 10_000_000;
    const eventId = "z3oj52Iiime";
    const event = {
      status: "scheduled",
      isSundayMons: true,
      startAtMs: targetMs + 14_400_000,
    };
    let nowMs = targetMs - 1_000;
    let failedId: string | undefined;
    const records = new Map<string, unknown>();
    const created: string[] = [];
    const prize = await buildEventPrizeAnnouncementPlan(eventId, event, nowMs);
    const reminder = await buildSundayMonsReminderPlan(eventId, event, nowMs);
    assert.ok(prize);
    assert.ok(reminder);
    const failureReason =
      scenario === "failed-prize"
        ? prize.params.reason
        : scenario === "failed-reminder"
          ? reminder.params.reason
          : scenario === "failed-start"
            ? "scheduled-start-reconciliation"
            : null;
    const repository: EventProgressSweepRepository = {
      readEvent: async (id) => (id === eventId ? event : null),
      getStatePath: async (path) =>
        path === "eventProgressOutbox" ? {} : (records.get(path) ?? null),
      patchStateRoot: async (updates) => {
        for (const [path, value] of Object.entries(updates))
          records.set(path, value);
      },
    };
    const environment = workflowEnvironment();
    const instance =
      await environment.EVENT_PROGRESS_WORKFLOW.get("test-instance");
    environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      return items.map((item) => {
        if (item.params?.reason === failureReason) {
          failedId = item.id;
          throw new Error("dispatch-failed");
        }
        created.push(item.params!.reason);
        return instance;
      });
    };
    environment.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
      if (id === failedId) throw new Error("instance-missing");
      instance.status = async () => {
        nowMs += 1_500;
        return { status: "waiting" };
      };
      return instance;
    };
    const run = () =>
      sweepEventProgress(environment, {
        now: () => nowMs,
        repository,
        ratingRepository: null,
        scheduledRecovery: scheduledRecovery({ [eventId]: event }),
      });
    if (scenario === "slow-start") await run();
    else await assert.rejects(run(), /scheduled-event-reconciliation-failed/);
    assert.deepEqual(
      records.get(`eventProgressOutbox/${prize.outboxId}`),
      prize.outbox,
    );
    assert.deepEqual(
      records.get(`eventProgressOutbox/${reminder.outboxId}`),
      reminder.outbox,
    );
    assert.deepEqual(
      new Set(created),
      new Set(
        [
          "scheduled-start-reconciliation",
          prize.params.reason,
          reminder.params.reason,
        ].filter((reason) => reason !== failureReason),
      ),
    );
  }
});

test("recreates terminal event progress Workflow instances", async () => {
  const outbox = await validOutbox();
  const repository = sweepRepository(outbox.value);
  let creates = 0;
  let deletes = 0;
  await sweepEventProgress(
    workflowEnvironment({
      status: "errored",
      onCreate: () => creates++,
      onDelete: () => deletes++,
    }),
    {
      now: () => 2_000,
      ratingRepository: null,
      repository: repository.value,
    },
  );
  assert.equal(creates, 2);
  assert.equal(deletes, 1);
  assert.equal(repository.patches.length, 0);
});

test("recreates operator-terminated event progress Workflow instances", async () => {
  const outbox = await validOutbox();
  const repository = sweepRepository(outbox.value);
  let deletes = 0;
  await sweepEventProgress(
    workflowEnvironment({
      status: "terminated",
      onDelete: () => deletes++,
    }),
    {
      now: () => 2_000,
      ratingRepository: null,
      repository: repository.value,
    },
  );
  assert.equal(deletes, 1);
});

test("removes outbox records for completed Workflow instances", async () => {
  const outbox = await validOutbox();
  const repository = sweepRepository(outbox.value);
  await sweepEventProgress(workflowEnvironment({ status: "complete" }), {
    now: () => 2_000,
    ratingRepository: null,
    repository: repository.value,
  });
  assert.deepEqual(repository.patches, [
    { [`eventProgressOutbox/${outbox.plan.outboxId}`]: null },
  ]);
});

test("atomically dead-letters malformed outbox records", async () => {
  const originalRecord = { schemaVersion: 2 };
  const repository = sweepRepository({ "bad-record": originalRecord });
  await sweepEventProgress(workflowEnvironment(), {
    now: () => 2_000,
    ratingRepository: null,
    repository: repository.value,
  });
  assert.deepEqual(repository.patches, [
    {
      [`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/bad-record`]: {
        deadAtMs: 2_000,
        originalRecord,
        reason: "invalid-event-progress-outbox",
      },
      "eventProgressOutbox/bad-record": null,
    },
  ]);
});

test("dead-letters outbox records whose key mismatches their source", async () => {
  const outbox = await validOutbox();
  const mismatchedOutboxId = `ep_${"0".repeat(64)}`;
  const repository = sweepRepository({
    [mismatchedOutboxId]: outbox.plan.outbox,
  });
  let workflowCreates = 0;
  await sweepEventProgress(
    workflowEnvironment({ onCreate: () => workflowCreates++ }),
    {
      now: () => 2_000,
      ratingRepository: null,
      repository: repository.value,
    },
  );
  assert.equal(workflowCreates, 0);
  assert.deepEqual(repository.patches, [
    {
      [`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/${mismatchedOutboxId}`]: {
        deadAtMs: 2_000,
        originalRecord: outbox.plan.outbox,
        reason: "invalid-event-progress-outbox",
      },
      [`eventProgressOutbox/${mismatchedOutboxId}`]: null,
    },
  ]);
});

test("dispatches valid outbox records before reporting dead-letter failure", async () => {
  const outbox = await validOutbox();
  let workflowCreates = 0;
  const repository = sweepRepository(
    { ...outbox.value, "bad-record": { schemaVersion: 2 } },
    (updates) => {
      if (
        Object.keys(updates).some((path) =>
          path.startsWith(`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/`),
        )
      ) {
        throw new Error("dead-letter-unavailable");
      }
    },
  );
  await assert.rejects(
    sweepEventProgress(
      workflowEnvironment({ onCreate: () => workflowCreates++ }),
      {
        now: () => 2_000,
        ratingRepository: null,
        repository: repository.value,
      },
    ),
    /dead-letter-unavailable/,
  );
  assert.equal(workflowCreates, 1);
  assert.deepEqual(repository.patches, [
    {
      [`eventProgressOutbox/${outbox.plan.outboxId}/lastQueuedAtMs`]: 2_000,
    },
  ]);
});

test("recovers a finalized event rating when its outbox write was lost", async () => {
  const repository = sweepRepository({});
  const calls: string[] = [];
  const ratingRepository = {
    claimRatingEventProgress: async () => {
      calls.push("claim");
      return true;
    },
    listDueRatingEventProgress: async () => [
      {
        eventId: "event-1",
        inviteId: "invite-1",
        matchId: "match-1",
        operationId: "invite-1__match-1",
        updateTime: "2026-08-25T00:00:00Z",
        version: 1,
      },
    ],
    markRatingEventProgress: async (_operationId, state) => {
      calls.push(state);
    },
  } satisfies EventProgressRatingRepository;
  let workflowCreates = 0;
  await sweepEventProgress(
    workflowEnvironment({ onCreate: () => workflowCreates++ }),
    {
      now: () => 2_000,
      ratingRepository,
      repository: repository.value,
    },
  );
  assert.equal(workflowCreates, 1);
  assert.deepEqual(calls, ["claim", "done"]);
  const outboxPatch = repository.patches.find((patch) =>
    Object.keys(patch).some((path) =>
      path.startsWith("eventProgressOutbox/ep_"),
    ),
  );
  assert.ok(outboxPatch);
  const outbox = Object.values(outboxPatch)[0] as Record<string, unknown>;
  assert.deepEqual(
    {
      eventId: outbox.eventId,
      reason: outbox.reason,
      sourceKey: outbox.sourceKey,
    },
    {
      eventId: "event-1",
      reason: "match-rating-updated",
      sourceKey: "rating:invite-1:match-1",
    },
  );
});

type StepCall = { config: unknown; name: string };

function workflowStep({ retryOnce = false } = {}) {
  const calls: StepCall[] = [];
  const sleeps: Array<{ name: string; timestamp: Date | number }> = [];
  const value = {
    do: async (...args: unknown[]) => {
      const name = args[0];
      const config = args[1];
      const callback = args[2];
      assert.equal(typeof name, "string");
      assert.equal(typeof callback, "function");
      calls.push({ config, name: name as string });
      try {
        return await (callback as () => Promise<unknown>)();
      } catch (error) {
        if (!retryOnce || name !== "synchronize event") throw error;
        assert.ok(error instanceof EventProgressRetryableError);
        return (callback as () => Promise<unknown>)();
      }
    },
    sleep: async () => undefined,
    sleepUntil: async (name: string, timestamp: Date | number) => {
      sleeps.push({ name, timestamp });
    },
    waitForEvent: async () => {
      throw new Error("unexpected waitForEvent");
    },
  } as unknown as WorkflowStep;
  return { calls, sleeps, value };
}

function workflowEvent(
  params: EventProgressWorkflowParams,
): Readonly<WorkflowEvent<EventProgressWorkflowParams>> {
  return {
    instanceId: "instance-1",
    payload: params,
    timestamp: new Date(1_000),
    workflowName: "mons-link-event-progress",
  };
}

test("sleeps for future progress, configures capped retries, and acknowledges", async () => {
  const outbox = await validOutbox();
  const step = workflowStep();
  const acknowledgements: string[] = [];
  const params = { ...outbox.plan.params, runAtMs: 5_000 };
  const result = await runEventProgressWorkflow(
    workflowEvent(params),
    step.value,
    {
      acknowledge: async (outboxId) => {
        acknowledgements.push(outboxId);
      },
      synchronize: async () => ({ didChange: true }),
    },
  );
  assert.deepEqual(step.sleeps, [
    { name: "wait for scheduled event", timestamp: 5_000 },
  ]);
  assert.deepEqual(result, { status: "applied", didChange: true });
  assert.deepEqual(acknowledgements, [params.outboxId]);
  const synchronizeCall = step.calls[0];
  assert.equal(synchronizeCall.name, "synchronize event");
  const config = synchronizeCall.config as {
    retries: {
      delay(input: { ctx: { attempt: number } }): number;
      limit: number;
    };
    timeout: number;
  };
  assert.equal(config.retries.limit, 13);
  assert.equal(config.timeout, 30_000);
  assert.equal(config.retries.delay({ ctx: { attempt: 1 } }), 1_000);
  assert.equal(config.retries.delay({ ctx: { attempt: 20 } }), 30_000);
});

test("completes missing events without retry and acknowledges the outbox", async () => {
  const outbox = await validOutbox();
  const step = workflowStep();
  let acknowledged = false;
  const result = await runEventProgressWorkflow(
    workflowEvent(outbox.plan.params),
    step.value,
    {
      acknowledge: async () => {
        acknowledged = true;
      },
      synchronize: async () => {
        throw Object.assign(new Error("missing"), { code: "not-found" });
      },
    },
  );
  assert.deepEqual(result, { status: "not-found" });
  assert.equal(acknowledged, true);
});

test("lets the synchronization step retry a locked event", async () => {
  const outbox = await validOutbox();
  const step = workflowStep({ retryOnce: true });
  let synchronizations = 0;
  const result = await runEventProgressWorkflow(
    workflowEvent(outbox.plan.params),
    step.value,
    {
      acknowledge: async () => undefined,
      synchronize: async () => {
        synchronizations++;
        return synchronizations === 1
          ? { reason: "locked", skipped: true }
          : { didChange: false };
      },
    },
  );
  assert.equal(synchronizations, 2);
  assert.deepEqual(result, { status: "applied", didChange: false });
});
