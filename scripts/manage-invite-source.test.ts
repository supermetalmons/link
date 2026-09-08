import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  auditWorkflows,
  createProductionDependencies,
  createSqlDependencies,
  loadExport,
  manageInviteSource,
  parseArgs,
  sourceRow,
  type Arguments,
  type WorkflowPage,
} from "./manage-invite-source.ts";
import { canonicalJson, digest, type SqlRunner } from "./manage-wager-state.ts";

const VERSION = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION = "22222222-2222-4222-8222-222222222222";

function insertInviteAdmission(f: ReturnType<typeof fixture>, id = VERSION) {
  f.db
    .prepare(
      "INSERT INTO invite_source_write_admissions (admission_id, backend, epoch, freeze_generation, kind, created_at_ms) SELECT ?, backend, epoch, freeze_generation, 'invite-patch', 100 FROM invite_source_control",
    )
    .run(id);
}

async function admissionEvidence(
  f: ReturnType<typeof fixture>,
  admissionId = VERSION,
) {
  await f.command("inspect-admission", { admissionId });
  return resolve(
    f.directory,
    readdirSync(f.directory).find(
      (name) => name.includes(admissionId) && name.endsWith("-evidence.json"),
    )!,
  );
}

function finishAdmissionEvidence(
  file: string,
  sources: Array<{ inviteId: string; digest: string }> = [],
) {
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.requestFinishedAtMs = 1000;
  evidence.completionEvidence = {
    reference: "protected-request-trace",
    explanation: "The original request finished and cannot resume.",
  };
  evidence.sourceReconciliation = {
    scopeComplete: true,
    noSourceEffects: sources.length === 0,
    reference: "protected-source-investigation",
    explanation: sources.length
      ? "All request effects and receipts reconciled; these are all affected invite sources."
      : "Acquisition failed before any source work started; no write was dispatched.",
    sources,
  };
  writeFileSync(file, canonicalJson(evidence));
  return evidence;
}

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(
    resolve(tmpdir(), "mons-invite-migration-test-"),
  );
  const db = new DatabaseSync(":memory:");
  const events = new DatabaseSync(":memory:");
  for (const file of [
    "0007_gameplay_coordination.sql",
    "0009_automatch_state.sql",
    "0010_game_session_transitions.sql",
    "0018_invite_sources.sql",
  ])
    db.exec(
      readFileSync(resolve("cloud/workers/api/migrations", file), "utf8"),
    );
  db.exec(
    "UPDATE automatch_runtime_control SET backend = 'd1', epoch = 2, freeze_generation = 1;",
  );
  for (const file of ["0001_event_store.sql", "0002_event_store_safety.sql"])
    events.exec(
      readFileSync(resolve("cloud/workers/api/event-migrations", file), "utf8"),
    );
  events.exec(`
    UPDATE event_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'firebase', freeze_generation = 1;
    UPDATE event_runtime_control SET source_digest = '${"a".repeat(64)}', source_event_count = 0, source_selection_count = 0, source_assignment_count = 0, source_exported_at_ms = 1, cutover_at_ms = 2, verified_import_generation = 1;
    UPDATE event_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL;
    UPDATE event_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'd1', freeze_generation = 2, verified_import_generation = NULL;
  `);
  events.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/event-migrations/0003_finalize_event_storage.sql",
      ),
      "utf8",
    ),
  );
  events.exec("UPDATE event_runtime_control SET storage_mode = 'd1';");
  const source = new Map<string, unknown>([
    [
      "private",
      {
        hostId: "host",
        password: "private-password",
        automatchOperationIds: { host: "internal-operation" },
        sessionTransition: { sequence: 3, transitionId: "old-transition" },
      },
    ],
    [
      "10",
      {
        hostId: "ten",
        guestId: "guest",
        unknown: { keep: [false, null, 4], wagers: "nested-field-is-kept" },
      },
    ],
    [
      "2",
      {
        hostId: "two",
        reactions: { old: true },
        wagers: { old: true },
        matchesWagerResolutions: { old: true },
      },
    ],
    ["empty", {}],
    [
      "event",
      {
        eventId: "tournament",
        eventOwned: true,
        hostRematches: "1",
        guestRematches: "1",
      },
    ],
  ]);
  let deployed = VERSION;
  let now = 100_000;
  let reads = 0;
  let failReadAt = 0;
  let failImportAt = 0;
  let imports = 0;
  let sourceKeyFailure = false;
  let loseAdmissionDeleteResponse = false;
  let beforeAdmissionDelete: (() => void) | undefined;
  let workflowPages = new Map<string | null, WorkflowPage>([
    [
      null,
      {
        rows: [
          { id: "completed", status: "complete", versionId: OTHER_VERSION },
        ],
        cursor: null,
      },
    ],
  ]);
  const calls: Array<{ sql: string; database: string }> = [];
  const logs: Record<string, unknown>[] = [];
  const run: SqlRunner = async (
    sql,
    database = "mons-link-profile-games",
    bindings = [],
  ) => {
    calls.push({ sql, database });
    if (
      sql.startsWith("INSERT INTO invite_sources") &&
      ++imports === failImportAt
    )
      throw new Error("interrupted import");
    const admissionDelete = sql.startsWith(
      "DELETE FROM invite_source_write_admissions",
    );
    if (admissionDelete) beforeAdmissionDelete?.();
    const result = (database === "mons-link-events" ? events : db)
      .prepare(sql)
      .all(...bindings) as Record<string, unknown>[];
    if (admissionDelete && loseAdmissionDeleteResponse) {
      loseAdmissionDeleteResponse = false;
      throw new Error("admission delete response lost");
    }
    return result;
  };
  const dependencies = createSqlDependencies(
    run,
    {
      async assertDeployment(candidate) {
        assert.equal(
          candidate,
          deployed,
          "candidate is not sole deployed version",
        );
      },
      async workflowPage(cursor) {
        const page = workflowPages.get(cursor);
        if (!page) throw new Error("unexpected Workflow page cursor");
        return structuredClone(page);
      },
      async *streamInviteKeys() {
        for (const key of source.keys()) yield key;
        if (sourceKeyFailure) throw new Error("truncated Firebase inventory");
      },
      async readInvite(inviteId) {
        if (++reads === failReadAt) throw new Error("interrupted source read");
        return structuredClone(source.get(inviteId) ?? null);
      },
    },
    () => now++,
  );
  dependencies.log = (value) => logs.push(value);
  const command = (
    operation: Arguments["operation"],
    extra: Partial<Arguments> = {},
  ) =>
    manageInviteSource(
      {
        operation,
        ...(operation === "status" || operation === "preflight"
          ? {}
          : { directory }),
        ...(["freeze", "verify", "activate", "resume", "abort"].includes(
          operation,
        )
          ? { candidateVersionId: VERSION }
          : {}),
        ...extra,
      },
      dependencies,
    );
  const importSource = async () => {
    await command("freeze");
    await command("export");
    await command("import");
  };
  t.after(() => {
    db.close();
    events.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    events,
    source,
    calls,
    logs,
    directory,
    dependencies,
    command,
    importSource,
    setDeployed: (value: string) => {
      deployed = value;
    },
    setFailReadAt: (value: number) => {
      failReadAt = value;
    },
    setFailImportAt: (value: number) => {
      failImportAt = value;
    },
    setSourceKeyFailure: (value: boolean) => {
      sourceKeyFailure = value;
    },
    loseAdmissionDeleteResponse: () => {
      loseAdmissionDeleteResponse = true;
    },
    beforeAdmissionDelete: (callback: () => void) => {
      beforeAdmissionDelete = callback;
    },
    setWorkflowPages: (value: Map<string | null, WorkflowPage>) => {
      workflowPages = value;
    },
    get reads() {
      return reads;
    },
  };
}

