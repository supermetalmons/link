import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import { buildEventPrizeAnnouncementPlan } from "../src/eventPrizeAnnouncementSchedule.ts";
import { runEventPrizeAnnouncementWorkflow } from "../src/eventPrizeAnnouncementWorkflow.ts";
import {
  InvalidEventProgressPayloadError,
  type EventProgressWorkflowParams,
} from "../src/eventProgress.ts";
import type { EventPrizeAnnouncementDeliveryResult } from "../src/eventPrizeAnnouncement.ts";

const EVENT_ID = "z3oj52Iiime";
const RUN_AT_MS = 10_000_000;
const EVENT = {
  status: "scheduled",
  isSundayMons: true,
  startAtMs: RUN_AT_MS + 3_600_000,
};

async function harness() {
  const plan = await buildEventPrizeAnnouncementPlan(
    EVENT_ID,
    EVENT,
    RUN_AT_MS - 1_000,
  );
  assert.ok(plan);
  let nowMs = RUN_AT_MS - 1_000;
  let record: unknown = plan.outbox;
  let acknowledgements = 0;
  let sends = 0;
  let outcome: () => Promise<EventPrizeAnnouncementDeliveryResult> =
    async () => ({ status: "sent" });
  const sleeps: Array<{ name: string; timestamp: number }> = [];
  const configs: WorkflowStepConfig[] = [];
  const completed = new Map<string, unknown>();
  const step = Object.create(null) as WorkflowStep;
  step.sleepUntil = async (name, timestamp) => {
    const value = Number(timestamp);
    sleeps.push({ name, timestamp: value });
    nowMs = Math.max(nowMs, value);
  };
  step.do = (async (...args: unknown[]) => {
    const [name, config, callback] = args;
    assert.equal(typeof name, "string");
    assert.equal(typeof callback, "function");
    if (completed.has(name as string)) return completed.get(name as string);
    configs.push(config as WorkflowStepConfig);
    const value = await (callback as () => Promise<unknown>)();
    completed.set(name as string, value);
    return value;
  }) as WorkflowStep["do"];
  const event: WorkflowEvent<EventProgressWorkflowParams> = {
    payload: plan.params,
    instanceId: plan.workflowId,
    timestamp: new Date(nowMs),
    workflowName: "mons-link-event-progress",
  };
  const run = () =>
    runEventPrizeAnnouncementWorkflow(event, step, {
      now: () => nowMs,
      readOutbox: async (outboxId) => {
        assert.equal(outboxId, plan.outboxId);
        return record;
      },
      deliver: async (input) => {
        assert.deepEqual(input, {
          eventId: EVENT_ID,
          startAtMs: EVENT.startAtMs,
          runAtMs: RUN_AT_MS,
          firstQueuedAtMs: RUN_AT_MS - 1_000,
        });
        sends += 1;
        return outcome();
      },
      acknowledge: async () => {
        acknowledgements += 1;
        record = null;
      },
    });
  return {
    plan,
    event,
    run,
    step,
    sleeps,
    configs,
    setNow: (value: number) => {
      nowMs = value;
    },
    setRecord: (value: unknown) => {
      record = value;
    },
    setOutcome: (value: typeof outcome) => {
      outcome = value;
    },
    sends: () => sends,
    acknowledgements: () => acknowledgements,
  };
}

test("sleeps until the one-hour target, preserves discovery proof, and safely replays", async () => {
  const state = await harness();
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.deepEqual(state.sleeps, [
    { name: "wait for prize announcement", timestamp: RUN_AT_MS },
  ]);
  assert.equal(state.configs[0].retries?.limit, 0);
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 1);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 1);
});

test("retries only within the fixed grace and honors retryAtMs", async () => {
  const state = await harness();
  state.setOutcome(async () =>
    state.sends() === 1
      ? { status: "retryable", retryAtMs: RUN_AT_MS + 20_000 }
      : { status: "sent" },
  );
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 2);
  assert.equal(state.sleeps[1].timestamp, RUN_AT_MS + 20_000);
});

test("a retry beyond the deadline expires without another send", async () => {
  const state = await harness();
  state.setOutcome(async () => ({
    status: "retryable",
    retryAtMs: RUN_AT_MS + 60_001,
  }));
  assert.deepEqual(await state.run(), { status: "skipped", reason: "expired" });
  assert.equal(state.sends(), 1);
  assert.equal(state.sleeps.length, 1);
});

test("missed deadline and missing or late scheduling proof never send", async () => {
  for (const scenario of ["expired", "missing", "late"]) {
    const state = await harness();
    if (scenario === "expired") state.setNow(RUN_AT_MS + 60_000);
    if (scenario === "missing") state.setRecord(null);
    if (scenario === "late")
      state.setRecord({ ...state.plan.outbox, firstQueuedAtMs: RUN_AT_MS + 1 });
    assert.equal((await state.run()).status, "skipped");
    assert.equal(state.sends(), 0);
    assert.equal(state.acknowledgements(), 1);
  }
});

test("a scheduled job may run just before the grace deadline", async () => {
  const state = await harness();
  state.setNow(RUN_AT_MS + 59_999);
  assert.equal((await state.run()).status, "sent");
  assert.equal(state.sends(), 1);
});

test("uncertain, terminal, and ineligible outcomes are acknowledged without retries", async () => {
  for (const status of ["uncertain", "terminal", "skipped"] as const) {
    const state = await harness();
    state.setOutcome(async () => ({ status }));
    assert.deepEqual(await state.run(), { status });
    assert.equal(state.sends(), 1);
    assert.equal(state.sleeps.length, 1);
  }
});

test("unexpected errors only retry through the guarded delivery operation", async () => {
  const state = await harness();
  state.setOutcome(async () => {
    if (state.sends() === 1) throw new Error("store-unavailable");
    return { status: "uncertain" };
  });
  assert.deepEqual(await state.run(), { status: "uncertain" });
  assert.equal(state.sends(), 2);
  assert.equal(state.sleeps[1].timestamp, RUN_AT_MS + 1_000);
});

test("rejects altered prize timing and reasons before any step", async () => {
  for (const changes of [
    { runAtMs: RUN_AT_MS + 1 },
    { reason: "scheduled-start" },
  ]) {
    const state = await harness();
    Object.assign(state.event.payload, changes);
    await assert.rejects(state.run(), InvalidEventProgressPayloadError);
    assert.equal(state.sends(), 0);
    assert.equal(state.sleeps.length, 0);
  }
});
