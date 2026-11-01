import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { quarantineCanonicalAuthRecoveryJob } from "../src/profileCanonical/recovery.ts";
import { createProfileLinkCatchupStore } from "../src/profileLinkCatchupD1.ts";
import { quarantineRatingRecoveryEntry } from "../src/ratingProjectionD1.ts";
import { buildRecoveryQuarantineWrite } from "../src/recoveryQuarantine.ts";
import type { RatingRecoveryProjectionKind } from "../src/ratingContracts.ts";
import type { RecoveryRowObservation } from "../src/recoveryObservation.ts";

const lanes = [
  "auth",
  "profile-link",
  "event-progress",
  "profile-game",
  "telegram",
] as const;
type Lane = (typeof lanes)[number];
type Binding = string | number | Uint8Array | null;
type Stage = "prepare" | "bind" | "run";
type StoredObservation = Omit<RecoveryRowObservation, "keyBytes" | "fields"> & {
  keyBytes: number[];
  fields: Array<
    Omit<RecoveryRowObservation["fields"][number], "bytes"> & {
      bytes: number[] | null;
    }
  >;
};
type Baseline = {
  observation: StoredObservation;
  sql: string;
  bindings: Array<string | number | number[] | null>;
  result: Record<string, string>;
};

const baselines = JSON.parse(
  readFileSync(
    new URL("./recoveryQuarantineWriteBaseline.json", import.meta.url),
    "utf8",
  ),
) as Record<Lane, Baseline>;

function observationFor(lane: Lane): RecoveryRowObservation {
  const stored = baselines[lane].observation;
  return {
    ...stored,
    keyBytes: Uint8Array.from(stored.keyBytes),
    fields: stored.fields.map((field) => ({
      ...field,
      bytes: field.bytes === null ? null : Uint8Array.from(field.bytes),
    })),
  };
}

