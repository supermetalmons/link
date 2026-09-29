import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
  EventCommand,
  EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import { encodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import {
  commitPreparedEventMutation,
  createEventMutationReads,
} from "../src/eventMutationCommit.ts";
import { createEventMutationRepository } from "../src/eventMutationRepository.ts";
import type { EventGameplayRepository } from "../src/eventRepository.ts";
import { eventReadFixture } from "./eventReadFixture.ts";
import { attachEventTestPorts } from "./eventTestPorts.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const EVENT_ID = "z3oj52Iiime";
const NOW_MS = 1_000_000;
const EVENT = {
  status: "scheduled",
  isSundayMons: true,
  startAtMs: 30_000_000,
  participants: { owner: { profileId: "previous-owner" } },
};
const UPDATES: EventCommitPlan = [
  {
    kind: "event-field",
    eventId: EVENT_ID,
    field: "status",
    value: "scheduled",
  },
];

function fixture(
  options: {
    readEvent?: EventGameplayRepository["readEvent"];
    beforeCommit?: EventGameplayRepository["commitEventPlan"];
    dispatch?: (kind: string) => Promise<void>;
  } = {},
) {
  const commits: EventCommand[][] = [];
  const reads: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const deliveries: { kind: string; value: unknown }[] = [];
  const dispatch = async (kind: string, value: unknown) => {
    deliveries.push({ kind, value });
    await options.dispatch?.(kind);
  };
  const repository: EventGameplayRepository = {
    ...attachEventTestPorts<EventGameplayRepository>({
      ...eventReadFixture(async () => null),
    }),
    async readEvent(eventId, signal) {
      reads.push(eventId);
      signals.push(signal);
      return options.readEvent
        ? options.readEvent(eventId, signal)
        : structuredClone(EVENT);
    },
    async commitEventPlan(updates, signal, commitOptions) {
      await options.beforeCommit?.(updates, signal, commitOptions);
      commits.push(structuredClone([...updates]));
    },
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
      async send(task) {
        await dispatch("profile", task);
        return TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE.send();
      },
    },
    TELEGRAM_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      async send(task) {
        await dispatch("telegram", task);
        return TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE.send();
      },
    },
    EVENT_PROGRESS_WORKFLOW: {
      ...TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
      async createBatch(batch) {
        for (const item of batch) await dispatch("announcement", item);
        return TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW.createBatch();
      },
    },
  };
  return { commits, deliveries, env, reads, repository, signals };
}

test("the coordinator commits all outboxes before dispatch and shares only each commit's prior reads", async (t) => {
  t.mock.method(Date, "now", () => NOW_MS);
  const started = Promise.withResolvers<void>();
  const allowCommit = Promise.withResolvers<void>();
  let snapshot = 0;
  const memory = fixture({
    readEvent: async () => ({
      ...EVENT,
      startAtMs: EVENT.startAtMs + ++snapshot * 1_000,
      participants: { owner: { profileId: `previous-owner-${snapshot}` } },
    }),
    beforeCommit: async () => {
      started.resolve();
      await allowCommit.promise;
    },
  });
  const coordinator = createEventMutationRepository(memory.env, {
    eventRepository: memory.repository,
  });
  const signal = new AbortController().signal;
  const pending = coordinator.commitEventPlan(UPDATES, signal);
  await started.promise;
  assert.equal(memory.deliveries.length, 0);
  assert.equal(memory.commits.length, 0);
  allowCommit.resolve();
  await pending;
  assert.deepEqual(memory.reads, [EVENT_ID]);
  assert.deepEqual(memory.signals, [signal]);
  assert.equal(memory.commits.length, 1);
  assert.deepEqual(
    memory.deliveries.map(({ kind }) => kind),
    ["announcement", "announcement", "telegram", "profile"],
  );
  const committed = memory.commits[0];
  assert.deepEqual(committed.slice(0, UPDATES.length), UPDATES);
  assert.deepEqual(
    committed.filter(
      (command) => command.kind === "profile-game-outbox-cleanup",
    ),
    [
      {
        kind: "profile-game-outbox-cleanup",
        eventId: EVENT_ID,
        profileId: "previous-owner-1",
        value: true,
      },
    ],
  );
  assert.equal(
    committed.filter((command) => command.kind === "telegram-generation")
      .length,
    1,
  );
  assert.deepEqual(
    committed.flatMap((command) =>
      command.kind === "progress-outbox" ? [command.value?.sourceKey] : [],
    ),
    [`prizes:${EVENT_ID}:30001000`, `reminder:${EVENT_ID}:30001000`],
  );
  await coordinator.commitEventPlan(UPDATES);
  assert.deepEqual(memory.reads, [EVENT_ID, EVENT_ID]);
  assert.equal(memory.commits.length, 2);
  assert.ok(
    memory.commits[1].some(
      (command) =>
        command.kind === "profile-game-outbox-cleanup" &&
        command.profileId === "previous-owner-2",
    ),
  );
});