test("admission CLI accepts only named inspection and protected reconciliation evidence", () => {
  const args = parseArgs([
    "--inspect-admission",
    VERSION,
    "--directory",
    "/private/evidence",
  ]);
  assert.equal(args.admissionId, VERSION);
  assert.equal(args.directory, "/private/evidence");
  assert.deepEqual(
    parseArgs([
      "--reconcile-admission",
      "--evidence",
      "/private/evidence/completed.json",
    ]),
    {
      operation: "reconcile-admission",
      evidence: "/private/evidence/completed.json",
    },
  );
  for (const argv of [
    ["--inspect-admission"],
    ["--inspect-admission", "all", "--directory", "/private/evidence"],
    ["--inspect-admission", VERSION, "--directory", "relative"],
    [
      "--inspect-admission",
      VERSION,
      "--directory",
      "/private/evidence",
      "--candidate-version-id",
      VERSION,
    ],
    ["--reconcile-admission"],
    ["--reconcile-admission", "--evidence", "relative"],
    [
      "--reconcile-admission",
      "--evidence",
      "/private/evidence.json",
      "--directory",
      "/private/evidence",
    ],
  ])
    assert.throws(() => parseArgs(argv));
});

test("named orphan admission recovery works before and after activation with no intents or automatic freeze", async (t) => {
  for (const [backend, partiallyFrozen] of [
    ["rtdb", false],
    ["d1", false],
    ["rtdb", true],
    ["d1", true],
  ]) {
    const f = fixture(t);
    if (backend === "d1")
      f.db.exec("UPDATE invite_source_control SET backend = 'd1', epoch = 1");
    insertInviteAdmission(f);
    if (partiallyFrozen)
      f.db.exec(
        "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1",
      );
    await f.command("status");
    assert.equal(
      (f.logs.at(-1)?.admissions as Array<{ admissionId: string }>)[0]
        .admissionId,
      VERSION,
    );
    const file = await admissionEvidence(f);
    const evidence = finishAdmissionEvidence(file);
    const inspection = readFileSync(evidence.inspectionFile, "utf8");
    assert.equal(statSync(evidence.inspectionFile).mode & 0o777, 0o600);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const controls = (await f.dependencies.status()).control;
    await f.command("reconcile-admission", { evidence: file });
    assert.equal((await f.dependencies.status()).counts.inviteAdmissions, 0);
    assert.deepEqual((await f.dependencies.status()).control, controls);
    await f.command("reconcile-admission", { evidence: file });
    assert.equal(f.logs.at(-1)?.alreadyAbsent, true);
    assert.equal(readFileSync(evidence.inspectionFile, "utf8"), inspection);
    assert.equal(
      f.calls.filter((call) =>
        call.sql.startsWith("DELETE FROM invite_source_write_admissions"),
      ).length,
      1,
    );
  }
});

test("admission recovery rejects incomplete request or source proof and arbitrary missing rows", async (t) => {
  const f = fixture(t);
  insertInviteAdmission(f);
  const file = await admissionEvidence(f);
  await assert.rejects(
    f.command("reconcile-admission", { evidence: file }),
    /completed-request evidence/,
  );
  const evidence = finishAdmissionEvidence(file);
  evidence.sourceReconciliation.scopeComplete = false;
  writeFileSync(file, canonicalJson(evidence));
  await assert.rejects(
    f.command("reconcile-admission", { evidence: file }),
    /source reconciliation proof/,
  );
  finishAdmissionEvidence(file);
  f.db.exec("DELETE FROM invite_source_write_admissions");
  await assert.rejects(
    f.command("reconcile-admission", { evidence: file }),
    /no matching protected pre-delete evidence/,
  );
  assert.equal(
    readdirSync(f.directory).filter((name) =>
      name.startsWith("invite-admission-completed-"),
    ).length,
    0,
  );
});

