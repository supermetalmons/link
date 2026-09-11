import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  manageMatchState,
  parseMatchStateArgs,
  type MatchStateArguments,
  type MatchStateOperatorDependencies,
} from "./manage-match-state.ts";
import {
  canonicalJson,
  digest,
  readPrivateJson,
  writePrivateImmutable,
  type SqlRunner,
} from "./operator/runtime.ts";
import type { MatchStateInventory } from "./match-state-manifest.ts";
import type { MatchStateImportSnapshot } from "../cloud/workers/api/src/matchStateTypes.ts";
import { createMatchStateProvider } from "./match-state-provider.ts";

const VERSION = "00000000-0000-4000-8000-000000000001";
const GAMEPLAY = "mons-link-profile-games";

function fixture() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "match-state-operator-test-"),
  );
  const gameplay = new DatabaseSync(":memory:");
  const events = new DatabaseSync(":memory:");
  gameplay.exec(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../cloud/workers/api/migrations/0024_match_state.sql",
      ),
      "utf8",
    ),
  );
  gameplay.exec(`CREATE TABLE game_session_transitions (transition_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE game_session_transition_resources (resource_key TEXT PRIMARY KEY);
    CREATE TABLE invite_source_write_admissions (admission_id TEXT PRIMARY KEY);
    CREATE TABLE automatch_write_admissions (admission_id TEXT PRIMARY KEY);
    CREATE TABLE game_session_mutation_locks (lock_id TEXT PRIMARY KEY, expires_at_ms INTEGER);`);
  events.exec(`CREATE TABLE event_transition_intents (transition_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE event_write_admissions (admission_id TEXT PRIMARY KEY);
    CREATE TABLE event_leases (event_id TEXT PRIMARY KEY, expires_at_ms INTEGER);
    CREATE TABLE event_runtime_control (singleton INTEGER PRIMARY KEY, storage_mode TEXT);
    INSERT INTO event_runtime_control VALUES (1,'frozen');`);
  const source: MatchStateInventory = {
    records: [
      {
        actorUid: "host",
        matchId: "game",
        value: {
          color: "white",
          fen: "fen",
          timer: "1;90000",
          retained: { privateLegacyField: true },
        },
      },
      { actorUid: "orphan", matchId: "gone", value: "retained-scalar" },
    ],
    claims: [{ matchId: "gone", value: { status: "old-claim" } }],
    invites: [
      {
        inviteId: "game",
        value: { hostId: "host", guestId: "guest" },
        revision: 1,
      },
      { inviteId: "empty", value: { hostId: "host" }, revision: 1 },
    ],
    discovery: [
      {
        actorUid: "host",
        matchId: "game",
        inviteId: "game",
        resolution: "resolved",
      },
    ],
    crossChecks: { timerMarkers: [] },
  };
  const rooms = new Map<string, MatchStateImportSnapshot>();
  const logs: Record<string, unknown>[] = [];
  let failImportResponse = false;
  let failActivationResponse = false;
  const run: SqlRunner = async (sql, database = GAMEPLAY, bindings = []) => {
    const db = database === GAMEPLAY ? gameplay : events;
    const result = db.prepare(sql).all(...bindings) as Record<
      string,
      unknown
    >[];
    if (failActivationResponse && sql.includes("SET backend = 'durable'")) {
      failActivationResponse = false;
      throw new Error("simulated-provider-timeout-after-activation");
    }
    return result;
  };
  const deps: MatchStateOperatorDependencies = {
    run,
    now: () => 1000,
    deployment: async () => VERSION,
    inventory: async () => structuredClone(source),
    readSource: async (path) => {
      const row = source.records.find(
        (entry) =>
          `players/${entry.actorUid}/matches/${entry.matchId}` === path,
      );
      return (
        row?.value ??
        source.claims.find(
          (entry) => `matchTimerClaims/${entry.matchId}` === path,
        )?.value ??
        null
      );
    },
    log: (value) => logs.push(value),
    migrate: async (request) => {
      const { bundle } = request;
      if (request.operation === "import") {
        const existing = rooms.get(bundle.inviteId);
        if (existing && canonicalJson(existing) !== canonicalJson(bundle))
          throw new Error("room-import-conflict");
        rooms.set(bundle.inviteId, structuredClone(bundle));
        for (const row of bundle.records) {
          gameplay
            .prepare(
              "INSERT OR IGNORE INTO match_state_routes VALUES (?, ?, 'durable', ?, ?)",
            )
            .run(row.playerId, row.matchId, bundle.inviteId, bundle.epoch);
        }
        gameplay
          .prepare(
            "INSERT OR IGNORE INTO match_state_import_receipts VALUES (?, ?, ?, ?, ?, ?, 'staged')",
          )
          .run(
            bundle.importId,
            bundle.inviteId,
            bundle.epoch,
            bundle.digest,
            bundle.recordCount,
            bundle.claimCount,
          );
        if (failImportResponse) {
          failImportResponse = false;
          throw new Error("simulated-lost-import-response");
        }
      } else {
        const existing = rooms.get(bundle.inviteId);
        if (!existing || canonicalJson(existing) !== canonicalJson(bundle))
          throw new Error("room-readback-conflict");
        gameplay
          .prepare(
            "UPDATE match_state_import_receipts SET phase = ? WHERE import_id = ? AND invite_id = ?",
          )
          .run(
            request.operation === "activate" ? "active" : "verified",
            bundle.importId,
            bundle.inviteId,
          );
      }
      return structuredClone(bundle);
    },
  };
  const fenceFile = resolve(directory, "fence-input.json");
  const fenceProof = {
    schemaVersion: 1,
    kind: "match-state-source-fence",
    candidateVersionId: VERSION,
    databaseUrl: "https://mons-link-default-rtdb.firebaseio.com",
    checkedAtMs: 1000,
    workflowInstancesFenced: true,
    principals: [
      {
        principal: "gameplay@mons-link.iam.gserviceaccount.com",
        beforeTokenWriteStatus: 403,
        freshTokenWriteStatus: 403,
        readStatus: 200,
      },
    ],
  };
  const perform = async (
    operation: MatchStateArguments["operation"],
    extra: Partial<MatchStateArguments> = {},
  ) => {
    if (operation === "export" && !extra.fenceEvidence) {
      const owner = readPrivateJson(resolve(directory, "operator.json")) as {
        importId: string;
      };
      writePrivateImmutable(fenceFile, {
        ...fenceProof,
        importId: owner.importId,
        freezeGeneration: gameplay
          .prepare("SELECT freeze_generation FROM match_state_control")
          .get()?.freeze_generation,
      });
    }
    return manageMatchState(
      {
        operation,
        directory,
        ...(operation === "preflight" ? { candidateVersionId: VERSION } : {}),
        ...(operation === "export" ? { fenceEvidence: fenceFile } : {}),
        ...extra,
      },
      deps,
    );
  };
  const prepare = async () => {
    await perform("preflight");
    await perform("drain");
    await perform("freeze");
    await perform("export");
  };
  return {
    deps,
    source,
    rooms,
    logs,
    directory,
    gameplay,
    events,
    perform,
    prepare,
    failImport() {
      failImportResponse = true;
    },
    failActivation() {
      failActivationResponse = true;
    },
    close() {
      gameplay.close();
      events.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("operator performs exhaustive import, keeps deadlines and has one-way activation", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    await f.perform("activate");
    assert.deepEqual(
      f.gameplay
        .prepare("SELECT backend, state, epoch FROM match_state_control")
        .get(),
      Object.assign(Object.create(null), {
        backend: "durable",
        state: "frozen",
        epoch: 2,
      }),
    );
    assert.equal(f.rooms.size, 2);
    assert.equal(f.rooms.get("empty")?.recordCount, 0);
    assert.equal(f.rooms.get("game")?.records[0].value.timer, "1;90000");
    assert.equal(
      f.gameplay
        .prepare("SELECT record_json FROM match_state_legacy_records")
        .get()?.record_json,
      '"retained-scalar"',
    );
    assert.throws(
      () =>
        f.gameplay
          .prepare("UPDATE match_state_control SET backend = 'rtdb'")
          .run(),
      /one-way/,
    );
    await f.perform("resume");
    await assert.rejects(f.perform("resume"), /mutating phases are retired/);
    assert.equal(
      f.gameplay
        .prepare("SELECT COUNT(*) AS n FROM match_state_operator_lock")
        .get()?.n,
      0,
    );
    assert.ok(exists(f.directory, "activated.json"));
  } finally {
    f.close();
  }
});

