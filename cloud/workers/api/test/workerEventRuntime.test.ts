import { eventDocumentFixture } from "./eventCompatibilityFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  EventCommand,
  EventRuntimeStore,
} from "../../../runtime/eventCommands.js";
import type { EventLeaseRecord } from "../../../runtime/eventLeases.js";
import { createWorkflowEventRuntime } from "../src/eventProgress.ts";
import type { EventGameplayRepository } from "../src/eventRepository.ts";
import {
  createEventRuntimeStore,
  createWorkerEventRuntime,
} from "../src/workerEventRuntime.ts";
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

const runtimeMethods = [
  "readEvent",
  "readEventSnapshot",
  "commitEventPlan",
  "transactEventSyncThrottle",
  "transactProfileEventPrize",
] as const;

for (const capturedSignal of [undefined, new AbortController().signal]) {
  for (const outcome of ["success", "reject", "throw"] as const) {
    test(`runtime adapter forwards ${outcome} with ${capturedSignal ? "the captured" : "no captured"} signal and lazy receiver lookup`, async () => {
      const failure = new Error("repository-failed");
      const accesses: PropertyKey[] = [];
      const calls: Array<{ method: string; args: unknown[] }> = [];
      let returned: Promise<unknown> | undefined;
      let repository: EventRuntimeStore;
      const complete = <T>(
        receiver: unknown,
        method: string,
        args: unknown[],
        value: T,
      ): Promise<T> => {
        assert.equal(receiver, repository);
        calls.push({ method, args });
        if (outcome === "throw") throw failure;
        const result =
          outcome === "reject"
            ? Promise.reject(failure)
            : Promise.resolve(value);
        returned = result;
        return result;
      };
      const source: EventRuntimeStore = {
        readEvent(...args) {
          return complete(this, "readEvent", args, null);
        },
        readEventSnapshot(...args) {
          return complete(this, "readEventSnapshot", args, {
            event: null,
            eventId: EVENT_ID,
            prizeSelections: {},
            revision: 0,
          });
        },
        commitEventPlan(...args) {
          return complete(this, "commitEventPlan", args, undefined);
        },
        transactEventSyncThrottle(...args) {
          return complete(this, "transactEventSyncThrottle", args, {
            committed: false,
            value: null,
          });
        },
        transactProfileEventPrize(...args) {
          return complete(this, "transactProfileEventPrize", args, {
            committed: false,
            value: null,
          });
        },
      };
      repository = new Proxy(source, {
        ownKeys: () => assert.fail("unexpected-repository-enumeration"),
        get(target, property, receiver) {
          assert.ok(runtimeMethods.some((name) => name === property));
          accesses.push(property);
          return Reflect.get(target, property, receiver);
        },
      });
      const store = createEventRuntimeStore(repository, capturedSignal);
      assert.deepEqual(Object.keys(store).sort(), [...runtimeMethods].sort());
      assert.deepEqual(accesses, []);
      const perCallSignal = AbortSignal.abort(new Error("per-call-abort"));
      const plan: EventCommand[] = [];
      const throttle: Parameters<
        EventRuntimeStore["transactEventSyncThrottle"]
      >[1] = () => ({ commit: false });
      const prize: Parameters<
        EventRuntimeStore["transactProfileEventPrize"]
      >[2] = () => ({ commit: false });
      const operations = [
        {
          run: () => store.readEvent(EVENT_ID, perCallSignal),
          args: [EVENT_ID],
        },
        {
          run: () => store.readEventSnapshot(EVENT_ID, perCallSignal),
          args: [EVENT_ID],
        },
        { run: () => store.commitEventPlan(plan, perCallSignal), args: [plan] },
        {
          run: () =>
            store.transactEventSyncThrottle(EVENT_ID, throttle, perCallSignal),
          args: [EVENT_ID, throttle],
        },
        {
          run: () =>
            store.transactProfileEventPrize(
              "profile",
              EVENT_ID,
              prize,
              perCallSignal,
            ),
          args: ["profile", EVENT_ID, prize],
        },
      ];
      for (const [index, operation] of operations.entries()) {
        if (outcome === "throw") {
          assert.throws(operation.run, (error) => error === failure);
        } else {
          const result = operation.run();
          assert.equal(result, returned);
          if (outcome === "reject") {
            await assert.rejects(result, (error) => error === failure);
          } else {
            await result;
          }
        }
        assert.equal(accesses.length, index + 1);
        assert.equal(accesses[index], runtimeMethods[index]);
        assert.equal(calls[index].method, runtimeMethods[index]);
        const expectedArgs = [...operation.args, capturedSignal];
        assert.equal(calls[index].args.length, expectedArgs.length);
        for (const [argumentIndex, expected] of expectedArgs.entries()) {
          assert.equal(calls[index].args[argumentIndex], expected);
        }
      }
      if (outcome === "success") {
        const replacement = Promise.resolve(null);
        source.readEvent = function (...args) {
          assert.equal(this, repository);
          assert.deepEqual(args, [EVENT_ID, capturedSignal]);
          return replacement;
        };
        assert.equal(store.readEvent(EVENT_ID), replacement);
      }
    });
  }
}

test("event synchronization accepts only its nine required repository capabilities", async () => {
  const memory = fixture();
  const source = memory.repository;
  const repository: Parameters<
    typeof createWorkerEventRuntime
  >[0]["repository"] = {
    readEvent: (...args) => source.readEvent(...args),
    readEventSnapshot: (...args) => source.readEventSnapshot(...args),
    commitEventPlan: (...args) => source.commitEventPlan(...args),
    transactEventSyncThrottle: (...args) =>
      source.transactEventSyncThrottle(...args),
    transactProfileEventPrize: (...args) =>
      source.transactProfileEventPrize(...args),
    transactEventLease: (...args) => source.transactEventLease(...args),
    readProfileOwnershipSnapshot: (...args) =>
      source.readProfileOwnershipSnapshot(...args),
    readMatchPair: (...args) => source.readMatchPair(...args),
    readMatchPairs: (...args) => source.readMatchPairs(...args),
  };
  const signal = new AbortController().signal;
  const runtime = createWorkerEventRuntime({
    repository,
    signal,
    withdrawalDb: memory.env.EVENT_PRIZE_WITHDRAWALS_DB,
    lockFailureEvent: "event_control_lock_failure",
    now: () => 100,
    enqueueEventProgressTask: async () => assert.fail("unexpected-scheduling"),
  });
  const result = await runtime.runEventSyncState({
    ...synchronization,
    syncLog: {},
  });
  assert.equal(result.didChange, true);
  assert.equal(memory.event.status, "dismissed");
  assert.equal(memory.commits.length, 1);
  assert.equal(memory.lease(), null);
  assert.deepEqual(memory.leaseSignals, [signal, signal, undefined]);
});

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
