import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  assertGameplayMigrationOperation,
  currentMatchStateAdmission,
  withGameplayMigrationOperation,
  withMatchStateWrite,
} from "../test/legacyGameplayMigrationGate.ts";
import { readCurrentMatchState } from "../test/legacyGameplayMigrationGate.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

type Row = { phase: "admitted" | "uncertain"; values: unknown[] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  options: {
    failMark?: boolean;
    failRelease?: boolean;
    failExtend?: boolean;
    ambiguousExtend?: boolean;
  } = {},
) {
  const rows = new Map<string, Row>();
  const control: { backend: "rtdb" | "durable"; epoch: number } = {
    backend: "rtdb",
    epoch: 1,
  };
  const counts = {
    acquired: 0,
    guarded: 0,
    released: 0,
    uncertain: 0,
    extended: 0,
  };
  const statements = new WeakMap<
    object,
    { query: string; values: unknown[] }
  >();
  const base = TELEGRAM_TEST_ENV.PROFILE_GAMES_DB;
  const statement = (
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement => {
    const fallback = base.prepare(query);
    const value: D1PreparedStatement = {
      all: fallback.all,
      raw: fallback.raw,
      bind: (...bindings) => statement(query, bindings),
      first: async <T>() => {
        if (query.includes("SELECT * FROM match_state_control")) {
          const current = await fallback.first<Record<string, unknown>>();
          return { ...current, ...control } as T;
        }
        if (query.includes("INSERT INTO match_state_write_admissions")) {
          const id = String(values[0]);
          assert.equal(rows.has(id), false);
          rows.set(id, { phase: "admitted", values });
          counts.acquired++;
          return { backend: "rtdb", epoch: 1, freeze_generation: 0 } as T;
        }
        if (
          query.includes(
            "SELECT resources_json FROM match_state_write_admissions",
          )
        ) {
          const row = rows.get(String(values[0]));
          return row ? ({ resources_json: row.values[2] } as T) : null;
        }
        return fallback.first<T>();
      },
      run: async <T>() => {
        let changes = 0;
        if (query.includes("DELETE FROM match_state_write_admissions")) {
          const row = rows.get(String(values[0]));
          if (
            row?.phase === "admitted" &&
            row.values[2] === values[5] &&
            !options.failRelease
          ) {
            rows.delete(String(values[0]));
            changes = 1;
            counts.released++;
          }
        } else if (query.includes("SET phase = 'uncertain'")) {
          if (options.failMark) throw new Error("uncertainty-write-offline");
          const row = rows.get(String(values[0]));
          assert.ok(row);
          row.phase = "uncertain";
          changes = 1;
          counts.uncertain++;
        } else if (query.includes("SET resources_json = ?")) {
          if (options.failExtend) throw new Error("resource-write-offline");
          const row = rows.get(String(values[1]));
          if (row?.phase === "admitted" && row.values[2] === values[2]) {
            row.values[2] = values[0];
            counts.extended++;
            changes = 1;
          }
          if (options.ambiguousExtend)
            throw new Error("resource-write-response-lost");
        } else {
          return fallback.run<T>();
        }
        const result = await fallback.run<T>();
        return { ...result, meta: { ...result.meta, changes } };
      },
    };
    statements.set(value, { query, values });
    return value;
  };
  const db: D1Database = {
    ...base,
    prepare: statement,
    async batch<T>(batch: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const item of batch) {
        const entry = statements.get(item);
        if (entry?.query.includes("INSERT INTO match_state_guards")) {
          const row = rows.get(String(entry.values[0]));
          assert.equal(row?.phase, "admitted");
          assert.equal(row?.values[2], entry.values[5]);
          counts.guarded++;
        }
        results.push(await item.run<T>());
      }
      return results;
    },
    withSession: () => ({
      prepare: statement,
      batch: db.batch,
      getBookmark: () => null,
    }),
  };
  return { db, rows, counts, control };
}

const operation = { kind: "test-operation", resources: ["invite-one"] };

