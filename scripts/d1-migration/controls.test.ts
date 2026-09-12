import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cloneDatabase } from "./clone.ts";
import {
  freezeDomainControls,
  resumeDomainControls,
  type ControlQuery,
  type DomainControlDependencies,
  type DomainControlJournal,
} from "./controls.ts";
import type { MigrationManifest } from "./state.ts";
import { D1_BINDINGS, type D1Binding } from "../operator/configuration.ts";

const OLD_VERSION = "cccccccc-0000-4000-8000-000000000001";
const ACTIVE_VERSION = "dddddddd-0000-4000-8000-000000000001";
const AUTO = "PROFILE_GAMES_DB.automatch_runtime_control";
const PROFILE = "PROFILE_DB.profile_canonical_control";
const WAGER = "PROFILE_DB.wager_reservation_runtime_control";
const EVENT = "EVENT_DB.event_runtime_control";

async function fixture(preFrozen: readonly string[] = []) {
  const databases = new Map<string, DatabaseSync>();
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    revision: 1,
    previousDigest: null,
    runId: "eeeeeeee-0000-4000-8000-000000000001",
    createdAt: "2026-09-12T00:00:00.000Z",
    accountId: "a".repeat(32),
    workerName: "mons-link-api",
    originalVersionId: OLD_VERSION,
    namespaceId: "namespace",
    configuration: { d1_databases: [] },
    databases: [],
    queues: [],
    controls: {},
    phases: {},
    versions: {},
    records: {},
  };
  let index = 0;
  for (const [name, binding] of Object.entries(D1_BINDINGS)) {
    const suffix = String(++index).padStart(12, "0");
    const sourceId = `aaaaaaaa-0000-4000-8000-${suffix}`;
    const destinationId = `bbbbbbbb-0000-4000-8000-${suffix}`;
    for (const id of [sourceId, destinationId]) {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA foreign_keys = ON");
      databases.set(id, db);
    }
    manifest.databases.push({
      binding,
      sourceId,
      sourceName: name,
      sourceRegion: "WEUR",
      destinationName: `${name}-enam`,
      destinationId,
    });
    (manifest.configuration.d1_databases as unknown[]).push({
      binding,
      database_id: sourceId,
      database_name: name,
    });
  }
  const database = (
    binding: D1Binding,
    side: "source" | "destination" = "source",
  ) => {
    const entry = manifest.databases.find(
      (entry) => entry.binding === binding,
    )!;
    return databases.get(
      side === "source" ? entry.sourceId : entry.destinationId!,
    )!;
  };
  database("PROFILE_DB").exec(`
    CREATE TABLE profile_canonical_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('active','frozen')));
    INSERT INTO profile_canonical_control VALUES(1,'active');
    CREATE TABLE wager_reservation_runtime_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),storage_mode TEXT NOT NULL,freeze_generation INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL);
    INSERT INTO wager_reservation_runtime_control VALUES(1,'d1',4,10);
    CREATE TABLE wager_reservation_write_admissions(admission_id TEXT PRIMARY KEY);
  `);
  database("PROFILE_GAMES_DB").exec(`
    CREATE TABLE automatch_runtime_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),backend TEXT,state TEXT,epoch INTEGER,freeze_generation INTEGER,candidate_version_id TEXT,activated_at_ms INTEGER,source_digest TEXT,import_digest TEXT,metadata_json TEXT,staged_at_ms INTEGER,imported_at_ms INTEGER);
    CREATE TABLE invite_source_control(singleton INTEGER PRIMARY KEY,backend TEXT,state TEXT,epoch INTEGER,freeze_generation INTEGER,source_digest TEXT);
    INSERT INTO invite_source_control VALUES(1,'d1','active',11,2,'retained-invite-proof');
    CREATE TABLE match_state_control(singleton INTEGER PRIMARY KEY,backend TEXT,state TEXT,epoch INTEGER,freeze_generation INTEGER,source_digest TEXT);
    INSERT INTO match_state_control VALUES(1,'durable','draining',12,3,'retained-match-proof');
    CREATE TABLE automatch_write_admissions(admission_id TEXT PRIMARY KEY);
    CREATE TABLE game_session_legacy_fence(singleton INTEGER PRIMARY KEY,enabled INTEGER);
    INSERT INTO game_session_legacy_fence VALUES(1,1);
    CREATE TABLE game_session_mutation_locks(lock_id TEXT PRIMARY KEY,writer_generation INTEGER,expires_at_ms INTEGER);
    CREATE TABLE game_session_legacy_releases(lock_id TEXT PRIMARY KEY,reconciled_at_ms INTEGER);
  `);
  database("PROFILE_GAMES_DB")
    .prepare(
      "INSERT INTO automatch_runtime_control VALUES(1,'d1','active',8,9,?,20,'digest','digest',?,10,15)",
    )
    .run(
      OLD_VERSION,
      JSON.stringify({
        verifiedAtMs: 20,
        activationCandidateVersionId: OLD_VERSION,
      }),
    );
  database("EVENT_DB").exec(`
    CREATE TABLE event_runtime_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),storage_mode TEXT,freeze_generation INTEGER,updated_at_ms INTEGER);
    INSERT INTO event_runtime_control VALUES(1,'d1',7,10);
    CREATE TABLE event_write_admissions(admission_id TEXT PRIMARY KEY);
  `);
  database("TELEGRAM_DB").exec(`
    CREATE TABLE telegram_runtime_control(singleton INTEGER PRIMARY KEY,storage_mode TEXT,updated_at_ms INTEGER,source_digest TEXT,source_message_count INTEGER);
    INSERT INTO telegram_runtime_control VALUES(1,'d1',10,'telegram-proof',20);
  `);
  database("EVENT_PRIZE_WITHDRAWALS_DB").exec(`
    CREATE TABLE event_prize_withdrawal_runtime_control(singleton INTEGER PRIMARY KEY,storage_mode TEXT,previous_storage_mode TEXT,updated_at_ms INTEGER,source_digest TEXT,source_record_count INTEGER);
    INSERT INTO event_prize_withdrawal_runtime_control VALUES(1,'d1',NULL,10,'withdrawal-proof',7);
  `);
  const controls = [
    ["PROFILE_DB", "profile_canonical_control"],
    ["PROFILE_DB", "wager_reservation_runtime_control"],
    ["PROFILE_GAMES_DB", "automatch_runtime_control"],
    ["PROFILE_GAMES_DB", "invite_source_control"],
    ["PROFILE_GAMES_DB", "match_state_control"],
    ["EVENT_DB", "event_runtime_control"],
    ["TELEGRAM_DB", "telegram_runtime_control"],
    ["EVENT_PRIZE_WITHDRAWALS_DB", "event_prize_withdrawal_runtime_control"],
  ] as const;
  for (const [binding, table] of controls) {
    if (preFrozen.includes(`${binding}.${table}`)) {
      const column =
        table === "profile_canonical_control" ||
        table === "automatch_runtime_control"
          ? "state"
          : "storage_mode";
      database(binding).exec(
        `UPDATE ${table} SET ${column}='frozen'${table === "event_prize_withdrawal_runtime_control" ? ",previous_storage_mode='d1'" : ""}`,
      );
    }
    manifest.controls[`${binding}.${table}`] = database(binding)
      .prepare(`SELECT * FROM ${table}`)
      .all() as Record<string, unknown>[];
  }
  const writes: { id: string; sql: string }[] = [];
  const persisted: DomainControlJournal[] = [];
  const query: ControlQuery = async (id, sql, params = []) => {
    const db = databases.get(id);
    assert.ok(db, "query only manifest-owned fixtures");
    if (/^UPDATE "/.test(sql)) {
      const table = /^UPDATE "([^"]+)"/.exec(sql)![1];
      const committed = persisted.at(-1);
      assert.ok(committed, "intent is durable before a control write");
      assert.ok(
        Object.entries(committed.controls).some(
          ([name, operations]) =>
            name.endsWith(`.${table}`) &&
            Object.values(operations).some(
              (entry) => entry?.databaseId === id && entry.status === "intent",
            ),
        ),
        "matching pinned intent precedes the write",
      );
      writes.push({ id, sql });
    }
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  };
  const input: DomainControlDependencies = {
    manifest,
    query,
    persist: async () => {
      persisted.push(
        structuredClone(
          manifest.records.domainControls,
        ) as DomainControlJournal,
      );
    },
    activeVersionId: ACTIVE_VERSION,
    now: () => 500,
  };
  return {
    input,
    manifest,
    database,
    databases,
    writes,
    persisted,
    query,
    journal: () => manifest.records.domainControls as DomainControlJournal,
    async copy() {
      for (const entry of manifest.databases) {
        await cloneDatabase(
          (sql, params) => query(entry.sourceId, sql, params),
          (sql, params) => query(entry.destinationId!, sql, params),
        );
      }
    },
    close() {
      for (const db of databases.values()) db.close();
    },
  };
}

