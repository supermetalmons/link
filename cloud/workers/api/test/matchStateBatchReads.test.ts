import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import type {
  MatchStatePair,
  MatchStatePairRequest,
} from "../src/matchStateTypes.ts";

type Control = { backend: string; state: string; epoch: number };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requests(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    inviteId: `invite-${index}`,
    matchId: `invite-${index}`,
    playerId: `host-${index}`,
    opponentId: `guest-${index}`,
  }));
}

function pair(input: MatchStatePairRequest): MatchStatePair {
  return {
    ...input,
    revision: 1,
    playerMatch: { playerId: input.playerId, epoch: input.epoch },
    opponentMatch:
      input.opponentId === null ? null : { playerId: input.opponentId },
    claim: null,
  };
}

function fixture({
  control = () => ({ backend: "durable", state: "active", epoch: 1 }),
  read = async (input) => pair(input),
}: {
  control?: (index: number) => Control | Promise<Control>;
  read?: (input: MatchStatePairRequest) => Promise<MatchStatePair>;
} = {}) {
  const stats = {
    controls: 0,
    active: 0,
    maximumActive: 0,
    requests: [] as MatchStatePairRequest[],
  };
  const source = createMatchStateSource({
    PROFILE_GAMES_DB: {
      withSession: (constraint: string) => {
        assert.equal(constraint, "first-primary");
        return {
          prepare: () => ({
            first: async () => ({
              ...(await control(++stats.controls)),
              freeze_generation: 0,
            }),
          }),
        };
      },
    },
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        readCanonicalMatchPair: async (input: MatchStatePairRequest) => {
          assert.equal(input.inviteId, inviteId);
          stats.requests.push(input);
          stats.active++;
          stats.maximumActive = Math.max(stats.maximumActive, stats.active);
          try {
            return { ok: true, value: await read(input) };
          } finally {
            stats.active--;
          }
        },
      }),
    },
  } as unknown as Env);
  return { source, stats };
}

test("sixteen pairs use two authority reads and four ordered room readers", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  const pending: ReturnType<typeof deferred>[] = [];
  const { source, stats } = fixture({
    read: async (input) => {
      const gate = deferred();
      pending.push(gate);
      await gate.promise;
      return pair(input);
    },
  });
  const inputs = requests(16);
  const result = source.readMatchPairs(inputs);
  await setImmediate();
  assert.equal(stats.active, 4);
  for (let index = 0; index < inputs.length; index++) {
    assert.ok(pending.length > 0);
    pending.pop()!.resolve();
    await setImmediate();
  }
  assert.deepEqual(
    (await result).map(({ playerId }) => playerId),
    inputs.map(({ playerId }) => playerId),
  );
  assert.equal(stats.controls, 2);
  assert.equal(stats.requests.length, 16);
  assert.equal(stats.maximumActive, 4);
  assert.equal(stats.active, 0);
  assert.deepEqual(
    stats.requests.map(({ epoch }) => epoch),
    Array(16).fill(1),
  );
  const timing = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(timing.event, "match_state_batch_read");
  assert.equal(timing.count, 16);
  assert.equal(timing.attempts, 1);
  assert.equal(timing.authorityReads, 2);
  assert.equal(timing.outcome, "ok");
  for (const key of ["authorityMs", "roomReadsMs", "durationMs"])
    assert.ok(Number.isFinite(timing[key]) && timing[key] >= 0);
});

test("empty batches and pre-aborted batches never contact authority or rooms", async () => {
  const { source, stats } = fixture();
  assert.deepEqual(await source.readMatchPairs([]), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.readMatchPairs(requests(2), controller.signal), {
    name: "AbortError",
  });
  assert.equal(stats.controls, 0);
  assert.equal(stats.requests.length, 0);
});

test("a changed epoch discards and rereads every successful batch result", async () => {
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
  });
  const result = await source.readMatchPairs(requests(5));
  assert.deepEqual(
    result.map(({ epoch }) => epoch),
    Array(5).fill(2),
  );
  assert.deepEqual(
    stats.requests.map(({ epoch }) => epoch),
    [...Array(5).fill(1), ...Array(5).fill(2)],
  );
  assert.equal(stats.controls, 4);
});

test("failed old-epoch reads drain before retrying the whole batch", async () => {
  const gate = deferred();
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
    read: async (input) => {
      if (input.epoch === 1) {
        if (input.inviteId === "invite-0") {
          await setImmediate();
          throw new Error("old-room-epoch");
        }
        await gate.promise;
      }
      return pair(input);
    },
  });
  const result = source.readMatchPairs(requests(8));
  await setImmediate();
  await setImmediate();
  assert.equal(stats.controls, 1);
  assert.equal(stats.requests.length, 4);
  assert.equal(stats.active, 3);
  gate.resolve();
  assert.deepEqual(
    (await result).map(({ epoch }) => epoch),
    Array(8).fill(2),
  );
  assert.equal(stats.controls, 4);
  assert.equal(stats.maximumActive, 4);
  assert.equal(stats.active, 0);
  assert.equal(stats.requests.filter(({ epoch }) => epoch === 2).length, 8);
});

