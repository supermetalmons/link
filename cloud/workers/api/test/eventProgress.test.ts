import type {
  WorkflowEvent,
  WorkflowInstanceStatus,
  WorkflowStep,
} from "cloudflare:workers";
import assert from "node:assert/strict";
import test from "node:test";
import type { EventJsonRecord } from "../../../runtime/eventReads.js";
import { buildEventAnnouncementPlan } from "../src/eventPrizeAnnouncementSchedule.ts";
import {
  buildEventProgressPlan,
  EVENT_PROGRESS_OUTBOX_DEAD_ROOT,
  EventProgressRetryableError,
  runEventProgressWorkflow,
  sweepEventProgress as runEventProgressSweep,
  type EventProgressRatingRepository,
  type EventProgressSweepRepository,
  type EventProgressSweepDependencies,
  type EventProgressWorkflowParams,
} from "../src/eventProgress.ts";
import {
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  SCHEDULED_EVENT_RECOVERY_URGENT_LIMIT,
  type EventScheduledRecoveryStore,
  type ScheduledEventRecoveryCandidate,
  type ScheduledEventRecoveryCursor,
} from "../src/eventScheduledRecoveryD1.ts";
import {
  attachEventTestPorts,
  type EventTestSource,
} from "./eventTestPorts.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import { createEventProgressRecoveryTestStore } from "./eventProgressRecoveryTestStore.ts";

const outboxRecoveryStores = new WeakMap<
  EventProgressSweepRepository,
  ReturnType<typeof createEventProgressRecoveryTestStore>
>();

function sweepEventProgress(
  env: Env,
  dependencies: EventProgressSweepDependencies,
): Promise<void> {
  const { repository } = dependencies;
  if (!repository) throw new Error("missing-test-event-repository");
  let outboxRecovery = outboxRecoveryStores.get(repository);
  if (!outboxRecovery) {
    outboxRecovery = createEventProgressRecoveryTestStore(repository);
    outboxRecoveryStores.set(repository, outboxRecovery);
  }
  return runEventProgressSweep(env, { outboxRecovery, ...dependencies });
}

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
  const records = new Map(
    Object.entries(outbox).map(([id, value]) => [
      `eventProgressOutbox/${id}`,
      value,
    ]),
  );
  const value: EventProgressSweepRepository = attachEventTestPorts<
    EventProgressSweepRepository & EventTestSource
  >({
    readEvent: async () => null,
    listDueEventProgressOutboxes: async (beforeMs, limit) => {
      assert.equal(beforeMs, Number.MAX_SAFE_INTEGER);
      assert.equal(limit, 10);
      return Object.entries(outbox).map(([outboxId, record]) => ({
        outboxId,
        record,
      }));
    },
    getStatePath: async (path) => records.get(path) ?? null,
    patchStateRoot: async (updates) => {
      await onPatch?.(updates);
      patches.push(updates);
      for (const [path, value] of Object.entries(updates)) {
        if (value === null) records.delete(path);
        else records.set(path, value);
      }
    },
  });
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

function ratingRecoveryRecords(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `rating-event-${index}`,
    inviteId: `rating-invite-${index}`,
    matchId: "match-1",
    operationId: `rating-invite-${index}__match-1`,
    revision: 1,
    version: 1,
  }));
}

for (const scenario of ["outbox-read", "outbox-dispatch"] as const) {
  test(
    `scheduled and rating recovery continue while ${scenario} stalls and fails`,
    { timeout: 10_000 },
    async () => {
      const nowMs = 1_000_000;
      const eventId = "z3oj52Iiime";
      const outbox = await validOutbox();
      const healthyDispatched = Promise.withResolvers<void>();
      const reasons = new Set<string>();
      const failure = new Error(`${scenario}-failed`);
      const environment = workflowEnvironment();
      const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
      const get = environment.EVENT_PROGRESS_WORKFLOW.get;
      environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
        if (
          scenario === "outbox-dispatch" &&
          items[0].id === outbox.plan.workflowId
        ) {
          await healthyDispatched.promise;
          throw failure;
        }
        for (const item of items) reasons.add(item.params!.reason);
        if (reasons.size === 4) healthyDispatched.resolve();
        return create(items);
      };
      environment.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
        if (scenario === "outbox-dispatch" && id === outbox.plan.workflowId)
          throw failure;
        return get(id);
      };
      const repository = sweepRepository(
        scenario === "outbox-dispatch" ? outbox.value : {},
      );
      if (scenario === "outbox-read") {
        repository.value.listDueEventProgressOutboxes = async () => {
          await healthyDispatched.promise;
          throw failure;
        };
      }
      const recovery = scheduledRecovery({
        [eventId]: {
          isSundayMons: true,
          startAtMs: nowMs + 14_400_000 + 30_000,
        },
      });
      let ratingDone = false;
      await assert.rejects(
        sweepEventProgress(environment, {
          now: () => nowMs,
          repository: repository.value,
          scheduledRecovery: recovery,
          ratingRepository: {
            listDueRatingEventProgress: async () => ratingRecoveryRecords(),
            claimRatingEventProgress: async () => true,
            markRatingEventProgress: async (_id, status) => {
              ratingDone = status === "done";
            },
          },
        }),
        (error) => error === failure,
      );
      assert.deepEqual(
        reasons,
        new Set([
          "scheduled-start-reconciliation",
          "sunday-mons-reminder",
          "event-prize-announcement",
          "match-rating-updated",
        ]),
      );
      assert.equal(ratingDone, true);
      assert.equal((await recovery.readCursor()).revision, 1);
    },
  );
}

