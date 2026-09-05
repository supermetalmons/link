import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { digest, QUEUE_NAMES } from "./migrate-wager-reservations.ts";
import {
  assertSource,
  buildActivationSql,
  buildClaimSql,
  buildImportBatches,
  firebaseDatabaseGetArgs,
  migrateRatingCompletions,
  normalizeSource,
  parseArgs,
  parseControl,
  persistArtifacts,
  readRemoteState,
  readSource,
  sourceCompletions,
  SQL_BATCH_BYTES,
  type Dependencies,
  type Inspection,
  type Options,
} from "./migrate-rating-completions.ts";

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
const preview: Options = { phase: "preview", project: "mons-link" };
const observe: Options = {
  ...preview,
  phase: "observe",
  evidenceFile: "evidence",
};
const final: Options = {
  ...observe,
  phase: "final",
  observationFile: "observation",
};

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE profile_canonical_control (singleton INTEGER PRIMARY KEY, state TEXT); INSERT INTO profile_canonical_control VALUES (1, 'frozen'); CREATE TABLE unrelated_sentinel(value TEXT); INSERT INTO unrelated_sentinel VALUES ('retained');",
  );
  db.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/profile-migrations/0013_rating_completions.sql",
      ),
      "utf8",
    ),
  );
  const source: Record<string, unknown> = {
    auto_first: { auto_first: true, auto_first1: false },
    legacy: { "legacy-match": true },
  };
  const inspection: Inspection = {
    canonicalState: "frozen",
    activeRatingLeases: 0,
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
    readState: () =>
      readRemoteState(
        (sql) => db.prepare(sql).all() as Record<string, unknown>[],
      ),
    inspect: () => structuredClone(inspection),
    executeSql: (sql) => {
      statements.push(sql);
      db.exec(sql);
    },
    persistArtifacts: (artifacts, phase) => {
      for (const [name, value] of Object.entries(artifacts)) {
        if (name.endsWith(".json"))
          files.set(`${phase}/${name}`, JSON.parse(value));
      }
      return `${phase}/private-artifacts`;
    },
  };
  return {
    db,
    source,
    inspection,
    files,
    logs,
    statements,
    dependencies,
    setNow: (value: number) => (now = value),
    sourceReads: () => sourceReads,
    observe: () => {
      migrateRatingCompletions(observe, dependencies);
      files.set("observation", files.get("observe/observation.json"));
      now = FINAL;
    },
  };
}

test("preview is the default and mutation arguments are strict", () => {
  assert.deepEqual(parseArgs([]), preview);
  assert.deepEqual(
    parseArgs([
      "--final",
      "--evidence-file",
      "evidence",
      "--observation",
      "observation",
    ]),
    final,
  );
  for (const args of [
    ["--observe"],
    ["--final", "--evidence-file", "evidence"],
    ["--preview", "--evidence-file", "evidence"],
    ["--observe", "--final"],
    ["--project", "x", "--project", "x"],
    ["--unknown"],
    ["--project"],
    ["--observe", "--project", "demo-test", "--evidence-file", "evidence"],
  ])
    assert.throws(() => parseArgs(args));
});

test("canonical export pins its Firebase instance and rejects source overrides", () => {
  assert.deepEqual(firebaseDatabaseGetArgs("mons-link", "/invites", true), [
    "database:get",
    "/invites",
    "--project",
    "mons-link",
    "--instance",
    "mons-link-default-rtdb",
    "--shallow",
  ]);
  assert.doesNotThrow(() => assertSource(preview, {}));
  for (const key of [
    "FIREBASE_CONFIG",
    "FIREBASE_REALTIME_URL",
    "FIREBASE_DATABASE_EMULATOR_HOST",
    "FIREBASE_RTDB_HOST",
  ])
    assert.throws(
      () => assertSource(preview, { [key]: "override" }),
      /overrides/,
    );
});

test("export reads only invite IDs and completion children, preserving false flags", () => {
  const calls: [string, boolean | undefined][] = [];
  const source = readSource("mons-link", (path, shallow) => {
    calls.push([path, shallow]);
    if (path === "/invites") return { "legacy invite": true, empty: true };
    if (path.endsWith("empty/matchesRatingUpdates")) return null;
    return { "legacy-match": true, pending: false };
  });
  assert.deepEqual(calls, [
    ["/invites", true],
    ["/invites/empty/matchesRatingUpdates", undefined],
    ["/invites/legacy%20invite/matchesRatingUpdates", undefined],
  ]);
  assert.deepEqual(sourceCompletions(source), [
    { inviteId: "legacy invite", matchId: "legacy-match" },
  ]);
  assert.equal(source["legacy invite"].pending, false);
  assert.throws(
    () => readSource("mons-link", () => ({ wrong: false })),
    /inventory/,
  );
});

