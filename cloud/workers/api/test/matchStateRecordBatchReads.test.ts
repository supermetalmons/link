import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import type {
  MatchStateRecord,
  MatchStateRecordsRequest,
} from "../src/matchStateTypes.ts";

type Request = { playerId: string; matchId: string };
type Control = { backend: string; state: string; epoch: number };
type Route = {
  actor_uid: string;
  match_id: string;
  kind: "durable" | "legacy";
  invite_id: string | null;
  epoch: number;
};
type LegacyResult = {
  success: boolean;
  results: Array<{ record_json: string }>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requests(count: number): Request[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index}`,
    matchId: `match-${index}`,
  }));
}

function route(input: Request, epoch = 1): Route {
  return {
    actor_uid: input.playerId,
    match_id: input.matchId,
    kind: "durable",
    invite_id: `stored-invite-${Math.floor(Number(input.matchId.split("-")[1]) / 2)}`,
    epoch,
  };
}

function records(input: MatchStateRecordsRequest): MatchStateRecord[] {
  return input.requests.map((request) => ({
    ...request,
    inviteId: input.inviteId,
    epoch: input.epoch,
  }));
}

function fixture({
  control = () => ({ backend: "durable", state: "active", epoch: 1 }),
  findRoute = (input) => route(input),
  beforeRoutes = async () => {},
  read = async (input) => records(input),
  legacy = async (input) => ({ ...input, legacy: true }),
  legacyJson,
  mapLegacyResults = (results) => results,
}: {
  control?: (index: number) => Control | Promise<Control>;
  findRoute?: (input: Request, controls: number) => Route | null;
  beforeRoutes?: (inputs: Request[], batch: number) => Promise<void>;
  read?: (
    input: MatchStateRecordsRequest,
  ) => Promise<Array<MatchStateRecord | null>>;
  legacy?: (input: Request) => Promise<unknown | null>;
  legacyJson?: (input: Request) => Promise<string | null>;
  mapLegacyResults?: (results: LegacyResult[]) => LegacyResult[];
} = {}) {
  const stats = {
    controls: 0,
    sessions: 0,
    routeBatches: [] as Request[][],
    routeBatchSessions: [] as number[],
    scalarRoutes: [] as Request[],
    legacyBatches: [] as Request[][],
    legacyBatchSessions: [] as number[],
    legacyReads: [] as Request[],
    roomReads: [] as MatchStateRecordsRequest[],
    active: 0,
    maximumActive: 0,
  };
  const tracked = async <T>(work: () => Promise<T>) => {
    stats.active++;
    stats.maximumActive = Math.max(stats.maximumActive, stats.active);
    try {
      return await work();
    } finally {
      stats.active--;
    }
  };
  const readLegacyRow = async (input: Request) => {
    stats.legacyReads.push(input);
    const value = legacyJson ? await legacyJson(input) : await legacy(input);
    return value === null
      ? null
      : { record_json: legacyJson ? (value as string) : JSON.stringify(value) };
  };
  const source = createMatchStateSource({
    PROFILE_GAMES_DB: {
      withSession: (constraint: string) => {
        assert.equal(constraint, "first-primary");
        const session = ++stats.sessions;
        return {
          prepare: (sql: string) => {
            const statement = {
              sql,
              values: [] as string[],
              bind(...values: string[]) {
                statement.values = values;
                return statement;
              },
              async first() {
                if (sql.includes("FROM match_state_control")) {
                  return {
                    ...(await control(++stats.controls)),
                    freeze_generation: 0,
                  };
                }
                const input = {
                  playerId: statement.values[0],
                  matchId: statement.values[1],
                };
                if (sql.includes("FROM match_state_legacy_records")) {
                  return tracked(() => readLegacyRow(input));
                }
                assert.ok(sql.includes("FROM match_state_routes"));
                stats.scalarRoutes.push(input);
                return findRoute(input, stats.controls);
              },
            };
            return statement;
          },
          batch: async (
            statements: Array<{ sql: string; values: string[] }>,
          ) => {
            const isLegacy = statements[0]?.sql.includes(
              "FROM match_state_legacy_records",
            );
            const inputs = statements.map(({ sql, values }) => {
              assert.ok(
                sql.includes(
                  isLegacy
                    ? "FROM match_state_legacy_records"
                    : "FROM match_state_routes",
                ),
              );
              assert.equal(values.length, 2);
              return { playerId: values[0], matchId: values[1] };
            });
            if (isLegacy) {
              stats.legacyBatches.push(inputs);
              stats.legacyBatchSessions.push(session);
              return tracked(async () => {
                const results: LegacyResult[] = [];
                for (const input of inputs) {
                  const found = await readLegacyRow(input);
                  results.push({
                    success: true,
                    results: found ? [found] : [],
                  });
                }
                return mapLegacyResults(results);
              });
            }
            stats.routeBatches.push(inputs);
            stats.routeBatchSessions.push(session);
            await beforeRoutes(inputs, stats.routeBatches.length);
            return inputs.map((input) => {
              const found = findRoute(input, stats.controls);
              return { success: true, results: found ? [found] : [] };
            });
          },
        };
      },
    },
    INVITE_REACTIONS: {
      getByName: (inviteId: string) => ({
        readCanonicalMatchRecords: async (input: MatchStateRecordsRequest) => {
          assert.equal(input.inviteId, inviteId);
          stats.roomReads.push(input);
          return tracked(async () => ({ ok: true, value: await read(input) }));
        },
      }),
    },
  } as unknown as Env);
  return { source, stats };
}

test("eight records batch routes once and read four stored invites in input order", async () => {
  const pending: ReturnType<typeof deferred>[] = [];
  const { source, stats } = fixture({
    read: async (input) => {
      const gate = deferred();
      pending.push(gate);
      await gate.promise;
      return records(input);
    },
  });
  const inputs = requests(8);
  const result = source.readMatchRecords(inputs);
  await setImmediate();
  assert.equal(stats.active, 4);
  while (pending.length) {
    pending.pop()!.resolve();
    await setImmediate();
  }
  assert.deepEqual(
    await result,
    inputs.map((input) => ({
      ...input,
      inviteId: route(input).invite_id,
      epoch: 1,
    })),
  );
  assert.equal(stats.controls, 2);
  assert.deepEqual(stats.routeBatches, [inputs]);
  assert.equal(stats.roomReads.length, 4);
  assert.ok(stats.roomReads.every((input) => input.requests.length === 2));
  assert.equal(stats.maximumActive, 4);
  assert.equal(stats.active, 0);
  assert.deepEqual(stats.scalarRoutes, []);
});

test("eight legacy records use one primary batch in input order", async () => {
  const inputs = requests(8);
  const { source, stats } = fixture({
    findRoute: (input) => ({
      ...route(input),
      kind: "legacy",
      invite_id: null,
    }),
  });
  assert.deepEqual(
    await source.readMatchRecords(inputs),
    inputs.map((input) => ({ ...input, legacy: true })),
  );
  assert.deepEqual(stats.routeBatches, [inputs]);
  assert.deepEqual(stats.legacyBatches, [inputs]);
  assert.deepEqual(stats.legacyReads, inputs);
  assert.equal(stats.legacyBatchSessions.length, 1);
  assert.equal(stats.controls, 2);
  assert.equal(stats.maximumActive, 1);
  assert.deepEqual(stats.roomReads, []);
  assert.deepEqual(stats.scalarRoutes, []);
});

test("interleaved legacy duplicates retain raw JSON values and missing positions", async () => {
  const inputs = requests(7);
  const targets = [
    inputs[4],
    inputs[5],
    inputs[0],
    inputs[2],
    inputs[1],
    inputs[0],
    inputs[6],
    inputs[3],
  ];
  const values = [null, false, 0, [1, { legacy: true }], ""];
  const { source, stats } = fixture({
    findRoute: (input) =>
      input.matchId === inputs[6].matchId
        ? null
        : input.matchId === inputs[5].matchId
          ? route(input)
          : { ...route(input), kind: "legacy", invite_id: null },
    legacyJson: async (input) =>
      JSON.stringify(values[Number(input.matchId.split("-")[1])]),
  });
  assert.deepEqual(await source.readMatchRecords(targets), [
    "",
    { ...inputs[5], inviteId: route(inputs[5]).invite_id, epoch: 1 },
    null,
    0,
    false,
    null,
    null,
    values[3],
  ]);
  assert.deepEqual(stats.legacyBatches, [
    [inputs[4], inputs[0], inputs[2], inputs[1], inputs[0], inputs[3]],
  ]);
  assert.deepEqual(stats.routeBatches, [targets]);
  assert.equal(stats.roomReads.length, 1);
});

test("only absent legacy rows recheck routes in a fresh primary session", async () => {
  for (const recheckedKind of ["missing", "durable", "legacy"] as const) {
    let routeBatch = 0;
    const inputs = requests(3);
    const { source, stats } = fixture({
      beforeRoutes: async (_inputs, batch) => {
        routeBatch = batch;
      },
      findRoute: (input) =>
        routeBatch === 1 || recheckedKind === "legacy"
          ? { ...route(input), kind: "legacy", invite_id: null }
          : recheckedKind === "durable"
            ? route(input)
            : null,
      legacy: async (input) =>
        input.matchId === inputs[0].matchId ? { stored: true } : null,
    });
    const result = source.readMatchRecords(inputs);
    if (recheckedKind === "legacy") {
      await assert.rejects(result, {
        message: "match-state-legacy-record-unavailable",
      });
    } else {
      assert.deepEqual(await result, [{ stored: true }, null, null]);
    }
    assert.deepEqual(stats.legacyBatches, [inputs]);
    assert.deepEqual(stats.routeBatches, [inputs, inputs.slice(1)]);
    assert.notEqual(stats.routeBatchSessions[1], stats.legacyBatchSessions[0]);
    assert.notEqual(stats.routeBatchSessions[1], stats.routeBatchSessions[0]);
    assert.deepEqual(stats.scalarRoutes, []);
    assert.equal(stats.controls, 2);
  }
});

test("malformed JSON and incomplete legacy batches fail closed", async () => {
  for (const malformedJson of [false, true]) {
    const { source, stats } = fixture({
      findRoute: (input) => ({
        ...route(input),
        kind: "legacy",
        invite_id: null,
      }),
      ...(malformedJson
        ? { legacyJson: async () => "{" }
        : {
            mapLegacyResults: (results: LegacyResult[]) => results.slice(0, -1),
          }),
    });
    await assert.rejects(source.readMatchRecords(requests(2)), (error) => {
      if (malformedJson) assert.ok(error instanceof SyntaxError);
      else
        assert.equal(
          (error as Error).message,
          "match-state-legacy-record-unavailable",
        );
      return true;
    });
    assert.equal(stats.legacyBatches.length, 1);
    assert.equal(stats.routeBatches.length, 1);
    assert.equal(stats.controls, 2);
    assert.deepEqual(stats.roomReads, []);
  }
});

test("duplicate and interleaved targets preserve every result position", async () => {
  const { source, stats } = fixture();
  const inputs = requests(4);
  const targets = [inputs[3], inputs[0], inputs[2], inputs[0], inputs[1]];
  assert.deepEqual(
    await source.readMatchRecords(targets),
    targets.map((input) => ({
      ...input,
      inviteId: route(input).invite_id,
      epoch: 1,
    })),
  );
  assert.equal(stats.roomReads.length, 2);
  assert.equal(stats.controls, 2);
});

test("single records and one-item batches preserve the same routing outcomes", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  const [input] = requests(1);
  const cases: Array<{
    options?: Parameters<typeof fixture>[0];
    value?: unknown;
    error?: string;
  }> = [
    { value: { ...input, inviteId: "stored-invite-0", epoch: 1 } },
    {
      options: { findRoute: () => null },
      value: null,
    },
    {
      options: {
        findRoute: (target) => ({
          ...route(target),
          kind: "legacy",
          invite_id: null,
        }),
        legacy: async () => [1, { legacy: true }],
      },
      value: [1, { legacy: true }],
    },
    {
      options: { read: async () => [null] },
      error: "match-state-record-unavailable",
    },
    {
      options: {
        findRoute: (target) => ({
          ...route(target),
          kind: "legacy",
          invite_id: null,
        }),
        legacy: async () => null,
      },
      error: "match-state-legacy-record-unavailable",
    },
    {
      options: { findRoute: (target) => route(target, 2) },
      error: "match-state-route-epoch-conflict",
    },
    {
      options: {
        control: () => ({ backend: "durable", state: "frozen", epoch: 1 }),
      },
      value: { ...input, inviteId: "stored-invite-0", epoch: 1 },
    },
    {
      options: {
        control: () => ({ backend: "rtdb", state: "active", epoch: 1 }),
      },
      error: "match-state-durable-authority-required",
    },
  ];
  for (const mode of ["single", "batch"] as const) {
    for (const scenario of cases) {
      const { source } = fixture(scenario.options);
      const result =
        mode === "single"
          ? source.readMatchRecord(input)
          : source.readMatchRecords([input]).then(([record]) => record);
      if (scenario.error)
        await assert.rejects(result, { message: scenario.error });
      else assert.deepEqual(await result, scenario.value);
    }
  }
  assert.equal(log.mock.callCount(), 0);
});

test("invalid and pre-aborted single records perform no storage reads", async () => {
  const { source, stats } = fixture();
  for (const input of [
    { playerId: "player/invalid", matchId: "match-0" },
    { playerId: "player-0", matchId: "match/invalid" },
  ])
    await assert.rejects(source.readMatchRecord(input), {
      message: "match-state-invalid-read-target",
    });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.readMatchRecord(requests(1)[0], controller.signal),
    {
      name: "AbortError",
    },
  );
  assert.equal(stats.controls, 0);
  assert.deepEqual(stats.routeBatches, []);
  assert.deepEqual(stats.scalarRoutes, []);
  assert.deepEqual(stats.roomReads, []);
  assert.deepEqual(stats.legacyReads, []);
});

test("empty, invalid and pre-aborted batches perform no storage reads", async () => {
  const { source, stats } = fixture();
  assert.deepEqual(await source.readMatchRecords([]), []);
  const invalid: unknown[] = [
    requests(9),
    [{ playerId: "player/invalid", matchId: "match-0" }],
    [{ playerId: "player-0", matchId: "match/invalid" }],
    [null],
  ];
  for (const inputs of invalid)
    await assert.rejects(source.readMatchRecords(inputs as Request[]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.readMatchRecords(requests(2), controller.signal),
    {
      name: "AbortError",
    },
  );
  assert.equal(stats.controls, 0);
  assert.deepEqual(stats.routeBatches, []);
  assert.deepEqual(stats.roomReads, []);
  assert.deepEqual(stats.legacyReads, []);
});

test("mixed durable, legacy and missing routes retain scalar read results", async () => {
  const inputs = requests(4);
  const { source, stats } = fixture({
    findRoute: (input) =>
      input.matchId === "match-1"
        ? { ...route(input), kind: "legacy", invite_id: null }
        : input.matchId === "match-2"
          ? null
          : route(input),
  });
  assert.deepEqual(await source.readMatchRecords(inputs), [
    { ...inputs[0], inviteId: "stored-invite-0", epoch: 1 },
    { ...inputs[1], legacy: true },
    null,
    { ...inputs[3], inviteId: "stored-invite-1", epoch: 1 },
  ]);
  assert.deepEqual(stats.legacyReads, [inputs[1]]);
  assert.equal(stats.roomReads.length, 2);
  assert.equal(stats.controls, 2);
  assert.equal(stats.routeBatches.length, 1);
});

test("one legacy batch and room groups share the four-read concurrency limit", async () => {
  const pending: ReturnType<typeof deferred>[] = [];
  const pause = async () => {
    const gate = deferred();
    pending.push(gate);
    await gate.promise;
  };
  const inputs = requests(8);
  const { source, stats } = fixture({
    findRoute: (input) =>
      Number(input.matchId.split("-")[1]) % 2 === 0
        ? { ...route(input), invite_id: input.matchId }
        : { ...route(input), kind: "legacy", invite_id: null },
    read: async (input) => {
      await pause();
      return records(input);
    },
    legacy: async (input) => {
      await pause();
      return { ...input, legacy: true };
    },
  });
  const result = source.readMatchRecords(inputs);
  await setImmediate();
  assert.equal(stats.active, 4);
  while (pending.length) {
    pending.shift()!.resolve();
    await setImmediate();
  }
  assert.deepEqual(
    await result,
    inputs.map((input, index) =>
      index % 2 === 0
        ? { ...input, inviteId: input.matchId, epoch: 1 }
        : { ...input, legacy: true },
    ),
  );
  assert.equal(stats.legacyReads.length, 4);
  assert.deepEqual(stats.legacyBatches, [
    inputs.filter((_, index) => index % 2 === 1),
  ]);
  assert.equal(stats.roomReads.length, 4);
  assert.equal(stats.maximumActive, 4);
  assert.equal(stats.active, 0);
});

test("routed durable or legacy records cannot silently become missing", async () => {
  for (const kind of ["durable", "legacy"] as const) {
    const { source, stats } = fixture({
      findRoute: (input) => ({
        ...route(input),
        kind,
        invite_id: kind === "legacy" ? null : route(input).invite_id,
      }),
      read: async () => [null],
      legacy: async () => null,
    });
    await assert.rejects(source.readMatchRecords(requests(1)), {
      message:
        kind === "legacy"
          ? "match-state-legacy-record-unavailable"
          : "match-state-record-unavailable",
    });
    assert.equal(stats.controls, 2);
    assert.equal(stats.routeBatches.length, kind === "legacy" ? 2 : 1);
    assert.equal(stats.scalarRoutes.length, 0);
  }
});

test("authority changes discard all successful route and record results", async () => {
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
    findRoute: (input, controls) => route(input, controls === 1 ? 1 : 2),
  });
  assert.deepEqual(
    await source.readMatchRecords(requests(4)),
    requests(4).map((input) => ({
      ...input,
      inviteId: route(input).invite_id,
      epoch: 2,
    })),
  );
  assert.equal(stats.controls, 4);
  assert.equal(stats.routeBatches.length, 2);
  assert.deepEqual(
    stats.roomReads.map(({ epoch }) => epoch),
    [1, 1, 2, 2],
  );
});

test("authority changes discard legacy values and repeat the whole batch", async () => {
  let epoch = 1;
  const inputs = requests(3);
  const { source, stats } = fixture({
    control: (index) => {
      epoch = index === 1 ? 1 : 2;
      return { backend: "durable", state: "active", epoch };
    },
    findRoute: (input) => ({
      ...route(input, epoch),
      kind: "legacy",
      invite_id: null,
    }),
    legacy: async (input) => ({ ...input, epoch }),
  });
  assert.deepEqual(
    await source.readMatchRecords(inputs),
    inputs.map((input) => ({ ...input, epoch: 2 })),
  );
  assert.deepEqual(stats.legacyBatches, [inputs, inputs]);
  assert.deepEqual(stats.routeBatches, [inputs, inputs]);
  assert.notEqual(stats.legacyBatchSessions[0], stats.legacyBatchSessions[1]);
  assert.equal(stats.controls, 4);
  assert.deepEqual(stats.roomReads, []);
});

test("failed old-epoch groups drain before retrying and scheduling new groups", async () => {
  const gate = deferred();
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
    findRoute: (input, controls) => ({
      ...route(input, controls === 1 ? 1 : 2),
      invite_id: input.matchId,
    }),
    read: async (input) => {
      if (input.epoch === 1) {
        if (input.inviteId === "match-0") {
          await setImmediate();
          throw new Error("old-room-epoch");
        }
        await gate.promise;
      }
      return records(input);
    },
  });
  const result = source.readMatchRecords(requests(8));
  await setImmediate();
  await setImmediate();
  assert.equal(stats.controls, 1);
  assert.equal(stats.roomReads.length, 4);
  assert.equal(stats.active, 3);
  gate.resolve();
  assert.deepEqual(
    await result,
    requests(8).map((input) => ({
      ...input,
      inviteId: input.matchId,
      epoch: 2,
    })),
  );
  assert.equal(stats.controls, 4);
  assert.equal(stats.routeBatches.length, 2);
  assert.equal(stats.roomReads.filter(({ epoch }) => epoch === 2).length, 8);
  assert.equal(stats.maximumActive, 4);
  assert.equal(stats.active, 0);
});

test("stable authority preserves failures and route epoch conflicts without retry", async () => {
  const failure = new Error("room-unavailable");
  const failed = fixture({
    read: async () => {
      throw failure;
    },
  });
  await assert.rejects(failed.source.readMatchRecords(requests(8)), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.equal(failed.stats.controls, 2);
  assert.equal(failed.stats.routeBatches.length, 1);
  const conflicting = fixture({ findRoute: (input) => route(input, 2) });
  await assert.rejects(conflicting.source.readMatchRecords(requests(2)), {
    message: "match-state-route-epoch-conflict",
  });
  assert.equal(conflicting.stats.controls, 2);
  assert.equal(conflicting.stats.roomReads.length, 0);
});

test("authority churn stops after three complete batch attempts", async () => {
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: Math.floor(index / 2) + 1,
    }),
    findRoute: (input, controls) => route(input, Math.floor(controls / 2) + 1),
  });
  await assert.rejects(source.readMatchRecords(requests(2)), {
    message: "match-state-read-authority-changed",
  });
  assert.equal(stats.controls, 6);
  assert.equal(stats.routeBatches.length, 3);
  assert.deepEqual(
    stats.roomReads.map(({ epoch }) => epoch),
    [1, 2, 3],
  );
});

test("frozen authority permits reads and retired authority fails closed", async () => {
  const frozen = fixture({
    control: () => ({ backend: "durable", state: "frozen", epoch: 1 }),
  });
  assert.equal((await frozen.source.readMatchRecords(requests(2))).length, 2);
  assert.equal(frozen.stats.controls, 2);
  for (const initiallyDurable of [false, true]) {
    const { source, stats } = fixture({
      control: (index) => ({
        backend: initiallyDurable && index === 1 ? "durable" : "rtdb",
        state: "active",
        epoch: 1,
      }),
    });
    await assert.rejects(source.readMatchRecords(requests(2)), {
      message: "match-state-durable-authority-required",
    });
    assert.equal(stats.controls, initiallyDurable ? 3 : 1);
    assert.equal(stats.routeBatches.length, initiallyDurable ? 1 : 0);
    assert.equal(stats.roomReads.length, initiallyDurable ? 1 : 0);
  }
});

test("aborted legacy reads do not recheck missing-record routes after draining", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const { source, stats } = fixture({
    findRoute: (input) => ({
      ...route(input),
      kind: "legacy",
      invite_id: null,
    }),
    legacy: async () => {
      await gate.promise;
      return null;
    },
  });
  let outcome: { error?: unknown } | undefined;
  const observed = source.readMatchRecords(requests(8), controller.signal).then(
    () => (outcome = {}),
    (error) => (outcome = { error }),
  );
  try {
    await setImmediate();
    assert.equal(stats.active, 1);
    controller.abort();
    await setImmediate();
    assert.ok(outcome);
    assert.equal(outcome.error, controller.signal.reason);
    gate.resolve();
    await observed;
    await setImmediate();
    assert.equal(stats.controls, 1);
    assert.equal(stats.routeBatches.length, 1);
    assert.equal(stats.legacyReads.length, 8);
    assert.deepEqual(stats.legacyBatches, [requests(8)]);
    assert.equal(stats.scalarRoutes.length, 0);
    assert.equal(stats.roomReads.length, 0);
    assert.equal(stats.active, 0);
  } finally {
    gate.resolve();
    await observed;
  }
});

test("cancellation during legacy route recheck does not read authority afterward", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const inputs = requests(2);
  const { source, stats } = fixture({
    findRoute: (input) => ({
      ...route(input),
      kind: "legacy",
      invite_id: null,
    }),
    beforeRoutes: async (_inputs, batch) => {
      if (batch === 2) await gate.promise;
    },
    legacy: async () => null,
  });
  let outcome: { error?: unknown } | undefined;
  const observed = source.readMatchRecords(inputs, controller.signal).then(
    () => (outcome = {}),
    (error) => (outcome = { error }),
  );
  try {
    await setImmediate();
    assert.deepEqual(stats.routeBatches, [inputs, inputs]);
    controller.abort(new DOMException("cancel legacy recheck", "AbortError"));
    await setImmediate();
    assert.ok(outcome);
    assert.equal(outcome.error, controller.signal.reason);
    gate.resolve();
    await observed;
    await setImmediate();
    assert.equal(stats.controls, 1);
    assert.equal(stats.routeBatches.length, 2);
    assert.deepEqual(stats.legacyBatches, [inputs]);
    assert.deepEqual(stats.scalarRoutes, []);
    assert.deepEqual(stats.roomReads, []);
  } finally {
    gate.resolve();
    await observed;
  }
});

test("single and batch cancellation interrupt authority, routes and rooms without more work", async () => {
  for (const mode of ["single", "batch"] as const) {
    for (const blockedAt of [
      "control-before",
      "routes",
      "rooms",
      "control-after",
    ]) {
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
        beforeRoutes: async () => {
          if (blockedAt === "routes") await gate.promise;
        },
        findRoute: (input) => ({ ...route(input), invite_id: input.matchId }),
        read: async (input) => {
          if (blockedAt === "rooms") await gate.promise;
          return records(input);
        },
      });
      let outcome: { error?: unknown } | undefined;
      const observed = (
        mode === "single"
          ? source.readMatchRecord(requests(1)[0], controller.signal)
          : source.readMatchRecords(requests(8), controller.signal)
      ).then(
        () => (outcome = {}),
        (error) => (outcome = { error }),
      );
      try {
        await setImmediate();
        const beforeAbort = {
          controls: stats.controls,
          routes: stats.routeBatches.length,
          rooms: stats.roomReads.length,
        };
        if (blockedAt === "rooms")
          assert.equal(stats.active, mode === "single" ? 1 : 4);
        controller.abort(reason);
        await setImmediate();
        assert.ok(outcome, blockedAt);
        assert.equal(outcome.error, reason, blockedAt);
        gate.resolve();
        await observed;
        await setImmediate();
        assert.deepEqual(
          {
            controls: stats.controls,
            routes: stats.routeBatches.length,
            rooms: stats.roomReads.length,
          },
          beforeAbort,
          blockedAt,
        );
        assert.equal(stats.active, 0);
      } finally {
        gate.resolve();
        await observed;
      }
    }
  }
});

test("record cancellation overrides an earlier failure without retrying stalled groups", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const reason = new DOMException("event deadline exceeded", "TimeoutError");
  const { source, stats } = fixture({
    control: (index) => ({
      backend: "durable",
      state: "active",
      epoch: index === 1 ? 1 : 2,
    }),
    findRoute: (input) => ({ ...route(input), invite_id: input.matchId }),
    read: async (input) => {
      if (input.inviteId === "match-0") throw new Error("room-unavailable");
      await gate.promise;
      throw new Error("late-room-failure");
    },
  });
  let outcome: { error?: unknown } | undefined;
  const observed = source.readMatchRecords(requests(8), controller.signal).then(
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
  } finally {
    gate.resolve();
    await observed;
    await setImmediate();
  }
  assert.equal(outcome?.error, reason);
  assert.equal(stats.controls, 1);
  assert.equal(stats.routeBatches.length, 1);
  assert.equal(stats.roomReads.length, 4);
  assert.equal(stats.active, 0);
});
