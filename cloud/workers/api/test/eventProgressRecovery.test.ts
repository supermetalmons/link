import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowInstanceStatus } from "cloudflare:workers";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import { dispatchOutboxPlan } from "../src/eventProgressDispatch.ts";
import type { EventProgressSweepRepository } from "../src/eventProgress.ts";
import { createEventProgressRecoveryTestStore } from "./eventProgressRecoveryTestStore.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const FIVE_MINUTES = 300_000;
const TEN_MINUTES = 600_000;
const HOUR = 3_600_000;

async function fixture(runAtMs: number | null = 20_000_000) {
  const plan = await buildEventProgressPlan(
    { eventId: "event-1", reason: "test", sourceKey: "scheduled:one", runAtMs },
    100,
  );
  let record: Record<string, unknown> | null = plan.outbox;
  let nowMs = 600_123;
  let status: WorkflowInstanceStatus = "waiting";
  const calls: string[] = [];
  const repository: EventProgressSweepRepository = {
    readEvent: async () => null,
    readEventProgressOutbox: async () => record,
    listDueEventProgressOutboxes: async () =>
      record ? [{ outboxId: plan.outboxId, record }] : [],
    commitEventPlan: async (commands) => {
      for (const command of commands)
        if (command.kind === "progress-outbox") record = command.value;
    },
  };
  const recovery = createEventProgressRecoveryTestStore(repository);
  const instance: WorkflowInstance = {
    id: plan.workflowId,
    delete: async () => {
      calls.push("delete");
    },
    pause: async () => {},
    restart: async () => {},
    resume: async () => {},
    sendEvent: async () => {},
    terminate: async () => {},
    status: async () => {
      calls.push("status");
      return { status };
    },
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => instance,
      createBatch: async () => {
        calls.push("create");
        return [instance];
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async () => {
        calls.push("get");
        return instance;
      },
    },
  };
  return {
    env,
    plan,
    recovery,
    instance,
    calls,
    dispatch: () =>
      dispatchOutboxPlan(env, recovery, plan.outboxId, () => nowMs),
    setNow: (value: number) => {
      nowMs = value;
    },
    setStatus: (value: WorkflowInstanceStatus) => {
      status = value;
    },
    replace: (value: Record<string, unknown> | null) => {
      record = value;
    },
    current: () => record,
  };
}

test("confirmed future waiting instances are checked hourly without rewriting their outbox", async () => {
  const f = await fixture();
  const original = JSON.stringify(f.current());
  await f.dispatch();
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    600_123 + HOUR,
  );
  assert.equal(JSON.stringify(f.current()), original);
  for (let interval = 1; interval < 12; interval++) {
    f.setNow(600_123 + interval * FIVE_MINUTES);
    await f.dispatch();
  }
  assert.equal(f.calls.filter((call) => call === "status").length, 1);
  f.setNow(600_123 + HOUR);
  await f.dispatch();
  assert.equal(f.calls.filter((call) => call === "status").length, 2);
});

test("future waiting instances resume five-minute checks at ten minutes before their deadline", async () => {
  const runAtMs = 600_123 + HOUR;
  const f = await fixture(runAtMs);
  await f.dispatch();
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    runAtMs - TEN_MINUTES,
  );
  f.setNow(runAtMs - TEN_MINUTES - 1);
  await f.dispatch();
  assert.equal(f.calls.filter((call) => call === "status").length, 1);
  f.setNow(runAtMs - TEN_MINUTES);
  await f.dispatch();
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    3_900_000,
  );
  f.setNow(3_900_000);
  await f.dispatch();
  assert.equal(f.calls.filter((call) => call === "status").length, 3);
});

for (const status of [
  "queued",
  "running",
  "paused",
  "waitingForPause",
  "unknown",
] as const) {
  test(`${status} instances remain eligible at the next five-minute boundary`, async () => {
    const f = await fixture();
    f.setStatus(status);
    await f.dispatch();
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000,
    );
    f.setNow(900_000);
    await f.dispatch();
    assert.equal(f.calls.filter((call) => call === "status").length, 2);
  });
}