test("source freezes and destination resumes preserve all epochs and journal each write before execution", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.manifest.controls);
    const frozen = await freezeDomainControls(f.input);
    assert.equal(frozen.changed.length, 6);
    assert.equal(frozen.preserved.length, 2);
    assert.equal(f.writes.length, 6);
    const firstWrites = [...f.writes];
    await freezeDomainControls(f.input);
    assert.deepEqual(f.writes, firstWrites);
    assert.equal(
      f
        .database("PROFILE_GAMES_DB")
        .prepare(
          "SELECT epoch,freeze_generation FROM automatch_runtime_control",
        )
        .get()?.epoch,
      8,
    );
    assert.equal(
      f
        .database("PROFILE_GAMES_DB")
        .prepare("SELECT freeze_generation FROM automatch_runtime_control")
        .get()?.freeze_generation,
      10,
    );
    await f.copy();
    const resumed = await resumeDomainControls(f.input);
    assert.equal(resumed.changed.length, 6);
    assert.equal(f.writes.length, 12);
    const afterResume = [...f.writes];
    await resumeDomainControls(f.input);
    assert.deepEqual(f.writes, afterResume);
    assert.deepEqual(structuredClone(f.manifest.controls), original);
    const auto = f
      .database("PROFILE_GAMES_DB", "destination")
      .prepare(
        "SELECT epoch,freeze_generation,candidate_version_id,state FROM automatch_runtime_control",
      )
      .get();
    assert.equal(auto?.epoch, 8);
    assert.equal(auto?.freeze_generation, 10);
    assert.equal(auto?.candidate_version_id, ACTIVE_VERSION);
    assert.equal(auto?.state, "active");
    for (const table of ["invite_source_control", "match_state_control"])
      assert.deepEqual(
        structuredClone(
          f
            .database("PROFILE_GAMES_DB", "destination")
            .prepare(`SELECT * FROM ${table}`)
            .all(),
        ),
        original[`PROFILE_GAMES_DB.${table}`],
      );
    assert.equal(
      f
        .database("PROFILE_DB")
        .prepare("SELECT state FROM profile_canonical_control")
        .get()?.state,
      "frozen",
    );
    assert.equal(
      f
        .database("PROFILE_DB", "destination")
        .prepare("SELECT state FROM profile_canonical_control")
        .get()?.state,
      "active",
    );
    assert.ok(
      f.writes
        .slice(0, 6)
        .every((write) =>
          f.manifest.databases.some((db) => db.sourceId === write.id),
        ),
    );
    assert.ok(
      f.writes
        .slice(6)
        .every((write) =>
          f.manifest.databases.some((db) => db.destinationId === write.id),
        ),
    );
  } finally {
    f.close();
  }
});