test(
  "outbox and scheduled recovery continue while the rating query stalls and fails",
  { timeout: 10_000 },
  async () => {
    const outbox = await validOutbox();
    const healthyDispatched = Promise.withResolvers<void>();
    const reasons = new Set<string>();
    const environment = workflowEnvironment();
    const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
    environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      for (const item of items) reasons.add(item.params!.reason);
      if (reasons.size === 2) healthyDispatched.resolve();
      return create(items);
    };
    await assert.rejects(
      sweepEventProgress(environment, {
        now: () => 1_000,
        repository: sweepRepository(outbox.value).value,
        scheduledRecovery: scheduledRecovery({
          scheduled: { startAtMs: 10_000 },
        }),
        ratingRepository: {
          listDueRatingEventProgress: async () => {
            await healthyDispatched.promise;
            throw new Error("rating-read-failed");
          },
          claimRatingEventProgress: async () => true,
          markRatingEventProgress: async () => {},
        },
      }),
      /rating-read-failed/,
    );
    assert.deepEqual(
      reasons,
      new Set(["test", "scheduled-start-reconciliation"]),
    );
  },
);

test(
  "recovery reserves ten scheduled slots and five slots each for mixed outboxes and ratings",
  { timeout: 10_000 },
  async () => {
    const release = Promise.withResolvers<void>();
    const full = Promise.withResolvers<void>();
    const active = { outbox: 0, rating: 0, scheduled: 0 };
    const maximum = { ...active };
    const wait = async (lane: keyof typeof active) => {
      active[lane]++;
      maximum[lane] = Math.max(maximum[lane], active[lane]);
      if (active.outbox === 5 && active.rating === 5 && active.scheduled === 10)
        full.resolve();
      await release.promise;
      active[lane]--;
    };
    const outboxes = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        if (index % 2) return [`bad-${index}`, { schemaVersion: 2 }] as const;
        const plan = await buildEventProgressPlan(
          {
            eventId: `outbox-${index}`,
            sourceKey: `test-${index}`,
            reason: "outbox",
          },
          100,
        );
        return [plan.outboxId, plan.outbox] as const;
      }),
    );
    const environment = workflowEnvironment();
    const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
    environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      const reason = items[0].params!.reason;
      if (reason === "outbox") await wait("outbox");
      if (reason === "scheduled-start-reconciliation") await wait("scheduled");
      return create(items);
    };
    const repository = sweepRepository(
      Object.fromEntries(outboxes),
      async (updates) => {
        if (
          Object.keys(updates).some((path) =>
            path.startsWith(`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/`),
          )
        )
          await wait("outbox");
      },
    );
    const events = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `scheduled-${index}`,
        { startAtMs: 10_000 },
      ]),
    );
    const sweep = sweepEventProgress(environment, {
      now: () => 1_000,
      repository: repository.value,
      scheduledRecovery: scheduledRecovery(events),
      ratingRepository: {
        listDueRatingEventProgress: async () => ratingRecoveryRecords(10),
        claimRatingEventProgress: async () => {
          await wait("rating");
          return true;
        },
        markRatingEventProgress: async () => {},
      },
    });
    await full.promise;
    assert.deepEqual(maximum, { outbox: 5, rating: 5, scheduled: 10 });
    release.resolve();
    await sweep;
    assert.deepEqual(maximum, { outbox: 5, rating: 5, scheduled: 10 });
  },
);

