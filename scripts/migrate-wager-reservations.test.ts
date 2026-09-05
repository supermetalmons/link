import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseControl, type JsonRecord } from "./manage-wager-reservations.ts";
import {
  assertSource,
  buildImportBatches,
  buildClaimSql,
  buildVerificationSql,
  digest,
  firebaseDatabaseGetArgs,
  migrateWagerReservations,
  normalizeFrozen,
  normalizeOperations,
  normalizeSnapshot,
  parseArgs,
  parseEvidence,
  persistArtifacts,
  QUEUE_NAMES,
  readImportedSnapshot,
  readBoundedResponse,
  readSource,
  readSourceAsync,
  readSourceConcurrency,
  SQL_BATCH_BYTES,
  type Dependencies,
  type Evidence,
  type Observation,
  type Proof,
  type Snapshot,
} from "./migrate-wager-reservations.ts";

const NOW = 2_000_000;
const FIRST_EXPORTED = 1_000_000;

function source(): Snapshot {
  return normalizeSnapshot({
    "player-a": {
      frozen: { dust: 9 },
      operations: {
        "active-operation": {
          appliedAtMs: 100,
          count: 9,
          deltas: { dust: 9 },
          fingerprint: JSON.stringify([
            "send-reserve",
            "dust",
            9,
            0,
            0,
            0,
            0,
            0,
          ]),
        },
      },
    },
    "orphan-uid": {
      frozen: {},
      operations: { "consumed-operation": { consumed: true } },
    },
  });
}

function evidence(): Evidence {
  return {
    bridgeVersionId: "bridge-version",
    bridgeDeployedAtMs: 1_000,
    queuesPausedAtMs: Object.fromEntries(
      QUEUE_NAMES.map((queue) => [queue, 10_000]),
    ),
    legacyWritersDrained: true,
    recordedAtMs: 20_000,
  };
}

function applySchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE profile_canonical_control (singleton INTEGER PRIMARY KEY, state TEXT); INSERT INTO profile_canonical_control VALUES (1, 'frozen');",
  );
  for (const file of [
    "0010_wager_frozen_reservations.sql",
    "0011_wager_reservation_control.sql",
  ])
    db.exec(
      readFileSync(
        resolve("cloud/workers/api/profile-migrations", file),
        "utf8",
      ),
    );
  db.exec(
    "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', previous_storage_mode = 'firebase', freeze_generation = 1 WHERE singleton = 1;",
  );
}

function harness() {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const first: Observation = {
    schemaVersion: 1,
    project: "mons-link",
    freezeGeneration: 1,
    exportedAtMs: FIRST_EXPORTED,
    sourceDigest: digest(source()),
    evidence: evidence(),
    snapshot: source(),
  };
  const state = {
    now: NOW,
    source: source(),
    evidence: evidence(),
    first,
    files: {} as Record<string, string>,
    logs: [] as string[],
    imports: 0,
    sourceReads: 0,
    proof: null as Proof | null,
    admissions: 0,
    activeLeases: 0,
    deployment: { versionId: "bridge-version", deployedAtMs: 1_000 },
    beforeReadback: () => undefined as void,
    afterImport: () => undefined as void,
  };
  const dependencies: Dependencies = {
    now: () => state.now,
    log: (message) => state.logs.push(message),
    readJson: (path) =>
      path === "evidence.json" ? state.evidence : state.first,
    readSource: () => {
      state.sourceReads++;
      return structuredClone(state.source);
    },
    inspect: () => ({
      control: parseControl(
        db.prepare("SELECT * FROM wager_reservation_runtime_control").get(),
      ),
      canonicalState: String(
        db.prepare("SELECT state FROM profile_canonical_control").get()?.state,
      ),
      writeAdmissions: state.admissions,
      activeGameplayLeases: state.activeLeases,
      deployment: state.deployment,
    }),
    persistArtifacts: (files) => {
      Object.assign(state.files, files);
      return "/private/tmp/wager-test";
    },
    importSql: (path) => {
      state.imports++;
      const name = path.split("/").at(-1) as string;
      db.exec(state.files[name]);
      state.afterImport();
    },
    readImportedSnapshot: () => {
      state.beforeReadback();
      return readImportedSnapshot(
        (sql) => db.prepare(sql).all() as JsonRecord[],
      );
    },
    claimImport: (generation, attemptId, startedAtMs) => {
      assert.equal(
        db.prepare(buildClaimSql(generation, attemptId, startedAtMs)).all()
          .length,
        1,
      );
    },
    markVerified: (proof) => {
      assert.equal(
        db.prepare(buildVerificationSql(proof, NOW)).all().length,
        1,
      );
      state.proof = proof;
    },
  };
  return { db, state, dependencies };
}

