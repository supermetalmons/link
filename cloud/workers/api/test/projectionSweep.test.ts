import assert from "node:assert/strict";
import test from "node:test";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  collectSuccessfulClaims,
  sendQueueTasks,
} from "../src/projectionSweep.ts";

test("projection repairs continue sequentially and retain ordered results and failures", async () => {
  const failure = new Error("repair-unavailable");
  const visited: number[] = [];
  let repairing = false;
  const result = await collectProjectionRepairs(
    [0, 1, 2, 3, 4, 5, 6],
    async (entry) => {
      assert.equal(repairing, false);
      repairing = true;
      visited.push(entry);
      await Promise.resolve();
      repairing = false;
      if (entry === 0) return { kind: "changed" };
      if (entry === 1) return { kind: "removed" };
      if (entry === 3) throw failure;
      if (entry === 4) throw "unavailable";
      if (entry === 5) return;
      return { kind: "repaired", task: `repaired-${entry}` };
    },
    "projection-invalid-record-failed",
  );

  assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.repairedTasks, ["repaired-2", "repaired-6"]);
  assert.equal(result.removedCount, 1);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0], failure);
  assert.equal(result.failures[1].message, "projection-invalid-record-failed");
});

test("projection repairs support quarantine callbacks without generated tasks", async () => {
  const failure = new Error("quarantine-unavailable");
  const visited: string[] = [];
  const result = await collectProjectionRepairs(
    ["first", "broken", "last"],
    async (entry): Promise<void> => {
      visited.push(entry);
      if (entry === "broken") throw failure;
    },
    "projection-invalid-record-failed",
  );

  assert.deepEqual(visited, ["first", "broken", "last"]);
  assert.deepEqual(result, {
    repairedTasks: [],
    removedCount: 0,
    failures: [failure],
  });
});

test("projection repairs skip empty input", async () => {
  assert.deepEqual(
    await collectProjectionRepairs(
      [],
      async () => {
        throw new Error("unexpected-repair");
      },
      "projection-invalid-record-failed",
    ),
    { repairedTasks: [], removedCount: 0, failures: [] },
  );
});

test("projection batches preserve task order and await each send", async () => {
  const tasks = Array.from({ length: 201 }, (_, id) => ({ id }));
  const batches: MessageSendRequest<{ id: number }>[][] = [];
  let sending = false;
  const queue = {
    async sendBatch(messages) {
      assert.equal(sending, false);
      sending = true;
      await Promise.resolve();
      batches.push(Array.from(messages));
      sending = false;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Pick<Queue<{ id: number }>, "sendBatch">;

  await sendQueueTasks(queue, tasks);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 1],
  );
  assert.deepEqual(
    batches.flat(),
    tasks.map((body) => ({ body })),
  );

  await sendQueueTasks(queue, []);
  assert.equal(batches.length, 3);
});

test("projection batching stops after a failed send and preserves its error", async () => {
  const failure = new Error("queue-unavailable");
  const batches: number[][] = [];
  const queue = {
    async sendBatch(messages) {
      batches.push(Array.from(messages, ({ body }) => body));
      if (batches.length === 2) throw failure;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Pick<Queue<number>, "sendBatch">;

  await assert.rejects(
    sendQueueTasks(
      queue,
      Array.from({ length: 201 }, (_, id) => id),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100],
  );
});

test("projection claims continue sequentially and retain all failures with the first failure alias", async () => {
  const failure = new Error("claim-unavailable");
  const visited: number[] = [];
  let claiming = false;
  const result = await collectSuccessfulClaims(
    [1, 2, 3, 4, 5],
    async (item) => {
      assert.equal(claiming, false);
      claiming = true;
      visited.push(item);
      await Promise.resolve();
      claiming = false;
      if (item === 2) throw failure;
      if (item === 4) throw "later-failure";
      return item !== 1;
    },
    "projection-claim-failed",
  );

  assert.deepEqual(visited, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.claimed, [3, 5]);
  assert.equal(result.failure, failure);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0], failure);
  assert.equal(result.failures[1].message, "projection-claim-failed");
});