test("admission source proof verifies current canonical metadata on either backend without logging payloads", async (t) => {
  for (const backend of ["rtdb", "d1"]) {
    const f = fixture(t);
    const source = { hostId: "host", password: "secret-source-payload" };
    if (backend === "d1") {
      f.db.exec("UPDATE invite_source_control SET backend = 'd1', epoch = 1");
      f.db
        .prepare("INSERT INTO invite_sources VALUES ('private', ?, 1, 100)")
        .run(canonicalJson(source));
    } else f.source.set("private", { ...source, reactions: { retired: true } });
    insertInviteAdmission(f);
    const file = await admissionEvidence(f);
    finishAdmissionEvidence(file, [
      { inviteId: "private", digest: digest({ wrong: true }) },
    ]);
    await assert.rejects(
      f.command("reconcile-admission", { evidence: file }),
      /source changed/,
    );
    finishAdmissionEvidence(file, [
      { inviteId: "private", digest: digest(source) },
    ]);
    await f.command("reconcile-admission", { evidence: file });
    assert.ok(!JSON.stringify(f.logs).includes("secret-source-payload"));
    assert.equal((await f.dependencies.status()).counts.inviteAdmissions, 0);
  }
});

test("two orphan admissions can be reconciled separately without deleting or waiting on other admissions", async (t) => {
  const f = fixture(t);
  insertInviteAdmission(f);
  insertInviteAdmission(f, OTHER_VERSION);
  f.db.exec(
    "INSERT INTO automatch_write_admissions VALUES ('session', 2, 1, 'd1', 'patch', 100)",
  );
  f.events.exec(
    "INSERT INTO event_write_admissions VALUES ('event',2,100,101)",
  );
  const other = await f.dependencies.readAdmission(OTHER_VERSION);
  for (const admissionId of [VERSION, OTHER_VERSION]) {
    const file = await admissionEvidence(f, admissionId);
    finishAdmissionEvidence(file);
    await f.command("reconcile-admission", { evidence: file });
    assert.equal(await f.dependencies.readAdmission(admissionId), null);
    if (admissionId === VERSION)
      assert.deepEqual(
        await f.dependencies.readAdmission(OTHER_VERSION),
        other,
      );
  }
  const status = await f.dependencies.status();
  assert.equal(status.counts.inviteAdmissions, 0);
  assert.equal(status.counts.sessionAdmissions, 1);
  assert.equal(status.counts.eventAdmissions, 1);
});

test("pending transitions, resources, and leases prevent named recovery", async (t) => {
  const blockers = [
    {
      sql: "INSERT INTO game_session_transitions (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('intent','private','{}','pending',100,100)",
    },
    {
      sql: "INSERT INTO game_session_transitions (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('intent','private','{}','completed',100,100); INSERT INTO game_session_transition_resources VALUES ('resource','intent')",
    },
    {
      sql: "INSERT INTO game_session_mutation_locks VALUES ('lock','owner','operation',1)",
    },
    {
      events: true,
      sql: "INSERT INTO event_leases VALUES ('event','lease','owner',100,100,101)",
    },
    {
      events: true,
      sql: "PRAGMA foreign_keys=OFF; INSERT INTO event_transition_intents (transition_id,event_id,expected_revision,status,intent_json,created_at_ms,updated_at_ms) VALUES ('intent','event',1,'dead','{}',100,100)",
    },
  ];
  for (const blocker of blockers) {
    const f = fixture(t);
    insertInviteAdmission(f);
    const file = await admissionEvidence(f);
    finishAdmissionEvidence(file);
    (blocker.events ? f.events : f.db).exec(blocker.sql);
    await assert.rejects(
      f.command("reconcile-admission", { evidence: file }),
      /not drained/,
    );
    assert.ok(await f.dependencies.readAdmission(VERSION));
    assert.equal(
      f.calls.filter((call) =>
        call.sql.startsWith("DELETE FROM invite_source_write_admissions"),
      ).length,
      0,
    );
  }
});

test("changed admission tuples, control epochs, and dispatch-time session work block the guarded delete", async (t) => {
  for (const sql of [
    "UPDATE invite_source_write_admissions SET kind = 'changed'",
    "UPDATE invite_source_write_admissions SET created_at_ms = 101",
    "UPDATE invite_source_control SET backend = 'd1', epoch = 1",
    "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1",
    "UPDATE automatch_runtime_control SET epoch = 3",
  ]) {
    const f = fixture(t);
    insertInviteAdmission(f);
    const file = await admissionEvidence(f);
    finishAdmissionEvidence(file);
    f.db.exec(sql);
    await assert.rejects(
      f.command("reconcile-admission", { evidence: file }),
      /changed after inspection/,
    );
    assert.ok(await f.dependencies.readAdmission(VERSION));
  }
  for (const sql of [
    "UPDATE invite_source_write_admissions SET kind = 'changed'",
    "UPDATE invite_source_control SET backend = 'd1', epoch = 1",
    "INSERT INTO game_session_mutation_locks VALUES ('lock','owner','operation',1)",
  ]) {
    const f = fixture(t);
    insertInviteAdmission(f);
    const file = await admissionEvidence(f);
    finishAdmissionEvidence(file);
    f.beforeAdmissionDelete(() => f.db.exec(sql));
    await assert.rejects(
      f.command("reconcile-admission", { evidence: file }),
      /not confirmed/,
    );
    assert.ok(await f.dependencies.readAdmission(VERSION));
  }
});

