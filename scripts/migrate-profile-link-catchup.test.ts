import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { digest, QUEUE_NAMES } from "./migrate-wager-reservations.ts";
import {
  assertSource,
  buildImportBatches,
  firebaseDatabaseGetArgs,
  migrateProfileLinkCatchup,
  normalizeJobs,
  parseArgs,
  parseImport,
  parseProof,
  persistArtifacts,
  readRemoteJobs,
  rebuildJobs,
  SQL_BATCH_BYTES,
  type Dependencies,
  type Import,
  type Inspection,
  type Job,
  type Options,
  type Owners,
} from "./migrate-profile-link-catchup.ts";

const FIRST = 1_000_000;
const FINAL = 2_000_000;
const evidence = {
  bridgeVersionId: "source-version",
  bridgeDeployedAtMs: 1_000,
  queuesPausedAtMs: Object.fromEntries(
    QUEUE_NAMES.map((queue) => [queue, 10_000]),
  ),
  legacyWritersDrained: true,
  recordedAtMs: 20_000,
};

function pending(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId: "original-request",
    profileId: "current-owner",
    cleanupProfileIds: { "old-owner": true },
    matchCursor: "match-47",
    sourceUpdatedAtMs: 100,
    lastQueuedAtMs: 120,
    ...overrides,
  };
}

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE profile_canonical_control (singleton INTEGER PRIMARY KEY, state TEXT); INSERT INTO profile_canonical_control VALUES(1, 'frozen'); CREATE TABLE unrelated_sentinel(value TEXT); INSERT INTO unrelated_sentinel VALUES('retained');",
  );
  db.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/profile-migrations/0012_profile_link_catchup.sql",
      ),
      "utf8",
    ),
  );
  const source: Record<string, unknown> = {
    "login-a": pending(),
    "login-b": pending({ profileId: "retired-owner" }),
    "login-c": {
      profileId: "retired-other",
      cleanupProfileIds: { "salvaged-owner": true, "bad-owner": false },
      matchCursor: "broken/cursor",
    },
  };
  const owners: Owners = {
    "login-a": "current-owner",
    "login-b": "current-owner",
    "login-c": "current-owner",
  };
  const inspection: Inspection = {
    canonicalState: "frozen",
    activeProjectionLeases: 0,
    deployment: {
      versionId: evidence.bridgeVersionId,
      deployedAtMs: evidence.bridgeDeployedAtMs,
    },
  };
  const files = new Map<string, unknown>([["evidence", evidence]]);
  const logs: string[] = [];
  const statements: string[] = [];
  let now = FIRST;
  let sourceReads = 0;
  const dependencies: Dependencies = {
    now: () => now,
    log: (message) => logs.push(message),
    readJson: (path) => structuredClone(files.get(path)),
    readSource: () => {
      sourceReads++;
      return structuredClone(source);
    },
    readOwners: () => structuredClone(owners),
    inspect: () => structuredClone(inspection),
    readProof: () =>
      parseProof(db.prepare("SELECT * FROM profile_link_catchup_import").get()),
    readJobs: () =>
      normalizeJobs(
        db
          .prepare("SELECT * FROM profile_link_catchup_jobs ORDER BY login_uid")
          .all()
          .map((row) => ({
            loginUid: row.login_uid,
            requestId: row.request_id,
            profileId: row.profile_id,
            cleanupProfileIds: JSON.parse(String(row.cleanup_profile_ids_json)),
            matchCursor: row.match_cursor,
            sourceUpdatedAtMs: row.source_updated_at_ms,
            lastQueuedAtMs: row.last_queued_at_ms,
            revision: row.revision,
          })),
      ),
    executeSql: (sql) => {
      statements.push(sql);
      db.exec(sql);
    },
    persistArtifacts: (output) => {
      for (const [name, contents] of Object.entries(output))
        if (name.endsWith(".json")) files.set(name, JSON.parse(contents));
      return "/private/artifacts";
    },
  };
  const run = (phase: Options["phase"], extra: Partial<Options> = {}) =>
    migrateProfileLinkCatchup(
      {
        phase,
        project: "mons-link",
        ...(phase === "observe" || phase === "final"
          ? { evidenceFile: "evidence" }
          : {}),
        ...(phase === "final" ? { observationFile: "observation.json" } : {}),
        ...(phase === "verify" || phase === "record-activation"
          ? { importFile: "import.json" }
          : {}),
        ...extra,
      },
      dependencies,
      {},
    );
  const observe = () => {
    run("observe");
    now = FINAL;
  };
  return {
    db,
    source,
    owners,
    inspection,
    files,
    logs,
    statements,
    dependencies,
    run,
    observe,
    setNow: (value: number) => {
      now = value;
    },
    sourceReads: () => sourceReads,
  };
}

