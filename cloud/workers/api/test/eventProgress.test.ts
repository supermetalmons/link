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
    getRtdbPath: async (path) => {
      if (path === "eventProgressOutbox") return outbox;
      if (path === "events") return null;
      return null;
    },
    patchRtdbRoot: async (updates) => {
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
  const repository: EventProgressSweepRepository = {
    getRtdbPath: async (path) => {
      if (path === "events") return { [eventId]: event };
      if (path === "eventProgressOutbox") return {};
      return records.get(path) ?? null;
    },
    patchRtdbRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates))
        records.set(path, value);
    },
  };
  const environment = workflowEnvironment({ onCreate: () => creates++ });
  await sweepEventProgress(environment, {
    now: () => nowMs,
    repository,
    ratingRepository: null,
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
      startAtMs: targetMs + 10_800_000,
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
      getRtdbPath: async (path) =>
        path === "events"
          ? { [eventId]: event }
          : path === "eventProgressOutbox"
            ? {}
            : (records.get(path) ?? null),
      patchRtdbRoot: async (updates) => {
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

test("recovers a finalized event rating when its RTDB outbox write was lost", async () => {
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
