import assert from "node:assert/strict";
import test from "node:test";
import { runOptimisticTransaction } from "../src/optimisticTransaction.ts";

test("conflicts reread state and recompute the decision before committing", async () => {
  let reads = 0;
  const writes: Array<{ version: number; value: unknown }> = [];
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: ++reads }, version: reads }),
    getValue: (current) => current.record,
    decide: (current) => ({
      value: { count: current.count + 1 },
      decision: `increment-${current.count}`,
    }),
    write: async (current, value) => {
      writes.push({ version: current.version, value });
      return { applied: writes.length === 2, value: { count: 3 } };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(writes, [
    { version: 1, value: { count: 2 } },
    { version: 2, value: { count: 3 } },
  ]);
  assert.deepEqual(result, {
    committed: true,
    decision: "increment-2",
    value: { count: 3 },
  });
  assert.equal(reads, 2);
});

test("a logical abort after a conflict returns the freshly read record", async () => {
  let reads = 0;
  let writes = 0;
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: ++reads }, version: reads }),
    getValue: (current) => current.record,
    decide: (current) =>
      current.count === 1
        ? { value: { count: 2 } }
        : { commit: false, decision: "already-applied" },
    write: async (current) => {
      writes++;
      return { applied: false, value: current.record };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(result, {
    committed: false,
    decision: "already-applied",
    value: { count: 2 },
  });
  assert.equal(writes, 1);
});

test("deletion commits the adapter's null value", async () => {
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: 1 }, version: 4 }),
    getValue: (current): { count: number } | null => current.record,
    decide: () => ({ value: null, decision: "deleted" }),
    write: async (current, value) => {
      assert.equal(current.version, 4);
      assert.equal(value, null);
      return { applied: true, value: null };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(result, {
    committed: true,
    decision: "deleted",
    value: null,
  });
});

for (const maxAttempts of [12, 25]) {
  test(`exhaustion stops after exactly ${maxAttempts} conflicts`, async () => {
    let reads = 0;
    let decisions = 0;
    let writes = 0;
    const failure = new Error("domain-conflict");
    await assert.rejects(
      runOptimisticTransaction({
        maxAttempts,
        read: async () => {
          reads++;
          return null;
        },
        getValue: (current): object | null => current,
        decide: () => {
          decisions++;
          return { value: {} };
        },
        write: async () => {
          writes++;
          return { applied: false, value: null };
        },
        conflictError: () => failure,
      }),
      (error) => error === failure,
    );
    assert.equal(reads, maxAttempts);
    assert.equal(decisions, maxAttempts);
    assert.equal(writes, maxAttempts);
  });
}

for (const stage of ["read", "getValue", "decide", "write"] as const) {
  test(`${stage} failures propagate without retrying`, async () => {
    const calls: string[] = [];
    const failure = new Error(`domain-${stage}-failure`);
    const enter = (currentStage: typeof stage) => {
      calls.push(currentStage);
      if (stage === currentStage) throw failure;
    };
    await assert.rejects(
      runOptimisticTransaction({
        maxAttempts: 25,
        read: async () => {
          enter("read");
          return null;
        },
        getValue: (current): object | null => {
          enter("getValue");
          return current;
        },
        decide: () => {
          enter("decide");
          return { value: {} };
        },
        write: async () => {
          enter("write");
          return { applied: true, value: {} };
        },
        conflictError: () => new Error("unexpected-exhaustion"),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      calls,
      ["read", "getValue", "decide", "write"].slice(
        0,
        ["read", "getValue", "decide", "write"].indexOf(stage) + 1,
      ),
    );
  });
}

test("retries retain the complete fresh snapshot and independently typed proposal", async () => {
  const snapshots = [
    { value: { count: 1 }, guard: { token: "first" } },
    { value: { count: 3 }, guard: { token: "second" } },
  ];
  let reads = 0;
  const result = await runOptimisticTransaction({
    maxAttempts: 2,
    read: async () => snapshots[reads++],
    getValue: (snapshot) => snapshot.value,
    decide: (value) => ({ value: String(value.count + 1) }),
    write: async (snapshot, proposed) => {
      assert.equal(snapshot, snapshots[reads - 1]);
      assert.equal(snapshot.guard.token, reads === 1 ? "first" : "second");
      assert.equal(proposed, reads === 1 ? "2" : "4");
      return { applied: reads === 2, value: { count: Number(proposed) } };
    },
    conflictError: () => new Error("unexpected-exhaustion"),
  });
  assert.equal(result.committed, true);
  assert.equal(result.value.count, 4);
});

test("a pre-aborted transaction does not read or decide", async () => {
  const reason = new Error("cancelled-before-read");
  await assert.rejects(
    runOptimisticTransaction({
      maxAttempts: 25,
      signal: AbortSignal.abort(reason),
      read: async () => assert.fail("unexpected-read"),
      getValue: () => assert.fail("unexpected-value"),
      decide: () => assert.fail("unexpected-decision"),
      write: async () => assert.fail("unexpected-write"),
      conflictError: () => new Error("unexpected-exhaustion"),
    }),
    (error) => error === reason,
  );
});

test("cancellation during a read prevents the decision and write", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled-during-read");
  const reading = Promise.withResolvers<number>();
  const transaction = runOptimisticTransaction({
    maxAttempts: 25,
    signal: controller.signal,
    read: () => reading.promise,
    getValue: () => assert.fail("unexpected-value"),
    decide: () => assert.fail("unexpected-decision"),
    write: async () => assert.fail("unexpected-write"),
    conflictError: () => new Error("unexpected-exhaustion"),
  });
  controller.abort(reason);
  reading.resolve(1);
  await assert.rejects(transaction, (error) => error === reason);
});

test("cancellation after a conflict prevents another attempt", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled-after-conflict");
  let reads = 0;
  await assert.rejects(
    runOptimisticTransaction({
      maxAttempts: 25,
      signal: controller.signal,
      read: async () => ++reads,
      getValue: (current) => current,
      decide: (current) => ({ value: current + 1 }),
      write: async (current) => {
        controller.abort(reason);
        return { applied: false, value: current };
      },
      conflictError: () => new Error("unexpected-exhaustion"),
    }),
    (error) => error === reason,
  );
  assert.equal(reads, 1);
});

test("cancellation during a successful write preserves its committed result", async () => {
  const controller = new AbortController();
  const writing = Promise.withResolvers<{ applied: boolean; value: number }>();
  const started = Promise.withResolvers<void>();
  const transaction = runOptimisticTransaction({
    maxAttempts: 25,
    signal: controller.signal,
    read: async () => 1,
    getValue: (current) => current,
    decide: () => ({ value: 2, decision: "incremented" }),
    write: () => {
      started.resolve();
      return writing.promise;
    },
    conflictError: () => new Error("unexpected-exhaustion"),
  });
  await started.promise;
  controller.abort(new Error("cancelled-during-write"));
  writing.resolve({ applied: true, value: 2 });
  assert.deepEqual(await transaction, {
    committed: true,
    decision: "incremented",
    value: 2,
  });
});