test("failed records cannot exhaust outbox or rating runners before the rest of the page", async () => {
  const outboxes = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      if (index < 5) return [`bad-${index}`, { schemaVersion: 2 }] as const;
      const plan = await buildEventProgressPlan(
        {
          eventId: `outbox-${index}`,
          sourceKey: `test-${index}`,
          reason: "outbox",
        },
        100,
      );
      return [plan.outboxId, plan.outbox] as const;
    }),
  );
  let dispatched = 0;
  const claimed: string[] = [];
  const done: string[] = [];
  const repository = sweepRepository(
    Object.fromEntries(outboxes),
    async (updates) => {
      if (
        Object.keys(updates).some((path) =>
          path.startsWith(`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/`),
        )
      )
        throw new Error("invalid-outbox-write-failed");
    },
  );
  await assert.rejects(
    sweepEventProgress(workflowEnvironment({ onCreate: () => dispatched++ }), {
      now: () => 1_000,
      repository: repository.value,
      scheduledRecovery: scheduledRecovery({}),
      ratingRepository: {
        listDueRatingEventProgress: async () => ratingRecoveryRecords(10),
        claimRatingEventProgress: async (id) => {
          claimed.push(id);
          if (claimed.length <= 5) throw new Error("rating-claim-failed");
          return true;
        },
        markRatingEventProgress: async (id, status) => {
          if (status === "done") done.push(id);
        },
      },
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(dispatched, 10);
  assert.equal(claimed.length, 10);
  assert.equal(done.length, 5);
});

for (const kind of ["start", "reminder"] as const) {
  test(
    `same-ID ${kind} scheduling waits for recreation and respects its retry checkpoint`,
    { timeout: 10_000 },
    async () => {
      const nowMs = 1_000_000;
      const eventId = "z3oj52Iiime";
      const event = {
        isSundayMons: kind === "reminder",
        startAtMs: nowMs + 14_400_000 + 30_000,
      };
      const plan =
        kind === "start"
          ? await buildEventProgressPlan(
              {
                eventId,
                sourceKey: `start:${eventId}:${event.startAtMs}`,
                reason: "scheduled-start-reconciliation",
                runAtMs: event.startAtMs,
              },
              100,
            )
          : await buildEventAnnouncementPlan(
              eventId,
              { ...event, status: "scheduled" },
              100,
              "reminder",
            );
      assert.ok(plan);
      const providerStarted = Promise.withResolvers<void>();
      const candidatesRead = Promise.withResolvers<void>();
      const recovery = scheduledRecovery({ [eventId]: event });
      const listUrgent = recovery.listUrgent;
      recovery.listUrgent = async (throughMs) => {
        await providerStarted.promise;
        const rows = await listUrgent(throughMs);
        candidatesRead.resolve();
        return rows;
      };
      let recreating = false;
      let creates = 0;
      let current: EventJsonRecord | null = plan.outbox;
      const operations: string[] = [];
      const repository: EventProgressSweepRepository = {
        readEvent: async () => null,
        listDueEventProgressOutboxes: async () => [
          { outboxId: plan.outboxId, record: plan.outbox },
        ],
        readEventProgressOutbox: async (id) => {
          if (id !== plan.outboxId) return null;
          assert.equal(recreating, false);
          operations.push("read");
          return current;
        },
        commitEventPlan: async (commands) => {
          for (const command of commands) {
            if (
              command.kind !== "progress-outbox" ||
              command.outboxId !== plan.outboxId
            )
              continue;
            assert.equal(recreating, false);
            current = command.value;
            operations.push(command.value === null ? "remove" : "publish");
          }
        },
      };
      const environment = workflowEnvironment();
      const create = environment.EVENT_PROGRESS_WORKFLOW.createBatch;
      const get = environment.EVENT_PROGRESS_WORKFLOW.get;
      const original = await get(plan.workflowId);
      environment.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
        if (items[0].id === plan.workflowId) {
          creates++;
          operations.push(`create-${creates}`);
          if (creates === 1) {
            recreating = true;
            providerStarted.resolve();
            await candidatesRead.promise;
          } else if (creates === 2) {
            recreating = false;
          }
        }
        return create(items);
      };
      environment.EVENT_PROGRESS_WORKFLOW.get = async (id) =>
        id === plan.workflowId
          ? {
              ...original,
              pause: () => original.pause(),
              resume: () => original.resume(),
              terminate: () => original.terminate(),
              restart: () => original.restart(),
              sendEvent: (event) => original.sendEvent(event),
              status: async () => ({
                status: creates === 1 ? "errored" : "complete",
              }),
              delete: async () => {
                operations.push("delete");
              },
            }
          : get(id);
      await sweepEventProgress(environment, {
        now: () => nowMs,
        repository,
        scheduledRecovery: recovery,
        ratingRepository: null,
      });
      assert.equal(creates, 2);
      assert.deepEqual(
        operations.filter((operation) =>
          /^(create-|delete|remove)/.test(operation),
        ),
        ["create-1", "delete", "create-2"],
      );
      assert.deepEqual(current, plan.outbox);
    },
  );
}

