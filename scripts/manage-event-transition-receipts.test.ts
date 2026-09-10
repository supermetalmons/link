import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  execute,
  createProvider,
  createSqlDependencies,
  listWorkflows,
  manageEventTransitionReceipts,
  type Dependencies,
} from "./manage-event-transition-receipts.ts";
const VERSION = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const logs: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const deps: Dependencies = {
    run: async (sql) => {
      queries.push(sql);
      assert.match(sql, /^SELECT /);
      return sql.includes("sqlite_master")
        ? [{ name: "event_transition_receipt_operator_lock" }]
        : [
            {
              owner_token: "orphan",
              operation: "retired-import",
              created_at_ms: 100,
            },
          ];
    },
    maintenance: async () => ({
      storageMode: "d1",
      freezeGeneration: 4,
      admissions: 0,
      leases: 0,
      intents: 0,
      effectAdmissions: 0,
      otherGates: {},
    }),
    control: async () => ({ state: "active" }),
    deployment: async () => VERSION,
    workflowPage: async () => ({
      rows: [{ id: "pinned", version_id: VERSION, status: "running" }],
      totalPages: 1,
      totalCount: 1,
    }),
    log: (value) => logs.push(value),
  };
  return { deps, logs, queries };
}
test("retired commands reject before credentials or provider requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected provider request");
  });
  for (const flag of [
    "--preflight",
    "--freeze",
    "--export",
    "--import",
    "--verify",
    "--activate",
    "--resume",
    "--abort",
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
test("receipt status reports pinned Workflows and lock ownership without taking the lock or changing controls", async () => {
  const f = fixture();
  await manageEventTransitionReceipts(parseArgs(["--status"]), f.deps);
  assert.equal(f.logs[0].state, "active");
  assert.equal(f.logs[0].workflows, 1);
  assert.equal(f.logs[0].versionId, VERSION);
  assert.deepEqual(f.logs[0].operatorLock, {
    owner_token: "orphan",
    operation: "retired-import",
    created_at_ms: 100,
  });
  assert.equal(f.queries.length, 2);
});
test("receipt status reads existing maintenance controls without requiring migration-only columns", async () => {
  const queries: string[] = [];
  const provider = fixture().deps;
  const deps = createSqlDependencies(
    async (sql, database) => {
      queries.push(sql);
      assert.match(sql, /^SELECT /);
      if (sql.includes("event_runtime_control"))
        return [
          {
            storage_mode: "d1",
            freeze_generation: 4,
            admissions: 0,
            leases: 0,
            intents: 0,
          },
        ];
      if (sql.includes("COUNT(*) AS count")) return [{ count: 0 }];
      if (sql.includes("sqlite_master"))
        return [{ name: "event_transition_receipt_control" }];
      if (sql.includes("SELECT * FROM event_transition_receipt_control"))
        return [{ state: "active", imported_count: 3 }];
      return [{ state: "active", storage_mode: "d1", backend: "d1", database }];
    },
    provider,
    () => 100,
  );
  assert.equal((await deps.maintenance()).storageMode, "d1");
  assert.equal((await deps.control()).state, "active");
  assert.ok(queries.length >= 7);
});
test("Workflow inventory traverses every page and rejects duplicates, truncation and moving pagination", async () => {
  for (const scenario of ["valid", "duplicate", "truncated", "changed"]) {
    const f = fixture();
    const pages: number[] = [];
    f.deps.workflowPage = async (page) => {
      pages.push(page);
      return {
        rows:
          scenario === "truncated" && page === 2
            ? []
            : [
                {
                  id: scenario === "duplicate" ? "one" : String(page),
                  version_id: VERSION,
                  status: "running",
                },
              ],
        totalPages: 2,
        totalCount: scenario === "changed" && page === 2 ? 3 : 2,
      };
    };
    if (scenario === "valid")
      assert.equal((await listWorkflows(f.deps)).length, 2);
    else await assert.rejects(listWorkflows(f.deps), /pagination/);
    assert.deepEqual(pages, [1, 2]);
  }
});
test("receipt provider performs only bounded read-only deployment and Workflow queries", async () => {
  const urls: string[] = [];
  const provider = createProvider({
    apiToken: "fixture-token",
    fetcher: async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      return Response.json(
        url.includes("/deployments")
          ? {
              success: true,
              result: {
                deployments: [
                  {
                    created_on: "2026-09-10",
                    versions: [{ version_id: VERSION, percentage: 100 }],
                  },
                ],
              },
            }
          : {
              success: true,
              result: [
                { id: "pinned", version_id: VERSION, status: "running" },
              ],
              result_info: { total_count: 1, per_page: 100, page: 1, count: 1 },
            },
      );
    },
  });
  assert.equal(await provider.deployment(), VERSION);
  assert.equal((await provider.workflowPage(1)).rows[0].id, "pinned");
  assert.equal(urls.length, 2);
  assert.deepEqual(Object.keys(provider).sort(), [
    "deployment",
    "workflowPage",
  ]);
});
