import { retainEventProgressRecord } from "../../../runtime/eventProgressRecords.js";
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
  let exists = true;
  const calls: string[] = [];
  const repository: EventProgressSweepRepository = {
    readEvent: async () => null,
    readEventProgressOutbox: async () =>
      retainEventProgressRecord("pending", record),
    listDueEventProgressOutboxes: async () =>
      record
        ? [
            {
              outboxId: plan.outboxId,
              record: retainEventProgressRecord("pending", record),
            },
          ]
        : [],
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
      exists = false;
    },
    pause: async () => {},
    restart: async () => {},
    resume: async () => {},
    sendEvent: async () => {},
    terminate: async () => {},
    status: async () => {
      calls.push("status");
      if (!exists) throw new Error("instance-missing");
      return { status };
    },
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => instance,
      createBatch: async () => {
        calls.push("create");
        if (exists) throw new Error("instance-exists");
        exists = true;
        return [instance];
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async () => {
        calls.push("get");
        if (!exists) throw new Error("instance-missing");
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
    setExists: (value: boolean) => {
      exists = value;
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
  assert.deepEqual(f.calls, ["get", "status"]);
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
    assert.deepEqual(f.calls, ["get", "status", "delete", "create"]);
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

for (const phase of ["create", "status", "delete", "recreate"] as const) {
  test(`${phase} failure remains retryable and preserves the provider error`, async () => {
    const f = await fixture();
    const failure = new Error(`${phase}-failed`);
    if (phase === "status") {
      f.instance.status = async () => {
        throw failure;
      };
    } else if (phase === "delete") {
      f.setStatus("errored");
      f.instance.delete = async () => {
        throw failure;
      };
    } else {
      if (phase === "create") f.setExists(false);
      else f.setStatus("errored");
      f.env.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
        throw failure;
      };
    }
    await assert.rejects(f.dispatch(), (error) => error === failure);
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      900_000,
    );
    assert.deepEqual(f.current(), f.plan.outbox);
    if (phase === "status" || phase === "delete") {
      assert.equal(f.calls.includes("create"), false);
    }
  });
}

test("lookup failure after an empty creation result remains retryable and preserves the provider error", async () => {
  const f = await fixture();
  const failure = new Error("empty-create-lookup-failed");
  const get = f.env.EVENT_PROGRESS_WORKFLOW.get;
  let reads = 0;
  f.setExists(false);
  f.env.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
    f.calls.push("create");
    f.setExists(true);
    return [];
  };
  f.env.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
    if (++reads === 2) {
      f.calls.push("get");
      throw failure;
    }
    return get(id);
  };
  await assert.rejects(f.dispatch(), (error) => error === failure);
  assert.deepEqual(f.calls, ["get", "create", "get"]);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000,
  );
  assert.deepEqual(f.current(), f.plan.outbox);
  f.env.EVENT_PROGRESS_WORKFLOW.get = get;
  f.setNow(900_000);
  await f.dispatch();
  assert.deepEqual(f.calls, ["get", "create", "get", "get", "status"]);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000 + HOUR,
  );
  assert.deepEqual(f.current(), f.plan.outbox);
});

for (const reason of ["missing", "retention-expired"] as const) {
  test(`${reason} instances are created with the original identity and retention`, async () => {
    const f = await fixture();
    if (reason === "retention-expired") {
      await f.dispatch();
      f.setNow(600_123 + HOUR);
      f.calls.length = 0;
    }
    f.setExists(false);
    const create = f.env.EVENT_PROGRESS_WORKFLOW.createBatch;
    f.env.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      assert.deepEqual(items, [
        {
          id: f.plan.workflowId,
          params: f.plan.params,
          retention: { successRetention: "1 day", errorRetention: "30 days" },
        },
      ]);
      return create(items);
    };
    await f.dispatch();
    assert.deepEqual(f.calls, ["get", "create", "status"]);
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      600_123 + (reason === "retention-expired" ? 2 : 1) * HOUR,
    );
    assert.deepEqual(f.current(), f.plan.outbox);
  });
}

test("an initial provider lookup failure retains the existing creation fallback", async () => {
  const f = await fixture();
  const get = f.env.EVENT_PROGRESS_WORKFLOW.get;
  let reads = 0;
  f.env.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
    if (++reads === 1) throw new Error("provider-unavailable");
    return get(id);
  };
  await f.dispatch();
  assert.deepEqual(f.calls, ["create", "get", "status"]);
  assert.equal(f.calls.includes("delete"), false);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    600_123 + HOUR,
  );
  assert.deepEqual(f.current(), f.plan.outbox);
});

for (const race of ["concurrent-create", "ambiguous-create"] as const) {
  test(`${race} is confirmed through the existing fallback without deleting the instance`, async () => {
    const f = await fixture();
    f.setExists(false);
    const create = f.env.EVENT_PROGRESS_WORKFLOW.createBatch;
    f.env.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      if (race === "concurrent-create") f.setExists(true);
      await create(items);
      throw new Error("provider-response-lost");
    };
    await f.dispatch();
    assert.deepEqual(f.calls, ["get", "create", "get", "status"]);
    assert.equal(
      (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
      600_123 + HOUR,
    );
    assert.deepEqual(f.current(), f.plan.outbox);
  });
}

test("an instance deleted after lookup is retried on the next sweep without eager recreation", async () => {
  const f = await fixture();
  const failure = new Error("instance-disappeared");
  const status = f.instance.status;
  f.instance.status = async () => {
    f.setExists(false);
    throw failure;
  };
  await assert.rejects(f.dispatch(), (error) => error === failure);
  assert.deepEqual(f.calls, ["get"]);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000,
  );
  f.instance.status = status;
  f.setNow(900_000);
  await f.dispatch();
  assert.deepEqual(f.calls, ["get", "get", "create", "status"]);
  assert.equal(
    (await f.recovery.read(f.plan.outboxId))?.nextReconcileAtMs,
    900_000 + HOUR,
  );
  assert.deepEqual(f.current(), f.plan.outbox);
});

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
  assert.deepEqual(f.calls, ["get", "status"]);
  await f.dispatch();
  assert.equal(f.calls.filter((call) => call === "status").length, 1);
});