test("a lost admission delete response retries from exact protected pre-delete evidence", async (t) => {
  const f = fixture(t);
  insertInviteAdmission(f);
  const file = await admissionEvidence(f);
  const evidence = finishAdmissionEvidence(file);
  f.loseAdmissionDeleteResponse();
  await assert.rejects(
    f.command("reconcile-admission", { evidence: file }),
    /response lost/,
  );
  assert.equal(await f.dependencies.readAdmission(VERSION), null);
  assert.equal(
    readdirSync(f.directory).filter((name) =>
      name.startsWith("invite-admission-completed-"),
    ).length,
    0,
  );
  evidence.completionEvidence.explanation = "different proof";
  writeFileSync(file, canonicalJson(evidence));
  await assert.rejects(
    f.command("reconcile-admission", { evidence: file }),
    /no matching protected pre-delete evidence/,
  );
  finishAdmissionEvidence(file);
  await f.command("reconcile-admission", { evidence: file });
  assert.equal(f.logs.at(-1)?.alreadyAbsent, true);
  assert.equal(
    readdirSync(f.directory).filter((name) =>
      name.startsWith("invite-admission-completed-"),
    ).length,
    1,
  );
  assert.equal(
    f.calls.filter((call) =>
      call.sql.startsWith("DELETE FROM invite_source_write_admissions"),
    ).length,
    1,
  );
});

test("invite migration requires an exact candidate and protected operator scope", () => {
  assert.deepEqual(parseArgs(["--status"]), {
    operation: "status",
    directory: undefined,
    candidateVersionId: undefined,
    firebaseCredentials: undefined,
  });
  assert.throws(
    () => parseArgs(["--freeze", "--directory", "/private/invites"]),
    /candidate/,
  );
  assert.throws(
    () => parseArgs(["--import", "--directory", "relative"]),
    /absolute/,
  );
  assert.throws(
    () => parseArgs(["--status", "--directory", "/private/invites"]),
    /no options/,
  );
  assert.throws(
    () => parseArgs(["--preflight", "--directory", "/private/invites"]),
    /does not retain/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--import",
        "--directory",
        "/private/invites",
        "--firebase-credentials",
        "/private/creds",
      ]),
    /source-reading/,
  );
  assert.throws(() => sourceRow({ inviteId: "x/y", source: {} }), /key/);
  assert.throws(
    () => sourceRow({ inviteId: "valid", source: { wagers: {} } }),
    /retired/,
  );
  assert.throws(() => sourceRow({ inviteId: "valid", source: [] }), /invalid/);
  assert.deepEqual(sourceRow({ inviteId: "valid", source: {} }), {
    inviteId: "valid",
    source: {},
  });
});

test("complete frozen export/import/verify/activate/resume preserves every invite and prior states", async (t) => {
  const f = fixture(t);
  await f.importSource();
  const manifest = loadExport(f.directory);
  assert.equal(manifest.count, f.source.size);
  assert.equal((await f.dependencies.status()).control.state, "frozen");
  const rows = await f.dependencies.readRows([...f.source.keys()]);
  assert.equal(
    rows.find((row) => row.inviteId === "private")?.source.password,
    "private-password",
  );
  assert.deepEqual(rows.find((row) => row.inviteId === "2")?.source, {
    hostId: "two",
  });
  assert.deepEqual(rows.find((row) => row.inviteId === "empty")?.source, {});
  assert.deepEqual(rows.find((row) => row.inviteId === "10")?.source.unknown, {
    keep: [false, null, 4],
    wagers: "nested-field-is-kept",
  });
  await f.command("verify");
  await f.command("activate");
  await f.command("activate");
  let status = await f.dependencies.status();
  assert.equal(status.control.backend, "d1");
  assert.equal(status.control.epoch, 1);
  assert.equal(status.control.state, "frozen");
  await f.command("resume");
  await f.command("resume");
  status = await f.dependencies.status();
  assert.equal(status.control.state, "active");
  assert.equal(status.automatch.state, "active");
  assert.equal(status.events.state, "active");
  assert.equal(status.automatch.freezeGeneration, 2);
  assert.equal(status.events.freezeGeneration, 3);
  assert.equal(status.control.sourceDigest, manifest.sourceDigest);
  assert.equal(status.control.importDigest, manifest.sourceDigest);
  assert(!canonicalJson(f.logs).includes("private-password"));
  assert(
    !f.calls.some(({ sql }) =>
      /DELETE FROM (event_progress_outboxes|game_session_projection_outbox)|profile_canonical_control|wager_reservation_runtime_control/.test(
        sql,
      ),
    ),
  );
});

test("pre-existing freezes remain frozen when the migration resumes", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = 2;",
  );
  f.events.exec(
    "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = 3;",
  );
  f.db.exec(
    "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1;",
  );
  await f.importSource();
  await f.command("activate");
  await f.command("resume");
  const status = await f.dependencies.status();
  assert.equal(status.control.state, "frozen");
  assert.equal(status.control.freezeGeneration, 1);
  assert.equal(status.automatch.state, "frozen");
  assert.equal(status.automatch.freezeGeneration, 2);
  assert.equal(status.events.state, "frozen");
  assert.equal(status.events.freezeGeneration, 3);
});