const finalOptions = {
  phase: "final" as const,
  project: "mons-link",
  evidenceFile: "evidence.json",
  observationFile: "observation.json",
};

test("migration arguments keep preview read-only and require explicit final evidence", () => {
  assert.deepEqual(parseArgs([]), { phase: "preview", project: "mons-link" });
  assert.deepEqual(
    parseArgs(["--observe", "--evidence-file", "evidence.json"]),
    { phase: "observe", project: "mons-link", evidenceFile: "evidence.json" },
  );
  assert.deepEqual(
    parseArgs([
      "--final",
      "--evidence-file",
      "evidence.json",
      "--observation",
      "observation.json",
    ]),
    finalOptions,
  );
  for (const args of [
    ["--final"],
    ["--observe"],
    ["--preview", "--final"],
    ["--preview", "--observation", "file"],
    [
      "--final",
      "--project",
      "demo-other",
      "--evidence-file",
      "file",
      "--observation",
      "file",
    ],
    ["--delete-source"],
  ])
    assert.throws(() => parseArgs(args));
  assert.throws(() =>
    assertSource(finalOptions, {
      FIREBASE_DATABASE_EMULATOR_HOST: "localhost",
    }),
  );
  assert.throws(() =>
    assertSource(finalOptions, { FIREBASE_RTDB_URL: "override" }),
  );
  assert.deepEqual(firebaseDatabaseGetArgs("mons-link", "/players", true), [
    "database:get",
    "/players",
    "--project",
    "mons-link",
    "--instance",
    "mons-link-default-rtdb",
    "--shallow",
  ]);
});