test("preexisting freezes remain frozen and their metadata is not rewritten", async () => {
  const frozenKeys = [
    PROFILE,
    AUTO,
    EVENT,
    "EVENT_PRIZE_WITHDRAWALS_DB.event_prize_withdrawal_runtime_control",
  ];
  const f = await fixture(frozenKeys);
  try {
    const original = structuredClone(f.manifest.controls);
    assert.equal((await freezeDomainControls(f.input)).changed.length, 2);
    await f.copy();
    assert.equal(
      (await resumeDomainControls({ ...f.input, activeVersionId: undefined }))
        .changed.length,
      2,
    );
    for (const name of frozenKeys) {
      const [binding, table] = name.split(".");
      assert.deepEqual(
        structuredClone(
          f
            .database(binding as D1Binding, "destination")
            .prepare(`SELECT * FROM ${table}`)
            .all(),
        ),
        original[name],
      );
      assert.equal(f.journal().controls[name].resume?.changed, false);
    }
  } finally {
    f.close();
  }
});

test("an uncertain successful freeze is reconciled without incrementing the generation twice", async () => {
  const f = await fixture();
  try {
    let failOnce = true;
    const query: ControlQuery = async (id, sql, params) => {
      const result = await f.query(id, sql, params);
      if (
        failOnce &&
        sql.startsWith('UPDATE "wager_reservation_runtime_control"')
      ) {
        failOnce = false;
        throw new Error("response lost after commit");
      }
      return result;
    };
    await assert.rejects(
      freezeDomainControls({ ...f.input, query }),
      /response lost/,
    );
    assert.equal(f.journal().controls[WAGER].freeze?.status, "uncertain");
    await freezeDomainControls(f.input);
    assert.equal(
      f
        .database("PROFILE_DB")
        .prepare(
          "SELECT freeze_generation FROM wager_reservation_runtime_control",
        )
        .get()?.freeze_generation,
      5,
    );
    assert.equal(
      f.writes.filter((write) =>
        write.sql.startsWith('UPDATE "wager_reservation_runtime_control"'),
      ).length,
      1,
    );
  } finally {
    f.close();
  }
});

