import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertMigrationSource,
  buildD1ControlTransitionSql,
  buildD1ReplacementSql,
  buildRtdbTimerRoot,
  digest,
  firebaseDatabaseGetArgs,
  firebaseDatabaseSetArgs,
  migrateGameplayCoordination,
  normalizeApiDeployment,
  normalizeApiVersion,
  normalizeD1TimerMarkers,
  normalizeGameplayControl,
  normalizeLegacySnapshot,
  parseArgs,
  persistMigrationArtifacts,
  type D1TimerMarker,
  type GameplayCoordinationControl,
  type LegacySnapshot,
  type MigrationDependencies,
  type MigrationOptions,
  type TimerMarker,
} from "./migrate-gameplay-coordination.ts";

const TEST_SOURCE_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EMPTY_MARKER_DIGEST = digest([]);

function marker(
  playerId: string,
  matchId: string,
  turnNumber: number,
  targetTimestamp = 100_000 + turnNumber,
): TimerMarker {
  return {
    playerId,
    matchId,
    timer: `${turnNumber};${targetTimestamp}`,
    turnNumber,
  };
}

function d1Marker(
  playerId: string,
  matchId: string,
  turnNumber: number,
  updatedAtMs = 10_000,
  targetTimestamp = 100_000 + turnNumber,
  opponentId: string | null = null,
): D1TimerMarker {
  return {
    ...marker(playerId, matchId, turnNumber, targetTimestamp),
    opponentId,
    updatedAtMs,
  };
}

function snapshot(
  timerMarkers: TimerMarker[] = [],
  leases: LegacySnapshot["leases"] = [],
): LegacySnapshot {
  return { leases, timerMarkers };
}

function control(
  authority: "uninitialized" | "rtdb" | "d1",
  generation = authority === "uninitialized" ? 0 : authority === "d1" ? 1 : 2,
): GameplayCoordinationControl {
  if (authority === "uninitialized") {
    return {
      authority,
      generation,
      sourceCount: null,
      sourceDigest: null,
      sourceVersionId: null,
      transitionedAtMs: 0,
    };
  }
  return {
    authority,
    generation,
    sourceCount: 0,
    sourceDigest: EMPTY_MARKER_DIGEST,
    sourceVersionId: OTHER_VERSION_ID,
    transitionedAtMs: 1,
  };
}

function mutatingOptions(
  phase: "final" | "rollback",
  allowEmptySourceDigest?: string,
): MigrationOptions {
  return {
    phase,
    project: "mons-link",
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    ...(allowEmptySourceDigest ? { allowEmptySourceDigest } : {}),
  };
}

function adoptionOptions(expectedTimerDigest: string): MigrationOptions {
  return {
    phase: "adopt-d1",
    project: "mons-link",
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    expectedTimerDigest,
  };
}

type HarnessOptions = {
  activeD1Leases?: number;
  apiDeployment?: MigrationDependencies["readApiDeployment"];
  apiVersionAuthority?: "rtdb" | "d1" | null;
  applyD1?: "success" | "throw-before" | "throw-after";
  coordinationControl?: GameplayCoordinationControl | null;
  d1?: D1TimerMarker[];
  legacy?: LegacySnapshot;
  profileControl?: string;
  setRtdb?: "success" | "throw-before" | "throw-after";
  transitionControl?: "success" | "throw-before" | "throw-after";
};