test("strict source normalization preserves sparse balances, orphan UIDs and consumed tombstones", () => {
  const snapshot = source();
  assert.deepEqual(snapshot["player-a"].frozen, {
    dust: 9,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
  assert.deepEqual(snapshot["orphan-uid"].operations, {
    "consumed-operation": { consumed: true },
  });
  for (const frozen of [
    { dust: -1 },
    { dust: "9" },
    { dust: 1.2 },
    { dust: Number.MAX_SAFE_INTEGER + 1 },
    { unknown: 1 },
    [],
    "bad",
  ])
    assert.throws(() => normalizeFrozen(frozen));
  for (const operations of [
    { bad: { consumed: true, count: 1 } },
    { bad: { consumed: false } },
    { bad: { appliedAtMs: 0, fingerprint: "[]" } },
    { "bad/key": { consumed: true } },
  ])
    assert.throws(() => normalizeOperations(operations));
});

test("valid historical zero-delta accept operations retain their exact stored shape", () => {
  const operation = {
    appliedAtMs: 100,
    count: 5,
    fingerprint: JSON.stringify([
      "accept-reserve",
      "dust:dust",
      5,
      5,
      0,
      0,
      0,
      0,
    ]),
  };
  assert.deepEqual(normalizeOperations({ operation }).operation, operation);
  assert.throws(() =>
    normalizeOperations({ operation: { ...operation, count: 6 } }),
  );
});

test("source reader enumerates UIDs and reads only each complete mining child", () => {
  const calls: Array<[string, boolean | undefined]> = [];
  const snapshot = readSource("mons-link", (path, shallow) => {
    calls.push([path, shallow]);
    if (path === "/players") return { orphan: true, empty: true, player: true };
    if (path === "/players/orphan/mining")
      return { _wagerOps: { retained: { consumed: true } } };
    if (path === "/players/player/mining")
      return { frozen: { dust: 4 }, unrelated: "retained-at-source" };
    if (path === "/players/empty/mining") return null;
    return assert.fail("must not read matches, invites, or complete players");
  });
  assert.deepEqual(Object.keys(snapshot), ["orphan", "player"]);
  assert.equal(calls.length, 5);
  assert.equal(snapshot.player.frozen.dust, 4);
  assert.throws(
    () =>
      readSource("mons-link", (path) =>
        path === "/players" ? { player: true } : "malformed-mining",
      ),
    /mining parent/,
  );
  let lists = 0;
  assert.throws(
    () =>
      readSource("mons-link", (path) =>
        path === "/players"
          ? ++lists === 1
            ? { one: true }
            : { two: true }
          : null,
      ),
    /enumeration changed/,
  );
});

test("preview has no control reads or D1 mutations and logs no wager payload", (t) => {
  const { db, state, dependencies } = harness();
  t.after(() => db.close());
  dependencies.inspect = () => assert.fail("preview must not inspect D1");
  dependencies.importSql = () => assert.fail("preview must not mutate D1");
  migrateWagerReservations(
    { phase: "preview", project: "mons-link" },
    dependencies,
    {},
  );
  assert.equal(state.sourceReads, 1);
  assert.equal(state.logs.length, 1);
  assert.ok(state.files["source.json"].includes("active-operation"));
  assert.equal(state.logs[0].includes("active-operation"), false);
  assert.equal(state.logs[0].includes("orphan-uid"), false);
});

test("observe records a protected reusable source observation without mutations", (t) => {
  const { db, state, dependencies } = harness();
  t.after(() => db.close());
  migrateWagerReservations(
    { phase: "observe", project: "mons-link", evidenceFile: "evidence.json" },
    dependencies,
    {},
  );
  const observation = JSON.parse(state.files["observation.json"]);
  assert.equal(observation.freezeGeneration, 1);
  assert.equal(observation.sourceDigest, digest(source()));
  assert.equal(state.imports, 0);
  assert.equal(state.proof, null);
});

test("final import exactly replaces target tables, preserves active and consumed operations, and activates with its proof", (t) => {
  const { db, state, dependencies } = harness();
  t.after(() => db.close());
  db.exec(
    'INSERT INTO wager_frozen_balances VALUES (\'staged-extra\', \'{"dust":0,"slime":0,"gum":0,"metal":0,"ice":0}\', 1, 1);',
  );
  migrateWagerReservations(finalOptions, dependencies, {});
  assert.deepEqual(
    readImportedSnapshot((sql) => db.prepare(sql).all() as JsonRecord[]),
    source(),
  );
  assert.equal(state.proof?.sourceBalanceCount, 2);
  assert.equal(state.proof?.sourceOperationCount, 2);
  assert.equal(state.sourceReads, 2);
  assert.equal(
    db
      .prepare(
        "SELECT revision, updated_at_ms FROM wager_frozen_balances WHERE player_uid = 'player-a'",
      )
      .get()?.updated_at_ms,
    NOW,
  );
  db.exec(
    `UPDATE wager_reservation_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL, activated_at_ms = ${NOW};`,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'firebase', activated_at_ms = NULL;",
      ),
    /wager reservation/,
  );
  assert.throws(() =>
    db.exec(buildImportBatches(source(), NOW, 1, "attempt")[0]),
  );
});

test("final rejects short observations, unpaused queues, all admissions and stale deployments before writing", (t) => {
  const changes: Array<(state: ReturnType<typeof harness>["state"]) => void> = [
    (state) => {
      state.now = FIRST_EXPORTED + 359_999;
    },
    (state) => {
      state.evidence.queuesPausedAtMs[QUEUE_NAMES[0]] = NOW - 100;
      state.evidence.recordedAtMs = NOW;
      state.first.evidence = state.evidence;
      state.first.exportedAtMs = NOW;
    },
    (state) => {
      state.admissions = 1;
    },
    (state) => {
      state.activeLeases = 1;
    },
    (state) => {
      state.deployment.versionId = "another-version";
    },
    (state) => {
      state.first.freezeGeneration = 2;
    },
  ];
  for (const change of changes) {
    const { db, state, dependencies } = harness();
    t.after(() => db.close());
    change(state);
    assert.throws(() =>
      migrateWagerReservations(finalOptions, dependencies, {}),
    );
    assert.equal(state.imports, 0);
    assert.equal(state.proof, null);
  }
});

test("source drift invalidates prior proof and never permits activation", (t) => {
  const { db, state, dependencies } = harness();
  t.after(() => db.close());
  migrateWagerReservations(finalOptions, dependencies, {});
  assert.equal(state.proof?.freezeGeneration, 1);
  state.imports = 0;
  state.proof = null;
  state.source["player-a"].frozen.dust++;
  assert.throws(
    () => migrateWagerReservations(finalOptions, dependencies, {}),
    /source changed/,
  );
  assert.equal(
    db
      .prepare(
        "SELECT verified_import_generation FROM wager_reservation_runtime_control",
      )
      .get()?.verified_import_generation,
    null,
  );
  assert.equal(state.imports, 0);
});

test("readback mismatch or source mutation during import leaves proof absent", (t) => {
  for (const mutateSource of [false, true]) {
    const { db, state, dependencies } = harness();
    t.after(() => db.close());
    if (mutateSource)
      state.afterImport = () => {
        state.source["player-a"].frozen.dust++;
      };
    else
      state.beforeReadback = () => {
        db.exec("DELETE FROM wager_frozen_operations;");
      };
    assert.throws(
      () => migrateWagerReservations(finalOptions, dependencies, {}),
      mutateSource ? /changed during import/ : /readback differs/,
    );
    assert.equal(state.proof, null);
    assert.equal(
      db
        .prepare(
          "SELECT verified_import_generation FROM wager_reservation_runtime_control",
        )
        .get()?.verified_import_generation,
      null,
    );
  }
});

test("bounded batches and paginated readback cover larger imports", (t) => {
  const { db } = harness();
  t.after(() => db.close());
  const snapshot: Snapshot = {};
  for (let index = 0; index < 620; index++)
    snapshot[`uid-${String(index).padStart(4, "0")}`] = {
      frozen: normalizeFrozen({ dust: index }),
      operations: { consumed: { consumed: true } },
    };
  db.exec(buildClaimSql(1, "attempt", NOW));
  const batches = buildImportBatches(snapshot, NOW, 1, "attempt");
  assert.ok(batches.length > 1);
  assert.ok(
    batches.every((batch) => Buffer.byteLength(batch) <= SQL_BATCH_BYTES),
  );
  for (const batch of batches) db.exec(batch);
  assert.equal(
    digest(
      readImportedSnapshot((sql) => db.prepare(sql).all() as JsonRecord[]),
    ),
    digest(snapshot),
  );
});

test("cutover evidence records each queue and cannot claim future timestamps", () => {
  assert.deepEqual(parseEvidence(evidence(), NOW), evidence());
  const missing = evidence();
  delete missing.queuesPausedAtMs[QUEUE_NAMES[0]];
  assert.throws(() => parseEvidence(missing, NOW));
  assert.throws(() =>
    parseEvidence({ ...evidence(), recordedAtMs: NOW + 1 }, NOW),
  );
  assert.throws(() =>
    parseEvidence({ ...evidence(), legacyWritersDrained: false }, NOW),
  );
});

test("private artifacts contain original source and SQL without broad permissions", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wager-artifact-test-"));
  const run = persistArtifacts(
    { "source.json": "{}\n", "import-00000.sql": "SELECT 1;\n" },
    "preview",
    NOW,
    directory,
  );
  assert.equal(statSync(run).mode & 0o777, 0o700);
  for (const name of readdirSync(run))
    assert.equal(statSync(resolve(run, name)).mode & 0o777, 0o600);
});