test("projection claims use the caller's fallback for non-Error failures", async () => {
  const laterFailure = new Error("later-failure");
  const result = await collectSuccessfulClaims(
    [1, 2, 3],
    async (item) => {
      if (item === 1) throw "unavailable";
      if (item === 2) throw laterFailure;
      return true;
    },
    "profile-game-projection-claim-failed",
  );

  assert.deepEqual(result.claimed, [3]);
  assert.equal(result.failure?.message, "profile-game-projection-claim-failed");
  assert.equal(result.failure, result.failures[0]);
  assert.equal(result.failures[1], laterFailure);
});

test("projection dispatch sends initial tasks and successful claims before returning all failures", async () => {
  const failure = new Error("claim-unavailable");
  const laterFailure = new Error("later-failure");
  const visited: number[] = [];
  const batches: string[][] = [];
  let claiming = false;
  const result = await claimAndEnqueueProjectionTasks({
    candidates: [1, 2, 3, 4, 5],
    async claim(item) {
      assert.equal(claiming, false);
      claiming = true;
      visited.push(item);
      await Promise.resolve();
      claiming = false;
      if (item === 2) throw failure;
      if (item === 4) throw laterFailure;
      return item !== 1;
    },
    toTask: (item) => `claimed-${item}`,
    initialTasks: ["repaired-1", "repaired-2"],
    queue: {
      async sendBatch(messages) {
        assert.deepEqual(visited, [1, 2, 3, 4, 5]);
        batches.push(Array.from(messages, ({ body }) => body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
    fallbackErrorMessage: "projection-claim-failed",
  });

  assert.deepEqual(batches, [
    ["repaired-1", "repaired-2", "claimed-3", "claimed-5"],
  ]);
  assert.deepEqual(result, {
    sentCount: 4,
    claimFailure: failure,
    claimFailures: [failure, laterFailure],
  });
  assert.equal(result.claimFailures[0], failure);
  assert.equal(result.claimFailures[1], laterFailure);
});

test("projection dispatch sends repaired-only work and skips empty batches", async () => {
  const batches: string[][] = [];
  const queue = {
    async sendBatch(messages) {
      batches.push(Array.from(messages, ({ body }) => body));
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Pick<Queue<string>, "sendBatch">;

  for (const initialTasks of [["repaired"], []]) {
    assert.deepEqual(
      await claimAndEnqueueProjectionTasks({
        candidates: [],
        claim: async () => {
          throw new Error("unexpected-claim");
        },
        toTask: () => "unexpected-task",
        initialTasks,
        queue,
        fallbackErrorMessage: "projection-claim-failed",
      }),
      { sentCount: initialTasks.length, claimFailure: null, claimFailures: [] },
    );
  }
  assert.deepEqual(batches, [["repaired"]]);
});

test("projection dispatch preserves queue failure precedence and stops later batches", async () => {
  const claimFailure = new Error("claim-unavailable");
  const queueFailure = new Error("queue-unavailable");
  const batches: number[][] = [];
  await assert.rejects(
    claimAndEnqueueProjectionTasks({
      candidates: Array.from({ length: 202 }, (_, index) => index),
      claim: async (item) => {
        if (item === 0) throw claimFailure;
        return true;
      },
      toTask: (item) => item,
      queue: {
        async sendBatch(messages) {
          batches.push(Array.from(messages, ({ body }) => body));
          if (batches.length === 2) throw queueFailure;
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
      fallbackErrorMessage: "projection-claim-failed",
    }),
    (error) => error === queueFailure,
  );
  assert.deepEqual(batches, [
    Array.from({ length: 100 }, (_, index) => index + 1),
    Array.from({ length: 100 }, (_, index) => index + 101),
  ]);
});