test("rebuild uses canonical owners, preserves current cursors, and salvages stale cleanup", () => {
  const source = {
    "login-a": pending(),
    "login-b": pending({ profileId: "wrong-owner" }),
    "login-c": {
      profileId: "older-owner",
      cleanupProfileIds: { "salvage-owner": true, "ignored-owner": false },
    },
  };
  const result = rebuildJobs(
    source,
    {
      "login-a": "current-owner",
      "login-b": "current-owner",
      "login-c": "current-owner",
    },
    FIRST,
  );
  assert.equal(result.rebuilt, 2);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.jobs[0].requestId, "original-request");
  assert.equal(result.jobs[0].matchCursor, "match-47");
  assert.equal(result.jobs[0].sourceUpdatedAtMs, 100);
  assert.deepEqual(result.jobs[1].cleanupProfileIds, [
    "old-owner",
    "wrong-owner",
  ]);
  assert.deepEqual(result.jobs[2].cleanupProfileIds, [
    "older-owner",
    "salvage-owner",
  ]);
  assert.equal(result.jobs[1].matchCursor, null);
  assert.equal(result.jobs[1].sourceUpdatedAtMs, FIRST);
  assert.deepEqual(
    result.jobs,
    rebuildJobs(
      source,
      {
        "login-a": "current-owner",
        "login-b": "current-owner",
        "login-c": "current-owner",
      },
      FIRST,
    ).jobs,
  );
});

test("missing canonical ownership and unsafe login IDs are retained as unresolved", () => {
  const result = rebuildJobs(
    {
      unknown: pending(),
      "invalid/uid": pending(),
      ["x".repeat(129)]: pending(),
    },
    {},
    FIRST,
  );
  assert.equal(result.jobs.length, 0);
  assert.equal(result.unresolved.length, 3);
});

test("preview exports protected diagnostics without writes, including unresolved records", () => {
  const h = harness();
  h.source.orphan = pending();
  h.run("preview");
  assert.equal(h.statements.length, 0);
  assert.deepEqual(h.files.get("unresolved.json"), ["orphan"]);
  assert.equal(JSON.parse(h.logs[0]).unresolved, 1);
  assert.doesNotMatch(
    h.logs.join(""),
    /login-a|current-owner|match-47|original-request/,
  );
});

test("final imports exactly the job table and proves source/readback before activation", () => {
  const h = harness();
  h.observe();
  h.run("final");
  assert.equal(h.dependencies.readProof().verifiedAtMs, FINAL);
  assert.equal(h.dependencies.readProof().importAttemptId, null);
  assert.equal(h.dependencies.readJobs().length, 3);
  assert.equal(h.sourceReads(), 3);
  assert.equal(
    h.db.prepare("SELECT value FROM unrelated_sentinel").get()?.value,
    "retained",
  );
  assert.deepEqual(h.source["login-a"], pending());
  h.run("verify");
  h.inspection.deployment = { versionId: "d1-version", deployedAtMs: FINAL };
  h.run("record-activation", { versionId: "d1-version" });
  assert.equal(h.dependencies.readProof().activatedVersionId, "d1-version");
  assert.throws(() => h.run("final"), /recorded Worker|activated/);
  h.inspection.deployment = {
    versionId: evidence.bridgeVersionId,
    deployedAtMs: evidence.bridgeDeployedAtMs,
  };
  assert.throws(() => h.run("final"), /activated.*never.*overwritten/);
});