test("completed migration status and admission inspection remain read-only after candidate cleanup", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    await f.perform("activate");
    await f.perform("resume");
    const run: SqlRunner = async (sql, database, bindings) => {
      assert.match(sql, /^\s*SELECT\b/);
      return f.deps.run(sql, database, bindings);
    };
    const deps = {
      ...f.deps,
      ...createMatchStateProvider({
        run,
        firebaseCredentials: resolve(
          f.directory,
          "missing-source-credentials.json",
        ),
        fetcher: async () => {
          throw new Error(
            "completed inspection must not contact source or deployment",
          );
        },
      }),
      run,
    };
    await manageMatchState({ operation: "status" }, deps);
    const status = f.logs.at(-1)!;
    assert.equal(
      (status.control as Record<string, unknown>).backend,
      "durable",
    );
    assert.equal((status.control as Record<string, unknown>).state, "active");
    assert.equal((status.counts as Record<string, unknown>).admissions, 0);
    assert.equal((status.counts as Record<string, unknown>).routes, 2);
    assert.equal((status.counts as Record<string, unknown>).bundles, 2);
    assert.equal(status.operatorLock, null);
    await manageMatchState(
      { operation: "inspect-admissions", directory: f.directory },
      deps,
    );
    assert.deepEqual(f.logs.at(-1), {
      operation: "inspect-admissions",
      admissions: 0,
    });
    const proof = readPrivateJson(
      resolve(f.directory, `admissions-${digest([])}.json`),
    ) as Record<string, unknown>;
    assert.deepEqual(proof.admissions, []);
    assert.equal(
      proof.importId,
      (status.control as Record<string, unknown>).import_id,
    );
  } finally {
    f.close();
  }
});