function harness(options: HarnessOptions = {}) {
  const files: Record<string, string> = {};
  const logs: string[] = [];
  const state = {
    control:
      "coordinationControl" in options
        ? options.coordinationControl || null
        : control("rtdb"),
    d1: options.d1 || [],
    legacy: options.legacy || snapshot(),
  };
  const writes = { d1: 0, rtdb: 0, control: 0 };
  const dependencies: MigrationDependencies = {
    applyD1Transition: () => {
      writes.d1 += 1;
      if (options.applyD1 === "throw-before") throw new Error("ambiguous");
      state.d1 = JSON.parse(
        files["d1-expected.json"] || "[]",
      ) as D1TimerMarker[];
      const metadata = JSON.parse(files["metadata.json"] || "{}") as {
        controlAfter: GameplayCoordinationControl;
      };
      state.control = metadata.controlAfter;
      if (options.applyD1 === "throw-after") throw new Error("ambiguous");
    },
    log: (message) => logs.push(message),
    now: () => 10_000,
    persistArtifacts: ({ files: nextFiles }) => {
      Object.assign(files, nextFiles);
      return {
        paths: Object.fromEntries(
          Object.keys(nextFiles).map((name) => [name, `/secure/${name}`]),
        ),
      };
    },
    readActiveD1Leases: () => options.activeD1Leases || 0,
    readApiDeployment:
      options.apiDeployment ||
      (() => ({
        versions: [{ versionId: TEST_SOURCE_VERSION_ID, percentage: 100 }],
      })),
    readApiVersion: (versionId) => ({
      versionId,
      declaredAuthority:
        "apiVersionAuthority" in options
          ? options.apiVersionAuthority || null
          : state.control?.authority === "d1"
            ? "d1"
            : "rtdb",
    }),
    readD1TimerMarkers: () => structuredClone(state.d1),
    readGameplayControl: () =>
      state.control ? structuredClone(state.control) : null,
    readLegacySnapshot: () => structuredClone(state.legacy),
    readProfileControl: () => options.profileControl || "frozen",
    setRtdbTimerMarkers: () => {
      writes.rtdb += 1;
      if (options.setRtdb === "throw-before") throw new Error("ambiguous");
      state.legacy.timerMarkers = normalizeLegacySnapshot({
        locks: Object.fromEntries(
          state.legacy.leases.map((lease) => [
            lease.lockId,
            {
              ownerId: lease.ownerId,
              operationId: lease.operationId,
              expiresAtMs: lease.expiresAtMs,
            },
          ]),
        ),
        timerStarts: JSON.parse(files["rtdb-set.json"] || "{}") as unknown,
      }).timerMarkers;
      if (options.setRtdb === "throw-after") throw new Error("ambiguous");
    },
    transitionGameplayControl: (_expected, next) => {
      writes.control += 1;
      if (options.transitionControl === "throw-before") {
        throw new Error("ambiguous");
      }
      state.control = structuredClone(next);
      if (options.transitionControl === "throw-after") {
        throw new Error("ambiguous");
      }
    },
    wait: () => {},
  };
  return { dependencies, files, logs, state, writes };
}

function applySchema(database: DatabaseSync): void {
  database.exec(
    readFileSync(
      resolve("cloud/workers/api/migrations/0007_gameplay_coordination.sql"),
      "utf8",
    ),
  );
  database.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/migrations/0008_gameplay_coordination_control.sql",
      ),
      "utf8",
    ),
  );
}

test("0008 adds reconciliation metadata and durable transition control", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  applySchema(database);
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT authority, generation, source_digest, source_count, source_version_id, transitioned_at_ms FROM gameplay_coordination_control",
        )
        .get(),
    },
    {
      authority: "uninitialized",
      generation: 0,
      source_digest: null,
      source_count: null,
      source_version_id: null,
      transitioned_at_ms: 0,
    },
  );
  assert.throws(() =>
    database.exec("DELETE FROM gameplay_coordination_control"),
  );
  assert.throws(() =>
    database.exec(
      "INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms, opponent_id) VALUES ('player', 'match', '1;100001', 1, 1, 'bad/opponent')",
    ),
  );
  assert.throws(() =>
    database.exec(
      `UPDATE gameplay_coordination_control SET authority = 'rtdb', generation = 1, source_digest = '${EMPTY_MARKER_DIGEST}', source_count = 0, source_version_id = '${OTHER_VERSION_ID}', transitioned_at_ms = 1`,
    ),
  );
  const adopted: GameplayCoordinationControl = {
    authority: "d1",
    generation: 1,
    sourceCount: 0,
    sourceDigest: EMPTY_MARKER_DIGEST,
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    transitionedAtMs: 1,
  };
  database.exec(buildD1ControlTransitionSql(control("uninitialized"), adopted));
  assert.equal(
    database
      .prepare("SELECT authority FROM gameplay_coordination_control")
      .get()?.authority,
    "d1",
  );
});

