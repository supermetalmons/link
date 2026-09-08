import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalJson,
  compareFirebaseKeys,
  createSqlDependencies,
  createWranglerRunner,
  loadExport,
  manageWagerState,
  normalizeSourcePage,
  parseArgs,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
  type Arguments,
  type Dependencies,
  type SqlRunner,
} from "./manage-wager-state.ts";

const VERSION = "ed41f283-8a34-4674-8bf4-a4774b1d0196";
const NOW = 2_000_000;

test("legacy wager migration rejects retained Firebase invite source after activation", async (t) => {
  const h = harness(t);
  h.db.exec(
    "CREATE TABLE invite_source_control (singleton INTEGER, backend TEXT); INSERT INTO invite_source_control VALUES (1, 'd1');",
  );
  await assert.rejects(
    h.perform("preflight"),
    /Firebase invite-source scans are retired/,
  );
  assert.equal(h.sourceReads.length, 0);
  await h.perform("status");
});

function sourceFixture(): Record<string, Record<string, unknown>> {
  return {
    a: {
      hostId: "host-a",
      guestId: "guest-a",
      wagers: {
        a: {
          proposals: {
            "host-a": { material: "dust", count: 2, operationId: "proposal-a" },
          },
          proposedBy: { "host-a": true },
          proposalRemovalOperations: {
            removal: { consumed: true, unknown: [null, false, "old"] },
          },
          unknownFutureField: { retained: true },
        },
      },
    },
    b: {
      wagers: {
        b: {
          agreed: { material: "slime", count: 3 },
          agreementOperation: { operationId: "agreement-b", completed: true },
          settlement: {
            state: "pending",
            operationId: "settlement-b",
            fingerprint: "pending-proof",
            releases: [
              { uid: "host-b", reservationOperationIds: ["reserve-b"] },
            ],
          },
        },
      },
    },
    c: {
      wagers: {
        "c-rematch-1": {
          resolved: {
            winnerId: "host-c",
            loserId: "guest-c",
            material: "ice",
            count: 5,
            total: 10,
          },
          settlement: {
            state: "completed",
            operationId: "settlement-c",
            failureReason: "retained-historical-reason",
          },
          lineage: ["old-1", "old-2"],
        },
      },
      matchesWagerResolutions: { "c-rematch-1": true },
    },
    d: {
      matchesWagerResolutions: { "d-history": true, "d-false-marker": false },
    },
    e: {
      wagers: {
        "e-array": { unknown: ["retained", null, { a: false }] },
        "e-scalar": { legacy: "retained" },
        "e-null": { optional: null },
      },
    },
    f: { hostId: "pending-host" },
  };
}

