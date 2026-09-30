import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledTasks } from "../src/scheduledTasks.ts";

test("scheduled tasks finish concurrently before logging every failure in task order", async () => {
  const first = Promise.withResolvers<void>();
  const later = Promise.withResolvers<void>();
  const successful = Promise.withResolvers<void>();
  const firstFailure = new Error("first-task-failed", {
    cause: new Error("database-unavailable"),
  });
  const laterFailure = new Error("later-task-failed");
  const started: string[] = [];
  const logs: unknown[] = [];
  let nowMs = 100;
  let settled = false;
  const completion = runScheduledTasks(
    [
      { name: "first", completion: first.promise },
      { name: "later", completion: later.promise },
      { name: "successful", completion: successful.promise },
    ].map(({ name, completion }) => ({
      name,
      run() {
        started.push(name);
        return completion;
      },
    })),
    {
      scheduledTime: 50,
      now: () => nowMs,
      logger: { error: (value: string) => logs.push(JSON.parse(value)) },
    },
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  assert.deepEqual(started, ["first", "later", "successful"]);

  nowMs = 110;
  later.reject(laterFailure);
  await later.promise.catch(() => undefined);
  assert.equal(settled, false);
  assert.deepEqual(logs, []);

  nowMs = 140;
  first.reject(firstFailure);
  await first.promise.catch(() => undefined);
  assert.equal(settled, false);
  assert.deepEqual(logs, []);

  nowMs = 200;
  successful.resolve();
  assert.equal(await completion, firstFailure);
  assert.deepEqual(logs, [
    {
      event: "scheduled_task_failed",
      task: "first",
      durationMs: 40,
      scheduledTime: 50,
      code: "first-task-failed",
      error: {
        name: "Error",
        message: "first-task-failed",
        cause: { name: "Error", message: "database-unavailable" },
      },
    },
    {
      event: "scheduled_task_failed",
      task: "later",
      durationMs: 10,
      scheduledTime: 50,
      code: "later-task-failed",
      error: { name: "Error", message: "later-task-failed" },
    },
  ]);
});

test("scheduled tasks retain synchronous non-Error failures and still run later tasks", async () => {
  const failure = { reason: "failed" };
  const calls: string[] = [];
  const logs: unknown[] = [];
  await assert.rejects(
    runScheduledTasks(
      [
        {
          name: "synchronous",
          run() {
            calls.push("synchronous");
            throw failure;
          },
        },
        {
          name: "later",
          async run() {
            calls.push("later");
          },
        },
      ],
      {
        scheduledTime: 1_000,
        now: () => 20,
        logger: { error: (value: string) => logs.push(JSON.parse(value)) },
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["synchronous", "later"]);
  assert.deepEqual(logs, [
    {
      event: "scheduled_task_failed",
      task: "synchronous",
      durationMs: 0,
      scheduledTime: 1_000,
      code: "unknown",
      error: { type: "object" },
    },
  ]);
});

test("successful and empty scheduled runs do not log", async () => {
  const logs: unknown[] = [];
  const options = {
    scheduledTime: 1_000,
    logger: { error: (value: unknown) => logs.push(value) },
  };
  await runScheduledTasks(
    [{ name: "successful", run: async () => "done" }],
    options,
  );
  await runScheduledTasks([], options);
  assert.deepEqual(logs, []);
});