test("normalizes empty, ordered, and malformed snapshots", () => {
  assert.deepEqual(
    normalizeLegacySnapshot({ locks: null, timerStarts: null }),
    snapshot(),
  );
  const normalized = normalizeLegacySnapshot({
    locks: {
      b: { ownerId: "b", operationId: "b", expiresAtMs: 9_000 },
      a: { ownerId: "a", operationId: "a", expiresAtMs: 8_000 },
    },
    timerStarts: {
      b: { b: { timer: "2;100002", turnNumber: 2 } },
      a: { a: { timer: "1;100001", turnNumber: 1 } },
    },
  });
  assert.deepEqual(normalized.timerMarkers, [
    marker("a", "a", 1),
    marker("b", "b", 2),
  ]);
  assert.throws(() =>
    normalizeLegacySnapshot({
      locks: {
        invite: {
          ownerId: "owner",
          operationId: "operation",
          expiresAtMs: "100",
        },
      },
      timerStarts: null,
    }),
  );
  assert.throws(() =>
    normalizeLegacySnapshot({
      locks: null,
      timerStarts: { player: { match: { timer: "2;100", turnNumber: 1 } } },
    }),
  );
});

test("normalizes D1 rows and gameplay control", () => {
  assert.deepEqual(
    normalizeD1TimerMarkers([
      {
        player_id: "player",
        match_id: "match",
        timer: "1;100001",
        turn_number: 1,
        updated_at_ms: 10,
        opponent_id: "opponent",
      },
    ]),
    [d1Marker("player", "match", 1, 10, 100_001, "opponent")],
  );
  assert.deepEqual(
    normalizeGameplayControl({
      authority: "uninitialized",
      generation: 0,
      source_digest: null,
      source_count: null,
      source_version_id: null,
      transitioned_at_ms: 0,
    }),
    control("uninitialized"),
  );
  assert.throws(() =>
    normalizeGameplayControl({
      authority: "d1",
      generation: 1,
      source_digest: EMPTY_MARKER_DIGEST,
      source_count: null,
      source_version_id: null,
      transitioned_at_ms: 0,
    }),
  );
});

test("generated transition exactly replaces rows and advances generation", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  applySchema(database);
  database.exec(
    `UPDATE gameplay_coordination_control SET authority = 'd1', generation = 1, source_digest = '${EMPTY_MARKER_DIGEST}', source_count = 0, source_version_id = '${OTHER_VERSION_ID}', transitioned_at_ms = 1`,
  );
  database.exec(
    `UPDATE gameplay_coordination_control SET authority = 'rtdb', generation = 2, source_digest = '${EMPTY_MARKER_DIGEST}', source_count = 0, source_version_id = '${OTHER_VERSION_ID}', transitioned_at_ms = 2`,
  );
  database.exec(
    "INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms) VALUES ('stale', 'stale', '9;100009', 9, 1), ('same', 'same', '2;200000', 2, 1)",
  );
  const before = control("rtdb");
  const source = [d1Marker("same", "same", 2, 10_000, 300_000)];
  const after: GameplayCoordinationControl = {
    authority: "d1",
    generation: 3,
    sourceCount: 1,
    sourceDigest: digest([marker("same", "same", 2, 300_000)]),
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    transitionedAtMs: 10_000,
  };
  database.exec(buildD1ReplacementSql(source, before, after));
  assert.deepEqual(
    database
      .prepare(
        "SELECT player_id, match_id, timer, turn_number, updated_at_ms, opponent_id FROM match_timer_starts",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        player_id: "same",
        match_id: "same",
        timer: "2;300000",
        turn_number: 2,
        updated_at_ms: 10_000,
        opponent_id: null,
      },
    ],
  );
  assert.equal(
    database
      .prepare("SELECT authority FROM gameplay_coordination_control")
      .get()?.authority,
    "d1",
  );
});