test(
  "stale malformed outbox snapshots cannot delete an announcement repaired by another lane",
  { timeout: 10_000 },
  async () => {
    const nowMs = 1_000_000;
    const eventId = "z3oj52Iiime";
    const event = {
      status: "scheduled",
      isSundayMons: true,
      startAtMs: nowMs + 14_400_000 + 30_000,
    };
    const plan = await buildEventAnnouncementPlan(
      eventId,
      event,
      nowMs,
      "reminder",
    );
    assert.ok(plan);
    const published = Promise.withResolvers<void>();
    const malformed = { schemaVersion: 2 };
    let current: EventJsonRecord | null = malformed;
    const repository: EventProgressSweepRepository = {
      readEvent: async () => null,
      listDueEventProgressOutboxes: async () => {
        await published.promise;
        return [{ outboxId: plan.outboxId, record: malformed }];
      },
      readEventProgressOutbox: async (id) =>
        id === plan.outboxId ? current : null,
      commitEventPlan: async (commands) => {
        for (const command of commands) {
          assert.notEqual(command.kind, "progress-dead");
          if (
            command.kind === "progress-outbox" &&
            command.outboxId === plan.outboxId
          ) {
            assert.notEqual(command.value, null);
            current = command.value;
            published.resolve();
          }
        }
      },
    };
    await sweepEventProgress(workflowEnvironment(), {
      now: () => nowMs,
      repository,
      scheduledRecovery: scheduledRecovery({ [eventId]: event }),
      ratingRepository: null,
    });
    assert.deepEqual(current, plan.outbox);
  },
);

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
  const repository: EventProgressSweepRepository = attachEventTestPorts<
    EventProgressSweepRepository & EventTestSource
  >({
    readEvent: async (id) => (id === eventId ? event : null),
    listDueEventProgressOutboxes: async () => [],
    getStatePath: async (path) => records.get(path) ?? null,
    patchStateRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates))
        records.set(path, value);
    },
  });
  const environment = workflowEnvironment({ onCreate: () => creates++ });
  await sweepEventProgress(environment, {
    now: () => nowMs,
    repository,
    ratingRepository: null,
    scheduledRecovery: recovery,
  });
  const plan = await buildEventAnnouncementPlan(
    eventId,
    event,
    nowMs,
    "prizes",
  );
  const reminder = await buildEventAnnouncementPlan(
    eventId,
    event,
    nowMs,
    "reminder",
  );
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
  assert.equal(creates, 3);
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

test("a failed or malformed event cannot block later recovery rows or cursor progress", async (context) => {
  const logs: Array<{ event: string; eventId: string }> = [];
  context.mock.method(console, "error", (value: string) => {
    logs.push(JSON.parse(value));
  });
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
      if (eventId === "event-0000") {
        throw new Error("event-persistence-failed", {
          cause: new Error("database-unavailable"),
        });
      }
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
  assert.deepEqual(
    logs.find((entry) => entry.event === "scheduled_event_recovery_failed"),
    {
      event: "scheduled_event_recovery_failed",
      eventId: "event-0000",
      error: {
        name: "Error",
        message: "event-persistence-failed",
        cause: { name: "Error", message: "database-unavailable" },
      },
    },
  );
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
    { timeout: 10_000 },
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
  assert.equal(created.length, 1);
  assert.deepEqual(await recovery.readCursor(), { cursor: null, revision: 1 });
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
    const prize = await buildEventAnnouncementPlan(
      eventId,
      event,
      nowMs,
      "prizes",
    );
    const reminder = await buildEventAnnouncementPlan(
      eventId,
      event,
      nowMs,
      "reminder",
    );
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
    const repository: EventProgressSweepRepository = attachEventTestPorts<
      EventProgressSweepRepository & EventTestSource
    >({
      readEvent: async (id) => (id === eventId ? event : null),
      listDueEventProgressOutboxes: async () => [],
      getStatePath: async (path) => records.get(path) ?? null,
      patchStateRoot: async (updates) => {
        for (const [path, value] of Object.entries(updates))
          records.set(path, value);
      },
    });
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
  repository.value.readEventProgressOutbox = async () => outbox.plan.outbox;
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
  assert.deepEqual(repository.patches, []);
});

test("recovers a finalized event rating when its outbox write was lost", async () => {
  const repository = sweepRepository({});
  const calls: string[] = [];
  const ratingRepository = {
    claimRatingEventProgress: async (
      operationId,
      expectedRevision,
      claimedAtMs,
    ) => {
      assert.equal(operationId, "invite-1__match-1");
      assert.equal(expectedRevision, 1);
      assert.equal(claimedAtMs, 2_000);
      calls.push("claim");
      return true;
    },
    listDueRatingEventProgress: async () => [
      {
        eventId: "event-1",
        inviteId: "invite-1",
        matchId: "match-1",
        operationId: "invite-1__match-1",
        revision: 1,
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
