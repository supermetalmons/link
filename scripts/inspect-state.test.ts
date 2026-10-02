import assert from "node:assert/strict";
import test from "node:test";
import { execute, inspectState, parseArgs } from "./inspect-state.ts";

test("inspection requires one domain and rejects write commands before any provider request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("unexpected provider request");
  });
  for (const domain of [
    "match-discovery",
    "match-presentations",
    "wagers",
    "event-receipts",
  ])
    assert.deepEqual(parseArgs(["--domain", domain]), { domain });
  for (const args of [
    [],
    ["--domain"],
    ["--domain", "unknown"],
    ["--status"],
    ["--domain", "wagers", "--domain", "event-receipts"],
    ...[
      "--preflight",
      "--export",
      "--import",
      "--verify",
      "--activate",
      "--freeze",
      "--resume",
      "--abort",
      "--execute",
    ].map((flag) => ["--domain", "wagers", flag]),
  ]) {
    assert.throws(() => parseArgs(args), /Usage:/);
    await assert.rejects(execute(args), /Usage:/);
  }
  assert.equal(requests, 0);
});

test("inspection dispatch preserves each domain report and performs only reads", async () => {
  const activation: Record<string, unknown> = { activation_epoch: 1 };
  for (const key of [
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
    activation[key] = null;
  for (const domain of [
    "match-discovery",
    "match-presentations",
    "wagers",
    "event-receipts",
  ]) {
    const logs: Record<string, unknown>[] = [];
    const queries: string[] = [];
    let providerReads = 0;
    await inspectState(parseArgs(["--domain", domain]), {
      run: async (sql) => {
        assert.match(sql, /^SELECT /);
        queries.push(sql);
        if (sql.includes("sqlite_master")) return [];
        if (sql.includes("login_match_discovery_control"))
          return [{ discovery_backend: "d1", capture_enforced: 1 }];
        if (sql.includes("match_presentation_control"))
          return [{ phase: "durable" }];
        if (sql.includes("GROUP BY"))
          return [{ provenance: "capture", count: 2 }];
        if (sql.includes("wager_state_activation")) return [activation];
        if (sql.includes("profile.state"))
          return [
            {
              profile_state: "active",
              reservation_state: "d1",
              freeze_generation: 1,
              admissions: 0,
            },
          ];
        if (sql.includes("row_count"))
          return [
            {
              row_count: 2,
              wager_count: 1,
              marker_count: 1,
              non_initial_revisions: 1,
            },
          ];
        if (sql.includes("event_runtime_control"))
          return [
            {
              storage_mode: "d1",
              freeze_generation: 1,
              admissions: 0,
              leases: 0,
              intents: 0,
            },
          ];
        if (sql.includes("COUNT(*) AS count")) return [{ count: 0 }];
        return [{ state: "active", storage_mode: "d1", backend: "d1" }];
      },
      log: (value) => logs.push(value),
      receiptProvider: {
        deployment: async () => {
          providerReads += 1;
          return "11111111-1111-4111-8111-111111111111";
        },
        workflowPage: async () => {
          providerReads += 1;
          return { rows: [], totalPages: 1, totalCount: 0 };
        },
      },
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].operation, "status");
    assert.ok(queries.length >= 2);
    assert.equal(providerReads, domain === "event-receipts" ? 2 : 0);
    if (domain === "match-discovery") assert.ok(logs[0].control);
    if (domain === "match-presentations")
      assert.deepEqual(logs[0].sourceExceptions, []);
    if (domain === "wagers") assert.ok(logs[0].activation);
    if (domain === "event-receipts") {
      assert.equal(logs[0].state, "absent");
      assert.equal(logs[0].operatorLock, null);
    }
  }
});