test("completed durable authority rejects every retired write phase before accessing files or providers", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    await f.perform("activate");
    await f.perform("resume");
    const directory = resolve(f.directory, "must-not-be-created");
    const deps = {
      ...f.deps,
      run: async (sql: string) => {
        assert.equal(
          sql,
          "SELECT * FROM match_state_control WHERE singleton = 1",
        );
        return f.deps.run(sql);
      },
      deployment: async () => {
        throw new Error("retired phase must not check the former deployment");
      },
    };
    for (const operation of [
      "preflight",
      "drain",
      "freeze",
      "export",
      "import",
      "verify",
      "activate",
      "resume",
      "reconcile-admission",
    ] as const)
      await assert.rejects(
        manageMatchState({ operation, directory }, deps),
        /migration-complete; mutating phases are retired/,
      );
    assert.equal(existsSync(directory), false);
    assert.ok(exists(f.directory, "activated.json"));
    assert.ok(exists(f.directory, "resumed.json"));
    assert.equal(
      f.gameplay
        .prepare("SELECT COUNT(*) AS n FROM match_state_operator_lock")
        .get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});

function exists(directory: string, name: string): boolean {
  return !!readPrivateJson(resolve(directory, name));
}

test("lost import responses resume without duplicate routes or missing rooms", async () => {
  const f = fixture();
  try {
    await f.prepare();
    f.failImport();
    await assert.rejects(f.perform("import"), /lost-import-response/);
    await f.perform("import");
    await f.perform("verify");
    assert.equal(
      f.gameplay.prepare("SELECT COUNT(*) AS n FROM match_state_routes").get()
        ?.n,
      2,
    );
    assert.equal(
      f.gameplay
        .prepare("SELECT COUNT(*) AS n FROM match_state_import_receipts")
        .get()?.n,
      2,
    );
  } finally {
    f.close();
  }
});

test("a lost activation response is resolved by authoritative readback", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    f.failActivation();
    await assert.rejects(f.perform("activate"), /timeout-after-activation/);
    assert.equal(
      f.gameplay.prepare("SELECT backend FROM match_state_control").get()
        ?.backend,
      "durable",
    );
    await f.perform("activate");
    assert.ok(exists(f.directory, "activated.json"));
  } finally {
    f.close();
  }
});

test("source changes prevent activation and retain frozen authority", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    (f.source.records[0].value as Record<string, unknown>).fen = "changed";
    await assert.rejects(f.perform("activate"), /source-changed/);
    assert.equal(
      f.gameplay.prepare("SELECT backend FROM match_state_control").get()
        ?.backend,
      "rtdb",
    );
    assert.equal(
      f.gameplay.prepare("SELECT state FROM match_state_control").get()?.state,
      "frozen",
    );
  } finally {
    f.close();
  }
});

test("uncertain admissions and pending effects prevent final freeze", async () => {
  const f = fixture();
  try {
    await f.perform("preflight");
    await f.perform("drain");
    f.gameplay
      .prepare(
        "INSERT INTO match_state_write_admissions VALUES ('old', 'rtdb', 1, 0, 'timer', '[]', NULL, 'uncertain', 0)",
      )
      .run();
    await assert.rejects(f.perform("freeze"), /unresolved-admissions/);
    assert.equal(
      f.gameplay.prepare("SELECT phase FROM match_state_write_admissions").get()
        ?.phase,
      "uncertain",
    );
  } finally {
    f.close();
  }
});

test("exclusive operator lock rejects a second migration", async () => {
  const f = fixture();
  const other = mkdtempSync(resolve(tmpdir(), "match-state-second-test-"));
  try {
    await f.perform("preflight");
    await f.perform("drain");
    await manageMatchState(
      { operation: "preflight", directory: other, candidateVersionId: VERSION },
      f.deps,
    );
    await assert.rejects(
      manageMatchState({ operation: "drain", directory: other }, f.deps),
      /owned-by-another/,
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
    f.close();
  }
});

test("extra routes prevent proof of complete import coverage", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    f.gameplay
      .prepare(
        "INSERT INTO match_state_routes VALUES ('unexpected', 'unexpected', 'legacy', NULL, 2)",
      )
      .run();
    await assert.rejects(f.perform("verify"), /coverage-incomplete/);
  } finally {
    f.close();
  }
});

