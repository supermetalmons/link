import { activateStrictLocalSchemaFixture } from "./test-fixtures/strict-local-schema.ts";
import { canonicalEvent as eventDocumentFixture } from "../test/fixtures/canonicalData.mjs";
import { inviteDocumentFixture } from "../cloud/workers/api/test/inviteDocumentFixture.ts";
import { applicationWriteFenceSql } from "../cloud/runtime/application-fence.js";
import assert from "node:assert/strict";
import {
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
  createSqlDependencies,
  manageInviteSource,
  parseArgs,
  sourceRow,
  execute,
  type Arguments,
} from "./manage-invite-source.ts";
import { canonicalJson, digest, type SqlRunner } from "./operator/runtime.ts";
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
  const dataEpoch = 1;
  const directory = mkdtempSync(resolve(tmpdir(), "invite-operator-test-"));
  const db = new DatabaseSync(":memory:"),
    events = new DatabaseSync(":memory:");
  for (const file of readdirSync(resolve("cloud/workers/api/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file.endsWith("_retire_canonical_source_tables.sql"))
      db.exec(
        "UPDATE application_data_control SET generation = 3, data_epoch = 1",
      );
    if (file === "0039_retire_canonical_timer_starts.sql")
      activateStrictLocalSchemaFixture(db);
    db.exec(
      readFileSync(resolve("cloud/workers/api/migrations", file), "utf8"),
    );
  }
  db.exec(`UPDATE application_data_control SET data_epoch = ${dataEpoch}`);
  db.exec(
    "UPDATE automatch_runtime_control SET backend='d1',epoch=2,freeze_generation=1;UPDATE invite_source_control SET backend='d1',epoch=1;",
  );
  for (const file of ["0001_event_store.sql", "0002_event_store_safety.sql"])
    events.exec(
      readFileSync(resolve("cloud/workers/api/event-migrations", file), "utf8"),
    );
  events.exec(
    `UPDATE event_runtime_control SET storage_mode='frozen',previous_storage_mode='firebase',freeze_generation=1;UPDATE event_runtime_control SET source_digest='${"a".repeat(64)}',source_event_count=0,source_selection_count=0,source_assignment_count=0,source_exported_at_ms=1,cutover_at_ms=2,verified_import_generation=1;UPDATE event_runtime_control SET storage_mode='d1',previous_storage_mode=NULL;UPDATE event_runtime_control SET storage_mode='frozen',previous_storage_mode='d1',freeze_generation=2,verified_import_generation=NULL;`,
  );
  events.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/event-migrations/0003_finalize_event_storage.sql",
      ),
      "utf8",
    ),
  );
  events.exec("UPDATE event_runtime_control SET storage_mode='d1'");
  for (const file of readdirSync(resolve("cloud/workers/api/event-migrations"))
    .filter(
      (name) =>
        name.endsWith(".sql") && name > "0003_finalize_event_storage.sql",
    )
    .sort()) {
    if (file.endsWith("_retire_canonical_source_tables.sql"))
      events.exec(
        "UPDATE application_data_control SET generation = 3, data_epoch = 1",
      );
    events.exec(
      readFileSync(resolve("cloud/workers/api/event-migrations", file), "utf8"),
    );
  }
  events.exec(`UPDATE application_data_control SET data_epoch = ${dataEpoch}`);
  let loseAdmissionDeleteResponse = false;
  let beforeAdmissionDelete: (() => void) | undefined;
  const calls: Array<{ sql: string; database: string }> = [],
    logs: Record<string, unknown>[] = [];
  const run: SqlRunner = async (
    sql,
    database = "mons-link-profile-games",
    bindings = [],
  ) => {
    calls.push({ sql, database });
    const deleting = sql.startsWith(
      "DELETE FROM invite_source_write_admissions",
    );
    if (deleting) beforeAdmissionDelete?.();
    const rows = (database === "mons-link-events" ? events : db)
      .prepare(sql)
      .all(...bindings) as Record<string, unknown>[];
    if (deleting && loseAdmissionDeleteResponse) {
      loseAdmissionDeleteResponse = false;
      throw new Error("admission delete response lost");
    }
    return rows;
  };
  const dependencies = createSqlDependencies(run, () => 100000, dataEpoch);
  dependencies.log = (value) => logs.push(value);
  const command = (
    operation: Arguments["operation"],
    extra: Partial<Arguments> = {},
  ) =>
    manageInviteSource(
      {
        operation,
        dataEpoch,
        ...(operation === "inspect-admission" ? { directory } : {}),
        ...extra,
      },
      dependencies,
    );
  t.after(() => {
    db.close();
    events.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    events,
    directory,
    calls,
    logs,
    dependencies,
    command,
    beforeAdmissionDelete: (callback: () => void) => {
      beforeAdmissionDelete = callback;
    },
    loseAdmissionDeleteResponse: () => {
      loseAdmissionDeleteResponse = true;
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

test("named orphan admission recovery works with active and frozen D1 gates with no intents or automatic freeze", async (t) => {
  for (const [backend, partiallyFrozen] of [
    ["d1", false],

    ["d1", true],
  ]) {
    const f = fixture(t);
    if (backend === "d1")
      f.db.exec("UPDATE invite_source_control SET backend = 'd1', epoch = 2");
    insertInviteAdmission(f);
    if (partiallyFrozen)
      f.db.exec(
        "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1",
      );
    await f.command("status");
    assert.equal(
      (f.logs.at(-1)?.admissions as Array<{ admissionId: string }>)[0]!
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

test("admission source proof verifies current canonical metadata in D1 without logging payloads", async (t) => {
  for (const backend of ["d1"]) {
    const f = fixture(t);
    const source = inviteDocumentFixture({
      hostId: "host",
      password: "secret-source-payload",
    });
    if (backend === "d1") {
      f.db.exec("UPDATE invite_source_control SET backend = 'd1', epoch = 2");
      f.db
        .prepare(
          "INSERT INTO invite_sources_canonical VALUES ('private', ?, 1, 100)",
        )
        .run(canonicalJson(source));
    }
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
    "INSERT INTO automatch_write_admissions (admission_id, epoch, freeze_generation, backend, kind, created_at_ms) VALUES ('session', 2, 1, 'd1', 'patch', 100)",
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
  const sessionIntent = {
    version: 3,
    inviteId: "private",
    inviteSourceEpoch: 1,
    inviteMutations: [
      {
        current: { inviteId: "private", revision: 0, value: null },
        value: inviteDocumentFixture({ hostId: "host" }),
      },
    ],
    transitionId: "intent",
    operationDigest: "a".repeat(64),
    resources: ["private"],
    mutations: [],
    creations: [],
    createdAtMs: 100,
  };
  const seedSession = (
    f: ReturnType<typeof fixture>,
    status: "pending" | "completed",
  ) => {
    f.db
      .prepare(
        "INSERT INTO game_session_transitions_canonical (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('intent','private',?,?,100,100)",
      )
      .run(JSON.stringify(sessionIntent), status);
  };
  const blockers: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => seedSession(f, "pending"),
    (f) => {
      seedSession(f, "completed");
      f.db.exec(
        "INSERT INTO game_session_transition_resources_canonical VALUES ('resource','intent')",
      );
    },
    (f) => {
      f.db.exec(
        "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms) VALUES ('lock','owner','operation',1)",
      );
    },
    (f) => {
      f.events.exec(
        "INSERT INTO event_leases VALUES ('event','lease','owner',100,100,101)",
      );
    },
    (f) => {
      const event = eventDocumentFixture({
        eventId: "event",
        status: "scheduled",
        startAtMs: 100,
        updatedAtMs: 100,
      });
      f.events
        .prepare(
          "INSERT INTO event_records_canonical (event_id,status,start_at_ms,updated_at_ms,record_json,revision) VALUES ('event','scheduled',100,100,?,1)",
        )
        .run(JSON.stringify(event));
      const intent = {
        schemaVersion: 3,
        transitionId: "intent",
        eventId: "event",
        expectedRevision: 1,
        canonicalUpdates: [],
        effects: [],
        inviteMutations: [],
        sourceEpoch: 1,
        payloadDigest: "a".repeat(64),
        operationDigest: "b".repeat(64),
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      f.events
        .prepare(
          "INSERT INTO event_transition_intents_canonical (transition_id,event_id,expected_revision,status,intent_json,created_at_ms,updated_at_ms) VALUES ('intent','event',1,'dead',?,100,100)",
        )
        .run(JSON.stringify(intent));
    },
  ];
  for (const block of blockers) {
    const f = fixture(t);
    insertInviteAdmission(f);
    const file = await admissionEvidence(f);
    finishAdmissionEvidence(file);
    block(f);
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
    "UPDATE invite_source_control SET backend = 'd1', epoch = 2",
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
    "UPDATE invite_source_control SET backend = 'd1', epoch = 2",
    "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms) VALUES ('lock','owner','operation',1)",
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
test("invite status refuses retired authority and admission evidence without reading Firebase", async (t) => {
  const f = fixture(t);
  insertInviteAdmission(f);
  f.db.exec("UPDATE invite_source_write_admissions SET backend='rtdb'");
  await assert.rejects(f.command("status"), /invalid exact/);
  f.db.exec("DELETE FROM invite_source_write_admissions");
  const fake = createSqlDependencies(async (sql, database, bindings = []) => {
    const rows = (database === "mons-link-events" ? f.events : f.db)
      .prepare(sql)
      .all(...bindings) as Record<string, unknown>[];
    return sql.includes("FROM invite_source_control")
      ? rows.map((row) => ({ ...row, backend: "rtdb", epoch: 0 }))
      : rows;
  });
  await assert.rejects(fake.status(), /invalid invite-source/);
  assert.ok(f.calls.every((call) => call.sql.startsWith("SELECT")));
});

test("operator reads only canonical metadata and rejects retired epochs", async (t) => {
  const f = fixture(t);
  const canonical = inviteDocumentFixture({ hostId: "canonical-host" });
  f.db
    .prepare(
      "INSERT INTO invite_sources_canonical VALUES ('current', ?, 1, 100)",
    )
    .run(JSON.stringify(canonical));
  const rows = await f.dependencies.readRows(["current"]);
  assert.equal(rows[0]!.source.hostId, "canonical-host");
  assert.equal(rows[0]!.sourceDigest, digest(canonical));
  assert.equal(
    f.db
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'invite_sources'")
      .get(),
    undefined,
  );
  assert.ok(
    f.calls.some(({ sql }) =>
      sql.includes("FROM invite_sources_canonical WHERE invite_id"),
    ),
  );
  assert.deepEqual(parseArgs(["--status", "--data-epoch", "1"]), {
    operation: "status",
    dataEpoch: 1,
  });
  for (const argv of [
    ["--status", "--data-epoch", "0"],
    ["--status", "--data-epoch", "2"],
    ["--data-epoch", "0", "--status"],
    ["--status", "--data-epoch", "0", "--data-epoch", "1"],
  ])
    assert.throws(() => parseArgs(argv));
});

test("operator rejects retired source records instead of converting them", () => {
  assert.throws(
    () =>
      sourceRow({
        inviteId: "retired",
        source: {
          version: 2,
          hostId: "host",
          hostColor: "white",
          unaccounted: true,
        },
      }),
    /invalid canonical invite metadata/,
  );
});

test("named admission reconciliation refuses epoch and generation changes", async (t) => {
  for (const changed of ["epoch", "generation"] as const) {
    const f = fixture(t);
    insertInviteAdmission(f);
    const evidence = await admissionEvidence(f);
    finishAdmissionEvidence(evidence);
    if (changed === "epoch")
      f.db.exec("UPDATE application_data_control SET data_epoch = 0");
    else
      f.beforeAdmissionDelete(() =>
        f.db.exec(
          "UPDATE application_data_control SET generation = generation + 1",
        ),
      );
    await assert.rejects(
      f.command("reconcile-admission", { evidence }),
      /generation mismatch|not confirmed/,
    );
    assert.ok(await f.dependencies.readAdmission(VERSION));
  }
});

test("named recovery cannot bypass installed application write fences", async (t) => {
  const f = fixture(t);
  insertInviteAdmission(f);
  const evidence = await admissionEvidence(f);
  finishAdmissionEvidence(evidence);
  f.db.exec(applicationWriteFenceSql("invite_source_write_admissions"));
  await assert.rejects(
    f.command("reconcile-admission", { evidence }),
    /application-write-fenced/,
  );
  assert.ok(await f.dependencies.readAdmission(VERSION));
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM application_write_context")
      .get()?.count,
    0,
  );
  assert.equal(
    f.calls.some(({ sql }) =>
      /INSERT INTO application_write_context|DROP TRIGGER|UPDATE application_data_control/.test(
        sql,
      ),
    ),
    false,
  );
});
