import assert from "node:assert/strict";
import test from "node:test";
import { runRecoveryItems } from "../src/recoveryRunner.ts";

test("recovery runs sequentially in input order by default", async () => {
  const events: string[] = [];
  await runRecoveryItems([0, 1, 2], async (item) => {
    events.push(`start-${item}`);
    await Promise.resolve();
    events.push(`finish-${item}`);
  });
  assert.deepEqual(events, [
    "start-0",
    "finish-0",
    "start-1",
    "finish-1",
    "start-2",
    "finish-2",
  ]);
});

test("recovery bounds concurrent work and starts remaining items in input order", async () => {
  const items = [0, 1, 2, 3, 4];
  const gates = items.map(() => Promise.withResolvers<void>());
  const started = items.map(() => Promise.withResolvers<void>());
  const visited: number[] = [];
  let active = 0;
  let maximum = 0;
  const recovery = runRecoveryItems(
    items,
    async (item) => {
      active++;
      maximum = Math.max(maximum, active);
      visited.push(item);
      started[item].resolve();
      await gates[item].promise;
      active--;
    },
    { concurrency: 2 },
  );

  await started[1].promise;
  assert.deepEqual(visited, [0, 1]);
  gates[1].resolve();
  await started[2].promise;
  assert.deepEqual(visited, [0, 1, 2]);
  assert.equal(active, 2);
  for (const gate of gates) gate.resolve();
  await recovery;
  assert.deepEqual(visited, items);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test("recovery skips empty input", async () => {
  await runRecoveryItems([], async () => {
    assert.fail("unexpected recovery operation");
  });
});

test("recovery rejects invalid concurrency before running any items", async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      runRecoveryItems(
        [0],
        async () => {
          assert.fail("unexpected recovery operation");
        },
        { concurrency },
      ),
      RangeError,
    );
  }
});

test("recovery continues after synchronous failures and preserves the raw single reason", async () => {
  for (const failure of [new Error("unavailable"), "unavailable", 0, null]) {
    const visited: number[] = [];
    await assert.rejects(
      runRecoveryItems([0, 1, 2], (item) => {
        visited.push(item);
        if (item === 1) throw failure;
        return Promise.resolve();
      }),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(visited, [0, 1, 2]);
  }
});

test("failed recovery awaits slow peers and continues later items before rejecting", async () => {
  const failure = new Error("unavailable");
  const gate = Promise.withResolvers<void>();
  const laterStarted = Promise.withResolvers<void>();
  const visited: number[] = [];
  let settled = false;
  const recovery = runRecoveryItems(
    [0, 1, 2],
    async (item) => {
      visited.push(item);
      if (item === 0) await Promise.reject(failure);
      if (item === 1) await gate.promise;
      if (item === 2) laterStarted.resolve();
    },
    { concurrency: 2 },
  );
  const result = recovery.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );

  await laterStarted.promise;
  assert.deepEqual(visited, [0, 1, 2]);
  assert.equal(settled, false);
  gate.resolve();
  assert.equal(await result, failure);
  assert.equal(settled, true);
});

test("recovery aggregates raw failures in completion order with the selected message", async () => {
  for (const aggregateErrorMessage of [
    undefined,
    "event-progress-records-failed",
  ]) {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const laterStarted = Promise.withResolvers<void>();
    const firstFailure = new Error("first-item-failed-last");
    const secondFailure = { code: "second-item-failed-first" };
    const recovery = runRecoveryItems(
      [0, 1, 2],
      (item) => {
        if (item === 0) return first.promise;
        if (item === 1) return second.promise;
        laterStarted.resolve();
        throw 0;
      },
      { concurrency: 2, aggregateErrorMessage },
    );
    const rejected = assert.rejects(recovery, (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal(
        error.message,
        aggregateErrorMessage ?? "recovery-records-failed",
      );
      assert.deepEqual(error.errors, [secondFailure, 0, firstFailure]);
      assert.equal(error.errors[0], secondFailure);
      assert.equal(error.errors[2], firstFailure);
      return true;
    });

    second.reject(secondFailure);
    await laterStarted.promise;
    first.reject(firstFailure);
    await rejected;
  }
});
