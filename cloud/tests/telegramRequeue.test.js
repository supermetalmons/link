"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildRecoveryTasks,
  parseArgs,
  requeueTelegramDelivery,
} = require("../admin/requeueTelegramDelivery");
const { smokeTelegramDelivery } = require("../admin/smokeTelegramDelivery");

test("requeue arguments default to dry-run and require an explicit target", () => {
  assert.deepEqual(parseArgs(["--target", "firebase"]), {
    adminArgs: [],
    bridgeSecretFile: "",
    dryRun: true,
    target: "firebase",
  });
  assert.deepEqual(
    parseArgs([
      "--target",
      "cloudflare",
      "--project",
      "mons-link",
      "--bridge-secret-file",
      "/secure/bridge-secret",
      "--execute",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      bridgeSecretFile: "/secure/bridge-secret",
      dryRun: false,
      target: "cloudflare",
    },
  );
  assert.throws(() => parseArgs([]), TypeError);
  assert.throws(
    () => parseArgs(["--target", "cloudflare", "--execute"]),
    TypeError,
  );
});

test("builds idempotent desired and pending manual recovery wake-ups", () => {
  assert.deepEqual(
    buildRecoveryTasks(
      {
        a: { desired: { revision: "revision-a" } },
        b: {
          desired: { revision: "revision-b" },
          manualRecovery: { requestId: "request-b" },
          delivery: { lastRecoveryRequestId: "old-request" },
        },
        c: {
          manualRecovery: { requestId: "request-c" },
          delivery: { lastRecoveryRequestId: "request-c" },
        },
      },
      "run-1",
    ),
    [
      {
        messageKey: "a",
        revision: "revision-a",
        taskKind: "desired",
        retrySequence: 0,
        generation: "recovery:run-1:desired:0",
      },
      {
        messageKey: "b",
        revision: "revision-b",
        taskKind: "desired",
        retrySequence: 0,
        generation: "recovery:run-1:desired:1",
      },
      {
        messageKey: "b",
        revision: "manual-recovery",
        taskKind: "manual-recovery",
        retrySequence: 0,
        generation: "request-b:recovery:run-1:manual:2",
      },
    ],
  );
});

test("dry-run scans state without enqueueing", async () => {
  let enqueues = 0;
  const summary = await requeueTelegramDelivery(
    { target: "firebase", dryRun: true, bridgeSecretFile: "" },
    {
      database: {
        ref() {
          return {
            once: async () => ({
              val: () => ({ key: { desired: { revision: "revision" } } }),
            }),
          };
        },
      },
      enqueueFirebaseTask: async () => {
        enqueues += 1;
      },
      runId: "run-1",
    },
  );
  assert.deepEqual(summary, {
    target: "firebase",
    dryRun: true,
    tasks: 1,
    desired: 1,
    manualRecovery: 0,
  });
  assert.equal(enqueues, 0);
});

test("safe smoke writes delete-only desired state and always cleans it up", async () => {
  let desired;
  let removed = false;
  const database = {
    ref(path = "") {
      if (!path) {
        return {
          async update(updates) {
            desired = Object.values(updates)[0];
          },
        };
      }
      return {
        async once() {
          return {
            val: () => ({
              desired,
              delivery: { status: "delivered" },
            }),
          };
        },
        async remove() {
          removed = true;
        },
      };
    },
  };
  const result = await smokeTelegramDelivery({
    database,
    now: () => 1_000,
    randomId: () => "smoke-id",
    sleepImpl: async () => undefined,
  });
  assert.deepEqual(result, {
    ok: true,
    messageKey: "migration-smoke:smoke-id",
    status: "delivered",
  });
  assert.equal(desired.operation, "delete");
  assert.equal(removed, true);
});