for (const runAtMs of [null, 500_000, 600_123 + TEN_MINUTES]) {
  test(`waiting work due at ${runAtMs} is not deferred for an hour`, async () => {
    const f = await fixture(runAtMs);
    await f.dispatch();
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000,
    );
  });
}

for (const status of ["errored", "terminated"] as const) {
  test(`recreated ${status} instances need a new waiting observation before hourly deferral`, async () => {
    const f = await fixture();
    f.setStatus(status);
    await f.dispatch();
    assert.deepEqual(f.calls, ["create", "get", "status", "delete", "create"]);
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000,
    );
    f.setStatus("waiting");
    f.setNow(900_000);
    await f.dispatch();
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000 + HOUR,
    );
  });
}

for (const phase of ["create", "status", "recreate"] as const) {
  test(`${phase} failure remains retryable and preserves the provider error`, async () => {
    const f = await fixture();
    const failure = new Error(`${phase}-failed`);
    if (phase === "status") {
      f.instance.status = async () => {
        throw failure;
      };
    } else {
      f.setStatus("errored");
      let creates = 0;
      const create = f.env.EVENT_PROGRESS_WORKFLOW.createBatch;
      f.env.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
        creates++;
        if (phase === "create" || creates === 2) throw failure;
        return create(items);
      };
      const get = f.env.EVENT_PROGRESS_WORKFLOW.get;
      f.env.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
        if (phase === "create" || creates === 2)
          throw new Error("workflow-missing");
        return get(id);
      };
    }
    await assert.rejects(f.dispatch(), (error) => error === failure);
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000,
    );
    assert.deepEqual(f.current(), f.plan.outbox);
  });
}

for (const status of ["waiting", "complete"] as const) {
  for (const replaced of [false, true]) {
    test(`${status} status cannot checkpoint or remove a concurrently ${replaced ? "replaced" : "deleted"} outbox`, async () => {
      const f = await fixture();
      const replacement = replaced
        ? { ...f.plan.outbox, firstQueuedAtMs: 200 }
        : null;
      f.instance.status = async () => {
        f.replace(replacement);
        return { status };
      };
      await f.dispatch();
      assert.deepEqual(f.current(), replacement);
      assert.equal(
        (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs ?? null,
        replaced ? 0 : null,
      );
    });
  }
}

test("a failed concurrent check shortens an hourly checkpoint for the same payload", async () => {
  const f = await fixture();
  const observed = await f.recovery.read(f.plan.outboxId);
  assert.ok(observed);
  const failure = new Error("provider-unavailable");
  f.instance.status = async () => {
    await f.recovery.checkpoint(observed, 600_123 + HOUR);
    throw failure;
  };
  await assert.rejects(f.dispatch(), (error) => error === failure);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000,
  );
});

test("a stale waiting check cannot extend a newer fast checkpoint", async () => {
  const f = await fixture();
  const observed = await f.recovery.read(f.plan.outboxId);
  assert.ok(observed);
  f.instance.status = async () => {
    await f.recovery.checkpoint(observed, 900_000);
    return { status: "waiting" };
  };
  await f.dispatch();
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000,
  );
});

test("checkpoint failure does not replace the provider failure", async (t) => {
  const f = await fixture();
  const failure = new Error("provider-unavailable");
  f.instance.status = async () => {
    throw failure;
  };
  f.recovery.checkpoint = async () => {
    throw new Error("checkpoint-unavailable");
  };
  const logged = t.mock.method(console, "error", () => {});
  await assert.rejects(f.dispatch(), (error) => error === failure);
  assert.deepEqual(JSON.parse(logged.mock.calls[0].arguments[0]), {
    event: "event_progress_recovery_checkpoint_failed",
    outboxId: f.plan.outboxId,
  });
  logged.mock.mockImplementation(() => {
    throw new Error("logger-unavailable");
  });
  await assert.rejects(f.dispatch(), (error) => error === failure);
});

test("completed instances remove only their captured outbox", async () => {
  const f = await fixture();
  f.setStatus("complete");
  await f.dispatch();
  assert.equal(f.current(), null);
  await f.dispatch();
  assert.equal(f.calls.filter((call) => call === "status").length, 1);
});