test("exclusive import claims reject a second runner and fence recovered runners", (t) => {
  const { db } = harness();
  t.after(() => db.close());
  assert.equal(
    db.prepare(buildClaimSql(1, "first-attempt", NOW)).all().length,
    1,
  );
  assert.equal(
    db.prepare(buildClaimSql(1, "second-attempt", NOW)).all().length,
    0,
  );
  assert.throws(() =>
    db.exec(buildImportBatches(source(), NOW, 1, "second-attempt")[0]),
  );
  const proof: Proof = {
    importAttemptId: "first-attempt",
    freezeGeneration: 1,
    sourceDigest: digest(source()),
    sourceBalanceCount: 2,
    sourceOperationCount: 2,
    sourceFirstExportedAtMs: FIRST_EXPORTED,
    sourceExportedAtMs: NOW,
    queuesPausedAtMs: 10_000,
    bridgeDeployedAtMs: 1_000,
    bridgeVersionId: "bridge-version",
  };
  db.exec(
    "UPDATE wager_reservation_runtime_control SET import_attempt_id = NULL, import_started_at_ms = NULL, verified_import_generation = NULL, source_digest = NULL;",
  );
  assert.equal(
    db.prepare(buildClaimSql(1, "replacement-attempt", NOW)).all().length,
    1,
  );
  assert.throws(() =>
    db.exec(buildImportBatches(source(), NOW, 1, "first-attempt")[0]),
  );
  assert.equal(db.prepare(buildVerificationSql(proof, NOW)).all().length, 0);
  assert.equal(
    db
      .prepare(
        "SELECT verified_import_generation FROM wager_reservation_runtime_control",
      )
      .get()?.verified_import_generation,
    null,
  );
});

