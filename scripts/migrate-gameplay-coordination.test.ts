import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertPreviewSource,
  digest,
  firebaseDatabaseGetArgs,
  migrateGameplayCoordination,
  normalizeD1Leases,
  normalizeD1TimerMarkers,
  normalizeLegacySnapshot,
  parseArgs,
  persistMigrationArtifacts,
  summarizeD1Snapshot,
  type D1Snapshot,
  type LegacySnapshot,
  type MigrationDependencies,
} from "./migrate-gameplay-coordination.ts";

function legacySnapshot(): LegacySnapshot {
  return {
    leases: [
      {
        lockId: "invite-1",
        ownerId: "owner-1",
        operationId: "operation-1",
        expiresAtMs: 20_000,
      },
    ],
    timerMarkers: [
      {
        playerId: "player-1",
        matchId: "match-1",
        timer: "2;100002",
        turnNumber: 2,
      },
    ],
  };
}

function d1Snapshot(hasOpponentIdColumn = true): D1Snapshot {
  return {
    hasOpponentIdColumn,
    leases: [
      {
        lockId: "invite-2",
        ownerId: "owner-2",
        operationId: "operation-2",
        expiresAtMs: 30_000,
      },
    ],
    timerMarkers: [
      {
        playerId: "player-2",
        matchId: "match-2",
        timer: "3;100003",
        turnNumber: 3,
        opponentId: hasOpponentIdColumn ? "player-3" : null,
        updatedAtMs: 15_000,
      },
    ],
  };
}

function harness(
  input: {
    activeD1Leases?: number;
    d1?: D1Snapshot;
    legacy?: LegacySnapshot;
    now?: number;
  } = {},
) {
  const calls: string[] = [];
  const files: Record<string, string> = {};
  const logs: string[] = [];
  const dependencies: MigrationDependencies = {
    log: (message) => logs.push(message),
    now: () => input.now ?? 10_000,
    persistArtifacts: ({ files: nextFiles }) => {
      calls.push("persistArtifacts");
      Object.assign(files, nextFiles);
    },
    readActiveD1Leases: () => {
      calls.push("readActiveD1Leases");
      return input.activeD1Leases ?? 1;
    },
    readD1Snapshot: () => {
      calls.push("readD1Snapshot");
      return structuredClone(input.d1 ?? d1Snapshot());
    },
    readLegacySnapshot: (project) => {
      calls.push(`readLegacySnapshot:${project}`);
      return structuredClone(input.legacy ?? legacySnapshot());
    },
  };
  return { calls, dependencies, files, logs };
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
        "cloud/workers/api/migrations/0008_match_timer_reconciliation.sql",
      ),
      "utf8",
    ),
  );
}

test("0008 adds only timer reconciliation metadata", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  applySchema(database);

  assert.deepEqual(
    database
      .prepare("SELECT name FROM pragma_table_info('match_timer_starts')")
      .all()
      .map((row) => row.name),
    [
      "player_id",
      "match_id",
      "timer",
      "turn_number",
      "updated_at_ms",
      "opponent_id",
    ],
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gameplay_coordination_%'",
      )
      .all(),
    [],
  );
  assert.ok(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_match_timer_starts_reconciliation'",
      )
      .get(),
  );
  assert.throws(() =>
    database.exec(
      "INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms, opponent_id) VALUES ('player', 'match', '1;100001', 1, 1, 'bad/opponent')",
    ),
  );
  database.exec(
    "INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms, opponent_id) VALUES ('player', 'match', '1;100001', 1, 1, NULL)",
  );
  assert.throws(() =>
    database.exec(
      "UPDATE match_timer_starts SET opponent_id = '' WHERE player_id = 'player' AND match_id = 'match'",
    ),
  );
});

test("arguments expose only preview and project", () => {
  assert.deepEqual(parseArgs([]), { project: "mons-link" });
  assert.deepEqual(parseArgs(["--preview"]), { project: "mons-link" });
  assert.deepEqual(parseArgs(["--project", "demo-project", "--preview"]), {
    project: "demo-project",
  });
  assert.throws(() => parseArgs(["--preview", "--preview"]));
  assert.throws(() => parseArgs(["--project"]));
  assert.throws(() => parseArgs(["--project", "--preview"]));
  assert.throws(() => parseArgs(["--project", "a", "--project", "b"]));
  assert.throws(() => parseArgs(["--write"]));
});

