"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTelegramRetryCoordinator,
} = require("../runtime/telegram/deliveryRetryCoordinator");

/** @type {import("../runtime/telegram/deliveryRetryTypes").TelegramRetryTarget[]} */
const targets = [
  { kind: "desired", safeRejectedAttemptId: "attempt-1" },
  { kind: "desired" },
  { kind: "pending-delete", pendingDeleteId: "cleanup-1" },
];

/** @param {{failAt?: string, barrierApplied?: boolean, releaseResult?: boolean}} [options] */
function createHarness({
  failAt,
  barrierApplied = true,
  releaseResult = true,
} = {}) {
  /** @type {{stage: string, value: unknown}[]} */
  const calls = [];
  /** @type {import("../runtime/telegram/deliveryRetryTypes").TelegramExactRetryInput[]} */
  const tasks = [];
  /** @type {import("../runtime/telegram/deliveryRetryTypes").TelegramRetryContext[]} */
  const contexts = [];
  const failure = new Error("injected-failure");
  let nowReads = 0;
  let localUpdates = 0;
  /** @param {string} stage @param {unknown} value */
  const record = (stage, value) => {
    calls.push({ stage, value });
    if (stage === failAt) throw failure;
  };
  const coordinator = createTelegramRetryCoordinator({
    now() {
      nowReads += 1;
      return 10_000;
    },
    async scheduleExactRetry(input) {
      record("enqueue", input);
      tasks.push(input);
      return { scheduled: true };
    },
    async releaseApiGate(owner) {
      record("release", owner);
      return releaseResult;
    },
    async extendRetryBarrierAndReleaseApiGate(proof) {
      record("barrier", proof);
      return {
        applied: barrierApplied,
        retryNotBeforeMs: proof.retryNotBeforeMs,
        gate: null,
      };
    },
    localRetryBarrier: {
      getRetryNotBeforeMs: () => 0,
      extendRetryNotBeforeMs(candidateMs) {
        localUpdates += 1;
        record(`local-${localUpdates}`, candidateMs);
        return candidateMs;
      },
    },
  });
  return {
    calls,
    tasks,
    contexts,
    failure,
    nowReads: () => nowReads,
    /** @param {Partial<import("../runtime/telegram/deliveryRetryTypes").TelegramRetryInput>} [input] */
    finish(input = {}) {
      assert.ok(targets[0]);
      return coordinator.finish({
        current: {},
        failure: { code: "safe-rejection", retryAfterSeconds: 8 },
        target: targets[0],
        messageKey: "message-1",
        revision: "revision-1",
        ownerToken: "lease-1",
        apiGateOwner: "gate-1",
        async persistProof(context) {
          contexts.push(context);
          record("proof", context);
        },
        async persistState(context) {
          contexts.push(context);
          record("state", context);
        },
        ...input,
      });
    },
  };
}

test("retry targets preserve durable proof fields and effect ordering", async (t) => {
  for (const target of targets) {
    for (const mode of ["response", "rate-limit", "deferral"]) {
      await t.test(`${JSON.stringify(target)} ${mode}`, async () => {
        const harness = createHarness();
        const rateLimited = mode === "rate-limit";
        const persistBeforeSchedule = mode === "deferral";
        const result = await harness.finish({
          target,
          persistBeforeSchedule,
          ...(rateLimited
            ? { failure: { code: "rate-limited", retryAfterSeconds: 900 } }
            : {}),
        });
        const retryState = {
          retryStartedAtMs: 10_000,
          retryDeadlineAtMs: 610_000,
          retryAtMs: rateLimited ? 610_000 : 18_000,
          retrySequence: 1,
        };
        assert.deepEqual(result, retryState);
        assert.equal(harness.nowReads(), 1);
        assert.deepEqual(
          harness.calls.map(({ stage }) => stage),
          rateLimited
            ? ["proof", "enqueue", "local-1", "barrier", "local-2", "state"]
            : persistBeforeSchedule
              ? ["state", "enqueue"]
              : ["enqueue", "release", "state"],
        );
        assert.deepEqual(harness.tasks, [
          {
            messageKey: "message-1",
            revision: "revision-1",
            taskKind: rateLimited ? "rate-limit-proof" : target.kind,
            retryState,
            ...(target.kind === "desired"
              ? { safeRejectedAttemptId: target.safeRejectedAttemptId || "" }
              : {}),
            pendingDeleteId: target.pendingDeleteId || "",
            retryProofLeaseOwner:
              ("safeRejectedAttemptId" in target &&
                target.safeRejectedAttemptId) ||
              persistBeforeSchedule
                ? ""
                : "lease-1",
            proofTaskKind: rateLimited ? target.kind : "",
            barrierProofOwner: rateLimited ? "gate-1" : "",
            barrierRetryNotBeforeMs: rateLimited ? 910_000 : 0,
            scheduleTimeMs: rateLimited ? 10_000 : 18_000,
            apiGateSettleOwner:
              rateLimited || persistBeforeSchedule ? "" : "gate-1",
          },
        ]);
        for (const context of harness.contexts) {
          assert.equal(context.finalizedAtMs, 10_000);
          assert.equal(context.retryState, result);
        }
      });
    }
  }
});