test("nested gameplay and match writes retain one admission through the outer result", async () => {
  const { db, rows, counts } = fixture();
  let rootId = "";
  const value = await withGameplayMigrationOperation(
    db,
    operation,
    async (root) => {
      rootId = root.admissionId;
      assert.equal(currentMatchStateAdmission(), root);
      await assertGameplayMigrationOperation(db);
      return withMatchStateWrite(db, operation, async (nested) => {
        assert.equal(nested.admissionId, rootId);
        assert.equal(rows.size, 1);
        return "committed";
      });
    },
  );
  assert.equal(value, "committed");
  assert.equal(rows.size, 0);
  assert.equal(counts.acquired, 1);
  assert.equal(counts.released, 1);
  assert.ok(counts.guarded >= 2);
  assert.equal(currentMatchStateAdmission(), undefined);
});

test("a nested write already running keeps the admission after its caller returns", async () => {
  const { db, rows, counts } = fixture();
  const started = deferred();
  const release = deferred();
  let nested: Promise<string> | undefined;
  await withGameplayMigrationOperation(db, operation, async () => {
    nested = withMatchStateWrite(db, operation, async () => {
      started.resolve();
      await release.promise;
      return "done";
    });
    await started.promise;
  });
  assert.equal(rows.size, 1);
  assert.equal(counts.released, 0);
  release.resolve();
  assert.equal(await nested, "done");
  assert.equal(rows.size, 0);
  assert.equal(counts.acquired, 1);
  assert.equal(counts.released, 1);
});

test("detached work starting after its caller returns obtains a fresh admission", async () => {
  const { db, rows, counts } = fixture();
  const release = deferred();
  let detached: Promise<string> | undefined;
  let rootId = "";
  await withGameplayMigrationOperation(db, operation, async (root) => {
    rootId = root.admissionId;
    detached = (async () => {
      await release.promise;
      return withMatchStateWrite(
        db,
        operation,
        async (admission) => admission.admissionId,
      );
    })();
  });
  assert.equal(rows.size, 0);
  release.resolve();
  assert.notEqual(await detached, rootId);
  assert.equal(counts.acquired, 2);
  assert.equal(counts.released, 2);
  assert.equal(rows.size, 0);
});

test("an uncertain nested write remains recorded even if the HTTP-style caller handles its error", async () => {
  const { db, rows, counts } = fixture();
  const result = await withGameplayMigrationOperation(
    db,
    operation,
    async () => {
      try {
        await withMatchStateWrite(db, operation, async () => {
          throw new Error("write-response-lost");
        });
      } catch {
        return { status: 503 };
      }
      return { status: 200 };
    },
  );
  assert.deepEqual(result, { status: 503 });
  assert.equal(rows.size, 1);
  assert.equal([...rows.values()][0].phase, "uncertain");
  assert.equal(counts.uncertain, 1);
  assert.equal(counts.released, 0);
});