test("repair resume preserves candidate receipts and legacy evidence with prior frozen gates", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1; UPDATE automatch_runtime_control SET state = 'frozen', freeze_generation = 2;",
  );
  f.events.exec(
    "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = 3;",
  );
  await f.importSource();
  await f.command("activate");
  await f.command("resume");
  const originalPath = resolve(f.directory, `resumed-${VERSION}.json`);
  const originalReceipt = readFileSync(originalPath, "utf8");
  const legacyPath = resolve(f.directory, "resumed.json");
  writeFileSync(legacyPath, originalReceipt, { mode: 0o600 });
  f.setDeployed(OTHER_VERSION);
  await f.command("resume", { candidateVersionId: OTHER_VERSION });
  await f.command("resume", { candidateVersionId: OTHER_VERSION });
  assert.equal(readFileSync(originalPath, "utf8"), originalReceipt);
  assert.equal(readFileSync(legacyPath, "utf8"), originalReceipt);
  assert.equal(JSON.parse(originalReceipt).candidateVersionId, VERSION);
  assert.equal(
    JSON.parse(
      readFileSync(
        resolve(f.directory, `resumed-${OTHER_VERSION}.json`),
        "utf8",
      ),
    ).candidateVersionId,
    OTHER_VERSION,
  );
  const status = await f.dependencies.status();
  for (const [gate, generation] of [
    [status.control, 1],
    [status.automatch, 2],
    [status.events, 3],
  ] as const) {
    assert.equal(gate.state, "frozen");
    assert.equal(gate.freezeGeneration, generation);
  }
});

test("repair resume adopts the deployed candidate without changing activation evidence", async (t) => {
  const f = fixture(t);
  await f.importSource();
  await f.command("activate");
  const original = (await f.dependencies.status()).control;
  const evidence = ["maintenance.json", "manifest.json"].map((name) =>
    readFileSync(resolve(f.directory, name), "utf8"),
  );
  const rows = await f.dependencies.readRows([...f.source.keys()]);
  f.setDeployed(OTHER_VERSION);
  await assert.rejects(f.command("resume"), /candidate/);
  await f.command("resume", { candidateVersionId: OTHER_VERSION });
  const repaired = await f.dependencies.status();
  const { resumeCandidateVersionId, resumeCandidateAdoptedAtMs, ...metadata } =
    repaired.control.metadata;
  assert.equal(resumeCandidateVersionId, OTHER_VERSION);
  assert.equal(typeof resumeCandidateAdoptedAtMs, "number");
  assert.deepEqual(metadata, original.metadata);
  for (const key of [
    "candidateVersionId",
    "epoch",
    "sourceDigest",
    "importDigest",
    "verifiedAtMs",
    "activatedAtMs",
  ] as const)
    assert.equal(repaired.control[key], original[key]);
  assert.deepEqual(await f.dependencies.readRows([...f.source.keys()]), rows);
  assert.deepEqual(
    ["maintenance.json", "manifest.json"].map((name) =>
      readFileSync(resolve(f.directory, name), "utf8"),
    ),
    evidence,
  );
  assert.equal(repaired.control.state, "active");
  assert.equal(repaired.automatch.state, "active");
  assert.equal(repaired.events.state, "active");
  assert.equal(
    JSON.parse(
      readFileSync(
        resolve(f.directory, `resumed-${OTHER_VERSION}.json`),
        "utf8",
      ),
    ).candidateVersionId,
    OTHER_VERSION,
  );
  f.db.exec(
    "INSERT INTO game_session_mutation_locks VALUES ('new-work', 'owner', 'operation', 999999);",
  );
  await f.command("resume", { candidateVersionId: OTHER_VERSION });
  assert.equal((await f.dependencies.status()).counts.sessionLocks, 1);
});

test("repair adoption requires activated, frozen, drained and verified storage", async (t) => {
  for (const scenario of [
    "unactivated",
    "open-event-gate",
    "pending-work",
    "changed-proof",
    "changed-generation",
    "running-workflow",
  ] as const) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      await f.importSource();
      if (scenario !== "unactivated") await f.command("activate");
      f.setDeployed(OTHER_VERSION);
      if (scenario === "open-event-gate")
        f.events.exec("UPDATE event_runtime_control SET storage_mode = 'd1';");
      if (scenario === "pending-work")
        f.db.exec(
          "INSERT INTO game_session_mutation_locks VALUES ('pending', 'owner', 'operation', 999999);",
        );
      if (scenario === "changed-proof")
        f.db.exec(
          "UPDATE invite_source_control SET metadata_json = json_set(metadata_json, '$.verifiedSourceDigest', 'wrong');",
        );
      if (scenario === "changed-generation")
        f.db.exec(
          "UPDATE invite_source_control SET freeze_generation = freeze_generation + 1;",
        );
      if (scenario === "running-workflow")
        f.setWorkflowPages(
          new Map([
            [
              null,
              {
                rows: [
                  {
                    id: "pending",
                    status: "running",
                    versionId: OTHER_VERSION,
                  },
                ],
                cursor: null,
              },
            ],
          ]),
        );
      const before = await f.dependencies.status();
      await assert.rejects(
        f.command("resume", { candidateVersionId: OTHER_VERSION }),
      );
      assert.deepEqual(await f.dependencies.status(), before);
    });
  }
});

test("repair resume recovers lost adoption and partial gate-restoration responses", async (t) => {
  const f = fixture(t);
  await f.importSource();
  await f.command("activate");
  f.setDeployed(OTHER_VERSION);
  const adopt = f.dependencies.adoptResumeCandidate.bind(f.dependencies);
  f.dependencies.adoptResumeCandidate = async (...args) => {
    await adopt(...args);
    throw new Error("adoption response lost");
  };
  await assert.rejects(
    f.command("resume", { candidateVersionId: OTHER_VERSION }),
    /response lost/,
  );
  assert.equal((await f.dependencies.status()).control.state, "frozen");
  assert.equal(
    (await f.dependencies.status()).control.metadata.resumeCandidateVersionId,
    OTHER_VERSION,
  );
  f.dependencies.adoptResumeCandidate = adopt;
  const setGate = f.dependencies.setGate.bind(f.dependencies);
  f.dependencies.setGate = async (...args) => {
    await setGate(...args);
    if (args[0] === "automatch") throw new Error("gate response lost");
  };
  await assert.rejects(
    f.command("resume", { candidateVersionId: OTHER_VERSION }),
    /response lost/,
  );
  const partial = await f.dependencies.status();
  assert.equal(partial.control.state, "active");
  assert.equal(partial.automatch.state, "active");
  assert.equal(partial.events.state, "frozen");
  f.dependencies.setGate = setGate;
  await f.command("resume", { candidateVersionId: OTHER_VERSION });
  assert.equal((await f.dependencies.status()).events.state, "active");
});