function harness(t: test.TestContext, source = sourceFixture()) {
  const directory = mkdtempSync(resolve(tmpdir(), "mons-wager-state-test-"));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE profile_canonical_control (singleton INTEGER PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO profile_canonical_control VALUES (1, 'frozen');
    CREATE TABLE wager_reservation_runtime_control (singleton INTEGER PRIMARY KEY, storage_mode TEXT NOT NULL, freeze_generation INTEGER NOT NULL);
    INSERT INTO wager_reservation_runtime_control VALUES (1, 'frozen', 3);
    CREATE TABLE wager_reservation_write_admissions (admission_id TEXT PRIMARY KEY, freeze_generation INTEGER, kind TEXT, created_at_ms INTEGER, expires_at_ms INTEGER, uncertain INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE wager_reservation_write_guards (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));
    CREATE TABLE game_session_mutation_locks (invite_id TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL);
    CREATE TABLE profile_records (profile_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, revision INTEGER NOT NULL);
    INSERT INTO profile_records VALUES ('profile-host', '{"mining":{"materials":{"dust":100,"slime":50}}}', 7);
    CREATE TABLE wager_settlements (operation_id TEXT PRIMARY KEY, fingerprint TEXT, outcome TEXT, count INTEGER);
    INSERT INTO wager_settlements VALUES ('settlement-c', 'immutable-transfer-proof', 'applied', 5);
  `);
  db.exec(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../cloud/workers/api/profile-migrations/0010_wager_frozen_reservations.sql",
      ),
      "utf8",
    ),
  );
  db.exec(`
    INSERT INTO wager_frozen_balances VALUES ('host-b', '{"dust":0,"slime":3,"gum":0,"metal":0,"ice":0}', 8, 1000);
    INSERT INTO wager_frozen_operations VALUES ('host-b', 'reserve-b', '{"material":"slime","count":3,"consumed":false}');
    INSERT INTO wager_frozen_operations VALUES ('host-b', 'old-consumed', '{"material":"ice","count":5,"consumed":true}');
  `);
  db.exec(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../cloud/workers/api/profile-migrations/0016_invite_wager_states.sql",
      ),
      "utf8",
    ),
  );
  const queries: string[] = [];
  const sourceReads: Array<string | null> = [];
  const logs: Record<string, unknown>[] = [];
  const run: SqlRunner = async (sql, _database, bindings = []) => {
    queries.push(sql);
    return db.prepare(sql).all(...bindings) as Record<string, unknown>[];
  };
  const reader: Dependencies["readInvitePage"] = async (after, pageSize) => {
    sourceReads.push(after);
    const keys = Object.keys(source)
      .sort(compareFirebaseKeys)
      .filter((key) => after === null || compareFirebaseKeys(key, after) >= 0)
      .slice(0, pageSize + (after === null ? 0 : 1));
    return keys.length === 0
      ? null
      : structuredClone(
          Object.fromEntries(keys.map((key) => [key, source[key]])),
        );
  };
  const dependencies = createSqlDependencies(run, reader, () => NOW);
  dependencies.log = (value) => logs.push(value);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const args = (operation: Arguments["operation"]): Arguments => ({
    operation,
    directory,
    pageSize: 2,
    ...(operation === "verify" || operation === "activate"
      ? { candidateVersionId: VERSION }
      : {}),
  });
  const perform = (
    operation: Arguments["operation"],
    overrides: Partial<Dependencies> = {},
  ) => manageWagerState(args(operation), { ...dependencies, ...overrides });
  return {
    directory,
    db,
    queries,
    source,
    sourceReads,
    logs,
    dependencies,
    perform,
    args,
  };
}

test("arguments require explicit immutable export scope and candidate identity", () => {
  assert.equal(parseArgs(["--status"]).operation, "status");
  assert.equal(parseArgs(["--preflight", "--page-size", "10"]).pageSize, 10);
  assert.deepEqual(
    parseArgs([
      "--activate",
      "--directory",
      "/private/tmp/export",
      "--candidate-version-id",
      VERSION,
    ]),
    {
      operation: "activate",
      directory: "/private/tmp/export",
      candidateVersionId: VERSION,
      firebaseCredentials: undefined,
      pageSize: 25,
    },
  );
  for (const argv of [
    [],
    ["--resume"],
    ["--status", "--directory", "/tmp/x"],
    ["--preflight", "--directory", "/tmp/x"],
    ["--export"],
    ["--export", "--directory", "relative"],
    ["--verify", "--directory", "/tmp/x"],
    ["--activate", "--directory", "/tmp/x", "--candidate-version-id", "guess"],
    ["--export", "--directory", "/tmp/x", "--page-size", "101"],
    ["--import", "--directory", "/tmp/x", "--firebase-credentials", "/tmp/key"],
    ["--export", "--directory", "/tmp/x", "--directory", "/tmp/y"],
  ])
    assert.throws(() => parseArgs(argv));
});

test("full local rehearsal preserves active and historical raw wagers, marker-only rows and all ledger evidence", async (t) => {
  const h = harness(t);
  const baseline = await h.dependencies.readBaseline();
  await h.perform("export");
  const manifest = loadExport(h.directory);
  assert.equal(manifest.source.rowCount, 8);
  assert.equal(manifest.source.wagerCount, 6);
  assert.equal(manifest.source.markerCount, 3);
  assert.equal(manifest.source.scannedInviteCount, 6);
  assert.equal(manifest.pages.length, 3);
  assert.deepEqual(h.sourceReads, [null, "b", "d", "f"]);
  await h.perform("import");
  await h.perform("import");
  await h.perform("verify");
  const beforeActivation = await h.dependencies.readActivation();
  assert.equal(beforeActivation.activationEpoch, 0);
  assert.equal(beforeActivation.importAttemptId, null);
  assert.equal(beforeActivation.sourceDigest, manifest.source.digest);
  assert.equal(beforeActivation.importDigest, manifest.source.digest);
  assert.equal(beforeActivation.baselineDigest, baseline.digest);
  const readsBeforeActivation = h.sourceReads.length;
  await h.perform("activate");
  assert.equal(h.sourceReads.length, readsBeforeActivation + 4);
  assert.equal((await h.dependencies.readActivation()).activationEpoch, 1);
  assert.deepEqual(await h.dependencies.readBaseline(), baseline);
  assert.deepEqual(
    h.db
      .prepare(
        "SELECT wager_json, resolution_marker FROM invite_wager_states WHERE invite_id = 'd' ORDER BY match_id",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { wager_json: null, resolution_marker: 0 },
      { wager_json: null, resolution_marker: 1 },
    ],
  );
  const pending = h.db
    .prepare("SELECT wager_json FROM invite_wager_states WHERE invite_id = 'b'")
    .get()!.wager_json;
  assert.deepEqual(
    JSON.parse(String(pending)),
    (h.source.b.wagers as Record<string, unknown>).b,
  );
  assert.throws(
    () =>
      h.db.exec(
        "INSERT INTO wager_reservation_write_admissions (admission_id) VALUES ('old-worker')",
      ),
    /epoch/,
  );
  assert.throws(
    () => h.db.exec("UPDATE wager_state_activation SET activation_epoch = 0"),
    /immutable/,
  );
  assert.throws(
    () => h.db.exec("DELETE FROM invite_wager_states"),
    /permanent/,
  );
  assert.equal(JSON.stringify(h.logs).includes("pending-proof"), false);
});

test("private export artifacts are immutable and directory scope rejects repository paths and symlinks", async (t) => {
  const h = harness(t);
  await h.perform("export");
  assert.equal(lstatSync(h.directory).mode & 0o777, 0o700);
  for (const name of readdirSync(h.directory))
    assert.equal(lstatSync(resolve(h.directory, name)).mode & 0o777, 0o600);
  assert.throws(
    () => privateDirectory(resolve(import.meta.dirname, "..")),
    /outside/,
  );
  const link = resolve(h.directory, "linked");
  symlinkSync(h.directory, link);
  assert.throws(() => privateDirectory(link), /symlink/);
  const file = resolve(h.directory, "private.json");
  writePrivateImmutable(file, { secret: "private-test-value" });
  writePrivateImmutable(file, { secret: "private-test-value" });
  assert.throws(
    () => writePrivateImmutable(file, { secret: "changed" }),
    /immutable/,
  );
  chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file), /private/);
  chmodSync(file, 0o600);
  writeFileSync(file, '{"private-test-value":broken}', { mode: 0o600 });
  assert.throws(
    () => readPrivateJson(file),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("private-test-value"),
  );
});

test("export resumes artifacts after a process exits between publication and partial cleanup", async (t) => {
  const h = harness(t);
  await h.perform("export");
  for (const name of ["session.json", "source-000000.json", "manifest.json"]) {
    const path = resolve(h.directory, name);
    const contents = readFileSync(path, "utf8");
    unlinkSync(path);
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const link = fs.linkSync;
          fs.linkSync = (...args) => { link(...args); process.exit(23); };
          syncBuiltinESMExports();
          const migration = await import(${JSON.stringify(new URL("./manage-wager-state.ts", import.meta.url).href)});
          migration.writePrivateImmutable(process.argv[1], JSON.parse(process.argv[2]));
        `,
        path,
        contents,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.status, 23, child.stderr);
    assert.equal(lstatSync(path).nlink, 2);
    await h.perform("export");
    assert.equal(lstatSync(path).nlink, 1);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(
      readdirSync(h.directory).some((entry) => entry.startsWith(".partial-")),
      false,
    );
  }
  await h.perform("import");
  await h.perform("activate");
});