test("a deterministic rejected write releases its admission", async () => {
  const { db, rows, counts } = fixture();
  const failure = new AuthApiFailure(409, "aborted", "move-chain-conflict");
  await assert.rejects(
    withMatchStateWrite(db, operation, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(rows.size, 0);
  assert.equal(counts.uncertain, 0);
  assert.equal(counts.released, 1);
});

test("failure to record uncertainty never releases the possibly applied write", async () => {
  const { db, rows, counts } = fixture({ failMark: true });
  await assert.rejects(
    withMatchStateWrite(db, operation, async () => {
      throw new Error("ambiguous-write");
    }),
    /uncertainty-write-offline/,
  );
  assert.equal(rows.size, 1);
  assert.equal(counts.released, 0);
});

test("unconfirmed admission release is reported without erasing its evidence", async () => {
  const { db, rows } = fixture({ failRelease: true });
  await assert.rejects(
    withGameplayMigrationOperation(db, operation, async () => "done"),
    /admission-release-unconfirmed/,
  );
  assert.equal(rows.size, 1);
});

test("admission assertions require the matching database and live context", async () => {
  const first = fixture();
  const second = fixture();
  await assert.rejects(
    assertGameplayMigrationOperation(first.db),
    /admission-required/,
  );
  await withGameplayMigrationOperation(first.db, operation, async () => {
    await assert.rejects(
      assertGameplayMigrationOperation(second.db),
      /admission-required/,
    );
    await assert.rejects(
      withMatchStateWrite(second.db, operation, async () => undefined),
      /admission-database-conflict/,
    );
  });
  assert.equal(first.rows.size, 0);
  assert.equal(second.counts.acquired, 0);
});

test("concurrent nested writes persist every exact resource before entering their effects", async () => {
  const { db, rows, counts } = fixture();
  const seen: string[] = [];
  await withGameplayMigrationOperation(
    db,
    { ...operation, resources: [] },
    async (root) => {
      await Promise.all(
        ["players/host/matches/one", "players/guest/matches/one"].map((path) =>
          withMatchStateWrite(
            db,
            { kind: "actor-write", resources: [path] },
            async (admission) => {
              assert.equal(admission.admissionId, root.admissionId);
              assert.ok(admission.resources.includes(path));
              assert.ok(
                JSON.parse(
                  String(rows.get(root.admissionId)?.values[2]),
                ).includes(path),
              );
              seen.push(path);
            },
          ),
        ),
      );
      assert.deepEqual(root.resources, [
        "players/guest/matches/one",
        "players/host/matches/one",
      ]);
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(counts.acquired, 1);
  assert.equal(counts.extended, 2);
  assert.equal(counts.released, 1);
  assert.equal(rows.size, 0);
});

test("an ambiguous resource extension is proven by readback before the write runs", async () => {
  const { db, rows, counts } = fixture({ ambiguousExtend: true });
  let writes = 0;
  await withGameplayMigrationOperation(
    db,
    { ...operation, resources: [] },
    async () =>
      withMatchStateWrite(db, operation, async (admission) => {
        writes++;
        assert.deepEqual(admission.resources, operation.resources);
      }),
  );
  assert.equal(writes, 1);
  assert.equal(counts.extended, 1);
  assert.equal(rows.size, 0);
});

test("unproven resource extension never starts a write", async () => {
  const { db, rows } = fixture({ failExtend: true });
  let writes = 0;
  await assert.rejects(
    withGameplayMigrationOperation(
      db,
      { ...operation, resources: [] },
      async () =>
        withMatchStateWrite(db, operation, async () => {
          writes++;
        }),
    ),
    /admission-resources-unconfirmed/,
  );
  assert.equal(writes, 0);
  assert.equal(rows.size, 0);
});

for (const completion of ["success", "failure"] as const) {
  test(`a legacy read ${completion} is discarded when authority changes before completion`, async () => {
    const { db, control } = fixture();
    let attempts = 0;
    const result = await readCurrentMatchState(
      { ...TELEGRAM_TEST_ENV, PROFILE_GAMES_DB: db },
      async (source) => {
        attempts++;
        if (source.backend === "rtdb") {
          control.backend = "durable";
          control.epoch = 2;
          if (completion === "failure")
            throw new Error("retired-source-offline");
          return "retired-value";
        }
        return "canonical-value";
      },
    );
    assert.equal(result, "canonical-value");
    assert.equal(attempts, 2);
  });
}

test("read authority guards preserve current failures and bound repeatedly changing sources", async () => {
  const { db, control } = fixture();
  const environment = { ...TELEGRAM_TEST_ENV, PROFILE_GAMES_DB: db };
  const failure = new Error("current-source-offline");
  await assert.rejects(
    readCurrentMatchState(environment, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  let attempts = 0;
  await assert.rejects(
    readCurrentMatchState(environment, async () => {
      attempts++;
      control.epoch++;
      return "stale";
    }),
    /read-authority-changed/,
  );
  assert.equal(attempts, 3);
});