test("partial resume checks only pending event work while preserving gate ownership", async (t) => {
  for (const scenario of [
    "new-invite-work",
    "pending-event-work",
    "changed-event-generation",
    "running-workflow",
  ] as const) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      await f.importSource();
      await f.command("activate");
      f.setDeployed(OTHER_VERSION);
      const setGate = f.dependencies.setGate.bind(f.dependencies);
      f.dependencies.setGate = async (...args) => {
        await setGate(...args);
        if (args[0] === "automatch") throw new Error("gate response lost");
      };
      await assert.rejects(
        f.command("resume", { candidateVersionId: OTHER_VERSION }),
        /response lost/,
      );
      f.dependencies.setGate = setGate;
      const partial = await f.dependencies.status();
      assert.equal(partial.control.state, "active");
      assert.equal(partial.automatch.state, "active");
      assert.equal(partial.events.state, "frozen");
      f.db.exec(
        "INSERT INTO invite_source_write_admissions VALUES ('new-invite', 'd1', 1, 1, 'patch', 100000); INSERT INTO game_session_mutation_locks VALUES ('new-invite', 'owner', 'new-operation', 999999);",
      );
      if (scenario === "pending-event-work")
        f.events.exec(
          "INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json) VALUES ('event', 'active', 1, 1, '{}'); INSERT INTO event_transition_intents (transition_id, event_id, expected_revision, status, intent_json, created_at_ms, updated_at_ms) VALUES ('pending', 'event', 1, 'pending', '{}', 1, 1);",
        );
      if (scenario === "changed-event-generation")
        f.events.exec(
          "UPDATE event_runtime_control SET storage_mode = 'd1'; UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1;",
        );
      if (scenario === "running-workflow")
        f.setWorkflowPages(
          new Map([
            [
              null,
              {
                rows: [
                  {
                    id: "new-work",
                    status: "running",
                    versionId: OTHER_VERSION,
                  },
                ],
                cursor: null,
              },
            ],
          ]),
        );
      const before = await f.dependencies.status();
      if (scenario === "new-invite-work") {
        await f.command("resume", { candidateVersionId: OTHER_VERSION });
        const restored = await f.dependencies.status();
        assert.equal(restored.events.state, "active");
        assert.deepEqual(restored.counts, before.counts);
        assert.equal(restored.counts.inviteAdmissions, 1);
        assert.equal(restored.counts.sessionLocks, 1);
      } else {
        await assert.rejects(
          f.command("resume", { candidateVersionId: OTHER_VERSION }),
          scenario === "pending-event-work"
            ? /not drained/
            : scenario === "running-workflow"
              ? /nonterminal/
              : /gate changed/,
        );
        assert.deepEqual(await f.dependencies.status(), before);
      }
    });
  }
});

test("resume audits no Workflows when the event gate remains in its prior freeze", async (t) => {
  const f = fixture(t);
  f.events.exec(
    "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = 3;",
  );
  await f.importSource();
  await f.command("activate");
  f.dependencies.workflowPage = async () => {
    throw new Error("unexpected Workflow audit");
  };
  await f.command("resume");
  const status = await f.dependencies.status();
  assert.equal(status.control.state, "active");
  assert.equal(status.automatch.state, "active");
  assert.equal(status.events.state, "frozen");
  assert.equal(status.events.freezeGeneration, 3);
});

test("confirmed restored gates make resume idempotent after normal traffic starts", async (t) => {
  const f = fixture(t);
  await f.importSource();
  await f.command("activate");
  await f.command("resume");
  f.db.exec(
    "INSERT INTO game_session_mutation_locks VALUES ('new-invite', 'owner', 'new-operation', 999999);",
  );
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [
            { id: "new-work", status: "running", versionId: OTHER_VERSION },
          ],
          cursor: null,
        },
      ],
    ]),
  );
  await f.command("resume");
  assert.equal((await f.dependencies.status()).counts.sessionLocks, 1);
});

test("candidate and Workflow failures occur before writer gates change", async (t) => {
  const f = fixture(t);
  f.setDeployed(OTHER_VERSION);
  await assert.rejects(f.command("freeze"), /candidate/);
  assert.equal((await f.dependencies.status()).control.state, "active");
  f.setDeployed(VERSION);
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "running-old", status: "running", versionId: VERSION }],
          cursor: null,
        },
      ],
    ]),
  );
  await assert.rejects(f.command("freeze"), /nonterminal/);
  assert.equal((await f.dependencies.status()).events.state, "active");
});

test("read-only preflight uses four concurrent readers and reports bounded progress", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 40; index++)
    f.source.set(`preflight-${index}`, { hostId: `host-${index}` });
  const read = f.dependencies.readInvite;
  let active = 0;
  let peak = 0;
  f.dependencies.readInvite = async (inviteId) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await read(inviteId);
    } finally {
      active--;
    }
  };
  await f.command("preflight");
  assert.equal(peak, 4);
  assert.equal(
    f.logs.filter((value) => value.operation === "preflight-progress").length,
    3,
  );
  assert.equal(f.logs.at(-1)?.count, 45);
  assert(f.calls.every(({ sql }) => sql.startsWith("SELECT ")));
});