test("generated transition rejects stale generation before deleting", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  applySchema(database);
  database.exec(
    "INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms) VALUES ('kept', 'kept', '1;100001', 1, 1)",
  );
  const stale = control("rtdb");
  const after: GameplayCoordinationControl = {
    authority: "d1",
    generation: 3,
    sourceCount: 0,
    sourceDigest: EMPTY_MARKER_DIGEST,
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    transitionedAtMs: 10_000,
  };
  assert.throws(() => database.exec(buildD1ReplacementSql([], stale, after)));
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM match_timer_starts").get()
      ?.count,
    1,
  );
});

test("arguments pin mutations and validate the empty-source guard", () => {
  assert.deepEqual(parseArgs([]), { phase: "preview", project: "mons-link" });
  assert.deepEqual(parseArgs(["--preview", "--project", "demo"]), {
    phase: "preview",
    project: "demo",
  });
  assert.deepEqual(
    parseArgs([
      "--final",
      "--source-version-id",
      TEST_SOURCE_VERSION_ID,
      "--allow-empty-source-digest",
      EMPTY_MARKER_DIGEST.toUpperCase(),
    ]),
    {
      phase: "final",
      project: "mons-link",
      sourceVersionId: TEST_SOURCE_VERSION_ID,
      allowEmptySourceDigest: EMPTY_MARKER_DIGEST,
    },
  );
  assert.deepEqual(
    parseArgs([
      "--adopt-d1",
      "--source-version-id",
      TEST_SOURCE_VERSION_ID,
      "--expected-timer-digest",
      EMPTY_MARKER_DIGEST,
    ]),
    adoptionOptions(EMPTY_MARKER_DIGEST),
  );
  assert.throws(() => parseArgs(["--final"]));
  assert.throws(() =>
    parseArgs(["--preview", "--allow-empty-source-digest", "bad"]),
  );
  assert.throws(() =>
    parseArgs([
      "--rollback",
      "--source-version-id",
      TEST_SOURCE_VERSION_ID,
      "--project",
      "demo",
    ]),
  );
});

test("mutations reject overrides and require the exact live version", () => {
  assert.throws(() =>
    assertMigrationSource(mutatingOptions("final"), {
      FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
    }),
  );
  assert.deepEqual(
    normalizeApiDeployment({
      versions: [{ version_id: TEST_SOURCE_VERSION_ID, percentage: 100 }],
    }),
    {
      versions: [{ versionId: TEST_SOURCE_VERSION_ID, percentage: 100 }],
    },
  );
  const run = harness({
    apiDeployment: () => ({
      versions: [{ versionId: OTHER_VERSION_ID, percentage: 100 }],
    }),
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(mutatingOptions("final"), run.dependencies),
    /not serving 100%/,
  );
});

test("reads coordination authority from immutable Worker version metadata", () => {
  assert.deepEqual(
    normalizeApiVersion({
      id: TEST_SOURCE_VERSION_ID,
      resources: { bindings: [] },
    }),
    { versionId: TEST_SOURCE_VERSION_ID, declaredAuthority: null },
  );
  assert.deepEqual(
    normalizeApiVersion({
      id: TEST_SOURCE_VERSION_ID,
      resources: {
        bindings: [
          {
            name: "GAMEPLAY_COORDINATION_AUTHORITY",
            type: "plain_text",
            text: "d1",
          },
        ],
      },
    }),
    { versionId: TEST_SOURCE_VERSION_ID, declaredAuthority: "d1" },
  );
  assert.throws(() =>
    normalizeApiVersion({
      id: TEST_SOURCE_VERSION_ID,
      resources: {
        bindings: [
          {
            name: "GAMEPLAY_COORDINATION_AUTHORITY",
            type: "plain_text",
            text: "invalid",
          },
        ],
      },
    }),
  );
});

test("normal transitions reject a source Worker in the wrong mode", () => {
  const final = harness({ apiVersionAuthority: "d1" });
  assert.throws(
    () =>
      migrateGameplayCoordination(mutatingOptions("final"), final.dependencies),
    /coordination authority does not match/,
  );
  assert.equal(final.writes.d1, 0);

  const rollback = harness({
    coordinationControl: control("d1"),
    apiVersionAuthority: null,
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        rollback.dependencies,
      ),
    /coordination authority does not match/,
  );
  assert.equal(rollback.writes.rtdb, 0);

  const untaggedRtdb = harness({ apiVersionAuthority: null });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        untaggedRtdb.dependencies,
      ),
    /coordination authority does not match/,
  );

  const mismatchedMetadata = harness();
  mismatchedMetadata.dependencies.readApiVersion = () => ({
    versionId: OTHER_VERSION_ID,
    declaredAuthority: "rtdb",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        mismatchedMetadata.dependencies,
      ),
    /metadata does not match/,
  );
});