test("activation retries after a lost response preserve the recorded activation", () => {
  const h = harness();
  h.observe();
  h.run("final");
  h.inspection.deployment = { versionId: "d1-version", deployedAtMs: FINAL };
  const execute = h.dependencies.executeSql;
  h.dependencies.executeSql = (sql) => {
    execute(sql);
    throw new Error("lost activation response");
  };
  assert.throws(
    () => h.run("record-activation", { versionId: "d1-version" }),
    /lost activation response/,
  );
  const activated = h.dependencies.readProof();
  assert.equal(activated.activatedVersionId, "d1-version");
  assert.equal(activated.activatedAtMs, FINAL);
  h.dependencies.executeSql = execute;
  h.setNow(FINAL + 1_000);
  h.run("record-activation", { versionId: "d1-version" });
  assert.deepEqual(h.dependencies.readProof(), activated);
  assert.equal(JSON.parse(h.logs.at(-1)!).activated, true);
});

test("activation retries reject a different version", () => {
  const h = harness();
  h.observe();
  h.run("final");
  h.inspection.deployment = { versionId: "d1-version", deployedAtMs: FINAL };
  h.run("record-activation", { versionId: "d1-version" });
  const activated = h.dependencies.readProof();
  h.inspection.deployment = {
    versionId: "different-d1-version",
    deployedAtMs: FINAL + 1_000,
  };
  h.setNow(FINAL + 1_000);
  assert.throws(
    () => h.run("record-activation", { versionId: "different-d1-version" }),
    /CHECK constraint/,
  );
  assert.deepEqual(h.dependencies.readProof(), activated);
});

test("final exact replacement removes stale imported jobs on a frozen retry", () => {
  const h = harness();
  h.observe();
  h.run("final");
  h.db.exec(
    "UPDATE profile_link_catchup_jobs SET match_cursor = 'stale' WHERE login_uid = 'login-a'",
  );
  h.run("final");
  assert.equal(h.dependencies.readJobs()[0].matchCursor, "match-47");
  assert.equal(h.dependencies.readJobs().length, 3);
});

test("retained attempt is explicit and a resumed attempt fences all stale import batches", () => {
  const h = harness();
  h.observe();
  const execute = h.dependencies.executeSql;
  h.dependencies.executeSql = (sql) => {
    execute(sql);
    if (sql.includes("DELETE FROM profile_link_catchup_jobs"))
      throw new Error("interrupted");
  };
  assert.throws(() => h.run("final"), /interrupted/);
  const attempt = h.dependencies.readProof().importAttemptId!;
  const stale = buildImportBatches(h.dependencies.readJobs(), attempt);
  h.dependencies.executeSql = execute;
  assert.throws(() => h.run("final"), /retained/);
  h.run("final", { resumeAttempt: attempt });
  assert.equal(h.dependencies.readProof().importAttemptId, null);
  assert.throws(() => execute(stale[0]), /CHECK constraint/);
  assert.equal(h.dependencies.readJobs().length, 3);
});

test("six-minute source quiet and fifteen-minute queue drain are independent gates", () => {
  const h = harness();
  h.observe();
  h.setNow(FIRST + 359_999);
  assert.throws(() => h.run("final"), /six minutes/);
  h.setNow(FINAL);
  const recentEvidence = {
    ...evidence,
    queuesPausedAtMs: Object.fromEntries(
      QUEUE_NAMES.map((queue) => [queue, 1_500_000]),
    ),
    recordedAtMs: 1_500_001,
  };
  h.files.set("evidence", recentEvidence);
  const observation = h.files.get("observation.json") as Record<
    string,
    unknown
  >;
  h.files.set("observation.json", {
    ...observation,
    exportedAtMs: 1_500_001,
    evidence: recentEvidence,
  });
  assert.throws(() => h.run("final"), /fifteen minutes/);
  assert.equal(h.statements.length, 0);
});

for (const failure of [
  "unfrozen",
  "lease",
  "deployment",
  "source",
  "owners",
  "unresolved",
] as const) {
  test(`final fails closed for ${failure} before mutating jobs`, () => {
    const h = harness();
    h.observe();
    if (failure === "unfrozen") h.inspection.canonicalState = "active";
    if (failure === "lease") h.inspection.activeProjectionLeases = 1;
    if (failure === "deployment")
      h.inspection.deployment.versionId = "other-version";
    if (failure === "source")
      h.source["login-a"] = pending({ matchCursor: "changed" });
    if (failure === "owners") h.owners["login-a"] = "different-owner";
    if (failure === "unresolved") {
      delete h.owners["login-a"];
      const observation = h.files.get("observation.json") as Record<
        string,
        unknown
      >;
      h.files.set("observation.json", {
        ...observation,
        owners: h.owners,
        ownersDigest: digest(h.owners),
      });
    }
    assert.throws(() => h.run("final"));
    assert.equal(h.statements.length, 0);
  });
}