test("a stable authority preserves the original room failure without retry", async () => {
  const failure = new Error("room-unavailable");
  const { source, stats } = fixture({
    read: async () => {
      throw failure;
    },
  });
  await assert.rejects(source.readMatchPairs(requests(8)), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(stats.controls, 2);
  assert.equal(stats.requests.length, 4);
  assert.equal(stats.active, 0);
});

test("authority churn stops after three attempts", async () => {
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: Math.floor(index / 2) + 1,
    }),
  });
  await assert.rejects(source.readMatchPairs(requests(1)), {
    message: "match-state-read-authority-changed",
  });
  assert.equal(stats.controls, 6);
  assert.deepEqual(
    stats.requests.map(({ epoch }) => epoch),
    [1, 2, 3],
  );
});

test("retired authority fails closed before a room read or after a backend change", async () => {
  for (const initiallyDurable of [false, true]) {
    const { source, stats } = fixture({
      control: (index) => ({
        backend: initiallyDurable && index === 1 ? "durable" : "rtdb",
        state: "active",
        epoch: 1,
      }),
    });
    await assert.rejects(source.readMatchPairs(requests(1)), {
      message: "match-state-durable-authority-required",
    });
    assert.equal(stats.controls, initiallyDurable ? 3 : 1);
    assert.equal(stats.requests.length, initiallyDurable ? 1 : 0);
  }
});

test("frozen durable authority continues to permit pair reads", async () => {
  const { source, stats } = fixture({
    control: () => ({ backend: "durable", state: "frozen", epoch: 1 }),
  });
  assert.equal((await source.readMatchPairs(requests(2))).length, 2);
  assert.equal(stats.controls, 2);
});

test("aborted batches reject before pending reads drain and never start another request", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const { source, stats } = fixture({
    read: async (input) => {
      await gate.promise;
      return pair(input);
    },
  });
  let outcome: { error?: unknown } | undefined;
  const observed = source.readMatchPairs(requests(8), controller.signal).then(
    () => (outcome = {}),
    (error) => (outcome = { error }),
  );
  try {
    await setImmediate();
    assert.equal(stats.active, 4);
    controller.abort();
    await setImmediate();
    assert.ok(outcome);
    assert.equal(outcome.error, controller.signal.reason);
    assert.equal(stats.active, 4);
    assert.equal(stats.controls, 1);
    assert.equal(stats.requests.length, 4);
  } finally {
    gate.resolve();
    await observed;
    await setImmediate();
  }
  assert.equal(stats.controls, 1);
  assert.equal(stats.requests.length, 4);
  assert.equal(stats.active, 0);
});

test("cancellation overrides an earlier room failure without awaiting stalled reads or retrying", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const reason = new DOMException("event deadline exceeded", "TimeoutError");
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
    read: async (input) => {
      if (input.inviteId === "invite-0") throw new Error("room-unavailable");
      await gate.promise;
      if (input.inviteId === "invite-1") throw new Error("late-room-failure");
      return pair(input);
    },
  });
  let outcome: { error?: unknown } | undefined;
  const observed = source.readMatchPairs(requests(8), controller.signal).then(
    () => (outcome = {}),
    (error) => (outcome = { error }),
  );
  try {
    await setImmediate();
    assert.equal(stats.active, 3);
    controller.abort(reason);
    await setImmediate();
    assert.ok(outcome);
    assert.equal(outcome.error, reason);
    assert.equal(stats.active, 3);
    assert.equal(stats.controls, 1);
    assert.equal(stats.requests.length, 4);
  } finally {
    gate.resolve();
    await observed;
    await setImmediate();
  }
  assert.equal(outcome?.error, reason);
  assert.equal(stats.controls, 1);
  assert.equal(stats.requests.length, 4);
  assert.equal(stats.active, 0);
});

test("cancellation during either authority read fences room requests and results", async () => {
  for (const abortOnRead of [1, 2]) {
    const controller = new AbortController();
    const { source, stats } = fixture({
      control: (index) => {
        if (index === abortOnRead) controller.abort();
        return { backend: "durable", state: "active", epoch: 1 };
      },
    });
    await assert.rejects(
      source.readMatchPairs(requests(2), controller.signal),
      {
        name: "AbortError",
      },
    );
    assert.equal(stats.controls, abortOnRead);
    assert.equal(stats.requests.length, abortOnRead === 1 ? 0 : 2);
  }
});

test("single pairs match one-item batches and retain null opponents and duplicate positions", async (t) => {
  t.mock.method(console, "info", () => {});
  const { source } = fixture();
  const inputs = requests(3);
  const withoutOpponent = { ...inputs[1], opponentId: null };
  for (const input of [inputs[0], withoutOpponent]) {
    const single = await source.readMatchPair(input);
    assert.deepEqual(await source.readMatchPairs([input]), [single]);
    assert.deepEqual(single, pair({ ...input, epoch: 1 }));
  }
  const targets = [inputs[2], withoutOpponent, inputs[0], withoutOpponent];
  assert.deepEqual(
    await source.readMatchPairs(targets),
    targets.map((input) => pair({ ...input, epoch: 1 })),
  );
});