test("preview reads both stores and control without writes or secret logs", () => {
  const run = harness({
    d1: [d1Marker("d1-secret", "match", 1)],
    legacy: snapshot([marker("rtdb-secret", "match", 2)]),
  });
  migrateGameplayCoordination(
    { phase: "preview", project: "demo" },
    run.dependencies,
  );
  assert.deepEqual(run.writes, { d1: 0, rtdb: 0, control: 0 });
  assert.ok(run.files["rtdb-source.json"]);
  assert.ok(run.files["d1-source.json"]);
  assert.equal(run.logs.length, 1);
  assert.equal(run.logs[0]?.includes("secret"), false);
  assert.equal(run.logs[0]?.includes("1;100001"), false);
});

test("preview works before the control migration is installed", () => {
  const run = harness({ coordinationControl: null });
  assert.doesNotThrow(() =>
    migrateGameplayCoordination(
      { phase: "preview", project: "mons-link" },
      run.dependencies,
    ),
  );
  const summary = JSON.parse(run.logs[0] || "{}") as Record<string, unknown>;
  assert.equal(summary.authority, "missing");
  assert.equal(summary.generation, null);
  assert.deepEqual(run.writes, { d1: 0, rtdb: 0, control: 0 });
});

test("explicit adoption records the unchanged live D1 snapshot", () => {
  const markers = [d1Marker("player", "match", 2, 100, 300_000, "opponent")];
  const expectedDigest = digest([marker("player", "match", 2, 300_000)]);
  const run = harness({
    coordinationControl: control("uninitialized"),
    d1: markers,
    apiVersionAuthority: null,
  });
  migrateGameplayCoordination(
    adoptionOptions(expectedDigest),
    run.dependencies,
  );
  assert.deepEqual(run.state.d1, markers);
  assert.deepEqual(run.writes, { d1: 0, rtdb: 0, control: 1 });
  assert.deepEqual(run.state.control, {
    authority: "d1",
    generation: 1,
    sourceCount: 1,
    sourceDigest: expectedDigest,
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    transitionedAtMs: 10_000,
  });
});

test("adoption requires preview digest, uninitialized control, and D1 source", () => {
  assert.throws(() =>
    parseArgs(["--adopt-d1", "--source-version-id", TEST_SOURCE_VERSION_ID]),
  );

  const wrongDigest = harness({
    coordinationControl: control("uninitialized"),
    d1: [d1Marker("player", "match", 1)],
    apiVersionAuthority: null,
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        adoptionOptions(EMPTY_MARKER_DIGEST),
        wrongDigest.dependencies,
      ),
    /does not match preview/,
  );
  assert.equal(wrongDigest.writes.control, 0);

  const initialized = harness({
    coordinationControl: control("d1"),
    apiVersionAuthority: "d1",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        adoptionOptions(EMPTY_MARKER_DIGEST),
        initialized.dependencies,
      ),
    /authority must be uninitialized/,
  );

  const explicitRtdb = harness({
    coordinationControl: control("uninitialized"),
    apiVersionAuthority: "rtdb",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        adoptionOptions(EMPTY_MARKER_DIGEST),
        explicitRtdb.dependencies,
      ),
    /coordination authority does not match/,
  );

  for (const blocked of [
    harness({
      coordinationControl: control("uninitialized"),
      apiVersionAuthority: null,
      profileControl: "active",
    }),
    harness({
      coordinationControl: control("uninitialized"),
      apiVersionAuthority: null,
      activeD1Leases: 1,
    }),
    harness({
      coordinationControl: control("uninitialized"),
      apiVersionAuthority: null,
      legacy: snapshot(
        [],
        [
          {
            lockId: "invite",
            ownerId: "owner",
            operationId: "operation",
            expiresAtMs: 20_000,
          },
        ],
      ),
    }),
  ]) {
    assert.throws(() =>
      migrateGameplayCoordination(
        adoptionOptions(EMPTY_MARKER_DIGEST),
        blocked.dependencies,
      ),
    );
    assert.equal(blocked.writes.control, 0);
  }
});

