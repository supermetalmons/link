import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureWorkflowHandoff,
  assertRecreatedEventSleep,
  executeWorkflowHandoff,
  getPublishedWorkflowVersion,
  listWorkflowInstances,
  pauseWorkflowHandoff,
  verifyWorkflowHandoff,
  WorkflowHandoffPendingError,
  EVENT_PROGRESS_WORKFLOW_NAME,
  WITHDRAWAL_WORKFLOW_NAME,
  type CloudflareRequest,
  type EventProgressHandoffParams,
  type SqlQuery,
  type WorkflowHandoffManifest,
} from "./workflows.ts";

type JsonRecord = Record<string, unknown>;
const OLD_VERSION = "00000000-0000-4000-8000-000000000001";
const NEW_VERSION = "00000000-0000-4000-8000-000000000002";
const EVENT_DATABASE = "00000000-0000-4000-8000-000000000003";
const WITHDRAWAL_DATABASE = "00000000-0000-4000-8000-000000000004";
const DESTINATION_DATABASE = "00000000-0000-4000-8000-000000000005";
const NOW = 1_800_000_000_000;

function sleepName(params: EventProgressHandoffParams): string {
  if (params.reason === "sunday-mons-reminder")
    return "wait for sunday mons reminder-1";
  if (params.reason === "event-prize-announcement")
    return "wait for prize announcement-1";
  return "wait for scheduled event-1";
}

function initialDetail(
  params: EventProgressHandoffParams,
  versionId = OLD_VERSION,
) {
  return {
    params: structuredClone(params),
    trigger: { source: "binding" },
    versionId,
    queued: new Date(NOW - 5_000).toISOString(),
    start: new Date(NOW - 5_000).toISOString(),
    end: null,
    success: null,
    error: null,
    output: null,
    rollback: null,
    status: "waiting",
    step_count: 1,
    steps: [
      {
        name: sleepName(params),
        type: "sleep",
        start: new Date(NOW - 5_000).toISOString(),
        end: new Date(params.runAtMs).toISOString(),
        finished: false,
        error: null,
      },
    ],
  };
}