test("a publisher tolerates a reader recovering its partial link before cleanup", (t) => {
  const h = harness(t);
  const path = resolve(h.directory, "publication.json");
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const link = fs.linkSync;
        let migration;
        fs.linkSync = (...args) => { link(...args); migration.readPrivateJson(args[1]); };
        syncBuiltinESMExports();
        migration = await import(${JSON.stringify(new URL("./manage-wager-state.ts", import.meta.url).href)});
        migration.writePrivateImmutable(process.argv[1], { retained: true });
      `,
      path,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readPrivateJson(path), { retained: true });
  assert.equal(lstatSync(path).nlink, 1);
  assert.deepEqual(readdirSync(h.directory), ["publication.json"]);
});

test("publication recovery rejects unrelated links, extra links and symlinks", (t) => {
  const h = harness(t);
  const file = resolve(h.directory, "private.json");
  const partial = resolve(h.directory, `.partial-${VERSION}`);
  const unrelated = resolve(h.directory, "unrelated.json");
  writePrivateImmutable(file, { retained: true });
  linkSync(file, unrelated);
  assert.throws(() => readPrivateJson(file), /hard links/);
  symlinkSync(file, partial);
  assert.throws(() => readPrivateJson(file), /hard links/);
  assert.throws(() => readPrivateJson(partial));
  assert.equal(lstatSync(partial).isSymbolicLink(), true);
  unlinkSync(partial);
  linkSync(file, partial);
  assert.throws(() => readPrivateJson(file), /hard links/);
  assert.equal(lstatSync(file).nlink, 3);
  unlinkSync(unrelated);
  assert.throws(() => readPrivateJson(file, true), /hard links/);
  assert.throws(() => readPrivateJson(partial), /hard links/);
  assert.equal(lstatSync(file).nlink, 2);
  assert.deepEqual(readPrivateJson(file), { retained: true });
  assert.equal(existsSync(partial), false);
});

test("interrupted export resumes existing immutable pages and rejects changed page size", async (t) => {
  const h = harness(t);
  let calls = 0;
  await assert.rejects(
    h.perform("export", {
      readInvitePage: async (...args) => {
        calls++;
        if (calls === 2) throw new Error("injected read interruption");
        return h.dependencies.readInvitePage(...args);
      },
    }),
    /interruption/,
  );
  assert.equal(existsSync(resolve(h.directory, "manifest.json")), false);
  const page = readFileSync(resolve(h.directory, "source-000000.json"), "utf8");
  await assert.rejects(
    manageWagerState({ ...h.args("export"), pageSize: 3 }, h.dependencies),
    /original page size/,
  );
  await h.perform("export");
  assert.equal(
    readFileSync(resolve(h.directory, "source-000000.json"), "utf8"),
    page,
  );
  assert.equal(loadExport(h.directory).source.rowCount, 8);
});

test("interrupted import resumes identical rows without deleting or overwriting source evidence", async (t) => {
  const h = harness(t);
  await h.perform("export");
  let calls = 0;
  await assert.rejects(
    h.perform("import", {
      importRows: async (manifest, rows) => {
        await h.dependencies.importRows(manifest, rows);
        if (++calls === 1) throw new Error("injected import interruption");
      },
    }),
    /interruption/,
  );
  assert.equal(
    (await h.dependencies.readActivation()).importAttemptId,
    loadExport(h.directory).session.exportId,
  );
  const before = h.db
    .prepare("SELECT * FROM invite_wager_states ORDER BY invite_id, match_id")
    .all();
  assert.ok(before.length > 0);
  await h.perform("import");
  const after = h.db
    .prepare("SELECT * FROM invite_wager_states ORDER BY invite_id, match_id")
    .all();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, 8);
  assert.equal((await h.dependencies.readActivation()).importAttemptId, null);
});

test("a second export cannot claim incompatible rows or invalidate the verified original import", async (t) => {
  const h = harness(t);
  await h.perform("export");
  await h.perform("import");
  await h.perform("verify");
  const activation = await h.dependencies.readActivation();
  const rows = h.db
    .prepare("SELECT * FROM invite_wager_states ORDER BY invite_id, match_id")
    .all();
  const directory = resolve(h.directory, "second-export");
  await manageWagerState(
    { ...h.args("export"), directory },
    { ...h.dependencies, now: () => NOW + 1 },
  );
  assert.equal(
    loadExport(directory).source.digest,
    loadExport(h.directory).source.digest,
  );
  await assert.rejects(
    manageWagerState({ ...h.args("import"), directory }, h.dependencies),
    /control update conflicted/,
  );
  assert.deepEqual(await h.dependencies.readActivation(), activation);
  assert.deepEqual(
    h.db
      .prepare("SELECT * FROM invite_wager_states ORDER BY invite_id, match_id")
      .all(),
    rows,
  );
  await h.perform("activate");
  assert.equal((await h.dependencies.readActivation()).activationEpoch, 1);
});

test("conflicting destination contents fail closed and stay available for reconciliation", async (t) => {
  const h = harness(t);
  await h.perform("export");
  const manifest = loadExport(h.directory);
  await h.dependencies.beginImport(manifest);
  h.db
    .prepare("INSERT INTO invite_wager_states VALUES (?, ?, ?, ?, 1, ?)")
    .run("a", "a", '{"different":true}', null, NOW);
  await assert.rejects(h.perform("import"), /conflicts/);
  assert.equal(
    h.db
      .prepare(
        "SELECT wager_json FROM invite_wager_states WHERE invite_id = 'a'",
      )
      .get()!.wager_json,
    '{"different":true}',
  );
  assert.equal((await h.dependencies.readActivation()).activationEpoch, 0);
});

test("every mutation requires both freezes, stable generation and drained admissions and gameplay leases", async (t) => {
  const h = harness(t);
  h.db.exec("UPDATE profile_canonical_control SET state = 'active'");
  await assert.rejects(h.perform("export"), /freeze canonical/);
  h.db.exec(
    "UPDATE profile_canonical_control SET state = 'frozen'; UPDATE wager_reservation_runtime_control SET storage_mode = 'd1'",
  );
  await assert.rejects(h.perform("export"), /freeze canonical/);
  h.db.exec(
    "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen'; INSERT INTO wager_reservation_write_admissions (admission_id, uncertain, expires_at_ms) VALUES ('expired-uncertain', 1, 1)",
  );
  await assert.rejects(h.perform("export"), /drained/);
  assert.equal(
    h.db
      .prepare(
        "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
      )
      .get()!.count,
    1,
  );
  h.db.exec(
    `DELETE FROM wager_reservation_write_admissions; INSERT INTO game_session_mutation_locks VALUES ('busy', ${NOW + 1})`,
  );
  await assert.rejects(h.perform("export"), /drained/);
  h.db.exec("DELETE FROM game_session_mutation_locks");
  await h.perform("export");
  h.db.exec(
    "UPDATE wager_reservation_runtime_control SET freeze_generation = 4",
  );
  await assert.rejects(h.perform("import"), /generation changed/);
  assert.equal((await h.dependencies.countRows()).rowCount, 0);
});

test("verification rejects source changes, added marker-only history and tampered artifacts", async (t) => {
  const h = harness(t);
  await h.perform("export");
  await h.perform("import");
  h.source.d.matchesWagerResolutions = {
    "d-history": true,
    "d-false-marker": false,
    "d-added-history": true,
  };
  await assert.rejects(h.perform("activate"), /source changed/);
  assert.equal((await h.dependencies.readActivation()).activationEpoch, 0);
  const path = resolve(h.directory, "source-000000.json");
  const page = JSON.parse(readFileSync(path, "utf8"));
  page.rows[0].wagerJson = '{"edited":true}';
  writeFileSync(path, JSON.stringify(page), { mode: 0o600 });
  assert.throws(() => loadExport(h.directory), /digest mismatch/);
});

for (const [name, sql] of [
  [
    "profile material balances",
    'UPDATE profile_records SET payload_json = \'{"mining":{"materials":{"dust":99}}}\'',
  ],
  [
    "frozen balances",
    "UPDATE wager_frozen_balances SET revision = revision + 1",
  ],
  [
    "consumed operation tombstones",
    "DELETE FROM wager_frozen_operations WHERE operation_id = 'old-consumed'",
  ],
  [
    "settlement transfer receipts",
    "UPDATE wager_settlements SET fingerprint = 'different'",
  ],
] as const) {
  test(`activation rejects changed ${name}`, async (t) => {
    const h = harness(t);
    await h.perform("export");
    await h.perform("import");
    h.db.exec(sql);
    await assert.rejects(
      h.perform("activate"),
      /tombstones or settlement receipts changed/,
    );
    assert.equal((await h.dependencies.readActivation()).activationEpoch, 0);
  });
}

test("destination verification detects extra rows and advanced revisions", async (t) => {
  const h = harness(t);
  await h.perform("export");
  await h.perform("import");
  const manifest = loadExport(h.directory);
  await h.dependencies.beginImport(manifest);
  h.db
    .prepare(
      "INSERT INTO invite_wager_states VALUES ('orphan', 'old', '{}', 1, 1, ?)",
    )
    .run(NOW);
  await h.dependencies.finishImport(manifest);
  await assert.rejects(h.perform("verify"), /extra, missing or changed/);
  await h.dependencies.beginImport(manifest);
  h.db.exec(
    "DELETE FROM invite_wager_states WHERE invite_id = 'orphan'; UPDATE invite_wager_states SET revision = 2 WHERE invite_id = 'a'",
  );
  await h.dependencies.finishImport(manifest);
  await assert.rejects(h.perform("verify"), /immutable imported revision/);
});

test("activation retries identify committed proof without replaying imports or requiring unchanged post-resume balances", async (t) => {
  const h = harness(t);
  await h.perform("export");
  await h.perform("import");
  await assert.rejects(
    h.perform("activate", {
      activate: async (...args) => {
        await h.dependencies.activate(...args);
        throw new Error("uncertain activation response");
      },
    }),
    /uncertain activation/,
  );
  assert.equal((await h.dependencies.readActivation()).activationEpoch, 1);
  h.db.exec(
    "UPDATE profile_canonical_control SET state = 'active'; UPDATE wager_reservation_runtime_control SET storage_mode = 'd1'; UPDATE profile_records SET revision = revision + 1",
  );
  await h.perform("activate", {
    readInvitePage: async () => {
      throw new Error("must not re-read retired source");
    },
  });
  assert.equal(h.logs.at(-1)!.alreadyActivated, true);
  await assert.rejects(
    manageWagerState(
      {
        ...h.args("activate"),
        candidateVersionId: "12345678-1234-1234-1234-123456789012",
      },
      h.dependencies,
    ),
    /candidate/,
  );
  await assert.rejects(h.perform("import"), /cannot be imported/);
});

test("empty projects export and activate with the empty manifest without inventing state", async (t) => {
  const h = harness(t, {});
  await h.perform("export");
  assert.equal(loadExport(h.directory).pages.length, 0);
  await h.perform("import");
  await h.perform("activate");
  assert.equal((await h.dependencies.countRows()).rowCount, 0);
});

test("preflight is read-only on active production controls and does not need the activation schema", async (t) => {
  const h = harness(t);
  h.db.exec(
    "UPDATE profile_canonical_control SET state = 'active'; UPDATE wager_reservation_runtime_control SET storage_mode = 'd1'",
  );
  h.queries.length = 0;
  await manageWagerState(parseArgs(["--preflight", "--page-size", "2"]), {
    ...h.dependencies,
    readActivation: async () => {
      throw new Error("activation schema not deployed");
    },
  });
  assert.deepEqual(readdirSync(h.directory), []);
  assert.equal(
    h.queries.every((query) => query.startsWith("SELECT ")),
    true,
  );
  const log = h.logs.at(-1)!;
  assert.equal(log.activationProof, false);
  assert.deepEqual(log.states, {
    proposalRows: 1,
    agreedRows: 1,
    pendingSettlements: 1,
    completedSettlements: 1,
    resolvedRows: 1,
    markerOnlyRows: 2,
    nonObjectWagers: 0,
  });
});

test("Firebase pagination and raw preservation reject silent truncation or coercion", () => {
  assert.deepEqual(
    ["z", "10", "2", "01", "-2", "a"].sort(compareFirebaseKeys),
    ["-2", "01", "2", "10", "a", "z"],
  );
  const source = JSON.parse(
    '{"a":{"wagers":{"a":{"__proto__":{"retained":true},"unknown":[false,null,1.5]}}}}',
  );
  const page = normalizeSourcePage(source, 0, null, 1);
  assert.deepEqual(JSON.parse(page.rows[0].wagerJson!), source.a.wagers.a);
  assert.throws(
    () => normalizeSourcePage({ a: { wagers: "invalid-map" } }, 0, null, 1),
    /aggregate/,
  );
  assert.throws(
    () =>
      normalizeSourcePage(
        { a: { matchesWagerResolutions: { a: "true" } } },
        0,
        null,
        1,
      ),
    /nonboolean/,
  );
  assert.throws(
    () => normalizeSourcePage({ b: {} }, 1, "a", 1),
    /cursor changed/,
  );
  assert.throws(
    () => normalizeSourcePage({ a: {}, b: {} }, 0, null, 1),
    /pagination/,
  );
  assert.throws(
    () => canonicalJson({ count: Number.MAX_SAFE_INTEGER + 1 }),
    /unsafe-json-number/,
  );
});

test("ledger hashing uses bounded keyset pages and preserves the entire dataset", async (t) => {
  const h = harness(t, {});
  const insert = h.db.prepare(
    "INSERT INTO profile_records VALUES (?, '{}', 1)",
  );
  for (let index = 0; index < 205; index++)
    insert.run(`profile-${String(index).padStart(4, "0")}`);
  const baseline = await h.dependencies.readBaseline();
  assert.equal(baseline.tables[0].count, 206);
  assert.ok(
    h.queries.filter((sql) => sql.startsWith("SELECT * FROM profile_records"))
      .length >= 4,
  );
  assert.equal(
    h.queries
      .filter((sql) => sql.startsWith("SELECT * FROM profile_records"))
      .every((sql) => sql.endsWith("LIMIT 100")),
    true,
  );
});

test("numeric invite pagination matches Firebase leading-zero and integer-boundary ordering", async (t) => {
  const h = harness(
    t,
    Object.fromEntries(
      ["0", "00", "001", "2", "2147483647", "2147483648", "a"].map(
        (inviteId) => [
          inviteId,
          { wagers: { [inviteId]: { retained: true } } },
        ],
      ),
    ),
  );
  await h.perform("export");
  assert.deepEqual(h.sourceReads, [null, "00", "2", "2147483648", "a"]);
  await h.perform("import");
  await h.perform("activate");
  assert.equal((await h.dependencies.countRows()).rowCount, 7);
});

test("preflight diagnoses non-object historical wagers and export refuses to change or discard them", async (t) => {
  const source = sourceFixture();
  source.e = { wagers: { legacy: ["private-legacy-content"] } };
  const h = harness(t, source);
  await h.perform("preflight");
  assert.equal(
    (h.logs.at(-1)!.states as Record<string, unknown>).nonObjectWagers,
    1,
  );
  await assert.rejects(
    h.perform("export"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "non-object wager aggregate: e/legacy",
  );
  assert.deepEqual(h.source.e, {
    wagers: { legacy: ["private-legacy-content"] },
  });
  assert.equal(existsSync(resolve(h.directory, "manifest.json")), false);
});

test("D1 runner sends query bindings in authenticated HTTP bodies and rejects bulk import summaries", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const run = createWranglerRunner({
    apiToken: "test-api-token",
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init! });
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ singleton: 1 }] }],
      });
    }) as typeof fetch,
  });
  const sql = "INSERT INTO fixture VALUES (?) RETURNING singleton";
  assert.deepEqual(
    await run(sql, "mons-link-profiles", ["private-wager-content"]),
    [{ singleton: 1 }],
  );
  assert.match(
    requests[0].url,
    /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[a-f0-9-]{36}\/query$/,
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    sql,
    params: ["private-wager-content"],
  });
  assert.equal(
    (requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer test-api-token",
  );
  assert.equal(requests[0].init.redirect, "error");
  const invalid = createWranglerRunner({
    apiToken: "test-api-token",
    fetcher: (async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [{ "Total queries executed": 1 }] }],
      })) as typeof fetch,
  });
  await assert.rejects(
    invalid("SELECT singleton FROM fixture"),
    /bulk import summary/,
  );
  const noToken = createWranglerRunner({ apiToken: "" });
  await assert.rejects(
    noToken(sql, "mons-link-profiles", ["private-wager-content"]),
    /private wager contents/,
  );
});