test("legacy invite keys survive Firebase CLI URL handling", () => {
  const { getDatabaseUrl } = createRequire(import.meta.url)(
    "firebase-tools/lib/utils.js",
  ) as {
    getDatabaseUrl(origin: string, namespace: string, path: string): string;
  };
  for (const inviteId of [
    "auto_legacy%20invite",
    "auto_legacy\\invite",
    "auto_legacy?invite",
    "古い招待",
  ]) {
    const source = readSource("mons-link", (path, shallow) => {
      if (shallow) return { [inviteId]: true };
      const url = new URL(
        getDatabaseUrl(
          "https://mons-link-default-rtdb.firebaseio.com",
          "mons-link-default-rtdb",
          `${path}.json`,
        ),
      );
      assert.equal(url.search, "");
      assert.deepEqual(url.pathname.split("/").map(decodeURIComponent), [
        "",
        "invites",
        inviteId,
        "matchesRatingUpdates.json",
      ]);
      return { [inviteId]: true };
    });
    assert.deepEqual(sourceCompletions(source), [
      { inviteId, matchId: inviteId },
    ]);
  }
});

test("normalization retains unusual valid legacy keys and rejects malformed evidence", () => {
  const input = JSON.parse(
    '{"__proto__":{"constructor":true,"é":true},"古い招待":{"💫":true}}',
  );
  assert.equal(sourceCompletions(normalizeSource(input)).length, 3);
  for (const value of [
    [],
    { "bad/key": { good: true } },
    { good: { "bad/key": true } },
    { good: { match: "true" } },
    { good: { match: 1 } },
    { good: { match: null } },
    { good: true },
  ])
    assert.throws(() => normalizeSource(value));
  assert.deepEqual(sourceCompletions(normalizeSource(null)), []);
});

test("numeric marker arrays preserve flags, skip null holes, and import correctly", () => {
  const source = readSource("mons-link", (path, shallow) => {
    if (shallow) return { "0": true, "1": true };
    return path.includes("/0/") ? [true, null, false, true] : [true, true];
  });
  const expected = normalizeSource({
    "0": { "0": true, "2": false, "3": true },
    "1": { "0": true, "1": true },
  });
  assert.deepEqual(source, expected);
  assert.equal(digest(source), digest(expected));
  assert.deepEqual(sourceCompletions(source), [
    { inviteId: "0", matchId: "0" },
    { inviteId: "0", matchId: "3" },
    { inviteId: "1", matchId: "0" },
    { inviteId: "1", matchId: "1" },
  ]);
  assert.deepEqual(
    sourceCompletions(normalizeSource({ empty: [null, null] })),
    [],
  );
  for (const markers of [[1], ["true"], [{}], [[]], [undefined]]) {
    assert.throws(
      () => normalizeSource({ legacy: markers }),
      /invalid rating completion marker/,
    );
  }

  const state = harness();
  state.source.legacy = [true, null, false, true];
  state.observe();
  migrateRatingCompletions(final, state.dependencies);
  assert.deepEqual(state.dependencies.readState().completions, [
    { inviteId: "auto_first", matchId: "auto_first" },
    { inviteId: "legacy", matchId: "0" },
    { inviteId: "legacy", matchId: "3" },
  ]);
});

test("preview and observation never execute SQL or activate storage", () => {
  const state = harness();
  state.inspection.canonicalState = "active";
  migrateRatingCompletions(preview, state.dependencies);
  assert.equal(state.statements.length, 0);
  assert.equal(state.dependencies.readState().control?.activatedAtMs, null);
  assert.equal(JSON.parse(state.logs[0]).sourceCount, 2);
  assert.equal(JSON.parse(state.logs[0]).missingCount, 2);
  state.inspection.canonicalState = "frozen";
  state.observe();
  assert.equal(state.statements.length, 0);
  assert.equal(state.sourceReads(), 2);
});

test("preview works before migration, while observation requires the new schema", () => {
  const state = harness();
  state.dependencies.readState = () => ({ control: null, completions: [] });
  migrateRatingCompletions(preview, state.dependencies);
  assert.equal(JSON.parse(state.logs[0]).activated, false);
  assert.throws(() => state.observe(), /migration 0013/);
  assert.equal(state.statements.length, 0);
});

test("final preserves marker-only evidence, verifies exact rows, and activates once", () => {
  const state = harness();
  state.observe();
  migrateRatingCompletions(final, state.dependencies);
  assert.deepEqual(state.dependencies.readState(), {
    control: {
      activatedAtMs: FINAL,
      sourceDigest: digest(normalizeSource(state.source)),
      sourceCount: 2,
    },
    completions: [
      { inviteId: "auto_first", matchId: "auto_first" },
      { inviteId: "legacy", matchId: "legacy-match" },
    ],
  });
  assert.equal(state.sourceReads(), 3);
  assert.equal(
    state.db.prepare("SELECT value FROM unrelated_sentinel").get()?.value,
    "retained",
  );
  const statementCount = state.statements.length;
  assert.throws(
    () => migrateRatingCompletions(final, state.dependencies),
    /already activated/,
  );
  assert.equal(state.statements.length, statementCount);
  assert.ok(state.files.has("final/activation.json"));
});