test("adoption resolves ambiguous control writes and rejects D1 drift", () => {
  const completed = harness({
    coordinationControl: control("uninitialized"),
    apiVersionAuthority: null,
    transitionControl: "throw-after",
  });
  assert.doesNotThrow(() =>
    migrateGameplayCoordination(
      adoptionOptions(EMPTY_MARKER_DIGEST),
      completed.dependencies,
    ),
  );

  const unchanged = harness({
    coordinationControl: control("uninitialized"),
    apiVersionAuthority: null,
    transitionControl: "throw-before",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        adoptionOptions(EMPTY_MARKER_DIGEST),
        unchanged.dependencies,
      ),
    /retry while frozen/,
  );

  const drift = harness({
    coordinationControl: control("uninitialized"),
    d1: [d1Marker("player", "match", 1)],
    apiVersionAuthority: null,
  });
  let reads = 0;
  drift.dependencies.readD1TimerMarkers = () => {
    reads += 1;
    return reads === 1
      ? [d1Marker("player", "match", 1)]
      : [d1Marker("player", "match", 2)];
  };
  assert.throws(
    () =>
      migrateGameplayCoordination(
        adoptionOptions(digest([marker("player", "match", 1)])),
        drift.dependencies,
      ),
    /D1 verification mismatch/,
  );
  assert.equal(drift.writes.control, 0);
});

test("transition direction comes only from durable control", () => {
  const finalRun = harness({ coordinationControl: control("d1") });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        finalRun.dependencies,
      ),
    /authority must be rtdb/,
  );
  const rollbackRun = harness({ coordinationControl: control("rtdb") });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        rollbackRun.dependencies,
      ),
    /authority must be d1/,
  );
});

test("final requires freeze and drained active leases", () => {
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        harness({ profileControl: "active" }).dependencies,
      ),
    /requires frozen/,
  );
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        harness({ activeD1Leases: 1 }).dependencies,
      ),
    /D1 has active leases/,
  );
  const activeLegacy = harness({
    legacy: snapshot(
      [],
      [
        {
          lockId: "invite",
          ownerId: "owner",
          operationId: "operation",
          expiresAtMs: 20_000,
        },
      ],
    ),
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        activeLegacy.dependencies,
      ),
    /RTDB has active leases/,
  );
  const expiredLegacy = harness({
    legacy: snapshot(
      [marker("player", "match", 1)],
      [
        {
          lockId: "invite",
          ownerId: "owner",
          operationId: "operation",
          expiresAtMs: 9_000,
        },
      ],
    ),
  });
  assert.doesNotThrow(() =>
    migrateGameplayCoordination(
      mutatingOptions("final"),
      expiredLegacy.dependencies,
    ),
  );
});

test("final rejects a changing RTDB source and a changed source version", () => {
  const changing = harness();
  let snapshotReads = 0;
  changing.dependencies.readLegacySnapshot = () =>
    snapshotReads++ === 0
      ? snapshot()
      : snapshot([marker("player", "match", 1)]);
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        changing.dependencies,
      ),
    /snapshots changed/,
  );
  assert.equal(changing.writes.d1, 0);

  const deploymentChanges = harness({
    legacy: snapshot([marker("player", "match", 1)]),
  });
  let deploymentReads = 0;
  deploymentChanges.dependencies.readApiDeployment = () => ({
    versions: [
      {
        versionId:
          deploymentReads++ === 0 ? TEST_SOURCE_VERSION_ID : OTHER_VERSION_ID,
        percentage: 100,
      },
    ],
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        deploymentChanges.dependencies,
      ),
    /not serving 100%/,
  );
  assert.equal(deploymentChanges.writes.d1, 0);
});

