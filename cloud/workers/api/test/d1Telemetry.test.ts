import assert from "node:assert/strict";
import test from "node:test";
import {
  collectD1Telemetry,
  measureD1Phase,
  withD1OperationTelemetry,
  type D1TelemetrySummary,
} from "../src/d1Telemetry.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import { measureAutomatchPhase } from "../src/automatchTelemetry.ts";
import { runScheduledTasks } from "../src/scheduledTasks.ts";

const query = "SELECT private_query FROM private_table WHERE private_key = ?";
const bindingValue = "private-binding-value";
const result = {
  success: true as const,
  results: [{ secret: "private-result-value" }],
  meta: {
    changed_db: false,
    changes: 1,
    duration: 5,
    last_row_id: 0,
    rows_read: 3,
    rows_written: 1,
    size_after: 0,
    timings: { sql_duration_ms: 2 },
  },
};

function databaseFixture(
  execute: (method: string, args: unknown[]) => unknown = () => result,
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const prepared: { query: string; values: unknown[] }[] = [];
  const nativeStatements = new WeakSet<D1PreparedStatement>();
  const statement = (
    sql: string,
    values: unknown[] = [],
  ): D1PreparedStatement => {
    const wrapped = new Proxy(TELEGRAM_TEST_ENV.PROFILE_DB.prepare(sql), {
      get(target, property) {
        if (property === "bind")
          return (...next: unknown[]) => statement(sql, next);
        if (["all", "run", "first", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            prepared.push({ query: sql, values });
            calls.push({ method: String(property), args });
            return execute(String(property), args);
          };
        return Reflect.get(target, property, target);
      },
    });
    nativeStatements.add(wrapped);
    return wrapped;
  };
  const batch = async <T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> => {
    assert.ok(statements.every((item) => nativeStatements.has(item)));
    calls.push({ method: "batch", args: statements });
    return statements.map(() => result as D1Result<T>);
  };
  const db = {
    ...TELEGRAM_TEST_ENV.PROFILE_DB,
    prepare: statement,
    batch,
    withSession: (constraint?: string): D1DatabaseSession => {
      calls.push({ method: "withSession", args: [constraint] });
      return {
        prepare: statement,
        batch,
        getBookmark: () => "private-bookmark",
      };
    },
    exec: async (sql: string) => {
      calls.push({ method: "exec", args: [sql] });
      return { count: 1, duration: 9 };
    },
  } satisfies D1Database;
  return { db, calls, prepared };
}

test("collects D1 metadata without altering statements, sessions, or results", async () => {
  const fixture = databaseFixture();
  const summaries: D1TelemetrySummary[] = [];
  let clock = 0;
  const response = new Response("unchanged");
  assert.equal(
    await collectD1Telemetry(
      { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
      async (env) => {
        assert.equal(env.PROFILE_DB, env.PROFILE_DB);
        assert.equal(
          env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_TEST_ENV.TELEGRAM_BOT_TOKEN,
        );
        const statement = env.PROFILE_DB.prepare(query).bind(bindingValue);
        assert.equal(await statement.all(), result);
        const session = env.PROFILE_DB.withSession("private-bookmark");
        assert.equal(session.getBookmark(), "private-bookmark");
        await measureD1Phase("commit", async () => {
          assert.equal(await session.prepare(query).bind(1).run(), result);
          const batch = await session.batch([
            statement,
            session.prepare(query).bind(2),
          ]);
          assert.equal(batch[0], result);
          assert.equal(batch[1], result);
        });
        return response;
      },
      { now: () => clock++, onComplete: (summary) => summaries.push(summary) },
    ),
    response,
  );
  assert.deepEqual(fixture.prepared, [
    { query, values: [bindingValue] },
    { query, values: [1] },
  ]);
  assert.deepEqual(
    fixture.calls.map(({ method }) => method),
    ["all", "withSession", "run", "batch"],
  );
  assert.deepEqual(fixture.calls[1].args, ["private-bookmark"]);
  assert.deepEqual(summaries[0].d1, {
    calls: 3,
    failedCalls: 0,
    elapsedMs: 3,
    metadataResults: 4,
    callsWithoutMetadata: 0,
    rowsRead: 12,
    rowsWritten: 4,
    sqlDurationMs: 8,
  });
  assert.deepEqual(summaries[0].databases.PROFILE_DB, summaries[0].d1);
  assert.equal(summaries[0].phases.commit.d1.calls, 2);
  assert.equal(summaries[0].phases.other.d1.calls, 1);
  const encoded = JSON.stringify(summaries);
  for (const secret of [
    query,
    bindingValue,
    "private-result-value",
    "private-bookmark",
  ])
    assert.equal(encoded.includes(secret), false);
});

test("first, raw, and exec retain their return formats and report missing metadata", async () => {
  const rawRows = [["column"], ["private-result-value"]];
  const fixture = databaseFixture((method, args) =>
    method === "raw" ? rawRows : args.length ? "private-result-value" : null,
  );
  let summary: D1TelemetrySummary | undefined;
  await collectD1Telemetry(
    { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
    async (env) => {
      const statement = env.PROFILE_DB.prepare(query);
      assert.equal(await statement.first(), null);
      assert.equal(await statement.first("column"), "private-result-value");
      assert.equal(await statement.raw({ columnNames: true }), rawRows);
      assert.deepEqual(await env.PROFILE_DB.exec(query), {
        count: 1,
        duration: 9,
      });
    },
    {
      onComplete: (value) => {
        summary = value;
      },
    },
  );
  assert.ok(summary);
  assert.equal(summary.d1.calls, 4);
  assert.equal(summary.d1.callsWithoutMetadata, 4);
  assert.equal(summary.d1.metadataResults, 0);
  assert.equal(summary.d1.rowsRead, null);
  assert.equal(summary.d1.rowsWritten, null);
  assert.equal(summary.d1.sqlDurationMs, null);
  assert.deepEqual(
    fixture.calls.map(({ method, args }) => ({ method, args })),
    [
      { method: "first", args: [] },
      { method: "first", args: ["column"] },
      { method: "raw", args: [{ columnNames: true }] },
      { method: "exec", args: [query] },
    ],
  );
});

test("uses duration fallback and rejects invalid metadata without failing the query", async () => {
  const values = [
    { ...result, meta: { ...result.meta, timings: undefined } },
    { ...result, meta: { ...result.meta, rows_read: -1 } },
    {
      ...result,
      meta: { ...result.meta, duration: Infinity, timings: undefined },
    },
    {
      get meta() {
        throw new Error("private-metadata-error");
      },
    },
  ];
  let index = 0;
  const fixture = databaseFixture(() => values[index++]);
  let summary: D1TelemetrySummary | undefined;
  await collectD1Telemetry(
    { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
    async (env) => {
      for (const expected of values)
        assert.equal(await env.PROFILE_DB.prepare(query).all(), expected);
    },
    {
      onComplete: (value) => {
        summary = value;
      },
    },
  );
  assert.ok(summary);
  assert.equal(summary.d1.callsWithoutMetadata, 3);
  assert.equal(summary.d1.metadataResults, 1);
  assert.equal(summary.d1.sqlDurationMs, 5);
});

test("records failed calls and preserves the exact failure if completion hooks fail", async () => {
  const failure = new Error("private-database-error");
  const fixture = databaseFixture(() => {
    throw failure;
  });
  let summary: D1TelemetrySummary | undefined;
  await assert.rejects(
    collectD1Telemetry(
      { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
      async (env) => env.PROFILE_DB.prepare(query).run(),
      {
        onComplete: (value, completion) => {
          summary = value;
          assert.equal(completion.ok, false);
          throw new Error("private-telemetry-error");
        },
      },
    ),
    (error) => error === failure,
  );
  assert.ok(summary);
  assert.equal(summary.d1.failedCalls, 1);
  assert.equal(summary.d1.callsWithoutMetadata, 1);
  assert.equal(JSON.stringify(summary).includes(failure.message), false);
  assert.equal(
    await collectD1Telemetry(TELEGRAM_TEST_ENV, async () => 42, {
      onComplete: () => {
        throw new Error("hook-failed");
      },
    }),
    42,
  );
});

test("isolates concurrent scopes and captures the phase at call start", async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const summaries: D1TelemetrySummary[] = [];
  const run = (phase: string, promise: Promise<unknown>) => {
    const fixture = databaseFixture(() => promise);
    return collectD1Telemetry(
      { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
      (env) => measureD1Phase(phase, () => env.PROFILE_DB.prepare(query).all()),
      { onComplete: (summary) => summaries.push(summary) },
    );
  };
  const firstRun = run("first", first.promise);
  const secondRun = run("second", second.promise);
  second.resolve(result);
  await secondRun;
  first.resolve(result);
  await firstRun;
  assert.deepEqual(
    summaries.map((summary) => Object.keys(summary.phases)),
    [["second"], ["first"]],
  );
  assert.ok(summaries.every((summary) => summary.d1.calls === 1));
});

test("attributes nested phases to their concurrent scheduled tasks without inflating totals", async () => {
  const fixture = databaseFixture();
  let summary: D1TelemetrySummary | undefined;
  await collectD1Telemetry(
    { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
    (env) =>
      runScheduledTasks(
        [
          {
            name: "gameSessionTransitions",
            async run() {
              await env.PROFILE_DB.prepare(query).first();
              await measureAutomatchPhase("finalize", () =>
                env.PROFILE_DB.prepare(query).run(),
              );
              await env.PROFILE_DB.prepare(query).all();
            },
          },
          {
            name: "eventTransitions",
            run: () =>
              measureAutomatchPhase("finalize", () =>
                env.PROFILE_DB.prepare(query).run(),
              ),
          },
        ],
        { scheduledTime: 0 },
      ),
    {
      onComplete: (value) => {
        summary = value;
      },
    },
  );
  assert.ok(summary);
  assert.equal(summary.d1.calls, 4);
  assert.equal(summary.d1.metadataResults, 3);
  assert.deepEqual(summary.databases.PROFILE_DB, summary.d1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(summary.phases).map(([name, phase]) => [
        name,
        {
          calls: phase.d1.calls,
          metadataResults: phase.d1.metadataResults,
          rowsRead: phase.d1.rowsRead,
          rowsWritten: phase.d1.rowsWritten,
          sqlDurationMs: phase.d1.sqlDurationMs,
        },
      ]),
    ),
    {
      gameSessionTransitions: {
        calls: 3,
        metadataResults: 2,
        rowsRead: 6,
        rowsWritten: 2,
        sqlDurationMs: 4,
      },
      eventTransitions: {
        calls: 1,
        metadataResults: 1,
        rowsRead: 3,
        rowsWritten: 1,
        sqlDurationMs: 2,
      },
      finalize: {
        calls: 2,
        metadataResults: 2,
        rowsRead: 6,
        rowsWritten: 2,
        sqlDurationMs: 4,
      },
    },
  );
});

test("nested task failures are attributed once even when task and phase names match", async () => {
  const failure = new Error("database-unavailable");
  const fixture = databaseFixture(() => {
    throw failure;
  });
  let summary: D1TelemetrySummary | undefined;
  await assert.rejects(
    collectD1Telemetry(
      { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
      (env) =>
        runScheduledTasks(
          [
            {
              name: "gameSessionTransitions",
              run: () =>
                measureAutomatchPhase("gameSessionTransitions", () =>
                  env.PROFILE_DB.prepare(query).run(),
                ),
            },
            {
              name: "eventTransitions",
              run: () =>
                measureAutomatchPhase("finalize", () =>
                  env.PROFILE_DB.prepare(query).run(),
                ),
            },
          ],
          { scheduledTime: 0, logger: { error() {} } },
        ),
      {
        onComplete: (value) => {
          summary = value;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.ok(summary);
  assert.equal(summary.d1.calls, 2);
  assert.equal(summary.d1.failedCalls, 2);
  assert.equal(summary.phases.gameSessionTransitions.d1.calls, 1);
  assert.equal(summary.phases.gameSessionTransitions.d1.failedCalls, 1);
  assert.equal(summary.phases.finalize.d1.calls, 1);
  assert.equal(summary.phases.eventTransitions.d1.calls, 1);
  assert.equal(summary.phases.eventTransitions.d1.failedCalls, 1);
  assert.equal(summary.phases.eventTransitions.d1.callsWithoutMetadata, 1);
  assert.equal(summary.phases.eventTransitions.d1.rowsRead, null);
});

test("freezes clocks and summaries when the main work finishes", async () => {
  const pending = Promise.withResolvers<unknown>();
  const fixture = databaseFixture(() => pending.promise);
  let measured: Env | undefined;
  let background: Promise<unknown> | undefined;
  let summary: D1TelemetrySummary | undefined;
  let closed = false;
  await collectD1Telemetry(
    { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db },
    async (env) => {
      measured = env;
      background = measureD1Phase("background", () =>
        env.PROFILE_DB.prepare(query).all(),
      );
    },
    {
      now: () => {
        assert.equal(closed, false);
        return 0;
      },
      onComplete: (value) => {
        summary = value;
        closed = true;
      },
    },
  );
  assert.ok(measured);
  assert.ok(summary);
  const snapshot = structuredClone(summary);
  pending.resolve(result);
  await background;
  await measured.PROFILE_DB.prepare(query).run();
  await measureD1Phase("later", async () => undefined);
  assert.deepEqual(summary, snapshot);
  assert.equal(summary.d1.calls, 1);
  assert.equal(summary.d1.metadataResults, 0);
});

test("samples once, logs only fixed labels and metrics, and leaves headers untouched", async () => {
  const fixture = databaseFixture();
  const env = { ...TELEGRAM_TEST_ENV, PROFILE_DB: fixture.db };
  const response = new Response("private-response-body", {
    headers: {
      "Server-Timing": "existing;dur=1",
      "X-Private": "private-header",
    },
  });
  const headers = [...response.headers];
  const logs: Record<string, unknown>[] = [];
  let samples = 0;
  assert.equal(
    await withD1OperationTelemetry(
      "ratings.update",
      env,
      async (measured) => {
        await measured.PROFILE_DB.prepare(query).bind(bindingValue).all();
        await measured.PROFILE_DB.prepare(query).first();
        return response;
      },
      {
        sample: () => {
          samples++;
          return true;
        },
        log: (record) => logs.push(record),
      },
    ),
    response,
  );
  assert.equal(samples, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "d1_timing");
  assert.equal(logs[0].operation, "ratings.update");
  assert.equal(logs[0].status, 200);
  assert.deepEqual([...response.headers], headers);
  const encoded = JSON.stringify(logs);
  for (const secret of [
    query,
    bindingValue,
    "private-result-value",
    "private-response-body",
    "private-header",
  ])
    assert.equal(encoded.includes(secret), false);
});

test("unsampled work uses original bindings and logs only throws or HTTP 5xx", async () => {
  const logs: Record<string, unknown>[] = [];
  const options = {
    sample: () => false,
    log: (record: Record<string, unknown>) => logs.push(record),
  };
  for (const status of [200, 401, 503]) {
    const response = await withD1OperationTelemetry(
      "/events/state/sync",
      TELEGRAM_TEST_ENV,
      async (env) => {
        assert.equal(env, TELEGRAM_TEST_ENV);
        return new Response(null, { status });
      },
      options,
    );
    assert.equal(response.status, status);
  }
  const failure = new Error("private-operation-failure");
  await assert.rejects(
    withD1OperationTelemetry(
      "scheduled.recovery",
      TELEGRAM_TEST_ENV,
      async () => {
        throw failure;
      },
      options,
    ),
    (error) => error === failure,
  );
  assert.equal(logs.length, 2);
  assert.equal(logs[0].status, 503);
  assert.ok(
    logs.every((record) => record.d1 === null && record.outcome === "failed"),
  );
  assert.equal(JSON.stringify(logs).includes(failure.message), false);
});

test("sampling and logging hooks cannot replace successful results or failures", async () => {
  const failure = new Error("original-error");
  for (const sample of [
    () => true,
    () => false,
    () => {
      throw new Error("sample-error");
    },
  ]) {
    const options = {
      sample,
      log: () => {
        throw new Error("log-error");
      },
    };
    assert.equal(
      await withD1OperationTelemetry(
        "test",
        TELEGRAM_TEST_ENV,
        async () => 42,
        options,
      ),
      42,
    );
    await assert.rejects(
      withD1OperationTelemetry(
        "test",
        TELEGRAM_TEST_ENV,
        async () => {
          throw failure;
        },
        options,
      ),
      (error) => error === failure,
    );
  }
});
