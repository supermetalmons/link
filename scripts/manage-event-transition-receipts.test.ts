import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  auditWorkflow,
  createProvider,
  listWorkflows,
  manageEventTransitionReceipts,
  normalizeSourcePage,
  parseArgs,
  type Arguments,
  type Dependencies,
  type Maintenance,
  type Workflow,
} from "./manage-event-transition-receipts.ts";
import {
  canonicalJson,
  compareFirebaseKeys,
  writePrivateImmutable,
} from "./manage-wager-state.ts";
const PREVIOUS = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";
const OLD_WORKFLOW = "33333333-3333-4333-8333-333333333333";
const NEW_WORKFLOW = "44444444-4444-4444-8444-444444444444";
function fixture(
  t: test.TestContext,
  options: { receipts?: number; workflows?: boolean } = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), "mons-event-receipts-test-")),
    db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE invite_source_write_admissions(admission_id TEXT, kind TEXT);",
  );
  db.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/migrations/0019_event_transition_receipts.sql",
      ),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/migrations/0020_event_transition_receipt_operator_lock.sql",
      ),
      "utf8",
    ),
  );
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = 1000,
    deployed = PREVIOUS;
  const maintenance: Maintenance = {
    storageMode: "d1",
    freezeGeneration: 3,
    admissions: 0,
    leases: 0,
    intents: 0,
    effectAdmissions: 0,
    otherGates: {
      profiles: "active",
      wagers: "d1",
      telegram: "d1",
      withdrawals: "d1",
    },
  };
  const source: Record<string, unknown> = {};
  for (let i = 0; i < (options.receipts ?? 3); i++) {
    const transitionId = `transition-${String(i).padStart(4, "0")}`;
    source[transitionId] = {
      schemaVersion: i % 2 ? 2 : 1,
      transitionId,
      eventId: `event-${i}`,
      expectedRevision: i + 1,
      ...(i % 2 ? { payloadDigest: "a".repeat(64) } : {}),
      preserved: { nested: [null, false, "history"] },
    };
  }
  const identity = createHash("sha256")
      .update("event-future\nstart:event-future:100000")
      .digest("hex"),
    id = `event-progress-${identity}`;
  const params = {
    schemaVersion: 1,
    eventId: "event-future",
    outboxId: `ep_${identity}`,
    reason: "scheduled-start-reconciliation",
    runAtMs: 100000,
    sourceKey: "start:event-future:100000",
  };
  const outbox = {
    outbox_id: params.outboxId,
    event_id: params.eventId,
    status: "pending",
    run_at_ms: params.runAtMs,
    last_queued_at_ms: 900,
    record_json: canonicalJson({
      schemaVersion: 1,
      eventId: params.eventId,
      sourceKey: params.sourceKey,
      reason: params.reason,
      runAtMs: params.runAtMs,
      firstQueuedAtMs: 100,
      lastQueuedAtMs: 900,
    }),
  };
  const initial: Workflow = {
    id,
    params,
    version_id: OLD_WORKFLOW,
    versionId: OLD_WORKFLOW,
    status: "waiting",
    end: null,
    error: null,
    step_count: 1,
    steps: [
      {
        name: "wait for scheduled event-1",
        type: "sleep",
        start: new Date(500).toISOString(),
        end: new Date(100000).toISOString(),
        finished: false,
        error: null,
      },
    ],
  };
  const workflows = new Map<string, Workflow>(
      options.workflows === false ? [] : [[id, structuredClone(initial)]],
    ),
    versions = [OLD_WORKFLOW];
  const actions: string[] = [],
    logs: unknown[] = [];
  const deps: Dependencies = {
    now: () => ++now,
    log: (value) => logs.push(value),
    async maintenance() {
      return structuredClone(maintenance);
    },
    async control() {
      return db
        .prepare("SELECT * FROM event_transition_receipt_control")
        .get() as Awaited<ReturnType<Dependencies["control"]>>;
    },
    async run(sql, database, bindings = []) {
      if (database === "mons-link-events") {
        if (sql.includes("SET storage_mode = 'frozen'")) {
          maintenance.storageMode = "frozen";
          maintenance.freezeGeneration++;
          actions.push("freeze");
        } else {
          maintenance.storageMode = "d1";
          actions.push("restore-gate");
        }
        return [{ singleton: 1 }];
      }
      return db.prepare(sql).all(...bindings) as Record<string, unknown>[];
    },
    async sourcePage(after, pageSize) {
      const keys = Object.keys(source)
        .sort(compareFirebaseKeys)
        .filter((key) => after === null || compareFirebaseKeys(key, after) >= 0)
        .slice(0, pageSize + Number(after !== null));
      return Object.fromEntries(keys.map((key) => [key, source[key]]));
    },
    async deployment() {
      return deployed;
    },
    async deploy(version) {
      deployed = version;
      actions.push(`deploy:${version}`);
    },
    async workflowPage() {
      return {
        rows: [...workflows.values()].map((row) => structuredClone(row)),
        totalPages: 1,
        totalCount: workflows.size,
      };
    },
    async workflow(instanceId) {
      return workflows.has(instanceId)
        ? structuredClone(workflows.get(instanceId)!)
        : null;
    },
    async workflowVersions() {
      return [...versions];
    },
    async registerWorkflow() {
      actions.push("register-workflow");
      if (!versions.includes(NEW_WORKFLOW)) versions.push(NEW_WORKFLOW);
      return NEW_WORKFLOW;
    },
    async terminate(instanceId) {
      actions.push("terminate");
      workflows.get(instanceId)!.status = "terminated";
    },
    async delete(instanceId) {
      actions.push("delete");
      workflows.delete(instanceId);
    },
    async create(instanceId, payload) {
      actions.push("create");
      workflows.set(instanceId, {
        ...structuredClone(initial),
        id: instanceId,
        params: payload,
        version_id: NEW_WORKFLOW,
        versionId: NEW_WORKFLOW,
      });
    },
    async outbox() {
      return structuredClone(outbox);
    },
  };
  const command = (
    operation: Arguments["operation"],
    extra: Partial<Arguments> = {},
  ) =>
    manageEventTransitionReceipts(
      {
        operation,
        directory,
        pageSize: 2,
        ...(operation === "freeze" ? { candidateVersionId: CANDIDATE } : {}),
        ...extra,
      },
      deps,
    );
  const imported = async () => {
    await command("freeze");
    await command("export");
    await command("import");
    await command("verify");
  };
  const activated = async () => {
    await imported();
    deployed = CANDIDATE;
    await command("activate");
  };
  return {
    directory,
    db,
    deps,
    maintenance,
    workflows,
    source,
    actions,
    logs,
    command,
    imported,
    activated,
    initial,
    outbox,
    id,
    releaseReconciledLock: () => {
      const lock = db
        .prepare(
          "SELECT owner_token FROM event_transition_receipt_operator_lock WHERE singleton = 1",
        )
        .get();
      assert.ok(lock);
      assert.equal(
        db
          .prepare(
            "DELETE FROM event_transition_receipt_operator_lock WHERE singleton = 1 AND owner_token = ?",
          )
          .run(lock.owner_token).changes,
        1,
      );
    },
    setVersion: (version: string) => {
      deployed = version;
    },
  };
}
test("complete V1/V2 migration preserves history and Workflow schedules with event-only gates", async (t) => {
  const f = fixture(t),
    originalSource = structuredClone(f.source),
    originalOutbox = structuredClone(f.outbox);
  await f.command("preflight");
  await f.imported();
  assert.equal(f.maintenance.storageMode, "frozen");
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(
    statSync(resolve(f.directory, "manifest.json")).mode & 0o777,
    0o600,
  );
  await assert.rejects(f.command("activate"), /sole 100%/);
  f.setVersion(CANDIDATE);
  await f.command("activate");
  await f.command("resume");
  assert.equal(f.maintenance.storageMode, "d1");
  assert.equal(f.maintenance.freezeGeneration, 4);
  assert.equal(f.workflows.get(f.id)?.version_id, NEW_WORKFLOW);
  assert.deepEqual(f.workflows.get(f.id)?.params, f.initial.params);
  assert.deepEqual(f.source, originalSource);
  assert.deepEqual(f.outbox, originalOutbox);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM event_transition_receipts").get()
      ?.n,
    3,
  );
  assert.deepEqual(f.actions, [
    "freeze",
    "terminate",
    "register-workflow",
    "delete",
    "create",
    "restore-gate",
  ]);
  await f.command("resume");
  assert.equal(f.actions.filter((x) => x === "create").length, 1);
  await assert.rejects(f.command("abort"), /rollback.*forbidden/);
});
test("interrupted insert-only import resumes without changing receipts", async (t) => {
  const f = fixture(t, { receipts: 25 });
  await f.command("freeze");
  await f.command("export");
  const original = f.deps.run;
  let inserts = 0;
  f.deps.run = async (...args) => {
    if (args[0].startsWith("WITH imported") && ++inserts === 2)
      throw new Error("interrupted");
    return original(...args);
  };
  await assert.rejects(f.command("import"), /interrupted/);
  const before = f.db
    .prepare("SELECT * FROM event_transition_receipts ORDER BY transition_id")
    .all();
  f.deps.run = original;
  f.releaseReconciledLock();
  await f.command("import");
  await f.command("import");
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM event_transition_receipts ORDER BY transition_id LIMIT 2",
      )
      .all(),
    before,
  );
  await f.command("verify");
});
test("conflicting immutable destination rows reject import", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  await f.command("export");
  const receipt = {
    schemaVersion: 1,
    transitionId: "transition-0000",
    eventId: "conflict",
    expectedRevision: 1,
  };
  f.db
    .prepare("INSERT INTO event_transition_receipts VALUES (?,1,?,1,NULL,?,0)")
    .run(receipt.transitionId, receipt.eventId, canonicalJson(receipt));
  await assert.rejects(f.command("import"), /conflict/);
  assert.equal((await f.deps.control()).state, "importing");
});
test("source changes and extra destination keys fail exact coverage verification", async (t) => {
  const f = fixture(t);
  await f.imported();
  (f.source["transition-0000"] as Record<string, unknown>).preserved =
    "changed";
  await assert.rejects(f.command("verify"), /source changed/);
  delete f.source["transition-0000"];
  await assert.rejects(f.command("activate"), /source changed|cursor changed/);
});
test("malformed receipt keys, revisions and V2 digests cannot be exported", () => {
  for (const value of [
    null,
    {},
    {
      schemaVersion: 1,
      transitionId: "other",
      eventId: "e",
      expectedRevision: 1,
    },
    {
      schemaVersion: 2,
      transitionId: "t",
      eventId: "e",
      expectedRevision: 1,
      payloadDigest: "bad",
    },
    { schemaVersion: 1, transitionId: "t", eventId: "e", expectedRevision: 0 },
  ])
    assert.throws(() => normalizeSourcePage({ t: value }, 0, null, 100, 1));
  assert.throws(
    () => normalizeSourcePage({ z: {} }, 0, "a", 100, 1),
    /cursor changed/,
  );
});
test("event drain checks reject every admission, lease and intent category", async (t) => {
  for (const key of [
    "admissions",
    "leases",
    "intents",
    "effectAdmissions",
  ] as const) {
    const f = fixture(t);
    f.maintenance[key] = 1;
    await assert.rejects(
      f.command("freeze"),
      /admissions, active leases or transition intents/,
    );
    assert.equal(f.actions.length, 0);
  }
});
test("changed event freeze generation or unrelated gates block migration", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  f.maintenance.freezeGeneration++;
  await assert.rejects(f.command("export"), /generation/);
  f.maintenance.freezeGeneration--;
  f.maintenance.otherGates.profiles = "frozen";
  await assert.rejects(f.command("export"), /unrelated/);
});
test("unsafe Workflows are not terminated or recreated", async (t) => {
  const f = fixture(t);
  const current = f.workflows.get(f.id)!;
  (current.steps as unknown[]).push({
    type: "step",
    name: "synchronize event",
  });
  current.step_count = 2;
  await assert.rejects(f.command("freeze"), /advanced beyond/);
  assert.deepEqual(f.actions, ["freeze"]);
  await f.command("abort");
  assert.equal(f.maintenance.storageMode, "d1");
  assert.deepEqual(f.actions, ["freeze", "restore-gate"]);
});
test("audit requires full step evidence, matching outbox hash and precise wakeup", async (t) => {
  const f = fixture(t);
  auditWorkflow(f.initial, f.outbox, 1000);
  for (const change of [
    { status: "complete" },
    { step_count: 2 },
    {
      params: {
        ...(f.initial.params as Record<string, unknown>),
        sourceKey: "changed",
      },
    },
  ])
    assert.throws(() =>
      auditWorkflow({ ...f.initial, ...change }, f.outbox, 1000),
    );
  const wrong = structuredClone(f.initial);
  (wrong.steps as Record<string, unknown>[])[0].end = new Date(
    100001,
  ).toISOString();
  assert.throws(
    () => auditWorkflow(wrong, f.outbox, 1000),
    /unrecognized initial sleep/,
  );
  assert.throws(
    () =>
      auditWorkflow(f.initial, { ...f.outbox, last_queued_at_ms: 100 }, 1000),
    /timestamps conflict/,
  );
  assert.throws(
    () => auditWorkflow(f.initial, f.outbox, 100000),
    /future scheduled/,
  );
});
test("freeze recovers an uncertain termination using saved evidence", async (t) => {
  const f = fixture(t),
    terminate = f.deps.terminate;
  f.deps.terminate = async (id) => {
    await terminate(id);
    throw new Error("uncertain termination");
  };
  await assert.rejects(f.command("freeze"), /uncertain termination/);
  f.deps.terminate = terminate;
  f.releaseReconciledLock();
  await f.command("freeze");
  await f.command("export");
  assert.equal(f.actions.filter((x) => x === "terminate").length, 1);
});
test("resume recovers uncertain Workflow registration and creation", async (t) => {
  const f = fixture(t);
  await f.activated();
  const register = f.deps.registerWorkflow;
  f.deps.registerWorkflow = async () => {
    await register();
    throw new Error("uncertain register");
  };
  await assert.rejects(f.command("resume"), /uncertain register/);
  f.deps.registerWorkflow = register;
  f.releaseReconciledLock();
  const create = f.deps.create;
  f.deps.create = async (id, params) => {
    await create(id, params);
    throw new Error("uncertain creation");
  };
  await assert.rejects(f.command("resume"), /uncertain creation/);
  f.deps.create = create;
  f.releaseReconciledLock();
  await f.command("resume");
  assert.equal(f.actions.filter((x) => x === "register-workflow").length, 2);
  assert.equal(f.actions.filter((x) => x === "create").length, 1);
});
test("resume recovers after gate restoration response is lost", async (t) => {
  const f = fixture(t);
  await f.activated();
  const run = f.deps.run;
  f.deps.run = async (...args) => {
    const result = await run(...args);
    if (args[0].includes("SET storage_mode = 'd1'"))
      throw new Error("uncertain gate");
    return result;
  };
  await assert.rejects(f.command("resume"), /uncertain gate/);
  f.deps.run = run;
  f.releaseReconciledLock();
  await f.command("resume");
  assert.equal(f.maintenance.storageMode, "d1");
  assert.equal(f.actions.filter((x) => x === "create").length, 1);
});
test("preactivation abort restores previous version and saved workflows", async (t) => {
  const f = fixture(t);
  await f.imported();
  f.setVersion(CANDIDATE);
  await f.command("abort");
  assert.equal(await f.deps.deployment(), PREVIOUS);
  assert.equal(f.maintenance.storageMode, "d1");
  assert.equal((await f.deps.control()).state, "importing");
  assert.deepEqual(f.workflows.get(f.id)?.params, f.initial.params);
});
test("activation requires completed import verification and no resurrected writers", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  await f.command("export");
  await f.command("import");
  f.setVersion(CANDIDATE);
  await assert.rejects(f.command("activate"), /prerequisites conflicted/);
  await f.command("verify");
  f.workflows.get(f.id)!.status = "waiting";
  await assert.rejects(f.command("activate"), /live event-progress Workflow/);
});
test("all Workflow pages are inspected and duplicate pages fail closed", async (t) => {
  const f = fixture(t),
    pages: number[] = [];
  f.deps.workflowPage = async (page) => {
    pages.push(page);
    return {
      rows: page === 2 ? [f.initial] : [],
      totalPages: 3,
      totalCount: 1,
    };
  };
  assert.equal((await listWorkflows(f.deps)).length, 1);
  assert.deepEqual(pages, [1, 2, 3]);
  f.deps.workflowPage = async () => ({
    rows: [f.initial],
    totalPages: 2,
    totalCount: 2,
  });
  await assert.rejects(listWorkflows(f.deps), /duplicate/);
});
test("command parser requires protected paths and one fixed candidate", () => {
  assert.throws(
    () => parseArgs(["--freeze", "--directory", "/tmp/example"]),
    /candidate/,
  );
  assert.throws(
    () => parseArgs(["--export", "--directory", "relative"]),
    /absolute/,
  );
  assert.throws(
    () => parseArgs(["--status", "--page-size", "5"]),
    /no options/,
  );
  assert.equal(
    parseArgs([
      "--freeze",
      "--directory",
      "/tmp/example",
      "--candidate-version-id",
      CANDIDATE,
    ]).candidateVersionId,
    CANDIDATE,
  );
});
test("provider normalizes real list pagination and detail versionId", async () => {
  const identity = "b".repeat(64),
    urls: string[] = [];
  const provider = createProvider({
    apiToken: "test-only",
    fetcher: (async (url) => {
      urls.push(String(url));
      if (String(url).includes("?page="))
        return Response.json({
          success: true,
          result: [
            {
              id: "event-progress-old-smoke",
              version_id: OLD_WORKFLOW,
              status: "complete",
            },
          ],
          result_info: { count: 1, total_count: 201, per_page: 100 },
        });
      return Response.json({
        success: true,
        result: { versionId: OLD_WORKFLOW, status: "waiting", steps: [] },
      });
    }) as typeof fetch,
  });
  assert.equal((await provider.workflowPage(1)).totalPages, 3);
  assert.equal(
    (await provider.workflow(`event-progress-${identity}`))?.version_id,
    OLD_WORKFLOW,
  );
  assert.ok(urls.every((url) => !url.includes("test-only")));
});
test("abort after an interrupted termination preserves untouched original instances", async (t) => {
  const f = fixture(t);
  const terminate = f.deps.terminate;
  f.deps.terminate = async () => {
    throw new Error("request never submitted");
  };
  await assert.rejects(f.command("freeze"), /never submitted/);
  f.deps.terminate = terminate;
  f.releaseReconciledLock();
  await f.command("abort");
  assert.equal(f.workflows.get(f.id)?.version_id, OLD_WORKFLOW);
  assert.ok(!f.actions.includes("delete") && !f.actions.includes("create"));
  assert.equal(f.maintenance.storageMode, "d1");
});
test("identical imported history keeps its first recorded timestamp", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  await f.command("export");
  const receipt = f.source["transition-0000"] as Record<string, unknown>;
  f.db
    .prepare("INSERT INTO event_transition_receipts VALUES (?,1,?,1,NULL,?,7)")
    .run(
      receipt.transitionId as string,
      receipt.eventId as string,
      canonicalJson(receipt),
    );
  await f.command("import");
  await f.command("verify");
  assert.equal(
    f.db
      .prepare(
        "SELECT recorded_at_ms FROM event_transition_receipts WHERE transition_id = 'transition-0000'",
      )
      .get()?.recorded_at_ms,
    7,
  );
});
test("new cutover after abort imports additional source history and rebaselines importing control", async (t) => {
  const f = fixture(t);
  await f.imported();
  await f.command("abort");
  const previous = f.db
    .prepare("SELECT * FROM event_transition_receipts ORDER BY transition_id")
    .all();
  f.source["transition-9999"] = {
    schemaVersion: 1,
    transitionId: "transition-9999",
    eventId: "event-new",
    expectedRevision: 1,
  };
  const directory = mkdtempSync(
    resolve(tmpdir(), "mons-event-receipts-retry-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const operation of ["freeze", "export", "import", "verify"] as const)
    await f.command(operation, { directory });
  assert.equal((await f.deps.control()).source_count, 4);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM event_transition_receipts ORDER BY transition_id LIMIT 3",
      )
      .all(),
    previous,
  );
});
test("receipt destination rejects unrelated extra keys even when every source key matches", async (t) => {
  const f = fixture(t);
  await f.imported();
  const receipt = {
    schemaVersion: 1,
    transitionId: "extra",
    eventId: "event-extra",
    expectedRevision: 1,
  };
  f.db
    .prepare(
      "INSERT INTO event_transition_receipts VALUES ('extra',1,'event-extra',1,NULL,?,7)",
    )
    .run(canonicalJson(receipt));
  await assert.rejects(f.command("verify"), /extra keys/);
});
test("Workflow pagination refuses declared count with truncated pages", async (t) => {
  const f = fixture(t);
  f.deps.workflowPage = async () => ({
    rows: [],
    totalPages: 2,
    totalCount: 101,
  });
  await assert.rejects(listWorkflows(f.deps), /incomplete coverage/);
});
test("Workflow version inventory follows every provider page", async () => {
  const ids = Array.from(
      { length: 101 },
      (_, index) =>
        `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    ),
    requested: number[] = [];
  const provider = createProvider({
    apiToken: "test-only",
    fetcher: (async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/versions"))
        return Response.json({
          success: true,
          result: {
            script_name: "mons-link-api",
            class_name: "EventProgressWorkflow",
          },
        });
      const page = Number(url.searchParams.get("page"));
      requested.push(page);
      const values = ids
        .slice((page - 1) * 100, page * 100)
        .map((id) => ({ id }));
      return Response.json({
        success: true,
        result: values,
        result_info: {
          page,
          count: values.length,
          total_count: 101,
          per_page: 100,
          total_pages: 2,
        },
      });
    }) as typeof fetch,
  });
  assert.deepEqual(await provider.workflowVersions(), ids);
  assert.deepEqual(requested, [1, 2]);
});

test("exact unfinished future sleep is safe while provider status still reports running", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    auditWorkflow({ ...f.initial, status: "running" }, f.outbox, 1000).params,
    f.initial.params,
  );
  await f.activated();
  const create = f.deps.create;
  f.deps.create = async (id, params) => {
    await create(id, params);
    f.workflows.get(id)!.status = "running";
  };
  await f.command("resume");
  assert.equal(f.maintenance.storageMode, "d1");
});
test("resume bounds immediate deletion readbacks and waits for confirmed absence before create", async (t) => {
  const f = fixture(t);
  await f.activated();
  const remove = f.deps.delete,
    read = f.deps.workflow;
  let deleting = false,
    reads = 0;
  f.deps.delete = async (id) => {
    await remove(id);
    deleting = true;
  };
  f.deps.workflow = async (id) => {
    if (deleting) {
      reads++;
      if (reads < 3) return { ...f.initial, status: "terminated" };
      deleting = false;
    }
    return read(id);
  };
  await f.command("resume");
  assert.equal(reads, 3);
  assert.equal(f.actions.filter((value) => value === "delete").length, 1);
  assert.equal(f.actions.filter((value) => value === "create").length, 1);
});
test("resume retries startup visibility with bounded reads without misclassifying it as effects", async (t) => {
  const f = fixture(t);
  await f.activated();
  const create = f.deps.create,
    read = f.deps.workflow;
  let starting = false,
    reads = 0;
  f.deps.create = async (id, params) => {
    await create(id, params);
    starting = true;
  };
  f.deps.workflow = async (id) => {
    const current = await read(id);
    if (starting && current) {
      reads++;
      if (reads < 3)
        return { ...current, status: "running", step_count: 0, steps: [] };
      starting = false;
    }
    return current;
  };
  await f.command("resume");
  assert.equal(reads, 3);
  assert.equal(f.maintenance.storageMode, "d1");
});
test("unfinished startup stays frozen with a retryable diagnostic after three reads", async (t) => {
  const f = fixture(t);
  await f.activated();
  const create = f.deps.create,
    read = f.deps.workflow;
  let starting = false,
    reads = 0;
  f.deps.create = async (id, params) => {
    await create(id, params);
    starting = true;
  };
  f.deps.workflow = async (id) => {
    const current = await read(id);
    if (starting && current) {
      reads++;
      return { ...current, status: "queued", step_count: 0, steps: [] };
    }
    return current;
  };
  await assert.rejects(
    f.command("resume"),
    /initial scheduled sleep is not visible yet/,
  );
  assert.equal(reads, 3);
  assert.equal(f.maintenance.storageMode, "frozen");
  starting = false;
  await f.command("resume");
  assert.equal(f.actions.filter((value) => value === "create").length, 1);
});

for (const first of ["activate", "abort"] as const) {
  test(`${first} excludes the competing cutover decision before reading authority`, async (t) => {
    const f = fixture(t);
    await f.imported();
    f.setVersion(CANDIDATE);
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const control = f.deps.control;
    let paused = false;
    f.deps.control = async () => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await proceed.promise;
      }
      return control();
    };
    const running = f.command(first);
    await entered.promise;
    try {
      await assert.rejects(
        f.command(first === "activate" ? "abort" : "activate", {
          directory: resolve(f.directory, "competing-operator"),
        }),
        /Another receipt operation holds the lock/,
      );
    } finally {
      proceed.resolve();
    }
    await running;
    assert.equal(
      (await f.deps.control()).state,
      first === "activate" ? "active" : "importing",
    );
    assert.equal(
      await f.deps.deployment(),
      first === "activate" ? CANDIDATE : PREVIOUS,
    );
    if (first === "activate") {
      await assert.rejects(f.command("abort"), /rollback.*forbidden/);
    }
  });
}

test("an uncertain activation retains ownership until its committed result is reconciled", async (t) => {
  const f = fixture(t);
  await f.imported();
  f.setVersion(CANDIDATE);
  const run = f.deps.run;
  f.deps.run = async (...args) => {
    const result = await run(...args);
    if (args[0].includes("SET state = 'active'")) {
      throw new Error("activation response lost");
    }
    return result;
  };
  await assert.rejects(f.command("activate"), /activation response lost/);
  f.deps.run = run;
  assert.equal((await f.deps.control()).state, "active");
  await assert.rejects(f.command("abort"), /holds the lock/);
  await f.command("status");
  assert.ok((f.logs.at(-1) as { operatorLock: unknown }).operatorLock);
  assert.equal(
    f.db
      .prepare(
        "DELETE FROM event_transition_receipt_operator_lock WHERE owner_token = 'wrong-owner'",
      )
      .run().changes,
    0,
  );
  f.releaseReconciledLock();
  await assert.rejects(f.command("abort"), /rollback.*forbidden/);
  assert.equal(await f.deps.deployment(), CANDIDATE);
});

test("read-only validation failures release the operator lock", async (t) => {
  const f = fixture(t);
  f.maintenance.admissions = 1;
  await assert.rejects(f.command("freeze"), /admissions/);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS count FROM event_transition_receipt_operator_lock",
      )
      .get()?.count,
    0,
  );
  f.maintenance.admissions = 0;
  await f.command("freeze");
});

test("ambiguous lock acquisition proceeds only after matching owner readback", async (t) => {
  const f = fixture(t);
  const run = f.deps.run;
  let failed = false;
  f.deps.run = async (...args) => {
    const result = await run(...args);
    if (
      !failed &&
      args[0].startsWith("INSERT INTO event_transition_receipt_operator_lock")
    ) {
      failed = true;
      throw new Error("lock response lost");
    }
    return result;
  };
  await f.command("freeze");
  assert.equal(f.maintenance.storageMode, "frozen");
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS count FROM event_transition_receipt_operator_lock",
      )
      .get()?.count,
    0,
  );
});

test("registration retries ignore unrelated inventory additions and require a returned version", async (t) => {
  const f = fixture(t);
  await f.activated();
  const unrelated = "55555555-5555-4555-8555-555555555555";
  writePrivateImmutable(
    resolve(f.directory, "resume-registration-intent.json"),
    {
      versionId: CANDIDATE,
      before: [OLD_WORKFLOW],
    },
  );
  const versions = f.deps.workflowVersions;
  f.deps.workflowVersions = async () => [...(await versions()), unrelated];
  await f.command("resume");
  assert.equal(
    f.actions.filter((action) => action === "register-workflow").length,
    1,
  );
  assert.equal(f.workflows.get(f.id)?.version_id, NEW_WORKFLOW);
  assert.equal(
    JSON.parse(
      readFileSync(resolve(f.directory, "resume-registration.json"), "utf8"),
    ).workflowVersion,
    NEW_WORKFLOW,
  );
});

test("completed early abort rejects session reuse without freezing or terminating workflows", async (t) => {
  const f = fixture(t);
  const deployment = f.deps.deployment;
  let reads = 0;
  f.deps.deployment = async () => {
    if (++reads === 2) throw new Error("deployment read failed before freeze");
    return deployment();
  };
  await assert.rejects(f.command("freeze"), /deployment read failed/);
  f.deps.deployment = deployment;
  await f.command("abort");
  for (const operation of [
    "freeze",
    "export",
    "import",
    "verify",
    "activate",
    "resume",
  ] as const) {
    await assert.rejects(f.command(operation), /fresh evidence directory/);
  }
  await f.command("abort");
  assert.equal(f.maintenance.storageMode, "d1");
  assert.equal(f.workflows.get(f.id)?.status, "waiting");
  assert.deepEqual(f.actions, []);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS count FROM event_transition_receipt_operator_lock",
      )
      .get()?.count,
    0,
  );

  const directory = mkdtempSync(resolve(tmpdir(), "mons-receipt-new-attempt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.command("freeze", { directory });
  await f.command("abort", { directory });
  assert.equal(f.maintenance.storageMode, "d1");
  assert.equal(f.workflows.get(f.id)?.status, "waiting");
});