test("final exactly replaces D1 and records provenance", () => {
  const run = harness({
    d1: [
      d1Marker("stale", "match", 9),
      d1Marker("player", "match", 2, 5, 200_000),
    ],
    legacy: snapshot([marker("player", "match", 2, 300_000)]),
  });
  migrateGameplayCoordination(mutatingOptions("final"), run.dependencies);
  assert.deepEqual(run.state.d1, [
    d1Marker("player", "match", 2, 10_000, 300_000),
  ]);
  assert.deepEqual(run.state.control, {
    authority: "d1",
    generation: 3,
    sourceCount: 1,
    sourceDigest: digest([marker("player", "match", 2, 300_000)]),
    sourceVersionId: TEST_SOURCE_VERSION_ID,
    transitionedAtMs: 10_000,
  });
  assert.equal(run.writes.d1, 1);
  assert.equal("d1-restore.sql" in run.files, false);
  assert.equal(
    run.logs.some((line) => line.includes("player")),
    false,
  );
});

test("empty final needs acknowledgement and still advances generation", () => {
  const rejected = harness({ d1: [d1Marker("stale", "match", 1)] });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        rejected.dependencies,
      ),
    /empty source requires/,
  );
  assert.equal(rejected.writes.d1, 0);

  const accepted = harness({ d1: [d1Marker("stale", "match", 1)] });
  migrateGameplayCoordination(
    mutatingOptions("final", EMPTY_MARKER_DIGEST),
    accepted.dependencies,
  );
  assert.deepEqual(accepted.state.d1, []);
  assert.equal(accepted.state.control?.generation, 3);

  const zeroToZero = harness();
  migrateGameplayCoordination(
    mutatingOptions("final"),
    zeroToZero.dependencies,
  );
  assert.equal(zeroToZero.writes.d1, 1);
  assert.equal(zeroToZero.state.control?.generation, 3);
});

test("final resolves ambiguous writes from control and exact target", () => {
  const completed = harness({
    applyD1: "throw-after",
    legacy: snapshot([marker("player", "match", 1)]),
  });
  assert.doesNotThrow(() =>
    migrateGameplayCoordination(
      mutatingOptions("final"),
      completed.dependencies,
    ),
  );

  const unchanged = harness({
    applyD1: "throw-before",
    legacy: snapshot([marker("player", "match", 1)]),
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("final"),
        unchanged.dependencies,
      ),
    /retry while frozen/,
  );
});

test("rollback replaces the entire RTDB root and advances control", () => {
  const run = harness({
    coordinationControl: control("d1"),
    d1: [d1Marker("player", "match", 2, 100, 300_000, "opponent")],
    legacy: snapshot([
      marker("player", "match", 2, 200_000),
      marker("stale", "match", 9),
    ]),
  });
  migrateGameplayCoordination(mutatingOptions("rollback"), run.dependencies);
  assert.deepEqual(run.state.legacy.timerMarkers, [
    marker("player", "match", 2, 300_000),
  ]);
  assert.equal(run.writes.rtdb, 1);
  assert.equal(run.writes.control, 1);
  assert.equal(run.state.control?.authority, "rtdb");
  assert.equal(run.state.control?.generation, 2);
  assert.deepEqual(JSON.parse(run.files["rtdb-set.json"] || "{}"), {
    player: { match: { timer: "2;300000", turnNumber: 2 } },
  });
});