test("Workflow audit traverses every page and rejects a later nonterminal instance", async (t) => {
  const f = fixture(t);
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "first", status: "complete", versionId: VERSION }],
          cursor: "next",
        },
      ],
      [
        "next",
        {
          rows: [{ id: "later", status: "waiting", versionId: OTHER_VERSION }],
          cursor: null,
        },
      ],
    ]),
  );
  await assert.rejects(auditWorkflows(f.dependencies), /nonterminal/);
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "first", status: "complete", versionId: VERSION }],
          cursor: "next",
        },
      ],
      [
        "next",
        {
          rows: [
            { id: "later", status: "terminated", versionId: OTHER_VERSION },
          ],
          cursor: null,
        },
      ],
    ]),
  );
  assert.equal((await auditWorkflows(f.dependencies)).pages, 2);
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "first", status: "complete", versionId: VERSION }],
          cursor: "next",
        },
      ],
      ["next", { rows: [], cursor: "next" }],
    ]),
  );
  await assert.rejects(auditWorkflows(f.dependencies), /pagination/);
});

test("incompatible Workflows created after import block activation", async (t) => {
  const f = fixture(t);
  await f.importSource();
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "late", status: "queued", versionId: OTHER_VERSION }],
          cursor: null,
        },
      ],
    ]),
  );
  await assert.rejects(f.command("activate"), /nonterminal/);
  assert.equal((await f.dependencies.status()).control.backend, "rtdb");
});

test("expired admissions and leases are not treated as completed work", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO game_session_mutation_locks VALUES ('invite', 'owner', 'operation', 1);",
  );
  await assert.rejects(f.command("freeze"), /not drained/);
  let status = await f.dependencies.status();
  assert.equal(status.control.state, "active");
  assert.equal(status.automatch.state, "active");
  assert.equal(status.events.state, "frozen");
  assert.equal(status.counts.sessionLocks, 1);
  f.db.exec("DELETE FROM game_session_mutation_locks;");
  f.db.exec(
    "INSERT INTO invite_source_write_admissions VALUES ('stale', 'rtdb', 0, 0, 'patch', 1);",
  );
  await assert.rejects(f.command("freeze"), /not drained/);
  status = await f.dependencies.status();
  assert.equal(status.counts.inviteAdmissions, 1);
  assert(
    !f.calls.some(({ sql }) =>
      sql.startsWith("DELETE FROM invite_source_write_admissions"),
    ),
  );
});

test("a partial pre-import freeze can abort without abandoning unfinished source work", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO game_session_mutation_locks VALUES ('invite', 'owner', 'operation', 1);",
  );
  await assert.rejects(f.command("freeze"), /not drained/);
  f.setWorkflowPages(
    new Map([
      [
        null,
        {
          rows: [{ id: "new", status: "running", versionId: OTHER_VERSION }],
          cursor: null,
        },
      ],
    ]),
  );
  await f.command("abort");
  await f.command("abort");
  const status = await f.dependencies.status();
  assert.equal(status.control.state, "active");
  assert.equal(status.events.state, "active");
  assert.equal(status.automatch.state, "active");
  assert.equal(status.counts.sessionLocks, 1);
  assert.equal(status.control.metadata.abortComplete, true);
});

test("atomic freeze refuses an event intent or session admission arriving after status", async (t) => {
  for (const gate of ["events", "automatch"] as const) {
    const f = fixture(t);
    const original = f.dependencies.setGate.bind(f.dependencies);
    f.dependencies.setGate = async (target, expected, state, maintenance) => {
      if (target === gate && state === "frozen") {
        if (gate === "events") {
          f.events.exec(
            "INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json) VALUES ('event', 'active', 1, 1, '{}'); INSERT INTO event_transition_intents (transition_id, event_id, expected_revision, status, intent_json, created_at_ms, updated_at_ms) VALUES ('uncertain', 'event', 1, 'dead', '{}', 1, 1);",
          );
        } else {
          f.db.exec(
            "INSERT INTO automatch_write_admissions VALUES ('late', 2, 1, 'd1', 'session', 1);",
          );
        }
      }
      return original(target, expected, state, maintenance);
    };
    await assert.rejects(f.command("freeze"), /not confirmed/);
    const status = await f.dependencies.status();
    assert.equal(status.control.state, "active");
    assert.equal(status[gate].state, "active");
    await f.command("abort");
    assert.equal((await f.dependencies.status()).events.state, "active");
  }
});

test("pending session resources and event intents block frozen export", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  f.db.exec(
    "INSERT INTO game_session_transitions VALUES ('transition', 'invite', '{}', 'pending', 1, 1, 0, NULL); INSERT INTO game_session_transition_resources VALUES ('invite', 'transition');",
  );
  await assert.rejects(f.command("export"), /not drained/);
  f.db.exec(
    "DELETE FROM game_session_transition_resources; DELETE FROM game_session_transitions;",
  );
  f.events.exec(
    "INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json) VALUES ('event', 'active', 1, 1, '{}'); INSERT INTO event_transition_intents (transition_id, event_id, expected_revision, status, intent_json, created_at_ms, updated_at_ms) VALUES ('pending', 'event', 1, 'pending', '{}', 1, 1);",
  );
  await assert.rejects(f.command("export"), /not drained/);
});