test("canonical preview rejects Firebase source overrides", () => {
  for (const key of [
    "FIREBASE_CONFIG",
    "FIREBASE_DATABASE_EMULATOR_HOST",
    "FIREBASE_REALTIME_URL",
    "FIREBASE_DATABASE_URL",
    "FIREBASE_REALTIME_DATABASE_URL",
    "FIREBASE_RTDB_OVERRIDE",
  ]) {
    assert.throws(() =>
      assertPreviewSource({ project: "mons-link" }, { [key]: "value" }),
    );
  }
  assert.doesNotThrow(() =>
    assertPreviewSource(
      { project: "demo-project" },
      { FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000" },
    ),
  );
  assert.doesNotThrow(() =>
    assertPreviewSource({ project: "mons-link" }, { unrelated: "value" }),
  );
});

test("legacy normalization accepts empty roots and sorts records", () => {
  assert.deepEqual(
    normalizeLegacySnapshot({ locks: null, timerStarts: null }),
    {
      leases: [],
      timerMarkers: [],
    },
  );
  assert.deepEqual(
    normalizeLegacySnapshot({
      locks: {
        second: {
          ownerId: "owner-2",
          operationId: "operation-2",
          expiresAtMs: 2,
        },
        first: {
          ownerId: "owner-1",
          operationId: "operation-1",
          expiresAtMs: 1,
        },
      },
      timerStarts: {
        second: { match: { timer: "2;102", turnNumber: 2 } },
        first: { match: { timer: "1;101", turnNumber: 1 } },
      },
    }),
    {
      leases: [
        {
          lockId: "first",
          ownerId: "owner-1",
          operationId: "operation-1",
          expiresAtMs: 1,
        },
        {
          lockId: "second",
          ownerId: "owner-2",
          operationId: "operation-2",
          expiresAtMs: 2,
        },
      ],
      timerMarkers: [
        {
          playerId: "first",
          matchId: "match",
          timer: "1;101",
          turnNumber: 1,
        },
        {
          playerId: "second",
          matchId: "match",
          timer: "2;102",
          turnNumber: 2,
        },
      ],
    },
  );
});

test("legacy normalization rejects malformed locks and timers", () => {
  assert.throws(() =>
    normalizeLegacySnapshot({
      locks: {
        lock: { ownerId: "owner", operationId: "operation", expiresAtMs: 0 },
      },
      timerStarts: null,
    }),
  );
  assert.throws(() =>
    normalizeLegacySnapshot({
      locks: null,
      timerStarts: {
        player: { match: { timer: "2;102", turnNumber: 1 } },
      },
    }),
  );
  assert.throws(() =>
    normalizeLegacySnapshot({
      locks: null,
      timerStarts: { "bad/player": {} },
    }),
  );
});

test("D1 normalization validates leases and timer markers", () => {
  assert.deepEqual(
    normalizeD1Leases([
      {
        lock_id: "lock",
        owner_id: "owner",
        operation_id: "operation",
        expires_at_ms: 10,
      },
    ]),
    [
      {
        lockId: "lock",
        ownerId: "owner",
        operationId: "operation",
        expiresAtMs: 10,
      },
    ],
  );
  assert.throws(() =>
    normalizeD1Leases([
      {
        lock_id: "lock",
        owner_id: "owner",
        operation_id: "operation",
        expires_at_ms: 10,
      },
      {
        lock_id: "lock",
        owner_id: "other",
        operation_id: "other",
        expires_at_ms: 20,
      },
    ]),
  );
  assert.deepEqual(
    normalizeD1TimerMarkers([
      {
        player_id: "player",
        match_id: "match",
        timer: "4;104",
        turn_number: 4,
        updated_at_ms: 10,
        opponent_id: null,
      },
    ])[0],
    {
      playerId: "player",
      matchId: "match",
      timer: "4;104",
      turnNumber: 4,
      updatedAtMs: 10,
      opponentId: null,
    },
  );
  assert.throws(() =>
    normalizeD1TimerMarkers([
      {
        player_id: "player",
        match_id: "match",
        timer: "4;104",
        turn_number: 4,
        updated_at_ms: 10,
        opponent_id: "bad/opponent",
      },
    ]),
  );
});

test("D1 summary separates logical and physical timer digests", () => {
  const before = d1Snapshot(false);
  const after = d1Snapshot(true);
  after.timerMarkers[0] = {
    ...after.timerMarkers[0],
    opponentId: null,
  };
  const beforeSummary = summarizeD1Snapshot(before, 0);
  const afterSummary = summarizeD1Snapshot(after, 0);
  assert.equal(beforeSummary.timerDigest, afterSummary.timerDigest);
  assert.equal(
    beforeSummary.timerSnapshotDigest,
    afterSummary.timerSnapshotDigest,
  );

  after.hasOpponentIdColumn = false;
  after.timerMarkers[0] = { ...after.timerMarkers[0], updatedAtMs: 99_999 };
  const metadataChanged = summarizeD1Snapshot(after, 0);
  assert.equal(beforeSummary.timerDigest, metadataChanged.timerDigest);
  assert.notEqual(
    beforeSummary.timerSnapshotDigest,
    metadataChanged.timerSnapshotDigest,
  );
  assert.throws(() => summarizeD1Snapshot(before, -1));
});

test("preview reads, validates, persists, and logs only summaries", () => {
  const { calls, dependencies, files, logs } = harness();
  migrateGameplayCoordination({ project: "mons-link" }, dependencies, {});

  assert.deepEqual(calls, [
    "readLegacySnapshot:mons-link",
    "readD1Snapshot",
    "readActiveD1Leases",
    "persistArtifacts",
  ]);
  assert.deepEqual(Object.keys(files).sort(), [
    "d1-source.json",
    "metadata.json",
    "rtdb-source.json",
  ]);
  const output = JSON.parse(logs[0] || "null") as Record<string, unknown>;
  assert.deepEqual(Object.keys(output).sort(), ["d1", "legacy"]);
  assert.doesNotMatch(logs[0] || "", /player-|match-|owner-|operation-/);
  assert.match(logs[0] || "", /"timerDigest":"[0-9a-f]{64}"/);
  assert.match(logs[0] || "", /"timerSnapshotDigest":"[0-9a-f]{64}"/);
  const metadata = JSON.parse(files["metadata.json"] || "null") as {
    d1: { hasOpponentIdColumn: boolean };
    phase: string;
  };
  assert.equal(metadata.phase, "preview");
  assert.equal(metadata.d1.hasOpponentIdColumn, true);
});

test("preview uses one local timestamp only for legacy lease information", () => {
  const legacy = legacySnapshot();
  legacy.leases[0] = { ...legacy.leases[0], expiresAtMs: 10_001 };
  const { dependencies, logs } = harness({
    activeD1Leases: 0,
    legacy,
    now: 10_000,
  });
  migrateGameplayCoordination({ project: "mons-link" }, dependencies, {});
  const output = JSON.parse(logs[0] || "null") as {
    d1: { activeLocks: number };
    legacy: { activeLocks: number };
  };
  assert.equal(output.legacy.activeLocks, 1);
  assert.equal(output.d1.activeLocks, 0);
});

test("preview artifacts use private directory and file modes", () => {
  const root = mkdtempSync(join(tmpdir(), "gameplay-preview-test-"));
  persistMigrationArtifacts(
    {
      exportedAtMs: 10_000,
      files: { "metadata.json": "{}\n", "d1-source.json": "[]\n" },
    },
    root,
  );
  const directories = readdirSync(root);
  assert.equal(directories.length, 1);
  const runDirectory = join(root, directories[0] || "");
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(runDirectory).mode & 0o777, 0o700);
  for (const name of readdirSync(runDirectory)) {
    assert.equal(statSync(join(runDirectory, name)).mode & 0o777, 0o600);
  }
  assert.throws(() =>
    persistMigrationArtifacts(
      { exportedAtMs: 10_001, files: { "../bad": "bad" } },
      root,
    ),
  );
});

test("Firebase reads pin the canonical production instance", () => {
  assert.deepEqual(firebaseDatabaseGetArgs("mons-link", "/root"), [
    "database:get",
    "/root",
    "--project",
    "mons-link",
    "--instance",
    "mons-link-default-rtdb",
  ]);
  assert.deepEqual(firebaseDatabaseGetArgs("demo-project", "/root"), [
    "database:get",
    "/root",
    "--project",
    "demo-project",
  ]);
});

test("tool source contains only read commands and D1 server-time lease checks", () => {
  const source = readFileSync(
    resolve("scripts/migrate-gameplay-coordination.ts"),
    "utf8",
  );
  assert.match(source, /database:get/);
  assert.match(source, /unixepoch\('subsec'\)/);
  assert.doesNotMatch(source, /database:set|--file|versions deploy/);
});

test("digests are stable across object key order", () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