function fixture() {
  const instances = new Map<string, Map<string, JsonRecord>>([
    [EVENT_PROGRESS_WORKFLOW_NAME, new Map()],
    [WITHDRAWAL_WORKFLOW_NAME, new Map()],
  ]);
  const outboxes = new Map<string, JsonRecord>();
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const state = {
    now: NOW,
    publishedVersion: NEW_VERSION,
    pendingWithdrawals: 0,
    persisted: null as WorkflowHandoffManifest | null,
    checkpoints: [] as WorkflowHandoffManifest[],
    failAfterMutation: "",
    failReadAfterDelete: false,
    failNextDetailRead: false,
    leavePausePending: false,
    leaveCreationQueued: false,
    nativeRunningSleep: false,
    listSleepStatus: "",
    finishSleepOnTermination: false,
    failPersist: false,
    omitDefinitionVersion: false,
    foreignPublishedVersion: false,
  };

  function addPending(
    kind: "start" | "prizes" | "reminder" = "start",
    lead = 14_400_000,
  ) {
    const eventId = `event-${outboxes.size + 1}`;
    const runAtMs = NOW + 36_000_000;
    const sourceKey =
      kind === "start"
        ? `start:${eventId}:${runAtMs}`
        : `${kind}:${eventId}:${runAtMs + (kind === "prizes" ? 3_600_000 : lead)}`;
    const digest = createHash("sha256")
      .update(`${eventId}\n${sourceKey}`)
      .digest("hex");
    const id = `event-progress-${digest}`;
    const params: EventProgressHandoffParams = {
      schemaVersion: 1,
      eventId,
      outboxId: `ep_${digest}`,
      reason:
        kind === "reminder"
          ? "sunday-mons-reminder"
          : kind === "prizes"
            ? "event-prize-announcement"
            : "scheduled-start-reconciliation",
      runAtMs,
      sourceKey,
    };
    instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.set(id, initialDetail(params));
    outboxes.set(params.outboxId, {
      outbox_id: params.outboxId,
      event_id: params.eventId,
      status: "pending",
      run_at_ms: params.runAtMs,
      last_queued_at_ms: NOW - 1_000,
      record_json: JSON.stringify(
        {
          schemaVersion: 1,
          eventId: params.eventId,
          sourceKey: params.sourceKey,
          reason: params.reason,
          runAtMs: params.runAtMs,
          firstQueuedAtMs: NOW - 5_000,
          lastQueuedAtMs: NOW - 1_000,
        },
        null,
        2,
      ),
    });
    return { id, params };
  }

  function addComplete(
    name: string,
    id: string,
    output: unknown = { ok: true },
  ) {
    instances.get(name)!.set(id, {
      params: { private: "retained-payload" },
      versionId: OLD_VERSION,
      status: "complete",
      steps: [{ type: "step", name: "original-step-1", output }],
      step_count: 1,
      output,
      success: true,
      error: null,
    });
  }

  const query: SqlQuery = async (_databaseId, sql, params = []) => {
    if (sql.includes("pending_count"))
      return [{ pending_count: state.pendingWithdrawals }];
    const row = outboxes.get(String(params[0]));
    return row ? [structuredClone(row)] : [];
  };

  const request: CloudflareRequest = async (path, method = "GET", body) => {
    calls.push({
      path,
      method,
      ...(body === undefined ? {} : { body: structuredClone(body) }),
    });
    const url = new URL(path, "https://provider.invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    const name = parts[1];
    const collection = instances.get(name);
    assert(collection, "only the two owned definitions may be addressed");
    if (parts.length === 2) {
      assert.equal(method, "GET");
      return {
        id: "00000000-0000-4000-8000-000000000010",
        name,
        script_name: "mons-link-api",
        class_name:
          name === EVENT_PROGRESS_WORKFLOW_NAME
            ? "EventProgressWorkflow"
            : "EventPrizeWithdrawalWorkflow",
        ...(state.omitDefinitionVersion
          ? {}
          : { version_id: state.publishedVersion }),
      };
    }
    if (parts.length === 3 && parts[2] === "versions" && method === "GET") {
      assert.equal(url.searchParams.get("per_page"), "1");
      return [
        {
          id: state.publishedVersion,
          workflow_id: state.foreignPublishedVersion
            ? OLD_VERSION
            : "00000000-0000-4000-8000-000000000010",
          class_name:
            name === EVENT_PROGRESS_WORKFLOW_NAME
              ? "EventProgressWorkflow"
              : "EventPrizeWithdrawalWorkflow",
        },
      ];
    }
    if (parts.length === 3 && method === "GET") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("per_page"), "100");
      return [...collection]
        .map(([id, detail]) => ({
          id,
          status:
            state.listSleepStatus &&
            ["waiting", "running"].includes(String(detail.status))
              ? state.listSleepStatus
              : detail.status,
          version_id: detail.versionId,
          created_on: new Date(NOW - 5_000).toISOString(),
          modified_on: new Date(NOW - 5_000).toISOString(),
        }))
        .slice((page - 1) * 100, page * 100);
    }
    if (parts.length === 4 && method === "GET") {
      if (state.failNextDetailRead) {
        state.failNextDetailRead = false;
        throw Object.assign(new Error("temporary provider failure"), {
          status: 503,
        });
      }
      const detail = collection.get(parts[3]);
      if (!detail)
        throw Object.assign(new Error("missing instance"), { status: 404 });
      return structuredClone(detail);
    }
    const input = body as JsonRecord;
    let action: string;
    let id: string;
    if (parts[4] === "status") {
      id = parts[3];
      action = String(input.status);
    } else if (parts[4] === "delete") {
      assert.equal(parts[3], "batch");
      assert.equal((input.instances as string[]).length, 1);
      id = (input.instances as string[])[0];
      action = "delete";
    } else {
      assert.equal(parts.length, 3);
      id = String(input.instance_id);
      action = "create";
    }
    assert.equal(
      name,
      EVENT_PROGRESS_WORKFLOW_NAME,
      "withdrawal histories must never be mutated",
    );
    const checkpoint = state.persisted?.entries.find(
      (entry) => entry.id === id,
    );
    assert(checkpoint, "manifest must be persisted before every mutation");
    const expectedStage = {
      pause: "pause-requested",
      terminate: "terminate-requested",
      delete: "delete-requested",
      create: "create-requested",
    }[action];
    assert.equal(checkpoint.stage, expectedStage);
    assert.notEqual(
      collection.get(id)?.status,
      "complete",
      "completed instances must never be mutated",
    );
    if (action === "pause") {
      assert.equal(method, "PATCH");
      collection.get(id)!.status = state.leavePausePending
        ? "waitingForPause"
        : "paused";
    } else if (action === "terminate") {
      assert.equal(method, "PATCH");
      assert.equal(input.rollback, false);
      const detail = collection.get(id)!;
      detail.status = "terminated";
      if (state.finishSleepOnTermination) {
        const sleep = (detail.steps as JsonRecord[])[0];
        sleep.finished = true;
        sleep.error = { name: "Terminated", message: "terminated by operator" };
        sleep.end = new Date(NOW).toISOString();
      }
      (detail.steps as JsonRecord[]).push({
        type: "termination",
        trigger: { source: "api" },
      });
      detail.step_count = (detail.steps as unknown[]).length;
    } else if (action === "delete") {
      assert.equal(method, "POST");
      assert.equal(collection.get(id)?.status, "terminated");
      collection.delete(id);
      if (state.failReadAfterDelete) {
        state.failReadAfterDelete = false;
        state.failNextDetailRead = true;
      }
    } else {
      assert.equal(method, "POST");
      assert(!collection.has(id), "a recreated ID must not be recreated again");
      assert.deepEqual(input.instance_retention, {
        success_retention: "1 day",
        error_retention: "30 days",
      });
      const detail: JsonRecord = initialDetail(
        input.params as EventProgressHandoffParams,
        state.publishedVersion,
      );
      if (state.leaveCreationQueued) detail.status = "queued";
      else if (state.nativeRunningSleep) detail.status = "running";
      collection.set(id, detail);
    }
    if (state.failAfterMutation === action) {
      state.failAfterMutation = "";
      throw Object.assign(new Error("response lost after application"), {
        status: 502,
      });
    }
    return action === "delete"
      ? { deleted: [{ id }], errors: [] }
      : { id, version_id: state.publishedVersion };
  };

  async function persist(manifest: WorkflowHandoffManifest) {
    if (state.failPersist) throw new Error("private artifact unavailable");
    state.persisted = structuredClone(manifest);
    state.checkpoints.push(structuredClone(manifest));
  }

  const dependencies = {
    request,
    query,
    eventDatabaseId: EVENT_DATABASE,
    withdrawalDatabaseId: WITHDRAWAL_DATABASE,
    now: () => state.now,
  };
  async function capture() {
    const manifest = await captureWorkflowHandoff(dependencies);
    await persist(manifest);
    return manifest;
  }
  async function pause(manifest = state.persisted!) {
    return pauseWorkflowHandoff({ ...dependencies, manifest, persist });
  }
  async function execute(manifest = state.persisted!) {
    return executeWorkflowHandoff({
      ...dependencies,
      manifest,
      persist,
      eventDatabaseId: DESTINATION_DATABASE,
      targetWorkflowVersionId: NEW_VERSION,
    });
  }
  return {
    state,
    calls,
    instances,
    outboxes,
    addPending,
    addComplete,
    dependencies,
    capture,
    pause,
    execute,
    persist,
  };
}