test("interrupted export and import resume with the same immutable pages", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 40; index++)
    f.source.set(`extra-${index}`, { hostId: `host-${index}` });
  await f.command("freeze");
  f.setFailReadAt(22);
  await assert.rejects(f.command("export"), /interrupted/);
  const firstPage = readFileSync(resolve(f.directory, "source-0.json"), "utf8");
  f.setFailReadAt(0);
  await f.command("export");
  assert.equal(
    readFileSync(resolve(f.directory, "source-0.json"), "utf8"),
    firstPage,
  );
  f.setFailImportAt(3);
  await assert.rejects(f.command("import"), /interrupted/);
  assert.equal(await f.dependencies.countRows(), 40);
  f.setFailImportAt(0);
  await f.command("import");
  await f.command("activate");
  assert.equal(await f.dependencies.countRows(), f.source.size);
});

test("truncated inventory cannot create complete export evidence", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  f.setSourceKeyFailure(true);
  await assert.rejects(f.command("export"), /truncated/);
  assert(!readdirSync(f.directory).includes("manifest.json"));
  assert(
    !readdirSync(f.directory).some(
      (name) => name.startsWith("keys-") && name.endsWith("-complete.json"),
    ),
  );
  f.setSourceKeyFailure(false);
  await f.command("export");
  assert.equal(loadExport(f.directory).count, f.source.size);
});

test("source metadata changes, new invites, and missing invites block activation", async (t) => {
  for (const change of ["metadata", "add", "delete"] as const) {
    const f = fixture(t);
    await f.importSource();
    if (change === "metadata") f.source.set("empty", { hostId: "changed" });
    if (change === "add") f.source.set("new", {});
    if (change === "delete") f.source.delete("empty");
    await assert.rejects(f.command("activate"), /changed after export/);
    assert.equal((await f.dependencies.status()).control.backend, "rtdb");
  }
});

test("retired child changes do not replace their canonical stores or invalidate metadata proof", async (t) => {
  const f = fixture(t);
  await f.importSource();
  f.source.set("2", {
    hostId: "two",
    wagers: { entirely: "different" },
    reactions: null,
  });
  await f.command("activate");
  assert.deepEqual((await f.dependencies.readRows(["2"]))[0].source, {
    hostId: "two",
  });
});

test("destination corruption and unexpected rows fail equality verification", async (t) => {
  for (const change of ["metadata", "revision", "extra"] as const) {
    const f = fixture(t);
    await f.importSource();
    if (change === "metadata")
      f.db.exec(
        "UPDATE invite_sources SET source_json = '{}' WHERE invite_id = 'private';",
      );
    if (change === "revision")
      f.db.exec(
        "UPDATE invite_sources SET revision = 2 WHERE invite_id = 'empty';",
      );
    if (change === "extra")
      f.db.exec(
        "INSERT INTO invite_sources VALUES ('unexpected', '{}', 1, 1);",
      );
    await assert.rejects(f.command("activate"), /destination/);
    assert.equal((await f.dependencies.status()).control.backend, "rtdb");
  }
});

test("changed frozen generation invalidates export and cannot resume another operator's state", async (t) => {
  const f = fixture(t);
  await f.importSource();
  f.db.exec(
    "UPDATE invite_source_control SET freeze_generation = freeze_generation + 1;",
  );
  await assert.rejects(f.command("activate"), /same frozen generation/);
  await assert.rejects(f.command("abort"), /same frozen generation/);
});

test("private artifact permissions and modified page proofs are checked", async (t) => {
  const f = fixture(t);
  await f.command("freeze");
  await f.command("export");
  const page = resolve(f.directory, "source-0.json");
  chmodSync(page, 0o644);
  assert.throws(() => loadExport(f.directory), /private/);
  chmodSync(page, 0o600);
  const value = JSON.parse(readFileSync(page, "utf8")) as {
    rows: Array<{ source: Record<string, unknown> }>;
  };
  value.rows[0].source.altered = true;
  writeFileSync(page, JSON.stringify(value));
  assert.throws(() => loadExport(f.directory), /proof mismatch/);
});

test("abort resets only unactivated imported metadata and restores owned gates", async (t) => {
  const f = fixture(t);
  await f.importSource();
  await f.command("abort");
  assert.equal(await f.dependencies.countRows(), 0);
  const status = await f.dependencies.status();
  assert.equal(status.control.backend, "rtdb");
  assert.equal(status.control.state, "active");
  assert.equal(status.control.sourceDigest, null);
  assert.equal(status.events.state, "active");
  const retryDirectory = mkdtempSync(resolve(tmpdir(), "mons-invite-retry-"));
  t.after(() => rmSync(retryDirectory, { recursive: true, force: true }));
  await f.command("freeze", { directory: retryDirectory });
  assert.equal((await f.dependencies.status()).control.state, "frozen");
});

test("activated source cannot be reimported, exported, or aborted", async (t) => {
  const f = fixture(t);
  await f.importSource();
  await f.command("activate");
  await assert.rejects(f.command("export"), /retired/);
  await assert.rejects(f.command("import"), /cannot be reimported/);
  await assert.rejects(f.command("abort"), /cannot be rolled back/);
  await assert.rejects(f.command("preflight"), /retired/);
});

test("production Workflow pages use opaque cursor continuation and validate completion proof", async () => {
  const requests: string[] = [];
  const dependencies = createProductionDependencies(undefined, {
    apiToken: "test-token-never-logged",
    fetcher: async (input) => {
      const url = new URL(String(input));
      requests.push(url.search);
      return Response.json({
        success: true,
        result: [{ id: "done", status: "complete", version_id: OTHER_VERSION }],
        result_info: { count: 1, per_page: 100, cursor: "opaque-next" },
      });
    },
  });
  assert.equal((await dependencies.workflowPage(null)).cursor, "opaque-next");
  await dependencies.workflowPage("opaque-next");
  assert(requests[1].includes("cursor=opaque-next"));
  assert(!new URLSearchParams(requests[1]).has("page"));
});