test("source mutation during import leaves the attempt retained and no verified proof", () => {
  const h = harness();
  h.observe();
  const execute = h.dependencies.executeSql;
  h.dependencies.executeSql = (sql) => {
    execute(sql);
    if (sql.includes("DELETE FROM profile_link_catchup_jobs"))
      h.source["login-a"] = pending({ matchCursor: "late-write" });
  };
  assert.throws(() => h.run("final"), /source changed/);
  assert.notEqual(h.dependencies.readProof().importAttemptId, null);
  assert.equal(h.dependencies.readProof().verifiedAtMs, null);
});

test("stopped import can observe a changed source and resume with a fresh fenced attempt", () => {
  const h = harness();
  h.observe();
  const execute = h.dependencies.executeSql;
  h.dependencies.executeSql = (sql) => {
    execute(sql);
    if (sql.includes("DELETE FROM profile_link_catchup_jobs"))
      h.source["login-a"] = pending({ matchCursor: "late-write" });
  };
  assert.throws(() => h.run("final"), /source changed/);
  const oldAttempt = h.dependencies.readProof().importAttemptId!;
  const staleBatches = buildImportBatches(
    h.dependencies.readJobs(),
    oldAttempt,
  );
  h.dependencies.executeSql = execute;
  h.run("observe", { resumeAttempt: oldAttempt });
  h.setNow(FINAL + 360_000);
  h.run("final", { resumeAttempt: oldAttempt });
  assert.equal(h.dependencies.readJobs()[0].matchCursor, "late-write");
  assert.equal(h.dependencies.readProof().importAttemptId, null);
  assert.throws(() => execute(staleBatches[0]), /CHECK constraint/);
});

test("activation requires a distinct D1 deployment promoted after final export", () => {
  const h = harness();
  h.observe();
  h.run("final");
  assert.throws(
    () => h.run("record-activation", { versionId: evidence.bridgeVersionId }),
    /promoted after final import/,
  );
  h.inspection.deployment = {
    versionId: "d1-version",
    deployedAtMs: FINAL - 1,
  };
  assert.throws(
    () => h.run("record-activation", { versionId: "d1-version" }),
    /promoted after final import/,
  );
  assert.equal(h.dependencies.readProof().activatedAtMs, null);
});

test("verification detects database corruption and activation rejects a tampered artifact", () => {
  const h = harness();
  h.observe();
  h.run("final");
  h.db.exec(
    "UPDATE profile_link_catchup_jobs SET match_cursor = 'corrupt' WHERE login_uid = 'login-a'",
  );
  assert.throws(() => h.run("verify"), /readback differs/);
  const artifact = h.files.get("import.json") as Import;
  artifact.jobs[0].matchCursor = "tampered";
  artifact.importDigest = digest(artifact.jobs);
  assert.throws(() => parseImport(artifact), /canonical source reconstruction/);
});

test("every import batch fails after canonical unfreeze or durable activation", () => {
  const h = harness();
  h.observe();
  const execute = h.dependencies.executeSql;
  h.dependencies.executeSql = (sql) => {
    execute(sql);
    if (sql.includes("import_started_at_ms =")) throw new Error("claimed");
  };
  assert.throws(() => h.run("final"), /claimed/);
  const input = h.files.get("import.json") as Import;
  const batches = buildImportBatches(input.jobs, input.importAttemptId);
  h.db.exec("UPDATE profile_canonical_control SET state = 'active'");
  assert.throws(() => execute(batches[0]), /CHECK constraint/);
  h.db.exec(
    "UPDATE profile_canonical_control SET state = 'frozen'; UPDATE profile_link_catchup_import SET activated_at_ms = 3",
  );
  assert.throws(() => execute(batches[0]), /CHECK constraint/);
});

