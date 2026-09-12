import assert from "node:assert/strict";
import test from "node:test";
import { concurrentSettled, retryRead } from "./retry.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("successful reads return immediately without retry classification, callbacks or waits", async () => {
  const result = { exact: "read-result" };
  let calls = 0;
  assert.equal(
    await retryRead(
      async () => {
        calls++;
        return result;
      },
      {
        shouldRetry: () => {
          throw new Error("should not classify success");
        },
        wait: async () => {
          throw new Error("should not wait after success");
        },
        onRetry: () => {
          throw new Error("should not report success as retry");
        },
      },
    ),
    result,
  );
  assert.equal(calls, 1);
});

test("default read retries stop at five attempts and wait only between failures", async () => {
  const errors = Array.from(
    { length: 5 },
    (_, index) => new Error(`failure-${index + 1}`),
  );
  let calls = 0;
  const waits: number[] = [];
  const reports: Array<{ error: unknown; attempt: number; delayMs: number }> =
    [];
  await assert.rejects(
    retryRead(
      async () => {
        throw errors[calls++];
      },
      {
        shouldRetry: () => true,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        onRetry: (retry) => {
          reports.push(retry);
        },
      },
    ),
    (error: unknown) => error === errors[4],
  );
  assert.equal(calls, 5);
  assert.deepEqual(waits, [250, 500, 1_000, 2_000]);
  assert.deepEqual(
    reports.map(({ attempt, delayMs }) => ({ attempt, delayMs })),
    [
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 500 },
      { attempt: 3, delayMs: 1_000 },
      { attempt: 4, delayMs: 2_000 },
    ],
  );
  assert.deepEqual(
    reports.map(({ error }) => error),
    errors.slice(0, 4),
  );
});

test("a transient read can recover without a trailing observation wait", async () => {
  let calls = 0;
  const waits: number[] = [];
  const expected = new Error("transient");
  const result = await retryRead(
    async () => {
      if (++calls < 3) throw expected;
      return "recovered";
    },
    {
      shouldRetry: (error) => error === expected,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("nonretryable errors and explicitly single attempts fail without waiting", async () => {
  const expected = new Error("permission denied");
  for (const attempts of [1, 5]) {
    let calls = 0;
    const waits: number[] = [];
    await assert.rejects(
      retryRead(
        async () => {
          calls++;
          throw expected;
        },
        {
          attempts,
          shouldRetry: () => false,
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
      ),
      (error: unknown) => error === expected,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});

test("retry diagnostics cannot hide the operation error or prevent safe retries", async () => {
  const expected = new Error("original read failure");
  let calls = 0;
  await assert.rejects(
    retryRead(
      async () => {
        calls++;
        throw expected;
      },
      {
        attempts: 2,
        shouldRetry: () => true,
        wait: async () => undefined,
        onRetry: async () => {
          throw new Error("diagnostic failed");
        },
      },
    ),
    (error: unknown) => error === expected,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    retryRead(
      async () => {
        throw expected;
      },
      {
        shouldRetry: () => {
          throw new Error("classifier failed");
        },
      },
    ),
    (error: unknown) => error === expected,
  );
  await assert.rejects(
    retryRead(
      async () => {
        throw expected;
      },
      {
        shouldRetry: () => true,
        wait: async () => {
          throw new Error("wait interrupted");
        },
      },
    ),
    (error: unknown) => error === expected,
  );
});

test("invalid retry and concurrency bounds fail before starting any work", async () => {
  let calls = 0;
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      retryRead(
        async () => {
          calls++;
        },
        { attempts: invalid, shouldRetry: () => true },
      ),
      /invalid read retry attempts/,
    );
    await assert.rejects(
      concurrentSettled(
        [1],
        async () => {
          calls++;
        },
        invalid,
      ),
      /invalid concurrency limit/,
    );
  }
  assert.equal(calls, 0);
});

test("concurrent work respects the cap and processes every successful item exactly once", async () => {
  let inFlight = 0;
  let maximum = 0;
  const seen: number[] = [];
  const gates = Array.from({ length: 7 }, deferred);
  const task = concurrentSettled(
    gates.map((_, index) => index),
    async (index) => {
      seen.push(index);
      maximum = Math.max(maximum, ++inFlight);
      await gates[index].promise;
      inFlight--;
    },
    3,
  );
  assert.deepEqual(seen, [0, 1, 2]);
  gates[1].resolve();
  await flush();
  assert.deepEqual(seen, [0, 1, 2, 3]);
  gates[0].resolve();
  gates[2].resolve();
  gates[3].resolve();
  await flush();
  for (const gate of gates) gate.resolve();
  await task;
  assert.equal(maximum, 3);
  assert.equal(inFlight, 0);
  assert.deepEqual(
    seen.toSorted((left, right) => left - right),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

test("a persistent failure stops new dispatch and waits for every already-started operation", async () => {
  const gates = Array.from({ length: 6 }, deferred);
  const first = new Error("first persistent failure");
  const later = new Error("later in-flight failure");
  const started: number[] = [];
  const settled: number[] = [];
  let finished = false;
  let thrown: unknown;
  const task = concurrentSettled(
    gates.map((_, index) => index),
    async (index) => {
      started.push(index);
      try {
        await gates[index].promise;
      } finally {
        settled.push(index);
      }
    },
    3,
  ).then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      thrown = error;
    },
  );
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].reject(first);
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].reject(later);
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(started, [0, 1, 2]);
  gates[2].resolve();
  await task;
  assert.equal(finished, true);
  assert.equal(thrown, first);
  assert.deepEqual(settled.toSorted(), [0, 1, 2]);
});

test("undefined rejections remain failures and cannot silently admit later items", async () => {
  const started: number[] = [];
  let rejected = false;
  await concurrentSettled(
    [0, 1, 2],
    async (item) => {
      started.push(item);
      throw undefined;
    },
    1,
  ).catch((error: unknown) => {
    rejected = true;
    assert.equal(error, undefined);
  });
  assert.equal(rejected, true);
  assert.deepEqual(started, [0]);
});

test("empty concurrent work never invokes its operation", async () => {
  await concurrentSettled([], async () => {
    throw new Error("unused");
  });
});