test("captures all pages and rejects inconsistent duplicate pages", async () => {
  const f = fixture();
  for (let index = 0; index < 205; index++)
    f.addComplete(WITHDRAWAL_WORKFLOW_NAME, `completed-${index}`);
  const manifest = await f.capture();
  assert.equal(manifest.completed.length, 205);
  assert(f.calls.some((call) => call.path.endsWith("per_page=100&page=3")));
  const repeated = Array.from({ length: 100 }, (_, index) => ({
    id: `id-${index}`,
    status: "complete",
    version_id: OLD_VERSION,
  }));
  await assert.rejects(
    listWorkflowInstances(async () => repeated, EVENT_PROGRESS_WORKFLOW_NAME),
    /inconsistent-instance-pages/,
  );
});

test("real Workflow GET without version_id resolves the latest owned version before handoff", async () => {
  const f = fixture();
  f.state.omitDefinitionVersion = true;
  f.addPending();
  await f.capture();
  await f.pause();
  await f.execute();
  assert(f.calls.some((call) => call.path.endsWith("/versions?per_page=1")));
  assert.equal(
    await getPublishedWorkflowVersion(
      f.dependencies.request,
      WITHDRAWAL_WORKFLOW_NAME,
    ),
    NEW_VERSION,
  );
});

test("published version fallback rejects metadata from another Workflow", async () => {
  const f = fixture();
  f.state.omitDefinitionVersion = true;
  f.state.foreignPublishedVersion = true;
  f.addPending();
  await f.capture();
  await f.pause();
  const before = f.calls.filter((call) => call.method !== "GET").length;
  await assert.rejects(f.execute(), /published-version-owner-conflict/);
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, before);
});