test("coordinated commands preserve exact serialization, ID order and clock placement", async (t) => {
  let time = NOW_MS;
  let id = 0;
  t.mock.method(Date, "now", () => ++time);
  t.mock.method(
    crypto,
    "randomUUID",
    () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  );
  const coordinated = fixture();
  await createEventMutationRepository(coordinated.env, {
    eventRepository: coordinated.repository,
  }).commitEventPlan(UPDATES);
  assert.equal(coordinated.commits.length, 1);
  const encoded = encodeEventUpdates(coordinated.commits[0]);
  const expected = {
    [`events/${EVENT_ID}/status`]: "scheduled",
    [`profileGameProjectionOutbox/event/${EVENT_ID}/schemaVersion`]: 1,
    [`profileGameProjectionOutbox/event/${EVENT_ID}/status`]: "pending",
    [`profileGameProjectionOutbox/event/${EVENT_ID}/requestId`]:
      "00000000-0000-4000-8000-000000000001",
    [`profileGameProjectionOutbox/event/${EVENT_ID}/lastQueuedAtMs`]:
      NOW_MS + 1,
    [`profileGameProjectionOutbox/event/${EVENT_ID}/reason`]: null,
    [`profileGameProjectionOutbox/event/${EVENT_ID}/deadAtMs`]: null,
    [`profileGameProjectionOutbox/event/${EVENT_ID}/cleanupOwnerProfileIds/previous-owner`]: true,
    [`telegramProjectionOutbox/event/${EVENT_ID}`]: {
      schemaVersion: 1,
      status: "pending",
      requestId: "00000000-0000-4000-8000-000000000002",
      firstQueuedAtMs: NOW_MS + 2,
      updatedAtMs: NOW_MS + 2,
    },
    [`eventTelegramProjectionGenerations/${EVENT_ID}`]: {
      ".sv": { increment: 1 },
    },
    "eventProgressOutbox/ep_67737a96acccfc1a890b7fbd6695cbc66af23eb9acd2cb4528abbfcfc9f0e227":
      {
        schemaVersion: 1,
        eventId: EVENT_ID,
        sourceKey: `prizes:${EVENT_ID}:30000000`,
        reason: "event-prize-announcement",
        runAtMs: 26_400_000,
        firstQueuedAtMs: NOW_MS + 3,
        lastQueuedAtMs: NOW_MS + 3,
      },
    "eventProgressOutbox/ep_e145147ed02fcd4752fed1c63ed4caafa3616e778823ae71b453f1eb34cba11f":
      {
        schemaVersion: 1,
        eventId: EVENT_ID,
        sourceKey: `reminder:${EVENT_ID}:30000000`,
        reason: "sunday-mons-reminder",
        runAtMs: 15_600_000,
        firstQueuedAtMs: NOW_MS + 3,
        lastQueuedAtMs: NOW_MS + 3,
      },
  };
  assert.equal(JSON.stringify(encoded), JSON.stringify(expected));
});

test("the coordinator forwards the signal and commit options with and without preparation", async (t) => {
  t.mock.method(Date, "now", () => NOW_MS);
  const signal = new AbortController().signal;
  const commitOptions = { upcomingEventId: EVENT_ID };
  const unrelated: EventCommitPlan = [
    { kind: "progress-outbox", outboxId: "outbox-1", value: null },
  ];
  for (const updates of [UPDATES, unrelated]) {
    const memory = fixture({
      beforeCommit: async (_updates, receivedSignal, receivedOptions) => {
        assert.equal(receivedSignal, signal);
        assert.equal(receivedOptions, commitOptions);
      },
    });
    await createEventMutationRepository(memory.env, {
      eventRepository: memory.repository,
    }).commitEventPlan(updates, signal, commitOptions);
    assert.equal(memory.commits.length, 1);
  }
});

test("unrelated mutations pass through without event reads or scheduled work", async () => {
  const memory = fixture();
  const scheduled: Promise<void>[] = [];
  const updates: EventCommitPlan = [
    { kind: "progress-outbox", outboxId: "outbox-1", value: null },
  ];
  await createEventMutationRepository(memory.env, {
    eventRepository: memory.repository,
    schedule: (work) => scheduled.push(work),
  }).commitEventPlan(updates);
  assert.deepEqual(memory.commits, [updates]);
  assert.deepEqual(memory.reads, []);
  assert.deepEqual(memory.deliveries, []);
  assert.deepEqual(scheduled, []);
});

