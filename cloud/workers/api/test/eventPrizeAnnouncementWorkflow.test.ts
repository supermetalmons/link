import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import { buildEventAnnouncementPlan } from "../src/eventPrizeAnnouncementSchedule.ts";
import type { EventAnnouncementKind } from "../src/eventAnnouncementKinds.ts";
import { runEventPrizeAnnouncementWorkflow } from "../src/eventPrizeAnnouncementWorkflow.ts";
import {
  buildEventProgressPlan,
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

async function harness(
  kind: EventAnnouncementKind = "prizes",
  eventId = EVENT_ID,
  persistedLeadMs?: number,
) {
  const startAtMs =
    RUN_AT_MS +
    (persistedLeadMs ?? (kind === "prizes" ? 3_600_000 : 14_400_000));
  const plan =
    persistedLeadMs === undefined
      ? await buildEventAnnouncementPlan(
          eventId,
          { ...EVENT, startAtMs },
          RUN_AT_MS - 1_000,
          kind,
        )
      : await buildEventProgressPlan(
          {
            eventId,
            sourceKey: `${kind}:${eventId}:${startAtMs}`,
            reason:
              kind === "prizes"
                ? "event-prize-announcement"
                : "sunday-mons-reminder",
            runAtMs: RUN_AT_MS,
          },
          RUN_AT_MS - 1_000,
        );
  assert.ok(plan);
  let nowMs = RUN_AT_MS - 1_000;
  let record: unknown = plan.outbox;
  let acknowledgements = 0;
  let sends = 0;
  let refreshes = 0;
  let refresh: () => Promise<void> = async () => undefined;
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
          ...(kind === "reminder" ? { kind } : {}),
          eventId,
          startAtMs,
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
      refreshReminder: async (requestedEventId) => {
        assert.equal(requestedEventId, eventId);
        assert.equal(acknowledgements, 0);
        refreshes++;
        await refresh();
        return { status: "queued" };
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
    setRefresh: (value: typeof refresh) => {
      refresh = value;
    },
    refreshes: () => refreshes,
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
  assert.equal(state.refreshes(), 0);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 1);
  assert.equal(state.refreshes(), 0);
});

test("reminders without prizes use the four-hour identity and their own step names", async () => {
  const state = await harness("reminder", "sunday-without-prizes");
  assert.equal(state.plan.params.reason, "sunday-mons-reminder");
  assert.equal(
    state.plan.params.sourceKey,
    `reminder:sunday-without-prizes:${RUN_AT_MS + 14_400_000}`,
  );
  assert.equal(state.plan.params.runAtMs, RUN_AT_MS);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.deepEqual(state.sleeps, [
    { name: "wait for sunday mons reminder", timestamp: RUN_AT_MS },
  ]);
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 1);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 1);
  assert.equal(state.refreshes(), 1);
});

test("persisted three-hour reminders deliver at their original time and acknowledge the same identity", async () => {
  const state = await harness("reminder", "sunday-without-prizes", 10_800_000);
  const currentPlan = await buildEventAnnouncementPlan(
    "sunday-without-prizes",
    { ...EVENT, startAtMs: RUN_AT_MS + 10_800_000 },
    RUN_AT_MS - 3_600_000 - 1_000,
    "reminder",
  );
  assert.ok(currentPlan);
  assert.equal(state.plan.workflowId, currentPlan.workflowId);
  assert.equal(state.plan.outboxId, currentPlan.outboxId);
  assert.equal(currentPlan.params.runAtMs, RUN_AT_MS - 3_600_000);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.deepEqual(state.sleeps, [
    { name: "wait for sunday mons reminder", timestamp: RUN_AT_MS },
  ]);
  assert.equal(state.sends(), 1);
  assert.equal(state.refreshes(), 1);
  assert.equal(state.acknowledgements(), 1);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 1);
});

test("reminder workflows reject unsupported stored lead times before any step", async () => {
  for (const leadMs of [
    3_600_000, 10_799_999, 10_800_001, 14_399_999, 14_400_001, 18_000_000,
  ]) {
    const state = await harness("reminder", EVENT_ID, leadMs);
    await assert.rejects(state.run(), InvalidEventProgressPayloadError);
    assert.equal(state.sends(), 0);
    assert.equal(state.sleeps.length, 0);
    assert.equal(state.acknowledgements(), 0);
  }
});

test("reminder projection retries after the send grace without repeating a completed send", async () => {
  const state = await harness("reminder");
  state.setRefresh(async () => {
    if (state.refreshes() === 1)
      throw new Error("projection-store-unavailable");
  });
  await assert.rejects(state.run(), /projection-store-unavailable/);
  assert.equal(state.sends(), 1);
  assert.equal(state.acknowledgements(), 0);
  state.setNow(RUN_AT_MS + 120_000);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.sends(), 1);
  assert.equal(state.refreshes(), 2);
  assert.equal(state.acknowledgements(), 1);
  assert.deepEqual(await state.run(), { status: "sent" });
  assert.equal(state.refreshes(), 2);
});

test("every reminder outcome checks the confirmed receipt before acknowledging, including expired replay", async () => {
  for (const status of [
    "sent",
    "uncertain",
    "terminal",
    "skipped",
    "expired",
  ] as const) {
    const state = await harness("reminder");
    if (status === "expired") state.setNow(RUN_AT_MS + 60_000);
    else state.setOutcome(async () => ({ status }));
    await state.run();
    assert.equal(state.refreshes(), 1);
    assert.equal(state.acknowledgements(), 1);
  }
});

test("reminders enforce the same discovery and grace limits", async () => {
  for (const scenario of ["late", "expired", "within-grace"]) {
    const state = await harness("reminder", "sunday-without-prizes");
    if (scenario === "late")
      state.setRecord({ ...state.plan.outbox, firstQueuedAtMs: RUN_AT_MS + 1 });
    state.setNow(RUN_AT_MS + (scenario === "expired" ? 60_000 : 59_999));
    assert.equal(
      (await state.run()).status,
      scenario === "within-grace" ? "sent" : "skipped",
    );
    assert.equal(state.sends(), scenario === "within-grace" ? 1 : 0);
  }
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

for (const kind of ["prizes", "reminder"] as const) {
  test(`${kind}: replaying a sleep preserves the last valid retry and its completed result`, async () => {
    const state = await harness(kind);
    const retryStepName =
      kind === "prizes"
        ? "retry prize announcement 0"
        : "retry sunday mons reminder 0";
    state.setOutcome(async () =>
      state.sends() === 1
        ? { status: "retryable", retryAtMs: RUN_AT_MS + 59_000 }
        : { status: "sent" },
    );
    const sleepUntil = state.step.sleepUntil;
    let suspended = false;
    state.step.sleepUntil = async (name, timestamp) => {
      await sleepUntil(name, timestamp);
      if (name === retryStepName && !suspended) {
        suspended = true;
        throw new Error("simulated-hibernation");
      }
    };
    await assert.rejects(state.run(), /simulated-hibernation/);
    assert.equal(state.sends(), 1);
    assert.deepEqual(await state.run(), { status: "sent" });
    assert.equal(state.sends(), 2);
    assert.deepEqual(
      state.sleeps
        .filter(({ name }) => name === retryStepName)
        .map(({ timestamp }) => timestamp),
      [RUN_AT_MS + 59_000, RUN_AT_MS + 59_000],
    );
    state.setNow(RUN_AT_MS + 61_000);
    assert.deepEqual(await state.run(), { status: "sent" });
    assert.equal(state.sends(), 2);
  });
}

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