test("migrates only initial sleeps and preserves exact 3h and 4h reminders, IDs, outbox bytes and completed results", async () => {
  const f = fixture();
  f.addPending("start");
  f.addPending("prizes");
  f.addPending("reminder", 10_800_000);
  f.addPending("reminder", 14_400_000);
  f.addComplete(EVENT_PROGRESS_WORKFLOW_NAME, "completed-event", {
    status: "applied",
    didChange: true,
  });
  f.addComplete(WITHDRAWAL_WORKFLOW_NAME, "completed-withdrawal", {
    transactionSignature: "retain-exact-signature",
  });
  const beforeRows = structuredClone([...f.outboxes]);
  const original = await f.capture();
  assert(f.calls.every((call) => call.method === "GET"));
  const paused = await f.pause(original);
  assert(paused.entries.every((entry) => entry.stage === "paused"));
  const migrated = await f.execute(paused);
  assert(migrated.entries.every((entry) => entry.stage === "recreated"));
  assert.deepEqual(
    migrated.entries.map((entry) => entry.params),
    original.entries.map((entry) => entry.params),
  );
  assert.deepEqual([...f.outboxes], beforeRows);
  const result = await verifyWorkflowHandoff({
    ...f.dependencies,
    manifest: migrated,
    targetWorkflowVersionId: NEW_VERSION,
  });
  assert.deepEqual(result, {
    migrated: 4,
    completedDuringHandoff: 0,
    completedHistoriesPreserved: 2,
    expiredCompletedHistories: [],
    oldVersionNonterminal: 0,
  });
  const mutationCount = f.calls.filter((call) => call.method !== "GET").length;
  await f.execute(migrated);
  assert.equal(
    f.calls.filter((call) => call.method !== "GET").length,
    mutationCount,
  );
});

test("accepts native running metadata only with a persisted future initial sleep throughout handoff", async () => {
  const f = fixture();
  const job = f.addPending();
  f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!.status =
    "running";
  f.state.nativeRunningSleep = true;
  f.state.listSleepStatus = "waiting";
  const captured = await f.capture();
  assert.equal(captured.entries[0].original.status, "running");
  assert.equal(captured.entries[0].original.summary.status, "waiting");
  const paused = await f.pause(captured);
  assert.equal(paused.entries[0].pausedDetail!.status, "paused");
  const migrated = await f.execute(paused);
  assert.equal(migrated.entries[0].recreatedDetail!.status, "running");
  const verification = await verifyWorkflowHandoff({
    ...f.dependencies,
    manifest: migrated,
    targetWorkflowVersionId: NEW_VERSION,
  });
  assert.equal(verification.migrated, 1);
  assertRecreatedEventSleep(
    migrated.entries[0].recreatedDetail,
    job.params,
    NOW,
  );
});

test("running business work or an expired sleep cannot qualify as a recreated scheduled instance", async () => {
  const f = fixture();
  const job = f.addPending();
  const detail = f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!;
  detail.status = "running";
  const valid = structuredClone(detail);
  detail.steps = [{ type: "step", name: "synchronize event-1", output: null }];
  await assert.rejects(f.capture(), /not-in-initial-sleep/);
  assert.throws(
    () => assertRecreatedEventSleep(detail, job.params, NOW),
    /not-in-initial-sleep/,
  );
  assert.throws(
    () => assertRecreatedEventSleep(valid, job.params, job.params.runAtMs),
    /not-in-future-initial-sleep/,
  );
  for (const status of ["errored", "terminated", "paused", "queued"])
    assert.throws(
      () => assertRecreatedEventSleep({ ...valid, status }, job.params, NOW),
      /not-in-future-initial-sleep/,
    );
});