test("a lost intent persistence never allows a control write", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      freezeDomainControls({
        ...f.input,
        persist: async () => {
          if (
            Object.values(f.journal().controls).some(
              (entry) => entry.freeze?.status === "intent",
            )
          )
            throw new Error("disk persistence unavailable");
          await f.input.persist();
        },
      }),
      /disk persistence/,
    );
    assert.equal(f.writes.length, 0);
    await freezeDomainControls(f.input);
    assert.equal(f.writes.length, 6);
  } finally {
    f.close();
  }
});

test("a competing control freeze is not adopted or later resumed as this run's write", async () => {
  const f = await fixture();
  try {
    const racing: ControlQuery = async (id, sql, params) => {
      if (sql.startsWith('UPDATE "profile_canonical_control"'))
        f.database("PROFILE_DB").exec(
          "UPDATE profile_canonical_control SET state='frozen'",
        );
      return f.query(id, sql, params);
    };
    await assert.rejects(
      freezeDomainControls({ ...f.input, query: racing }),
      /CAS did not apply/,
    );
    assert.equal(f.journal().controls[PROFILE].freeze?.status, "conflict");
    const count = f.writes.length;
    await assert.rejects(
      freezeDomainControls(f.input),
      /recorded control conflict/,
    );
    assert.equal(f.writes.length, count);
    await assert.rejects(
      resumeDomainControls(f.input),
      /complete source freeze/,
    );
  } finally {
    f.close();
  }
});

test("active event admissions block the supported transition without deleting evidence", async () => {
  const f = await fixture();
  try {
    f.database("EVENT_DB").exec(
      "INSERT INTO event_write_admissions VALUES('retained-admission')",
    );
    await assert.rejects(
      freezeDomainControls(f.input),
      /admission or writer guards/,
    );
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT storage_mode FROM event_runtime_control")
        .get()?.storage_mode,
      "d1",
    );
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT COUNT(*) AS count FROM event_write_admissions")
        .get()?.count,
      1,
    );
    f.database("EVENT_DB").exec(
      "DELETE FROM event_write_admissions WHERE admission_id='retained-admission'",
    );
    await freezeDomainControls(f.input);
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT freeze_generation FROM event_runtime_control")
        .get()?.freeze_generation,
      8,
    );
  } finally {
    f.close();
  }
});

test("wager resume requires drained gameplay leases and leaves profile frozen until it can finish", async () => {
  const f = await fixture();
  try {
    await freezeDomainControls(f.input);
    await f.copy();
    f.database("PROFILE_GAMES_DB", "destination").exec(
      "INSERT INTO game_session_mutation_locks VALUES('current-writer',2,1000)",
    );
    await assert.rejects(
      resumeDomainControls(f.input),
      /gameplay mutation leases/,
    );
    assert.equal(
      f
        .database("PROFILE_DB", "destination")
        .prepare("SELECT state FROM profile_canonical_control")
        .get()?.state,
      "frozen",
    );
    assert.equal(
      f
        .database("PROFILE_DB", "destination")
        .prepare("SELECT storage_mode FROM wager_reservation_runtime_control")
        .get()?.storage_mode,
      "frozen",
    );
    await resumeDomainControls({ ...f.input, now: () => 1_500 });
    assert.equal(
      f
        .database("PROFILE_DB", "destination")
        .prepare("SELECT state FROM profile_canonical_control")
        .get()?.state,
      "active",
    );
    assert.equal(
      f
        .database("PROFILE_GAMES_DB", "destination")
        .prepare("SELECT COUNT(*) AS count FROM game_session_mutation_locks")
        .get()?.count,
      1,
    );
  } finally {
    f.close();
  }
});