test("empty completion evidence is a valid activated import", () => {
  const state = harness();
  for (const key of Object.keys(state.source)) delete state.source[key];
  state.observe();
  migrateRatingCompletions(final, state.dependencies);
  assert.equal(state.dependencies.readState().control?.sourceCount, 0);
  assert.equal(state.dependencies.readState().control?.activatedAtMs, FINAL);
});

test("freeze, queue drain, lease drain, and deployment checks fail before writes", () => {
  const changes = [
    (state: ReturnType<typeof harness>) =>
      (state.inspection.canonicalState = "active"),
    (state: ReturnType<typeof harness>) =>
      (state.inspection.activeRatingLeases = 1),
    (state: ReturnType<typeof harness>) =>
      (state.inspection.activeProjectionLeases = 1),
    (state: ReturnType<typeof harness>) =>
      (state.inspection.deployment.versionId = "other"),
    (state: ReturnType<typeof harness>) =>
      (state.inspection.deployment.deployedAtMs = 5_000),
    (state: ReturnType<typeof harness>) => state.setNow(100_000),
  ];
  for (const change of changes) {
    const state = harness();
    change(state);
    assert.throws(() => migrateRatingCompletions(observe, state.dependencies));
    assert.equal(state.statements.length, 0);
  }
});

test("changed or premature observations fail before SQL, including false-flag changes", () => {
  for (const change of [
    (state: ReturnType<typeof harness>) => state.setNow(FIRST + 100),
    (state: ReturnType<typeof harness>) =>
      (state.source.auto_first = { auto_first: true }),
    (state: ReturnType<typeof harness>) =>
      (state.source.new_invite = { new_match: true }),
    (state: ReturnType<typeof harness>) => {
      const observation = state.files.get("observation") as Record<
        string,
        unknown
      >;
      observation.sourceDigest = "f".repeat(64);
    },
  ]) {
    const state = harness();
    state.observe();
    change(state);
    assert.throws(() => migrateRatingCompletions(final, state.dependencies));
    assert.equal(state.statements.length, 0);
  }
});

test("an interrupted import can resume the same evidence without overwriting rows", () => {
  const state = harness();
  state.observe();
  const execute = state.dependencies.executeSql;
  let fail = true;
  state.dependencies.executeSql = (sql) => {
    execute(sql);
    if (sql.startsWith("INSERT") && fail) {
      fail = false;
      throw new Error("interrupted after committed rows");
    }
  };
  assert.throws(
    () => migrateRatingCompletions(final, state.dependencies),
    /interrupted/,
  );
  assert.equal(state.dependencies.readState().control?.activatedAtMs, null);
  state.setNow(FINAL + 50);
  migrateRatingCompletions(final, state.dependencies);
  assert.equal(
    state.dependencies.readState().control?.activatedAtMs,
    FINAL + 50,
  );
  assert.equal(
    state.db
      .prepare(
        "SELECT MIN(imported_at_ms) AS imported FROM legacy_rating_completions",
      )
      .get()?.imported,
    FINAL,
  );
});

test("partial or changed imports never publish activation", () => {
  for (const mode of ["missing-row", "changed-source", "changed-freeze"]) {
    const state = harness();
    state.observe();
    const execute = state.dependencies.executeSql;
    state.dependencies.executeSql = (sql) => {
      if (mode === "missing-row" && sql.startsWith("INSERT")) return;
      execute(sql);
      if (sql.startsWith("INSERT")) {
        if (mode === "changed-source") state.source.new = { match: true };
        if (mode === "changed-freeze")
          state.inspection.canonicalState = "active";
      }
    };
    assert.throws(() => migrateRatingCompletions(final, state.dependencies));
    assert.equal(state.dependencies.readState().control?.activatedAtMs, null);
  }
});

test("unexpected retained evidence and a different pinned source block activation", () => {
  const state = harness();
  state.observe();
  state.db.exec(buildClaimSql("f".repeat(64), 1));
  state.db.exec(
    "INSERT INTO legacy_rating_completions VALUES ('unexpected', 'match', 1)",
  );
  assert.throws(
    () => migrateRatingCompletions(final, state.dependencies),
    /outside the source/,
  );
  assert.equal(state.statements.length, 0);
  const other = harness();
  other.observe();
  other.db.exec(buildClaimSql("f".repeat(64), 0));
  assert.throws(
    () => migrateRatingCompletions(final, other.dependencies),
    /source changed/,
  );
  assert.equal(other.dependencies.readState().control?.activatedAtMs, null);
});