test("refuses active withdrawals in either Workflow inventory or D1", async () => {
  const f = fixture();
  f.addComplete(WITHDRAWAL_WORKFLOW_NAME, "withdrawal");
  f.instances.get(WITHDRAWAL_WORKFLOW_NAME)!.get("withdrawal")!.status =
    "waiting";
  await assert.rejects(f.capture(), /noncomplete-withdrawal/);
  f.instances.get(WITHDRAWAL_WORKFLOW_NAME)!.get("withdrawal")!.status =
    "complete";
  f.state.pendingWithdrawals = 1;
  await assert.rejects(f.capture(), /pending-withdrawal-records/);
  assert(f.calls.every((call) => call.method === "GET"));
});

test("refuses a waiting instance that already executed a business step", async () => {
  const f = fixture();
  const job = f.addPending();
  const detail = f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!;
  (detail.steps as unknown[]).unshift({
    type: "step",
    name: "synchronize event-1",
    output: { didChange: true },
  });
  detail.step_count = 2;
  await assert.rejects(f.capture(), /not-in-(?:future-)?initial-sleep/);
});

test("rejects a provider sleep deadline that differs from the saved payload", async () => {
  const f = fixture();
  const job = f.addPending("reminder");
  const detail = f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!;
  (detail.steps as JsonRecord[])[0].end = new Date(
    job.params.runAtMs + 3_600_000,
  ).toISOString();
  await assert.rejects(f.capture(), /not-in-initial-sleep/);
});

test("retains terminated sleep evidence when the provider closes the sleep during termination", async () => {
  const f = fixture();
  f.addPending();
  await f.capture();
  await f.pause();
  f.state.finishSleepOnTermination = true;
  const migrated = await f.execute();
  assert.equal(migrated.entries[0].stage, "recreated");
  assert.equal(
    (migrated.entries[0].terminatedDetail!.steps as JsonRecord[])[0].finished,
    true,
  );
});

test("refuses outbox mismatches and deadline proximity before any mutation", async () => {
  const f = fixture();
  const job = f.addPending("reminder");
  const row = f.outboxes.get(job.params.outboxId)!;
  row.run_at_ms = job.params.runAtMs + 1;
  await assert.rejects(f.capture(), /outbox-row-mismatch/);
  row.run_at_ms = job.params.runAtMs;
  const manifest = await f.capture();
  f.state.now = job.params.runAtMs - 30_000;
  await assert.rejects(f.pause(manifest), /scheduled-deadline-too-close/);
  assert(f.calls.every((call) => call.method === "GET"));
});

test("does not unpause an operator pause or touch an instance completed before handoff", async () => {
  const f = fixture();
  const job = f.addPending();
  const manifest = await f.capture();
  const detail = f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!;
  detail.status = "paused";
  await assert.rejects(f.pause(manifest), /preexisting-pause-detected/);
  detail.status = "complete";
  detail.output = { status: "applied" };
  const paused = await f.pause(manifest);
  assert.equal(paused.entries[0].stage, "completed");
  const migrated = await f.execute(paused);
  assert.equal(migrated.entries[0].stage, "completed");
  assert(f.calls.every((call) => call.method === "GET"));
});

test("checkpoint failure prevents every provider mutation", async () => {
  const f = fixture();
  f.addPending();
  const manifest = await f.capture();
  f.state.failPersist = true;
  await assert.rejects(f.pause(manifest), /private artifact unavailable/);
  assert(f.calls.every((call) => call.method === "GET"));
});

for (const action of ["pause", "terminate", "delete", "create"]) {
  test(`accepts an ambiguous ${action} response only after matching provider readback`, async () => {
    const f = fixture();
    f.addPending();
    await f.capture();
    if (action === "pause") f.state.failAfterMutation = action;
    await f.pause();
    if (action !== "pause") f.state.failAfterMutation = action;
    await f.execute();
    assert.equal(f.state.persisted!.entries[0].stage, "recreated");
    const deletes = f.calls.filter((call) =>
      call.path.endsWith("/batch/delete"),
    );
    assert.equal(deletes.length, 1);
  });
}