test("overlapping or redirected database IDs are rejected before SQL", async () => {
  for (const kind of [
    "source-overlap",
    "changed-source",
    "duplicate-destination",
    "missing-binding",
  ] as const) {
    const f = await fixture();
    try {
      if (kind === "source-overlap")
        f.manifest.databases[0].destinationId =
          f.manifest.databases[1].sourceId.toUpperCase();
      if (kind === "changed-source")
        f.manifest.databases[0].sourceId =
          "eeeeeeee-0000-4000-8000-000000000001";
      if (kind === "duplicate-destination")
        f.manifest.databases[0].destinationId =
          f.manifest.databases[1].destinationId!.toUpperCase();
      if (kind === "missing-binding") f.manifest.databases.pop();
      await assert.rejects(
        freezeDomainControls({
          ...f.input,
          query: async () => assert.fail("no SQL before identity validation"),
        }),
      );
    } finally {
      f.close();
    }
  }
});

test("journal epoch changes and a missing active resume version are rejected before destination writes", async () => {
  const f = await fixture();
  try {
    await freezeDomainControls(f.input);
    await f.copy();
    const writes = f.writes.length;
    await assert.rejects(
      resumeDomainControls({ ...f.input, activeVersionId: undefined }),
      /verified active Version ID/,
    );
    assert.equal(f.writes.length, writes);
    f.journal().controls[AUTO].freeze!.after.epoch = 99;
    await assert.rejects(
      resumeDomainControls(f.input),
      /unauthorized field or generation/,
    );
    assert.equal(f.writes.length, writes);
  } finally {
    f.close();
  }
});

test("a new admission racing the CAS is retained and a later drained retry advances the generation once", async () => {
  const f = await fixture();
  try {
    let raced = false;
    const racing: ControlQuery = (id, sql, params) => {
      if (!raced && sql.startsWith('UPDATE "event_runtime_control"')) {
        raced = true;
        f.database("EVENT_DB").exec(
          "INSERT INTO event_write_admissions VALUES('racing-admission')",
        );
      }
      return f.query(id, sql, params);
    };
    await assert.rejects(
      freezeDomainControls({ ...f.input, query: racing }),
      /CAS did not apply/,
    );
    assert.equal(f.journal().controls[EVENT].freeze?.status, "blocked");
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT freeze_generation FROM event_runtime_control")
        .get()?.freeze_generation,
      7,
    );
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT COUNT(*) AS count FROM event_write_admissions")
        .get()?.count,
      1,
    );
    f.database("EVENT_DB").exec(
      "DELETE FROM event_write_admissions WHERE admission_id='racing-admission'",
    );
    await freezeDomainControls(f.input);
    assert.equal(
      f
        .database("EVENT_DB")
        .prepare("SELECT freeze_generation FROM event_runtime_control")
        .get()?.freeze_generation,
      8,
    );
    assert.equal(f.journal().controls[EVENT].freeze?.status, "applied");
  } finally {
    f.close();
  }
});

test("automatch legacy fencing and unreconciled legacy releases remain mandatory", async () => {
  const f = await fixture();
  try {
    f.database("PROFILE_GAMES_DB").exec(
      "UPDATE game_session_legacy_fence SET enabled=0",
    );
    await assert.rejects(
      freezeDomainControls(f.input),
      /admission or writer guards/,
    );
    assert.equal(
      f
        .database("PROFILE_GAMES_DB")
        .prepare("SELECT state FROM automatch_runtime_control")
        .get()?.state,
      "active",
    );
    f.database("PROFILE_GAMES_DB").exec(
      "UPDATE game_session_legacy_fence SET enabled=1; INSERT INTO game_session_legacy_releases VALUES('retained-release',NULL)",
    );
    await assert.rejects(
      freezeDomainControls(f.input),
      /admission or writer guards/,
    );
    assert.equal(
      f
        .database("PROFILE_GAMES_DB")
        .prepare("SELECT COUNT(*) AS count FROM game_session_legacy_releases")
        .get()?.count,
      1,
    );
    f.database("PROFILE_GAMES_DB").exec(
      "UPDATE game_session_legacy_releases SET reconciled_at_ms=400 WHERE lock_id='retained-release'",
    );
    await freezeDomainControls(f.input);
    assert.equal(
      f
        .database("PROFILE_GAMES_DB")
        .prepare("SELECT freeze_generation FROM automatch_runtime_control")
        .get()?.freeze_generation,
      10,
    );
  } finally {
    f.close();
  }
});