test("only nonempty public pair batches emit one timing event", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  const { source } = fixture();
  const [input] = requests(1);
  await source.readMatchPair(input);
  assert.deepEqual(await source.readMatchPairs([]), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.readMatchPair(input, controller.signal));
  await assert.rejects(source.readMatchPairs([input], controller.signal));
  assert.equal(log.mock.callCount(), 0);
  await source.readMatchPairs([input]);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).count, 1);
  assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).outcome, "ok");
  const failure = new Error("room-unavailable");
  const failed = fixture({
    read: async () => {
      throw failure;
    },
  });
  await assert.rejects(failed.source.readMatchPair(input), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(log.mock.callCount(), 1);
  await assert.rejects(failed.source.readMatchPairs([input]));
  assert.equal(log.mock.callCount(), 2);
  const timing = JSON.parse(log.mock.calls[1].arguments[0]);
  assert.equal(timing.count, 1);
  assert.equal(timing.outcome, "error");
});

test("single and batch pairs promptly cancel stalled authority and room reads", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  for (const mode of ["single", "batch"] as const) {
    for (const blockedAt of ["control-before", "rooms", "control-after"]) {
      const gate = deferred();
      const controller = new AbortController();
      const reason = new DOMException(
        "event deadline exceeded",
        "TimeoutError",
      );
      const { source, stats } = fixture({
        control: async (index) => {
          if (
            (blockedAt === "control-before" && index === 1) ||
            (blockedAt === "control-after" && index === 2)
          )
            await gate.promise;
          return { backend: "durable", state: "active", epoch: 1 };
        },
        read: async (input) => {
          if (blockedAt === "rooms") {
            await gate.promise;
            throw new Error("late-room-failure");
          }
          return pair(input);
        },
      });
      const inputs = requests(mode === "single" ? 1 : 8);
      const logsBefore = log.mock.callCount();
      let outcome: { error?: unknown } | undefined;
      const observed = (
        mode === "single"
          ? source.readMatchPair(inputs[0], controller.signal)
          : source.readMatchPairs(inputs, controller.signal)
      ).then(
        () => (outcome = {}),
        (error) => (outcome = { error }),
      );
      try {
        await setImmediate();
        const beforeAbort = {
          controls: stats.controls,
          requests: stats.requests.length,
        };
        controller.abort(reason);
        await setImmediate();
        assert.ok(outcome, `${mode}:${blockedAt}`);
        assert.equal(outcome.error, reason);
        assert.equal(
          log.mock.callCount() - logsBefore,
          mode === "single" ? 0 : 1,
        );
        if (mode === "batch")
          assert.equal(
            JSON.parse(log.mock.calls.at(-1)!.arguments[0]).outcome,
            "aborted",
          );
        gate.resolve();
        await observed;
        await setImmediate();
        assert.deepEqual(
          { controls: stats.controls, requests: stats.requests.length },
          beforeAbort,
        );
        assert.equal(stats.active, 0);
      } finally {
        gate.resolve();
        await observed;
      }
    }
  }
});

test("aborted pair timing includes elapsed authority and room time before reads drain", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  for (const blockedAt of ["control-before", "rooms", "control-after"]) {
    const gate = deferred();
    const controller = new AbortController();
    const { source, stats } = fixture({
      control: async (index) => {
        if (
          (blockedAt === "control-before" && index === 1) ||
          (blockedAt === "control-after" && index === 2)
        )
          await gate.promise;
        return { backend: "durable", state: "active", epoch: 1 };
      },
      read: async (input) => {
        if (blockedAt === "rooms") await gate.promise;
        return pair(input);
      },
    });
    const logsBefore = log.mock.callCount();
    const observed = source
      .readMatchPairs(requests(1), controller.signal)
      .catch((error) => {
        assert.equal(error, controller.signal.reason);
      });
    try {
      await setImmediate();
      const active = blockedAt === "rooms" ? 1 : 0;
      assert.equal(stats.active, active);
      now += 37;
      controller.abort();
      await setImmediate();
      assert.equal(log.mock.callCount(), logsBefore + 1);
      assert.equal(stats.active, active);
      const timing = JSON.parse(log.mock.calls.at(-1)!.arguments[0]);
      assert.equal(timing.outcome, "aborted");
      assert.equal(timing.roomReadsMs, blockedAt === "rooms" ? 37 : 0);
      assert.equal(timing.authorityMs, blockedAt === "rooms" ? 0 : 37);
      assert.equal(timing.durationMs, 37);
      now += 100;
    } finally {
      gate.resolve();
      await observed;
      await setImmediate();
    }
    assert.equal(log.mock.callCount(), logsBefore + 1);
    assert.equal(stats.active, 0);
  }
});