test("resumes a lost read after deletion without repeating termination or inventing a new ID", async () => {
  const f = fixture();
  const job = f.addPending();
  await f.capture();
  await f.pause();
  f.state.failReadAfterDelete = true;
  await assert.rejects(f.execute(), /temporary provider failure/);
  assert.equal(f.state.persisted!.entries[0].stage, "delete-requested");
  assert(!f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.has(job.id));
  await f.execute();
  assert.equal(
    f.calls.filter((call) => (call.body as JsonRecord)?.status === "terminate")
      .length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/batch/delete")).length,
    1,
  );
  assert.equal(f.state.persisted!.entries[0].stage, "recreated");
});

test("pause propagation is resumable and does not resend pause while waitingForPause", async () => {
  const f = fixture();
  const job = f.addPending();
  await f.capture();
  f.state.leavePausePending = true;
  await assert.rejects(f.pause(), WorkflowHandoffPendingError);
  assert.equal(f.state.persisted!.entries[0].stage, "pause-requested");
  await assert.rejects(f.pause(), WorkflowHandoffPendingError);
  assert.equal(
    f.calls.filter((call) => (call.body as JsonRecord)?.status === "pause")
      .length,
    1,
  );
  f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!.status = "paused";
  await f.pause();
  assert.equal(f.state.persisted!.entries[0].stage, "paused");
});

test("new instance startup is resumable without duplicate creation", async () => {
  const f = fixture();
  const job = f.addPending();
  await f.capture();
  await f.pause();
  f.state.leaveCreationQueued = true;
  await assert.rejects(f.execute(), WorkflowHandoffPendingError);
  assert.equal(f.state.persisted!.entries[0].stage, "create-requested");
  f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.get(job.id)!.status =
    "waiting";
  await f.execute();
  assert.equal(
    f.calls.filter((call) => (call.body as JsonRecord)?.instance_id === job.id)
      .length,
    1,
  );
});

test("never treats a transient read failure as proof that an instance is absent", async () => {
  const f = fixture();
  f.addPending();
  await f.capture();
  await f.pause();
  f.state.failNextDetailRead = true;
  const before = f.calls.filter((call) => call.method !== "GET").length;
  await assert.rejects(f.execute(), /temporary provider failure/);
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, before);
});

test("refuses wrong publication, changed destination bytes and new old-version work", async () => {
  const f = fixture();
  const job = f.addPending();
  await f.capture();
  await f.pause();
  const before = f.calls.filter((call) => call.method !== "GET").length;
  f.state.publishedVersion = OLD_VERSION;
  await assert.rejects(f.execute(), /target-definition-not-published/);
  f.state.publishedVersion = NEW_VERSION;
  const row = f.outboxes.get(job.params.outboxId)!;
  const savedJson = row.record_json;
  row.record_json = JSON.stringify(JSON.parse(String(savedJson)));
  await assert.rejects(f.execute(), /destination-outbox-changed/);
  row.record_json = savedJson;
  f.addPending();
  await assert.rejects(f.execute(), /unexpected-live-instance/);
  assert.equal(f.calls.filter((call) => call.method !== "GET").length, before);
});

test("final verification detects old-version work and changed terminal results", async () => {
  const f = fixture();
  f.addPending();
  f.addComplete(WITHDRAWAL_WORKFLOW_NAME, "completed-withdrawal");
  await f.capture();
  await f.pause();
  const migrated = await f.execute();
  const unexpected = f.addPending();
  await assert.rejects(
    verifyWorkflowHandoff({
      ...f.dependencies,
      manifest: migrated,
      targetWorkflowVersionId: NEW_VERSION,
    }),
    /old-or-unexpected-nonterminal-instance/,
  );
  f.instances.get(EVENT_PROGRESS_WORKFLOW_NAME)!.delete(unexpected.id);
  f.instances
    .get(WITHDRAWAL_WORKFLOW_NAME)!
    .get("completed-withdrawal")!.output = { changed: true };
  await assert.rejects(
    verifyWorkflowHandoff({
      ...f.dependencies,
      manifest: migrated,
      targetWorkflowVersionId: NEW_VERSION,
    }),
    /completed-history-changed/,
  );
});