test("large imports are bounded and unsafe SQL characters remain literal values", () => {
  const prototype = rebuildJobs({ uid: pending() }, { uid: "owner'--" }, FIRST)
    .jobs[0];
  const jobs: Job[] = Array.from({ length: 350 }, (_, index) => ({
    ...prototype,
    loginUid: `uid-${String(index).padStart(4, "0")}`,
  }));
  const batches = buildImportBatches(jobs, "attempt");
  assert.ok(batches.length > 1);
  assert.ok(
    batches.every((batch) => Buffer.byteLength(batch) <= SQL_BATCH_BYTES),
  );
  assert.ok(
    batches.every((batch) =>
      batch.startsWith("INSERT INTO profile_link_catchup_import_guards"),
    ),
  );
  assert.doesNotMatch(batches.join(""), /owner'--/);
});

for (const asciiCount of [0, 99]) {
  test(`Unicode job pagination preserves SQLite order with ${asciiCount} preceding rows`, (t) => {
    const { db } = harness();
    t.after(() => db.close());
    const loginUids = [
      ...Array.from(
        { length: asciiCount },
        (_, index) => `uid-${String(index).padStart(3, "0")}`,
      ),
      "uid-\uE000",
      "uid-\u{10000}",
    ];
    const insert = db.prepare(
      `INSERT INTO profile_link_catchup_jobs
       (login_uid, request_id, profile_id, cleanup_profile_ids_json,
        source_updated_at_ms, last_queued_at_ms)
       VALUES (?, 'request', 'profile', '[]', 1, 1)`,
    );
    for (const loginUid of loginUids) insert.run(loginUid);
    let queryCount = 0;
    const jobs = readRemoteJobs((sql) => {
      queryCount++;
      return db.prepare(sql).all();
    });
    assert.deepEqual(
      jobs.map((job) => job.loginUid),
      [...loginUids].sort(),
    );
    assert.equal(queryCount, asciiCount === 0 ? 2 : 3);
  });
}

test("empty source verifies an empty exact import", () => {
  const h = harness();
  for (const uid of Object.keys(h.source)) {
    delete h.source[uid];
    delete h.owners[uid];
  }
  h.observe();
  h.run("final");
  assert.equal(h.dependencies.readProof().jobCount, 0);
});

test("canonical source is pinned and source overrides are rejected", () => {
  assert.deepEqual(firebaseDatabaseGetArgs("mons-link"), [
    "database:get",
    "/profileGameProjectionOutbox/profile",
    "--project",
    "mons-link",
    "--instance",
    "mons-link-default-rtdb",
  ]);
  for (const name of [
    "FIREBASE_DATABASE_EMULATOR_HOST",
    "FIREBASE_CONFIG",
    "FIREBASE_RTDB_URL",
  ])
    assert.throws(
      () =>
        assertSource(
          { phase: "preview", project: "mons-link" },
          { [name]: "override" },
        ),
      /rejects.*overrides/,
    );
});

test("CLI requires phase-specific evidence and activation version", () => {
  assert.equal(parseArgs([]).phase, "preview");
  assert.equal(
    parseArgs([
      "--final",
      "--evidence-file",
      "evidence",
      "--observation",
      "observation",
    ]).phase,
    "final",
  );
  for (const args of [
    ["--observe"],
    ["--final", "--evidence-file", "file"],
    ["--preview", "--verify"],
    ["--record-activation", "--import-file", "file"],
    ["--preview", "--resume-attempt", "attempt"],
    [
      "--final",
      "--evidence-file",
      "file",
      "--observation",
      "observation",
      "--project",
      "other-project",
    ],
  ])
    assert.throws(() => parseArgs(args));
});

test("snapshots and SQL artifacts are mode 0600 in mode 0700 directories", () => {
  const root = mkdtempSync(resolve(tmpdir(), "profile-link-artifact-test-"));
  const directory = persistArtifacts(
    { "source.json": '{"private":true}\n', "import.sql": "SELECT 1;" },
    "final",
    FIRST,
    root,
  );
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(resolve(directory, "source.json")).mode & 0o777, 0o600);
  assert.equal(statSync(resolve(directory, "import.sql")).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(resolve(directory, "source.json"), "utf8"),
    '{"private":true}\n',
  );
  assert.throws(
    () => persistArtifacts({ "../unsafe.json": "{}" }, "preview", FIRST, root),
    /invalid migration artifact name/,
  );
});
