import assert from "node:assert/strict";
import test from "node:test";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  collectSuccessfulClaims,
  recoverAndEnqueueProjectionPages,
  recoverAndEnqueueProjectionScan,
  sendQueueTasks,
} from "../src/projectionSweep.ts";

test("scan recovery retains entry identity and raw failures, reports each phase safely, and sends healthy work", async () => {
  const invalid = { kind: "invalid" as const, observation: { key: "raw-key" } };
  const claimFailure = new Error("claim-failed");
  const markFailure = new Error("mark-failed");
  const entries = [
    { kind: "failure" as const, error: 0 },
    invalid,
    ...["skipped", "claim-failed", "mark-failed", "healthy"].map((value) => ({
      kind: "candidate" as const,
      value,
    })),
  ];
  const events: string[] = [];
  const reports: Array<[unknown, number, string]> = [];
  const batches: object[][] = [];
  const result = await recoverAndEnqueueProjectionScan({
    entries,
    async quarantine(entry) {
      assert.equal(entry, invalid);
      events.push("quarantine");
      throw undefined;
    },
    async processCandidate(value, setPhase) {
      events.push(value);
      if (value === "skipped") return;
      if (value === "claim-failed") throw claimFailure;
      if (value === "mark-failed") {
        setPhase("quarantine");
        throw markFailure;
      }
      return { value };
    },
    onFailure(entry, error, index, phase) {
      assert.equal(entry, entries[index]);
      reports.push([error, index, phase]);
      events.push(`report-${index}`);
      throw new Error("reporter-failed");
    },
    queue: {
      async sendBatch(messages) {
        events.push("send");
        batches.push(Array.from(messages, ({ body }) => body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  });

  assert.deepEqual(events, [
    "report-0",
    "quarantine",
    "report-1",
    "skipped",
    "claim-failed",
    "report-3",
    "mark-failed",
    "report-4",
    "healthy",
    "send",
  ]);
  assert.deepEqual(reports, [
    [0, 0, "inspect"],
    [undefined, 1, "quarantine"],
    [claimFailure, 3, "claim"],
    [markFailure, 4, "quarantine"],
  ]);
  assert.equal(result.sentCount, 1);
  assert.deepEqual(batches, [[{ value: "healthy" }]]);
  assert.deepEqual(
    result.failures,
    reports.map(([error, index]) => ({
      item: entries[index],
      index,
      error,
    })),
  );
});

test("scan recovery bounds work and retains completion order before dispatch", async () => {
  const entries = ["slow", "fast", "failed", "skipped", "later-failed"].map(
    (value) => ({ kind: "candidate" as const, value }),
  );
  const gates = entries.map(() => Promise.withResolvers<object | undefined>());
  const started = entries.map(() => Promise.withResolvers<void>());
  const reported = entries.map(() => Promise.withResolvers<void>());
  const failure = new Error("unavailable");
  const reports: unknown[][] = [];
  const batches: object[][] = [];
  let active = 0;
  let maximum = 0;
  const recovery = recoverAndEnqueueProjectionScan({
    entries,
    concurrency: 2,
    quarantine: async () => assert.fail("unexpected-quarantine"),
    async processCandidate(value) {
      const index = entries.findIndex((entry) => entry.value === value);
      active++;
      maximum = Math.max(maximum, active);
      started[index].resolve();
      try {
        return await gates[index].promise;
      } finally {
        active--;
      }
    },
    onFailure(entry, error, index, phase) {
      assert.equal(entry, entries[index]);
      reports.push([error, index, phase]);
      reported[index].resolve();
    },
    queue: {
      async sendBatch(messages) {
        assert.equal(active, 0);
        batches.push(Array.from(messages, ({ body }) => body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  });

  await started[1].promise;
  gates[1].resolve({ value: "fast" });
  await started[2].promise;
  gates[2].reject(failure);
  await reported[2].promise;
  await started[3].promise;
  gates[3].resolve(undefined);
  await started[4].promise;
  gates[4].reject(false);
  await reported[4].promise;
  assert.deepEqual(batches, []);
  gates[0].resolve({ value: "slow" });

  const result = await recovery;
  assert.equal(maximum, 2);
  assert.equal(result.sentCount, 2);
  assert.deepEqual(batches, [[{ value: "fast" }, { value: "slow" }]]);
  assert.deepEqual(reports, [
    [failure, 2, "claim"],
    [false, 4, "claim"],
  ]);
  assert.deepEqual(result.failures, [
    { item: entries[2], index: 2, error: failure },
    { item: entries[4], index: 4, error: false },
  ]);
});

test("scan recovery preserves Queue failure precedence after reporting item failures", async () => {
  const failure = new Error("queue-failed");
  const events: string[] = [];
  await assert.rejects(
    recoverAndEnqueueProjectionScan({
      entries: [
        { kind: "failure", error: null },
        { kind: "candidate", value: "healthy" },
      ],
      quarantine: async () => assert.fail("unexpected-quarantine"),
      processCandidate: async (value) => ({ value }),
      onFailure(_entry, error) {
        assert.equal(error, null);
        events.push("report");
      },
      queue: {
        async sendBatch(messages) {
          assert.deepEqual(Array.from(messages), [
            { body: { value: "healthy" } },
          ]);
          events.push("send");
          throw failure;
        },
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["report", "send"]);
});

test("scan recovery skips empty and entirely skipped batches", async () => {
  for (const entries of [
    [],
    [{ kind: "candidate" as const, value: "stale" }],
  ]) {
    assert.deepEqual(
      await recoverAndEnqueueProjectionScan({
        entries,
        quarantine: async () => assert.fail("unexpected-quarantine"),
        processCandidate: async () => undefined,
        queue: {
          sendBatch: async () => assert.fail("unexpected-send"),
        },
      }),
      { sentCount: 0, failures: [] },
    );
  }
});

test("paged recovery awaits dispatch before requesting the next page", async () => {
  const events: string[] = [];
  const sending = Promise.withResolvers<void>();
  const dispatched = Promise.withResolvers<void>();
  async function* pages() {
    for (const value of ["first", "second"]) {
      events.push(`read-${value}`);
      yield {
        entries: [{ kind: "candidate" as const, value }],
        itemOffset: 0,
      };
    }
  }
  const recovery = recoverAndEnqueueProjectionPages({
    pages: pages(),
    quarantine: async () => assert.fail("unexpected-quarantine"),
    async processCandidate(value) {
      events.push(`claim-${value}`);
      return { value };
    },
    queue: {
      async sendBatch(messages) {
        const [{ body }] = Array.from(messages);
        events.push(`send-${body.value}`);
        if (body.value === "first") {
          sending.resolve();
          await dispatched.promise;
        }
        events.push(`sent-${body.value}`);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  });
  await sending.promise;
  assert.deepEqual(events, ["read-first", "claim-first", "send-first"]);
  dispatched.resolve();
  assert.deepEqual(await recovery, { sentCount: 2, failures: [] });
  assert.deepEqual(events, [
    "read-first",
    "claim-first",
    "send-first",
    "sent-first",
    "read-second",
    "claim-second",
    "send-second",
    "sent-second",
  ]);
});

test("paged recovery forwards concurrency and preserves raw failures, global indices, and reporter containment", async () => {
  const firstEntries = ["slow", "fast", "healthy"].map((value) => ({
    kind: "candidate" as const,
    value,
  }));
  const secondEntries = [
    { kind: "failure" as const, error: undefined },
    { kind: "candidate" as const, value: "later" },
  ];
  const invalid = { kind: "invalid" as const, key: "raw-key" };
  async function* pages() {
    yield { entries: firstEntries, itemOffset: 7 };
    yield { entries: secondEntries, itemOffset: 25 };
    yield { entries: [invalid], itemOffset: 50 };
  }
  const failure = new Error("slow-failure");
  const gates = firstEntries.map(() => Promise.withResolvers<void>());
  const started = firstEntries.map(() => Promise.withResolvers<void>());
  const reports: unknown[][] = [];
  const batches: object[][] = [];
  let active = 0;
  let maximum = 0;
  const recovery = recoverAndEnqueueProjectionPages({
    pages: pages(),
    concurrency: 2,
    async quarantine(entry) {
      assert.equal(entry, invalid);
      throw 0;
    },
    async processCandidate(value, setPhase) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        const index = firstEntries.findIndex((entry) => entry.value === value);
        if (index >= 0) started[index].resolve();
        if (value === "slow") {
          setPhase("quarantine");
          await gates[0].promise;
          throw failure;
        }
        if (value === "fast") {
          await gates[1].promise;
          throw false;
        }
        return { value };
      } finally {
        active--;
      }
    },
    onFailure(entry, error, index, phase) {
      reports.push([entry, error, index, phase]);
      throw new Error("reporter-failed");
    },
    queue: {
      async sendBatch(messages) {
        assert.equal(active, 0);
        batches.push(Array.from(messages, ({ body }) => body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  });
  await started[1].promise;
  gates[1].resolve();
  await started[2].promise;
  assert.deepEqual(batches, []);
  gates[0].resolve();

  assert.deepEqual(await recovery, {
    sentCount: 2,
    failures: [false, failure, undefined, 0],
  });
  assert.equal(maximum, 2);
  assert.deepEqual(batches, [[{ value: "healthy" }], [{ value: "later" }]]);
  assert.deepEqual(reports, [
    [firstEntries[1], false, 8, "claim"],
    [firstEntries[0], failure, 7, "quarantine"],
    [secondEntries[0], undefined, 25, "inspect"],
    [invalid, 0, 50, "quarantine"],
  ]);
});

test("paged recovery preserves scan and Queue failure precedence and stops later pages", async () => {
  for (const stage of ["scan", "queue"] as const) {
    const failure = new Error(`${stage}-failed`);
    const events: string[] = [];
    async function* pages() {
      try {
        events.push("read-first");
        yield {
          entries: [
            { kind: "failure" as const, error: null },
            { kind: "candidate" as const, value: "healthy" },
          ],
          itemOffset: 3,
        };
        events.push("read-second");
        if (stage === "scan") throw failure;
        assert.fail("unexpected-next-page");
      } finally {
        events.push("closed");
      }
    }
    await assert.rejects(
      recoverAndEnqueueProjectionPages({
        pages: pages(),
        quarantine: async () => assert.fail("unexpected-quarantine"),
        async processCandidate(value) {
          events.push("claim");
          return { value };
        },
        onFailure(_entry, error, index) {
          assert.equal(error, null);
          assert.equal(index, 3);
          events.push("report");
        },
        queue: {
          async sendBatch(messages) {
            assert.deepEqual(Array.from(messages), [
              { body: { value: "healthy" } },
            ]);
            events.push("send");
            if (stage === "queue") throw failure;
            return {
              metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            };
          },
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(events, [
      "read-first",
      "report",
      "claim",
      "send",
      ...(stage === "scan" ? ["read-second"] : []),
      "closed",
    ]);
  }
});

test("paged recovery accepts no pages and continues through empty or skipped pages without dispatch", async () => {
  for (const includePages of [false, true]) {
    const visited: string[] = [];
    async function* pages() {
      if (!includePages) return;
      yield { entries: [], itemOffset: 0 };
      yield {
        entries: [{ kind: "candidate" as const, value: "stale" }],
        itemOffset: 10,
      };
      yield {
        entries: [{ kind: "invalid" as const }],
        itemOffset: 20,
      };
    }
    assert.deepEqual(
      await recoverAndEnqueueProjectionPages({
        pages: pages(),
        async quarantine() {
          visited.push("quarantine");
        },
        async processCandidate(value) {
          visited.push(value);
          return undefined;
        },
        queue: {
          sendBatch: async () => assert.fail("unexpected-send"),
        },
      }),
      { sentCount: 0, failures: [] },
    );
    assert.deepEqual(visited, includePages ? ["stale", "quarantine"] : []);
  }
});

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

test("repair and claim reporters receive original failures and cannot interrupt recovery", async () => {
  const failure = new Error("unavailable");
  const reports: unknown[][] = [];
  const report = (item: number, error: unknown, index: number) => {
    reports.push([item, error, index]);
    throw new Error("reporter-unavailable");
  };
  const repair = await collectProjectionRepairs(
    [1, 2, 3],
    async (item) => {
      if (item === 1) throw failure;
      if (item === 2) throw "private";
      return { kind: "repaired", task: item };
    },
    "repair-failed",
    report,
  );
  assert.deepEqual(repair.repairedTasks, [3]);
  assert.equal(repair.failures[0], failure);
  assert.equal(repair.failures[1].message, "repair-failed");
  assert.deepEqual(reports, [
    [1, failure, 0],
    [2, "private", 1],
  ]);
  reports.length = 0;
  const claims = await collectSuccessfulClaims(
    [1, 2, 3],
    async (item) => {
      if (item === 1) throw failure;
      if (item === 2) throw "private";
      return true;
    },
    "claim-failed",
    report,
  );
  assert.deepEqual(claims.claimed, [3]);
  assert.equal(claims.failure, failure);
  assert.equal(claims.failures[1].message, "claim-failed");
  assert.deepEqual(reports, [
    [1, failure, 0],
    [2, "private", 1],
  ]);
});

test("repair and claim failures are reported before the next item begins", async () => {
  const events: string[] = [];
  const report = (_item: number, error: unknown, index: number) => {
    assert.equal(error, undefined);
    assert.equal(index, 0);
    events.push("report");
    throw new Error("reporter-unavailable");
  };
  const repair = await collectProjectionRepairs(
    [0, 1],
    async (item) => {
      events.push(`repair-${item}`);
      if (item === 0) throw undefined;
      return { kind: "repaired", task: item };
    },
    "repair-failed",
    report,
  );
  assert.deepEqual(events, ["repair-0", "report", "repair-1"]);
  assert.deepEqual(repair.repairedTasks, [1]);
  assert.equal(repair.failures[0].message, "repair-failed");

  events.length = 0;
  const claims = await collectSuccessfulClaims(
    [0, 1],
    async (item) => {
      events.push(`claim-${item}`);
      if (item === 0) throw undefined;
      return true;
    },
    "claim-failed",
    report,
  );
  assert.deepEqual(events, ["claim-0", "report", "claim-1"]);
  assert.deepEqual(claims.claimed, [1]);
  assert.equal(claims.failure?.message, "claim-failed");
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
  const reports: unknown[][] = [];
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
      onClaimFailure(item, error, index) {
        reports.push([item, error, index]);
        throw new Error("reporter-unavailable");
      },
    }),
    (error) => error === queueFailure,
  );
  assert.deepEqual(batches, [
    Array.from({ length: 100 }, (_, index) => index + 1),
    Array.from({ length: 100 }, (_, index) => index + 101),
  ]);
  assert.deepEqual(reports, [[0, claimFailure, 0]]);
});