test("rollback handles ambiguous set and control responses", () => {
  const completed = harness({
    coordinationControl: control("d1"),
    d1: [d1Marker("player", "match", 1)],
    setRtdb: "throw-after",
    transitionControl: "throw-after",
  });
  assert.doesNotThrow(() =>
    migrateGameplayCoordination(
      mutatingOptions("rollback"),
      completed.dependencies,
    ),
  );

  const failedSet = harness({
    coordinationControl: control("d1"),
    d1: [d1Marker("player", "match", 1)],
    setRtdb: "throw-before",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        failedSet.dependencies,
      ),
    /RTDB verification mismatch/,
  );

  const failedControl = harness({
    coordinationControl: control("d1"),
    d1: [d1Marker("player", "match", 1)],
    transitionControl: "throw-before",
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        failedControl.dependencies,
      ),
    /retry while frozen/,
  );
});

test("rollback refuses to flip control when the D1 source changes", () => {
  const run = harness({
    coordinationControl: control("d1"),
    d1: [d1Marker("player", "match", 1)],
  });
  let reads = 0;
  run.dependencies.readD1TimerMarkers = () => {
    reads += 1;
    return reads < 3
      ? [d1Marker("player", "match", 1)]
      : [d1Marker("player", "match", 2)];
  };
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        run.dependencies,
      ),
    /D1 verification mismatch/,
  );
  assert.equal(run.writes.rtdb, 1);
  assert.equal(run.writes.control, 0);
});

test("empty rollback cannot erase RTDB without its preview digest", () => {
  const rejected = harness({
    coordinationControl: control("d1"),
    legacy: snapshot([marker("stale", "match", 1)]),
  });
  assert.throws(
    () =>
      migrateGameplayCoordination(
        mutatingOptions("rollback"),
        rejected.dependencies,
      ),
    /empty source requires/,
  );
  const accepted = harness({
    coordinationControl: control("d1"),
    legacy: snapshot([marker("stale", "match", 1)]),
  });
  migrateGameplayCoordination(
    mutatingOptions("rollback", EMPTY_MARKER_DIGEST),
    accepted.dependencies,
  );
  assert.deepEqual(accepted.state.legacy.timerMarkers, []);
  assert.equal(accepted.state.control?.generation, 2);
});

test("Firebase arguments use whole-root set without credentials", () => {
  const getArgs = firebaseDatabaseGetArgs("mons-link", "/matchTimerStarts");
  const setArgs = firebaseDatabaseSetArgs("mons-link", "/secure/file.json");
  assert.deepEqual(getArgs.slice(-2), ["--instance", "mons-link-default-rtdb"]);
  assert.deepEqual(setArgs.slice(0, 3), [
    "database:set",
    "/matchTimerStarts",
    "/secure/file.json",
  ]);
  assert.equal(
    [...getArgs, ...setArgs].some((argument) => /token|secret/i.test(argument)),
    false,
  );
  assert.equal(buildRtdbTimerRoot([]), null);
});

test("RTDB root serialization preserves prototype-shaped IDs", () => {
  const root = buildRtdbTimerRoot([
    marker("__proto__", "match", 1),
    marker("player", "__proto__", 2),
  ]);
  const parsed = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  assert.deepEqual(parsed["__proto__"], {
    match: { timer: "1;100001", turnNumber: 1 },
  });
  assert.deepEqual((parsed.player as Record<string, unknown>)["__proto__"], {
    timer: "2;100002",
    turnNumber: 2,
  });
  assert.equal(Object.hasOwn(root || {}, "__proto__"), true);
  assert.equal(
    Object.hasOwn((root as Record<string, object>).player, "__proto__"),
    true,
  );
});

test("artifacts are private and contain no compensation files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gameplay-coordination-test-"));
  t.after(() => {
    process.getBuiltinModule("node:fs").rmSync(root, {
      force: true,
      recursive: true,
    });
  });
  const persisted = persistMigrationArtifacts(
    {
      exportedAtMs: 1_000,
      phase: "preview",
      files: {
        "metadata.json": "{}\n",
        "rtdb-source.json": '{"private":true}\n',
      },
    },
    root,
  );
  assert.equal(statSync(root).mode & 0o777, 0o700);
  for (const path of Object.values(persisted.paths)) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(/restore|compensation/.test(path), false);
  }
  assert.equal(
    readFileSync(persisted.paths["rtdb-source.json"] || "", "utf8"),
    '{"private":true}\n',
  );
});
