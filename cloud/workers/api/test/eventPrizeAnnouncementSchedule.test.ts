import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventPrizeAnnouncementPlan,
  createEventPrizeAnnouncementScheduleRepository,
  EVENT_PRIZE_ANNOUNCEMENT_REASON,
  scheduleEventPrizeAnnouncement,
} from "../src/eventPrizeAnnouncementSchedule.ts";
import {
  buildEventProgressPlan,
  type EventProgressPlan,
} from "../src/eventProgress.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const EVENT_ID = "z3oj52Iiime";
const EVENT_PATH = `events/${EVENT_ID}`;
const NOW_MS = 1_000_000;
const START_AT_MS = 10_000_000;
const TARGET_MS = START_AT_MS - 3_600_000;

function scheduledEvent(overrides: Record<string, unknown> = {}) {
  return {
    status: "scheduled",
    isSundayMons: true,
    startAtMs: START_AT_MS,
    telegramAnnouncements: { invite: false, matches: false, results: false },
    ...overrides,
  };
}

function memoryRepository(
  initial: Record<string, unknown> = {},
  beforeCommit?: GameplayRepository["patchRtdbRoot"],
) {
  let data = structuredClone(initial);
  const patches: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const get = (path: string): unknown => {
    let value: unknown = data;
    for (const key of path.split("/")) {
      if (!value || typeof value !== "object") return null;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? null;
  };
  const repository: GameplayRepository = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    getMiningMaterials: async () => ({
      dust: 0,
      gum: 0,
      ice: 0,
      metal: 0,
      slime: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-read");
    },
    getRtdbPath: async (path) => {
      reads.push(path);
      return structuredClone(get(path));
    },
    patchRtdbRoot: async (updates, signal) => {
      await beforeCommit?.(updates, signal);
      const next = structuredClone(data);
      for (const [path, value] of Object.entries(updates)) {
        const keys = path.split("/");
        const leaf = keys.pop()!;
        let parent = next;
        for (const key of keys) {
          if (!parent[key] || typeof parent[key] !== "object") {
            parent[key] = {};
          }
          parent = parent[key] as Record<string, unknown>;
        }
        if (value === null) delete parent[leaf];
        else parent[leaf] = structuredClone(value);
      }
      data = next;
      patches.push(structuredClone(updates));
    },
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
  return { get, patches, reads, repository };
}

function wrapper(
  memory: ReturnType<typeof memoryRepository>,
  enqueue: (plan: EventProgressPlan) => Promise<void>,
  now: () => number = () => NOW_MS,
) {
  return createEventPrizeAnnouncementScheduleRepository(
    TELEGRAM_TEST_ENV,
    memory.repository,
    { enqueue, now },
  );
}

test("event creation commits its announcement marker atomically before dispatch", async () => {
  const commitStarted = Promise.withResolvers<void>();
  const allowCommit = Promise.withResolvers<void>();
  const memory = memoryRepository({}, async () => {
    commitStarted.resolve();
    await allowCommit.promise;
  });
  const enqueued: EventProgressPlan[] = [];
  const event = scheduledEvent();
  const expected = await buildEventPrizeAnnouncementPlan(
    EVENT_ID,
    event,
    NOW_MS,
  );
  assert.ok(expected);
  const markerPath = `eventProgressOutbox/${expected.outboxId}`;
  const wrapped = wrapper(memory, async (plan) => {
    assert.deepEqual(memory.get(EVENT_PATH), event);
    assert.deepEqual(memory.get(markerPath), plan.outbox);
    enqueued.push(plan);
  });

  const pending = wrapped.patchRtdbRoot({
    [EVENT_PATH]: event,
    "invites/unrelated/status": "active",
  });
  await commitStarted.promise;
  assert.deepEqual(enqueued, []);
  assert.equal(memory.get(EVENT_PATH), null);
  assert.equal(memory.get(markerPath), null);
  allowCommit.resolve();
  await pending;

  assert.deepEqual(memory.patches, [
    {
      [EVENT_PATH]: event,
      "invites/unrelated/status": "active",
      [markerPath]: expected.outbox,
    },
  ]);
  assert.deepEqual(enqueued, [expected]);
  assert.equal(expected.params.reason, EVENT_PRIZE_ANNOUNCEMENT_REASON);
  assert.equal(expected.params.runAtMs, TARGET_MS);
});

test("failed event persistence cannot dispatch or leave a schedule without the event", async () => {
  const memory = memoryRepository({}, async () => {
    throw new Error("persistence-unavailable");
  });
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(memory, async (plan) => {
    enqueued.push(plan);
  });

  await assert.rejects(
    wrapped.patchRtdbRoot({ [EVENT_PATH]: scheduledEvent() }),
    /persistence-unavailable/,
  );

  assert.deepEqual(enqueued, []);
  assert.deepEqual(memory.patches, []);
  assert.equal(memory.get(EVENT_PATH), null);
  assert.equal(memory.get("eventProgressOutbox"), null);
});

test("dispatch failure leaves the committed marker available for sweep recovery", async () => {
  const memory = memoryRepository();
  const logs: string[] = [];
  const wrapped = createEventPrizeAnnouncementScheduleRepository(
    TELEGRAM_TEST_ENV,
    memory.repository,
    {
      enqueue: async () => {
        throw new Error("workflow-unavailable");
      },
      logger: { error: (value: string) => logs.push(value) },
      now: () => NOW_MS,
    },
  );
  const event = scheduledEvent();
  const expected = await buildEventPrizeAnnouncementPlan(
    EVENT_ID,
    event,
    NOW_MS,
  );
  assert.ok(expected);

  await wrapped.patchRtdbRoot({ [EVENT_PATH]: event });

  assert.deepEqual(memory.get(EVENT_PATH), event);
  assert.deepEqual(
    memory.get(`eventProgressOutbox/${expected.outboxId}`),
    expected.outbox,
  );
  assert.deepEqual(
    logs.map((value) => JSON.parse(value)),
    [{ event: "event_prize_announcement_enqueue_failed", eventId: EVENT_ID }],
  );
});

test("repeat scheduling preserves first queue time and the workflow identity", async () => {
  let nowMs = NOW_MS;
  const memory = memoryRepository();
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(
    memory,
    async (plan) => {
      enqueued.push(plan);
    },
    () => nowMs,
  );

  await wrapped.patchRtdbRoot({ [EVENT_PATH]: scheduledEvent() });
  nowMs += 5_000;
  await wrapped.patchRtdbRoot({ [`${EVENT_PATH}/startAtMs`]: START_AT_MS });

  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued[1], enqueued[0]);
  assert.equal(enqueued[1].outbox.firstQueuedAtMs, NOW_MS);
  assert.equal(memory.patches.length, 2);
});

test("partial changes evaluate the event after all scheduling fields are applied", async () => {
  const memory = memoryRepository({
    events: {
      [EVENT_ID]: scheduledEvent({
        status: "active",
        isSundayMons: false,
        startAtMs: NOW_MS,
      }),
    },
  });
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(memory, async (plan) => {
    enqueued.push(plan);
  });

  await wrapped.patchRtdbRoot({
    [`${EVENT_PATH}/status`]: "scheduled",
    [`${EVENT_PATH}/isSundayMons`]: true,
    [`${EVENT_PATH}/startAtMs`]: START_AT_MS,
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].params.runAtMs, TARGET_MS);
  assert.deepEqual(memory.get(EVENT_PATH), scheduledEvent());
  assert.equal(memory.patches.length, 1);
  assert.deepEqual(
    memory.patches[0][`eventProgressOutbox/${enqueued[0].outboxId}`],
    enqueued[0].outbox,
  );
});

test("only scheduled strict Sunday Mons events with catalog prizes create markers", async () => {
  const cases = [
    { eventId: EVENT_ID, event: scheduledEvent({ isSundayMons: false }) },
    { eventId: EVENT_ID, event: scheduledEvent({ isSundayMons: undefined }) },
    { eventId: EVENT_ID, event: scheduledEvent({ isSundayMons: "true" }) },
    { eventId: EVENT_ID, event: scheduledEvent({ status: "active" }) },
    { eventId: EVENT_ID, event: scheduledEvent({ status: "ended" }) },
    { eventId: EVENT_ID, event: scheduledEvent({ status: "cancelled" }) },
    { eventId: "no-catalog-prizes", event: scheduledEvent() },
    { eventId: EVENT_ID, event: null },
    { eventId: EVENT_ID, event: scheduledEvent({ startAtMs: "10000000" }) },
    { eventId: EVENT_ID, event: scheduledEvent({ startAtMs: 1.5 }) },
  ];
  for (const { eventId, event } of cases) {
    const memory = memoryRepository();
    const enqueued: EventProgressPlan[] = [];
    const wrapped = wrapper(memory, async (plan) => {
      enqueued.push(plan);
    });
    const updates = { [`events/${eventId}`]: event };

    await wrapped.patchRtdbRoot(updates);

    assert.deepEqual(enqueued, [], JSON.stringify({ eventId, event }));
    assert.deepEqual(memory.patches, [updates]);
    assert.equal(memory.get("eventProgressOutbox"), null);
  }
});

test("automatic prizes do not depend on any existing Telegram announcement toggle", async () => {
  for (const telegramAnnouncements of [
    { invite: false, matches: false, results: false },
    { invite: true, matches: false, results: true },
    undefined,
  ]) {
    const plan = await buildEventPrizeAnnouncementPlan(
      EVENT_ID,
      scheduledEvent({ announceOnTelegram: false, telegramAnnouncements }),
      NOW_MS,
    );
    assert.ok(plan);
    assert.equal(plan.params.runAtMs, TARGET_MS);
  }
});

test("first discovery at the target is accepted but a millisecond late is skipped", async () => {
  assert.ok(
    await buildEventPrizeAnnouncementPlan(
      EVENT_ID,
      scheduledEvent(),
      TARGET_MS,
    ),
  );
  assert.equal(
    await buildEventPrizeAnnouncementPlan(
      EVENT_ID,
      scheduledEvent(),
      TARGET_MS + 1,
    ),
    null,
  );
  const memory = memoryRepository();
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(
    memory,
    async (plan) => {
      enqueued.push(plan);
    },
    () => TARGET_MS + 1,
  );
  const updates = { [EVENT_PATH]: scheduledEvent() };

  await wrapped.patchRtdbRoot(updates);

  assert.deepEqual(memory.patches, [updates]);
  assert.deepEqual(enqueued, []);
});

test("postponement creates a distinct schedule without overwriting the earlier marker", async () => {
  const memory = memoryRepository();
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(memory, async (plan) => {
    enqueued.push(plan);
  });

  await wrapped.patchRtdbRoot({ [EVENT_PATH]: scheduledEvent() });
  await wrapped.patchRtdbRoot({
    [`${EVENT_PATH}/startAtMs`]: START_AT_MS + 7_200_000,
  });

  assert.equal(enqueued.length, 2);
  assert.notEqual(enqueued[0].workflowId, enqueued[1].workflowId);
  assert.notEqual(enqueued[0].outboxId, enqueued[1].outboxId);
  assert.equal(enqueued[1].params.runAtMs, TARGET_MS + 7_200_000);
  for (const plan of enqueued) {
    assert.deepEqual(
      memory.get(`eventProgressOutbox/${plan.outboxId}`),
      plan.outbox,
    );
  }
});

test("gameplay updates and existing progress markers pass through unchanged", async () => {
  const existing = await buildEventProgressPlan(
    {
      eventId: EVENT_ID,
      reason: "match-rating-updated",
      sourceKey: "rating:invite-1:match-1",
    },
    NOW_MS,
  );
  const memory = memoryRepository({
    events: { [EVENT_ID]: scheduledEvent() },
    eventProgressOutbox: { [existing.outboxId]: existing.outbox },
  });
  const enqueued: EventProgressPlan[] = [];
  const wrapped = wrapper(memory, async (plan) => {
    enqueued.push(plan);
  });
  const updates = {
    [`${EVENT_PATH}/rounds/0/matches/match-1/status`]: "complete",
    [`${EVENT_PATH}/updatedAtMs`]: NOW_MS,
    [`eventProgressOutbox/${existing.outboxId}/lastQueuedAtMs`]: NOW_MS + 1,
  };

  await wrapped.patchRtdbRoot(updates);

  assert.deepEqual(memory.patches, [updates]);
  assert.deepEqual(memory.reads, []);
  assert.deepEqual(enqueued, []);
  assert.deepEqual(memory.get(`eventProgressOutbox/${existing.outboxId}`), {
    ...existing.outbox,
    lastQueuedAtMs: NOW_MS + 1,
  });
});

test("sweep scheduling persists before dispatch and preserves an existing first queue time", async () => {
  const memory = memoryRepository();
  const candidate = await buildEventPrizeAnnouncementPlan(
    EVENT_ID,
    scheduledEvent(),
    NOW_MS,
  );
  assert.ok(candidate);
  const requests: Array<{ id?: string; params?: unknown }> = [];
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      ...TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
      createBatch: async (options) => {
        assert.deepEqual(
          memory.get(`eventProgressOutbox/${candidate.outboxId}`),
          candidate.outbox,
        );
        requests.push(...options);
        return [];
      },
    },
  };

  await scheduleEventPrizeAnnouncement(
    env,
    memory.repository,
    EVENT_ID,
    scheduledEvent(),
    NOW_MS,
  );
  await scheduleEventPrizeAnnouncement(
    env,
    memory.repository,
    EVENT_ID,
    scheduledEvent(),
    NOW_MS + 1_000,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, candidate.workflowId);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(
    memory.get(`eventProgressOutbox/${candidate.outboxId}`),
    candidate.outbox,
  );
});

test("failed sweep dispatch retains its marker for another attempt", async () => {
  const memory = memoryRepository();
  const candidate = await buildEventPrizeAnnouncementPlan(
    EVENT_ID,
    scheduledEvent(),
    NOW_MS,
  );
  assert.ok(candidate);
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      ...TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
      createBatch: async () => {
        throw new Error("workflow-unavailable");
      },
      get: async () => {
        throw new Error("workflow-not-found");
      },
    },
  };

  await assert.rejects(
    scheduleEventPrizeAnnouncement(
      env,
      memory.repository,
      EVENT_ID,
      scheduledEvent(),
      NOW_MS,
    ),
    /workflow-unavailable/,
  );

  assert.deepEqual(
    memory.get(`eventProgressOutbox/${candidate.outboxId}`),
    candidate.outbox,
  );
});