test("schema guards protect evidence from active writes and post-activation changes", () => {
  const state = harness();
  const sourceDigest = "a".repeat(64);
  state.db.exec(buildClaimSql(sourceDigest, 1));
  const insert = buildImportBatches(
    [{ inviteId: "invite", matchId: "match" }],
    sourceDigest,
    1,
  )[0];
  state.db.exec("UPDATE profile_canonical_control SET state = 'active'");
  assert.throws(
    () =>
      state.db.exec(
        "INSERT INTO legacy_rating_completions VALUES ('invite', 'match', 1)",
      ),
    /requires-freeze/,
  );
  state.db.exec(insert);
  assert.equal(state.dependencies.readState().completions.length, 0);
  state.db.exec("UPDATE profile_canonical_control SET state = 'frozen'");
  state.db.exec(insert);
  assert.throws(
    () =>
      state.db.exec("UPDATE legacy_rating_completions SET imported_at_ms = 2"),
    /immutable/,
  );
  assert.throws(
    () => state.db.exec("DELETE FROM legacy_rating_completions"),
    /immutable/,
  );
  assert.throws(
    () =>
      state.db.exec(
        "UPDATE rating_completion_control SET source_digest = '" +
          "b".repeat(64) +
          "'",
      ),
    /source-changed/,
  );
  state.db.exec(buildActivationSql(sourceDigest, 1, 2));
  assert.throws(
    () =>
      state.db.exec(
        "INSERT INTO legacy_rating_completions VALUES ('new', 'match', 1)",
      ),
    /unavailable/,
  );
  assert.throws(
    () =>
      state.db.exec(
        "UPDATE rating_completion_control SET activated_at_ms = NULL",
      ),
    /already-activated/,
  );
});

test("bounded SQL batches preserve escaping and all Unicode completion pairs", () => {
  const state = harness();
  const rows = Array.from({ length: 250 }, (_, index) => ({
    inviteId: `invite'${index}`,
    matchId: `古い💫match${index}`,
  }));
  const sourceDigest = "b".repeat(64);
  const batches = buildImportBatches(rows, sourceDigest, 10);
  assert.ok(batches.length > 1);
  assert.ok(
    batches.every((batch) => Buffer.byteLength(batch) <= SQL_BATCH_BYTES),
  );
  state.db.exec(buildClaimSql(sourceDigest, rows.length));
  for (const batch of batches) state.db.exec(batch);
  assert.equal(state.dependencies.readState().completions.length, rows.length);
  assert.equal(
    state.db.prepare("SELECT COUNT(*) AS count FROM unrelated_sentinel").get()
      ?.count,
    1,
  );
});

test("D1 pagination and control parsing fail closed on incomplete data", () => {
  assert.deepEqual(
    readRemoteState(() => []),
    { control: null, completions: [] },
  );
  assert.throws(
    () => readRemoteState(() => [{ name: "legacy_rating_completions" }]),
    /incomplete/,
  );
  for (const row of [
    undefined,
    { activated_at_ms: null, source_digest: null, source_count: 0 },
    { activated_at_ms: 1, source_digest: null, source_count: null },
    { activated_at_ms: null, source_digest: "bad", source_count: 1 },
  ])
    assert.throws(() => parseControl(row));
  const state = harness();
  const rows = Array.from({ length: 510 }, (_, index) => ({
    inviteId: `invite-${index}`,
    matchId: "match",
  }));
  state.db.exec(buildClaimSql("c".repeat(64), rows.length));
  for (const batch of buildImportBatches(rows, "c".repeat(64), 1))
    state.db.exec(batch);
  assert.equal(state.dependencies.readState().completions.length, 510);
});

test("migration artifacts are private and logs contain no source identifiers", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "rating-completion-test-"));
  try {
    const artifact = persistArtifacts(
      { "source.json": '{"private":true}' },
      "preview",
      1,
      directory,
    );
    assert.equal(statSync(artifact).mode & 0o777, 0o700);
    assert.equal(
      statSync(resolve(artifact, "source.json")).mode & 0o777,
      0o600,
    );
    assert.equal(
      readFileSync(resolve(artifact, "source.json"), "utf8"),
      '{"private":true}',
    );
    assert.throws(() =>
      persistArtifacts({ "../public.json": "secret" }, "preview", 2, directory),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const state = harness();
  state.observe();
  migrateRatingCompletions(final, state.dependencies);
  assert.ok(
    state.logs.every(
      (log) => !log.includes("auto_first") && !log.includes("legacy-match"),
    ),
  );
});