test("failed durable boundaries retain the last recoverable state", async (t) => {
  const scenarios = [
    {
      failAt: "proof",
      input: { failure: { code: "rate-limited" } },
      stages: ["proof"],
    },
    {
      failAt: "enqueue",
      input: { failure: { code: "rate-limited" } },
      stages: ["proof", "enqueue"],
    },
    { failAt: "enqueue", input: {}, stages: ["enqueue"] },
    { failAt: "release", input: {}, stages: ["enqueue", "release"] },
    {
      failAt: "state",
      input: {},
      stages: ["enqueue", "release", "state"],
    },
    {
      failAt: "state",
      input: { persistBeforeSchedule: true },
      stages: ["state"],
    },
    {
      failAt: "enqueue",
      input: { persistBeforeSchedule: true },
      stages: ["state", "enqueue"],
    },
    {
      failAt: "state",
      input: { failure: { code: "rate-limited" } },
      stages: ["proof", "enqueue", "local-1", "barrier", "local-2", "state"],
    },
  ];
  for (const target of targets) {
    for (const { failAt, input, stages } of scenarios) {
      await t.test(
        `${target.kind} ${failAt} ${JSON.stringify(input)}`,
        async () => {
          const harness = createHarness({ failAt });
          await assert.rejects(
            harness.finish({ ...input, target }),
            (error) => error === harness.failure,
          );
          assert.deepEqual(
            harness.calls.map(({ stage }) => stage),
            stages,
          );
        },
      );
    }
  }
});

test("an unconfirmed barrier leaves the proof pending without finalizing", async (t) => {
  for (const options of [
    { barrierApplied: false },
    { failAt: "barrier" },
    { failAt: "local-2" },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const harness = createHarness(options);
      const result = await harness.finish({
        failure: { code: "rate-limited", retryAfterSeconds: 900 },
      });
      assert.equal(result.barrierProofPending, true);
      assert.equal(result.retryAtMs, 610_000);
      assert.ok(harness.tasks[0]);
      assert.equal(harness.tasks[0].barrierRetryNotBeforeMs, 910_000);
      assert.equal(
        harness.calls.some(({ stage }) => stage === "state"),
        false,
      );
      assert.equal(
        harness.calls.some(({ stage }) => stage === "release"),
        false,
      );
    });
  }
});

test("rate-limit proof requires an owner and retains its exact identity", async () => {
  const missing = createHarness();
  await assert.rejects(
    missing.finish({
      failure: { code: "rate-limited" },
      apiGateOwner: " ",
    }),
    { code: "rate-limit-gate-owner-missing", retryable: true },
  );
  assert.deepEqual(missing.calls, []);

  const exact = createHarness();
  await exact.finish({
    failure: { code: "rate-limited" },
    apiGateOwner: " gate-1 ",
  });
  assert.ok(exact.tasks[0]);
  assert.equal(exact.tasks[0].barrierProofOwner, " gate-1 ");
  const barrier = exact.calls.find(({ stage }) => stage === "barrier")?.value;
  assert.ok(
    barrier !== null && typeof barrier === "object" && "owner" in barrier,
  );
  assert.equal(barrier.owner, " gate-1 ");
});

test("a stale gate release still finalizes the owned retry state", async () => {
  const harness = createHarness({ releaseResult: false });
  const result = await harness.finish();
  assert.equal(result.retryAtMs, 18_000);
  assert.deepEqual(
    harness.calls.map(({ stage }) => stage),
    ["enqueue", "release", "state"],
  );
});