test("exact-source evidence reconciles an uncertain admission and replays safely", async () => {
  const f = fixture();
  try {
    await f.perform("preflight");
    await f.perform("drain");
    const admissionId = "00000000-0000-4000-8000-000000000003";
    const resource = "players/host/matches/game";
    f.gameplay
      .prepare(
        "INSERT INTO match_state_write_admissions VALUES (?, 'rtdb', 1, 0, 'timer', ?, NULL, 'uncertain', 1)",
      )
      .run(admissionId, JSON.stringify([resource]));
    const admission = f.gameplay
      .prepare(
        "SELECT * FROM match_state_write_admissions WHERE admission_id = ?",
      )
      .get(admissionId)!;
    const owner = readPrivateJson(resolve(f.directory, "operator.json")) as {
      importId: string;
    };
    const proof = {
      schemaVersion: 1,
      importId: owner.importId,
      admission,
      admissionDigest: digest(admission),
      requestFinished: true,
      requestFinishedAtMs: 2,
      sourceWritesFenced: true,
      sources: [{ resource, digest: digest(f.source.records[0].value) }],
    };
    const path = resolve(f.directory, "reconciliation-input.json");
    writePrivateImmutable(path, proof);
    await f.perform("reconcile-admission", { evidence: path });
    await f.perform("reconcile-admission", { evidence: path });
    assert.equal(
      f.gameplay
        .prepare("SELECT COUNT(*) AS n FROM match_state_write_admissions")
        .get()?.n,
      0,
    );
    assert.equal(
      f.gameplay
        .prepare(
          "SELECT COUNT(*) AS n FROM match_state_reconciliation_receipts",
        )
        .get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});

test("operator argument validation precedes provider access", () => {
  assert.deepEqual(parseMatchStateArgs(["--status"]), { operation: "status" });
  assert.throws(
    () =>
      parseMatchStateArgs([
        "--status",
        "--firebase-credentials",
        "/tmp/secret",
      ]),
    /no other/,
  );
  assert.throws(
    () => parseMatchStateArgs(["--preflight", "--directory", "/tmp/test"]),
    /candidate/,
  );
  assert.throws(
    () => parseMatchStateArgs(["--export", "--directory", "/tmp/test"]),
    /fence-evidence/,
  );
  assert.throws(
    () => parseMatchStateArgs(["--import", "--directory", "/tmp/test"]),
    /secret-file/,
  );
});

test("the deployed candidate is rechecked after room activation and immediately before the global switch", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.perform("import");
    await f.perform("verify");
    let reads = 0;
    let changed = false;
    f.deps.inventory = async () => {
      if (++reads === 2) changed = true;
      return structuredClone(f.source);
    };
    f.deps.deployment = async () =>
      changed ? "00000000-0000-4000-8000-000000000099" : VERSION;
    await assert.rejects(f.perform("activate"), /candidate-is-not-serving/);
    assert.equal(
      f.gameplay.prepare("SELECT backend FROM match_state_control").get()
        ?.backend,
      "rtdb",
    );
  } finally {
    f.close();
  }
});

test("source-fence evidence must belong to this frozen generation and a real past probe", async () => {
  const f = fixture();
  try {
    await f.perform("preflight");
    await f.perform("drain");
    await f.perform("freeze");
    const owner = readPrivateJson(resolve(f.directory, "operator.json")) as {
      importId: string;
    };
    for (const [index, change] of [
      { checkedAtMs: 999 },
      { checkedAtMs: 1001 },
      { freezeGeneration: 2 },
    ].entries()) {
      const path = resolve(f.directory, `invalid-fence-${index}.json`);
      writePrivateImmutable(path, {
        schemaVersion: 1,
        kind: "match-state-source-fence",
        importId: owner.importId,
        candidateVersionId: VERSION,
        databaseUrl: "https://mons-link-default-rtdb.firebaseio.com",
        freezeGeneration: 1,
        checkedAtMs: 1000,
        workflowInstancesFenced: true,
        principals: [
          {
            principal: "gameplay@mons-link.iam.gserviceaccount.com",
            beforeTokenWriteStatus: 403,
            freshTokenWriteStatus: 403,
            readStatus: 200,
          },
        ],
        ...change,
      });
      await assert.rejects(
        f.perform("export", { fenceEvidence: path }),
        /fence-evidence-required/,
      );
    }
  } finally {
    f.close();
  }
});