for (const phase of ["prepare", "commit"] as const) {
  test(`${phase} failure neither dispatches nor retries the mutation`, async (t) => {
    t.mock.method(Date, "now", () => NOW_MS);
    let attempts = 0;
    const failure = async () => {
      attempts++;
      throw new Error(`${phase}-failed`);
    };
    const memory = fixture(
      phase === "prepare" ? { readEvent: failure } : { beforeCommit: failure },
    );
    const scheduled: Promise<void>[] = [];
    await assert.rejects(
      createEventMutationRepository(memory.env, {
        eventRepository: memory.repository,
        schedule: (work) => scheduled.push(work),
      }).commitEventPlan(UPDATES),
      { message: `${phase}-failed` },
    );
    assert.equal(attempts, 1);
    assert.deepEqual(memory.commits, []);
    assert.deepEqual(memory.deliveries, []);
    assert.deepEqual(scheduled, []);
  });
}

test("a failed channel keeps committed markers and does not suppress other dispatch", async (t) => {
  t.mock.method(Date, "now", () => NOW_MS);
  const logs: unknown[] = [];
  t.mock.method(console, "error", (value: unknown) => logs.push(value));
  const memory = fixture({
    dispatch: async (kind) => {
      if (kind === "telegram") throw new Error("queue-unavailable");
    },
  });
  await createEventMutationRepository(memory.env, {
    eventRepository: memory.repository,
  }).commitEventPlan(UPDATES);
  assert.equal(memory.commits.length, 1);
  assert.deepEqual(
    memory.deliveries.map(({ kind }) => kind),
    ["announcement", "announcement", "telegram", "profile"],
  );
  assert.ok(
    memory.commits[0].some((command) => command.kind === "telegram-outbox"),
  );
  assert.deepEqual(logs, [
    JSON.stringify({
      event: "event_telegram_projection_enqueue_failed",
      eventId: EVENT_ID,
    }),
  ]);
});

test("scheduled dispatch starts every channel and registers one promise without delaying the mutation", async (t) => {
  t.mock.method(Date, "now", () => NOW_MS);
  const blocked = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let dispatches = 0;
  const memory = fixture({
    dispatch: async () => {
      if (++dispatches === 4) started.resolve();
      await blocked.promise;
    },
  });
  const scheduled: Promise<void>[] = [];
  try {
    await createEventMutationRepository(memory.env, {
      eventRepository: memory.repository,
      schedule: (work) => scheduled.push(work),
    }).commitEventPlan(UPDATES);
    assert.equal(memory.commits.length, 1);
    assert.equal(scheduled.length, 1);
    await started.promise;
    assert.deepEqual(memory.deliveries.map(({ kind }) => kind).sort(), [
      "announcement",
      "announcement",
      "profile",
      "telegram",
    ]);
  } finally {
    blocked.resolve();
    await Promise.all(scheduled);
  }
});

test("commit-local readers retain absent and failed results without caching progress outboxes", async () => {
  for (const fails of [false, true]) {
    let events = 0;
    let outboxes = 0;
    const reads = createEventMutationReads({
      readEvent: async () => {
        events++;
        if (fails) throw new Error("read-failed");
        return null;
      },
      readEventProgressOutbox: async () => {
        outboxes++;
        return null;
      },
    });
    const first = reads.readEvent(EVENT_ID);
    const second = reads.readEvent(EVENT_ID);
    assert.equal(first, second);
    if (fails) await assert.rejects(first, { message: "read-failed" });
    else assert.equal(await first, null);
    assert.equal(events, 1);
    await reads.readEventProgressOutbox("outbox-1");
    await reads.readEventProgressOutbox("outbox-1");
    assert.equal(outboxes, 2);
  }
});

test("combined scheduled work tracks remaining channels after an unexpected dispatch rejection", async () => {
  const blocked = Promise.withResolvers<void>();
  const failure = new Error("unexpected-dispatch-failure");
  const scheduled: Promise<void>[] = [];
  await commitPreparedEventMutation(
    { commitEventPlan: async () => undefined },
    [],
    [
      { commands: [], dispatch: () => blocked.promise },
      {
        commands: [],
        dispatch: async () => {
          throw failure;
        },
      },
    ],
    undefined,
    (work) => scheduled.push(work),
  );
  let settled = false;
  const result = scheduled[0].then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await setImmediate();
  assert.equal(settled, false);
  blocked.resolve();
  assert.equal(await result, failure);
});