function bindingsFor(lane: Lane): Binding[] {
  return baselines[lane].bindings.map((value) =>
    Array.isArray(value) ? Uint8Array.from(value) : value,
  );
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function database({
  changes = 1,
  failAt,
  failure,
}: {
  changes?: unknown;
  failAt?: Stage;
  failure?: unknown;
} = {}) {
  const calls: Stage[] = [];
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const step = (stage: Stage) => {
    calls.push(stage);
    if (failAt === stage) throw failure;
  };
  const db = {
    prepare(sql: string) {
      step("prepare");
      queries.push(sql);
      return {
        bind(...values: unknown[]) {
          step("bind");
          bindings.push(values);
          return {
            async run() {
              step("run");
              return { meta: { changes } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls, queries, bindings };
}

function invoke(
  lane: Lane,
  db: D1Database,
  observation = observationFor(lane),
  nowMs = 2_000,
) {
  const entry = {
    kind: "invalid" as const,
    observation,
    reason: "invalid-record" as const,
  };
  if (lane === "auth") {
    return quarantineCanonicalAuthRecoveryJob(db, entry, nowMs);
  }
  if (lane === "profile-link") {
    return createProfileLinkCatchupStore(db).quarantineInvalidEntry(
      entry,
      nowMs,
    );
  }
  return quarantineRatingRecoveryEntry(
    db,
    { ...entry, projectionKind: lane },
    nowMs,
  );
}

async function rejectedValue(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

for (const lane of lanes) {
  test(`${lane} preserves its captured quarantine SQL, binding order, and report`, async () => {
    const harness = database();
    const observation = observationFor(lane);
    const before = structuredClone(observation);
    const result = await invoke(lane, harness.db, observation);

    assert.deepEqual(harness.calls, ["prepare", "bind", "run"]);
    assert.deepEqual(harness.queries.map(normalizeSql), [
      normalizeSql(baselines[lane].sql),
    ]);
    assert.deepEqual(harness.bindings, [bindingsFor(lane)]);
    assert.deepEqual(result, baselines[lane].result);
    assert.deepEqual(observation, before);
  });

  test(`${lane} retains BLOB key identity and exact raw key bindings`, async () => {
    const harness = database();
    const observation = observationFor(lane);
    observation.keyType = "blob";
    observation.fields[0]!.storageType = "blob";
    const result = await invoke(lane, harness.db, observation);
    const expected = bindingsFor(lane);
    const keyOffset = lane === "auth" || lane === "profile-link" ? 2 : 0;
    const guardOffset = lane === "auth" || lane === "profile-link" ? 5 : 6;
    expected[keyOffset] = "blob";
    expected[guardOffset] = "blob";

    assert.deepEqual(harness.bindings, [expected]);
    assert.strictEqual(
      harness.bindings[0]![keyOffset + 1]!,
      observation.keyBytes,
    );
    assert.strictEqual(
      harness.bindings[0]![keyOffset + 2]!,
      observation.keyBytes,
    );
    assert.deepEqual(result, baselines[lane].result);
  });

  for (const changes of [0, 1, 2, -1, "1", null, Number.NaN]) {
    test(`${lane} reports a write only for numeric changes === 1 (${String(changes)})`, async () => {
      const harness = database({ changes });
      assert.deepEqual(
        await invoke(lane, harness.db),
        changes === 1 ? baselines[lane].result : null,
      );
      assert.deepEqual(harness.calls, ["prepare", "bind", "run"]);
    });
  }

  for (const failAt of ["prepare", "bind", "run"] as const) {
    test(`${lane} preserves ${failAt} failure identity and performs no later D1 calls`, async () => {
      const failures = [
        new Error(`${lane}-${failAt}`),
        { source: lane, phase: failAt },
        undefined,
        null,
        false,
        0,
        "",
      ];
      const expectedCalls = ["prepare", "bind", "run"].slice(
        0,
        ["prepare", "bind", "run"].indexOf(failAt) + 1,
      );
      for (const failure of failures) {
        const harness = database({ failAt, failure });
        assert.strictEqual(
          await rejectedValue(invoke(lane, harness.db)),
          failure,
        );
        assert.deepEqual(harness.calls, expectedCalls);
      }
    });
  }

  test(`${lane} rejects malformed observations before accessing D1`, async () => {
    const harness = database();
    const observation = { ...observationFor(lane), fields: [] };
    await assert.rejects(invoke(lane, harness.db, observation), {
      name: "Error",
      message: "recovery-observation-invalid",
    });
    assert.deepEqual(harness.calls, []);
  });

  for (const nowMs of [0, Number.MAX_SAFE_INTEGER]) {
    test(`${lane} accepts quarantine timestamp boundary ${nowMs}`, async () => {
      const harness = database();
      const expected = bindingsFor(lane);
      expected[lane === "auth" || lane === "profile-link" ? 1 : 5] = nowMs;
      assert.deepEqual(
        await invoke(lane, harness.db, observationFor(lane), nowMs),
        baselines[lane].result,
      );
      assert.deepEqual(harness.bindings, [expected]);
    });
  }

  test(`${lane} retains its timestamp-validation boundary and error`, async () => {
    for (const nowMs of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Infinity,
      -Infinity,
    ]) {
      const failure = new Error("D1 timestamp rejection");
      const harness = database({ failAt: "run", failure });
      const work = invoke(lane, harness.db, observationFor(lane), nowMs);
      if (lane === "auth") {
        assert.strictEqual(await rejectedValue(work), failure);
        assert.deepEqual(harness.calls, ["prepare", "bind", "run"]);
        assert.ok(Object.is(harness.bindings[0]![1]!, nowMs));
      } else {
        await assert.rejects(work, {
          name: "TypeError",
          message:
            lane === "profile-link"
              ? "invalid-profile-link-catchup-timestamp"
              : "invalid-rating-quarantine-timestamp",
        });
        assert.deepEqual(harness.calls, []);
      }
    }
  });

  test(`${lane} preserves validation precedence for timestamp and observation failures`, async () => {
    const harness = database();
    await assert.rejects(
      invoke(lane, harness.db, { ...observationFor(lane), fields: [] }, -1),
      {
        name: lane === "auth" ? "Error" : "TypeError",
        message:
          lane === "auth"
            ? "recovery-observation-invalid"
            : lane === "profile-link"
              ? "invalid-profile-link-catchup-timestamp"
              : "invalid-rating-quarantine-timestamp",
      },
    );
    assert.deepEqual(harness.calls, []);
  });
}

test("rating validates timestamps before projection kinds and observations", async () => {
  for (const nowMs of [-1, 2_000]) {
    const harness = database();
    await assert.rejects(
      quarantineRatingRecoveryEntry(
        harness.db,
        {
          kind: "invalid",
          reason: "invalid-record",
          projectionKind: "unknown" as RatingRecoveryProjectionKind,
          observation: { ...observationFor("telegram"), fields: [] },
        },
        nowMs,
      ),
      {
        name: "TypeError",
        message:
          nowMs === -1
            ? "invalid-rating-quarantine-timestamp"
            : "invalid-rating-recovery-projection",
      },
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("quarantine builder preserves SQL fragments and ordered bindings without mutating inputs", () => {
  const key = Uint8Array.of(0, 255);
  const beforeInsert = Object.freeze({
    sql: "WITH observed AS MATERIALIZED (SELECT ? AS operation_id)",
    bindings: Object.freeze([key]),
  });
  const select = Object.freeze({
    sql: "SELECT operation_id, ?, ?, ?, ? FROM observed WHERE ? IS NULL",
    bindings: Object.freeze(["telegram", "1", "invalid-record", 2_000, null]),
  });
  const input = Object.freeze({
    target: "rating" as const,
    beforeInsert,
    select,
  });
  const first = buildRecoveryQuarantineWrite(input);
  const second = buildRecoveryQuarantineWrite(input);

  assert.ok(first.sql.startsWith(`${beforeInsert.sql}\nINSERT INTO `));
  assert.ok(first.sql.includes(select.sql));
  assert.deepEqual(first.bindings, [
    key,
    "telegram",
    "1",
    "invalid-record",
    2_000,
    null,
  ]);
  assert.strictEqual(first.bindings[0], key);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.bindings, second.bindings);
  first.bindings.push("output-only");
  assert.deepEqual(beforeInsert.bindings, [key]);
  assert.deepEqual(select.bindings, [
    "telegram",
    "1",
    "invalid-record",
    2_000,
    null,
  ]);
  assert.equal(second.bindings.length, 6);
});
