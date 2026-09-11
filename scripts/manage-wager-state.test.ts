import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlDependencies,
  manageWagerState,
  parseArgs,
  execute,
} from "./manage-wager-state.ts";
import type { SqlRunner } from "./operator/runtime.ts";

test("retired commands reject before credentials or provider requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected provider request");
  });
  for (const flag of [
    "--preflight",
    "--export",
    "--import",
    "--verify",
    "--activate",
    "--resume",
  ]) {
    assert.throws(() => parseArgs([flag]), /retired/);
    await assert.rejects(execute([flag]), /retired/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(parseArgs(["--status"]).operation, "status");
  assert.throws(() =>
    parseArgs(["--status", "--firebase-credentials", "/missing"]),
  );
});
test("wager status preserves activation, maintenance and row-count diagnostics using read-only SQL", async () => {
  const queries: string[] = [];
  const activation: Record<string, unknown> = { activation_epoch: 1 };
  for (const field of [
    "import_attempt_id",
    "source_digest",
    "import_digest",
    "baseline_digest",
    "verified_baseline_digest",
    "source_wager_count",
    "source_marker_count",
    "source_row_count",
    "imported_row_count",
    "verified_freeze_generation",
    "verified_at_ms",
    "activated_at_ms",
    "candidate_version_id",
  ])
    activation[field] = null;
  activation.activated_at_ms = 10;
  const run: SqlRunner = async (sql, database) => {
    queries.push(sql);
    assert.match(sql, /^SELECT /);
    if (sql.includes("wager_state_activation")) return [activation];
    if (sql.includes("profile.state"))
      return [
        {
          profile_state: "active",
          reservation_state: "d1",
          freeze_generation: 4,
          admissions: 0,
        },
      ];
    if (database === "mons-link-profile-games") return [{ count: 0 }];
    return [
      {
        row_count: 3,
        wager_count: 2,
        marker_count: 1,
        non_initial_revisions: 2,
      },
    ];
  };
  const deps = createSqlDependencies(run, () => 100);
  const logs: Record<string, unknown>[] = [];
  deps.log = (value) => logs.push(value);
  await manageWagerState(parseArgs(["--status"]), deps);
  assert.equal(queries.length, 4);
  assert.deepEqual(logs[0].destination, {
    rowCount: 3,
    wagerCount: 2,
    markerCount: 1,
    nonInitialRevisions: 2,
  });
  assert.equal(
    (logs[0].activation as { activatedAtMs: number }).activatedAtMs,
    10,
  );
});
