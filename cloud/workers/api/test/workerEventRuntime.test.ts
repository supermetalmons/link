import { eventDocumentFixture } from "./eventCompatibilityFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import type { EventLeaseRecord } from "../../../runtime/eventLeases.js";
import { createWorkflowEventRuntime } from "../src/eventProgress.ts";
import type { EventGameplayRepository } from "../src/eventRepository.ts";
import { createWorkerEventRuntime } from "../src/workerEventRuntime.ts";
import { eventReadFixture } from "./eventReadFixture.ts";
import { attachEventTestPorts } from "./eventTestPorts.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const EVENT_ID = "runtime-event";
const OWNER_UID = "runtime-owner";

function fixture({
  startAtMs = 1,
  beforeRead,
}: {
  startAtMs?: number;
  beforeRead?: (count: number, signal?: AbortSignal) => void;
} = {}) {
  const event: Record<string, unknown> = {
    schemaVersion: 2,
    eventId: EVENT_ID,
    status: "scheduled",
    startAtMs,
    createdAtMs: 1,
    updatedAtMs: 1,
    createdByLoginUid: OWNER_UID,
    createdByProfileId: "owner-profile",
    participants: {},
    rounds: {},
  };
  const commits: EventCommand[][] = [];
  const leaseSignals: (AbortSignal | undefined)[] = [];
  const acquiredLeases: EventLeaseRecord[] = [];
  const deliveries: string[] = [];
  let lease: EventLeaseRecord | null = null;
  let reads = 0;
  const repository = attachEventTestPorts<EventGameplayRepository>({
    ...eventReadFixture(async () => null),
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-ownership-read");
    },
  });
  repository.readEvent = async (eventId, signal) => {
    assert.equal(eventId, EVENT_ID);
    beforeRead?.(++reads, signal);
    signal?.throwIfAborted();
    return eventDocumentFixture(structuredClone(event));
  };
  repository.commitEventPlan = async (plan, signal) => {
    signal?.throwIfAborted();
    commits.push(structuredClone([...plan]));
    for (const command of plan) {
      if (command.kind === "event-field") {
        event[command.field] = command.value;
      }
    }
  };
  repository.transactEventLease = async (key, updater, signal) => {
    assert.deepEqual(key, { kind: "event", id: EVENT_ID });
    leaseSignals.push(signal);
    signal?.throwIfAborted();
    const decision = updater(lease);
    if ("commit" in decision) {
      return { ...decision, committed: false, value: lease };
    }
    lease = decision.value;
    if (lease && decision.decision === "acquired") {
      acquiredLeases.push(structuredClone(lease));
    }
    return { committed: true, decision: decision.decision, value: lease };
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
      async send() {
        deliveries.push("profile");
        return TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send();
      },
    },
    TELEGRAM_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      async send() {
        deliveries.push("telegram");
        return TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE.send();
      },
    },
    EVENT_PROGRESS_WORKFLOW: {
      ...TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
      async createBatch() {
        deliveries.push("workflow");
        return TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW.createBatch();
      },
    },
  };
  return {
    acquiredLeases,
    commits,
    deliveries,
    env,
    event,
    lease: () => lease,
    leaseSignals,
    repository,
  };
}

const synchronization = {
  eventId: EVENT_ID,
  requesterUid: OWNER_UID,
  enforceParticipantGate: false,
  enforceThrottle: false,
  syncLog: {},
};

test("aborted event work releases its lease using the wall clock and an uncancelled transaction", async () => {
  const controller = new AbortController();
  const failure = new Error("event-work-aborted");
  const memory = fixture({
    beforeRead(count, signal) {
      assert.equal(signal, controller.signal);
      if (count === 2) controller.abort(failure);
    },
  });
  const wallClockStartedAtMs = Date.now();
  const runtime = createWorkerEventRuntime({
    repository: memory.repository,
    signal: controller.signal,
    withdrawalDb: memory.env.EVENT_PRIZE_WITHDRAWALS_DB,
    lockFailureEvent: "event_control_lock_failure",
    now: () => 100,
    enqueueEventProgressTask: async () => {
      throw new Error("unexpected-event-scheduling");
    },
  });
  await assert.rejects(
    runtime.runEventSyncState({ ...synchronization, syncLog: {} }),
    (error) => error === failure,
  );
  assert.deepEqual(memory.leaseSignals, [controller.signal, undefined]);
  assert.equal(memory.lease(), null);
  assert.equal(memory.acquiredLeases.length, 1);
  assert.ok(memory.acquiredLeases[0].acquiredAtMs >= wallClockStartedAtMs);
  assert.equal(memory.commits.length, 0);
});

test("the Workflow runtime commits and dispatches each event projection once", async () => {
  const memory = fixture();
  const { runtime } = createWorkflowEventRuntime(
    memory.env,
    new AbortController().signal,
    memory.repository,
  );
  const result = await runtime.runEventSyncState({
    ...synchronization,
    syncLog: {},
  });
  assert.equal(result.didChange, true);
  assert.equal(memory.event.status, "dismissed");
  assert.equal(memory.commits.length, 1);
  const commands = memory.commits[0];
  assert.equal(
    commands.filter((command) => command.kind === "telegram-generation").length,
    1,
  );
  assert.equal(
    commands.filter((command) => command.kind === "telegram-outbox").length,
    1,
  );
  assert.equal(
    commands.filter(
      (command) =>
        command.kind === "profile-game-outbox-field" &&
        command.field === "requestId",
    ).length,
    1,
  );
  assert.deepEqual(memory.deliveries, ["telegram", "profile"]);
  assert.equal(memory.lease(), null);
});

test("the Workflow runtime rejects rescheduling before provider calls or event commits", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const startAtMs = Date.now() + 300_000;
  const memory = fixture({ startAtMs });
  const { runtime } = createWorkflowEventRuntime(
    memory.env,
    new AbortController().signal,
    memory.repository,
  );
  await assert.rejects(
    runtime.postponeEventStart({
      auth: { uid: OWNER_UID },
      data: { eventId: EVENT_ID, postponeByMinutes: 5 },
    }),
    {
      code: "unavailable",
      message: "Could not schedule postponed event start. Please try again.",
    },
  );
  assert.equal(memory.event.startAtMs, startAtMs);
  assert.deepEqual(memory.commits, []);
  assert.deepEqual(memory.deliveries, []);
  assert.equal(memory.lease(), null);
});