test("authenticated source reader bounds concurrency and reads every UID once", async () => {
  const uids = Object.fromEntries(
    Array.from({ length: 13 }, (_, index) => [`uid-${index}`, true]),
  );
  let active = 0;
  let maximum = 0;
  let enumerations = 0;
  const reads: string[] = [];
  const snapshot = await readSourceAsync(async (path, shallow) => {
    if (path === "/players") {
      enumerations++;
      assert.equal(shallow, true);
      return uids;
    }
    active++;
    maximum = Math.max(maximum, active);
    reads.push(path);
    await Promise.resolve();
    active--;
    return { frozen: { dust: 3 }, _wagerOps: { retained: { consumed: true } } };
  });
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(enumerations, 2);
  assert.equal(reads.length, 13);
  assert.equal(new Set(reads).size, 13);
  assert.equal(Object.keys(snapshot).length, 13);
});

test("authenticated source reader rejects malformed mining and changed UID inventories", async () => {
  await assert.rejects(
    readSourceAsync(async (path) =>
      path === "/players" ? { uid: true } : ["invalid"],
    ),
    /mining parent/,
  );
  let enumerations = 0;
  await assert.rejects(
    readSourceAsync(async (path) =>
      path === "/players"
        ? ++enumerations === 1
          ? { one: true }
          : { two: true }
        : null,
    ),
    /enumeration changed/,
  );
});

test("bounded source responses fail without waiting for stalled stream cancellation", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    }),
  );
  await assert.rejects(readBoundedResponse(response, 4), /size limit/);
  assert.deepEqual(
    await readBoundedResponse(Response.json({ ok: true }), 100),
    { ok: true },
  );
});

test("source concurrency defaults to four and accepts only explicit bounds", async () => {
  assert.equal(readSourceConcurrency({}), 4);
  assert.equal(
    readSourceConcurrency({ WAGER_RESERVATION_SOURCE_CONCURRENCY: "1" }),
    1,
  );
  assert.equal(
    readSourceConcurrency({ WAGER_RESERVATION_SOURCE_CONCURRENCY: "16" }),
    16,
  );
  for (const value of [
    "0",
    "17",
    "-1",
    "1.5",
    "",
    " 4",
    "4 ",
    "NaN",
    "Infinity",
  ])
    assert.throws(
      () =>
        readSourceConcurrency({ WAGER_RESERVATION_SOURCE_CONCURRENCY: value }),
      /1 through 16/,
    );
  for (const value of [0, 17, -1, 1.5])
    await assert.rejects(
      readSourceAsync(async () => null, value),
      /concurrency/,
    );
});

test("source concurrency override reaches sixteen without changing snapshot contents", async () => {
  const uids = Object.fromEntries(
    Array.from({ length: 35 }, (_, index) => [`uid-${index}`, true]),
  );
  let active = 0;
  let maximum = 0;
  const get = async (path: string) => {
    if (path === "/players") return uids;
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return { frozen: { dust: 3 }, _wagerOps: { retained: { consumed: true } } };
  };
  const fast = await readSourceAsync(
    get,
    readSourceConcurrency({ WAGER_RESERVATION_SOURCE_CONCURRENCY: "16" }),
  );
  assert.equal(maximum, 16);
  assert.equal(active, 0);
  const ordinary = await readSourceAsync(get);
  assert.equal(digest(fast), digest(ordinary));
});

test("export concurrency is recorded outside the semantic digest", (t) => {
  const { db, state, dependencies } = harness();
  t.after(() => db.close());
  migrateWagerReservations(
    { phase: "preview", project: "mons-link" },
    dependencies,
    {
      GOOGLE_APPLICATION_CREDENTIALS: "explicit-credentials.json",
      WAGER_RESERVATION_SOURCE_CONCURRENCY: "16",
    },
  );
  assert.equal(JSON.parse(state.files["metadata.json"]).sourceConcurrency, 16);
  assert.equal(JSON.parse(state.logs[0]).sourceConcurrency, 16);
  assert.equal(JSON.parse(state.logs[0]).digest, digest(source()));
});
