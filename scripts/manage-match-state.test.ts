import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  executeMatchState,
  manageMatchState,
  parseMatchStateArgs,
  type MatchStateOperatorDependencies,
} from "./manage-match-state.ts";
import { digest, readPrivateJson, type SqlRunner } from "./operator/runtime.ts";

const IMPORT_ID = "00000000-0000-4000-8000-000000000001";
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
    CREATE TABLE game_session_mutation_locks (lock_id TEXT PRIMARY KEY, expires_at_ms INTEGER);
    UPDATE match_state_control SET backend = 'durable', state = 'active', epoch = 2, import_id = '${IMPORT_ID}', candidate_version_id = '${IMPORT_ID}', source_digest = '${"a".repeat(64)}', verified_digest = '${"a".repeat(64)}', fence_digest = '${"b".repeat(64)}', source_record_count = 0, source_claim_count = 0, source_bundle_count = 0, verified_at_ms = 1, activated_at_ms = 2;`);
  events.exec(`CREATE TABLE event_transition_intents (transition_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE event_write_admissions (admission_id TEXT PRIMARY KEY);
    CREATE TABLE event_leases (event_id TEXT PRIMARY KEY, expires_at_ms INTEGER);`);
  const logs: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const run: SqlRunner = async (sql, database = GAMEPLAY, bindings = []) => {
    assert.match(sql.trim(), /^SELECT\b/);
    queries.push(sql);
    return (database === GAMEPLAY ? gameplay : events)
      .prepare(sql)
      .all(...bindings) as Record<string, unknown>[];
  };
  const deps: MatchStateOperatorDependencies = {
    run,
    now: () => 1000,
    log: (value) => logs.push(value),
  };
  return {
    directory,
    gameplay,
    events,
    logs,
    queries,
    deps,
    close() {
      gameplay.close();
      events.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("match-state accepts only status and a new protected inspection directory", async () => {
  assert.deepEqual(parseMatchStateArgs(["--status"]), { operation: "status" });
  assert.deepEqual(
    parseMatchStateArgs([
      "--inspect-admissions",
      "--directory",
      "/private/tmp/new-inspection",
    ]),
    {
      operation: "inspect-admissions",
      directory: "/private/tmp/new-inspection",
    },
  );
  for (const args of [
    [],
    ["--status", "--directory", "/private/tmp/unused"],
    ["--inspect-admissions"],
    ["--inspect-admissions", "--directory", "relative"],
    [
      "--inspect-admissions",
      "--directory",
      "/private/tmp/output",
      "--secret-file",
      "/private/tmp/missing",
    ],
    ...[
      "preflight",
      "drain",
      "freeze",
      "export",
      "import",
      "verify",
      "activate",
      "resume",
      "reconcile-admission",
    ].map((name) => [`--${name}`]),
  ]) {
    assert.throws(() => parseMatchStateArgs(args), /supports only/);
    await assert.rejects(executeMatchState(args), /supports only/);
  }
});

test("status reads current authority, counts, and lock without local evidence or provider credentials", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.gameplay.exec(
    "INSERT INTO game_session_transitions VALUES ('pending','pending'),('complete','complete'); INSERT INTO game_session_mutation_locks VALUES ('live',1001),('expired',999);",
  );
  f.events.exec(
    "INSERT INTO event_transition_intents VALUES ('pending','pending'); INSERT INTO event_leases VALUES ('expired',1000),('live',1001);",
  );
  await manageMatchState({ operation: "status" }, f.deps);
  assert.equal(f.logs[0].operatorLock, null);
  assert.equal(
    (f.logs[0].control as Record<string, unknown>).import_id,
    IMPORT_ID,
  );
  assert.deepEqual(f.logs[0].counts, {
    admissions: 0,
    session_intents: 1,
    session_resources: 0,
    invite_admissions: 0,
    automatch_admissions: 0,
    session_leases: 1,
    routes: 0,
    bundles: 0,
    event_admissions: 0,
    event_intents: 1,
    event_leases: 1,
  });
  assert.deepEqual(readdirSync(f.directory), []);
});

test("inspection preserves exact admission bytes using only the D1 import identity", async (t) => {
  const f = fixture();
  t.after(f.close);
  f.gameplay.exec(`INSERT INTO match_state_write_admissions
    (admission_id, backend, epoch, freeze_generation, kind, resources_json, transition_id, phase, created_at_ms)
    VALUES ('old-admission', 'rtdb', 1, 0, 'match-move', '[ "players/host/matches/game" ]', NULL, 'uncertain', 123);`);
  const rows = f.gameplay
    .prepare("SELECT * FROM match_state_write_admissions ORDER BY admission_id")
    .all();
  const output = resolve(f.directory, "new-inspection");
  await manageMatchState(
    { operation: "inspect-admissions", directory: output },
    f.deps,
  );
  assert.equal(existsSync(resolve(output, "operator.json")), false);
  const path = resolve(output, `admissions-${digest(rows)}.json`);
  assert.deepEqual(readPrivateJson(path), {
    schemaVersion: 1,
    importId: IMPORT_ID,
    admissions: rows.map((row) => ({ ...row })),
  });
  assert.equal(statSync(output).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await manageMatchState(
    { operation: "inspect-admissions", directory: output },
    f.deps,
  );
  assert.equal(readdirSync(output).length, 1);
  assert.deepEqual(
    f.gameplay
      .prepare(
        "SELECT * FROM match_state_write_admissions ORDER BY admission_id",
      )
      .all(),
    rows,
  );
  assert.deepEqual(f.logs[0], {
    operation: "inspect-admissions",
    importId: IMPORT_ID,
    admissions: 1,
  });
});

test("inspection rejects missing or changing authority before writing an artifact", async (t) => {
  for (const mode of ["missing", "changing"] as const) {
    await t.test(mode, async (t) => {
      const f = fixture();
      t.after(f.close);
      const output = resolve(f.directory, "inspection");
      const run = f.deps.run;
      if (mode === "missing")
        f.deps.run = async (...args) =>
          (await run(...args)).map((row) => ({ ...row, import_id: null }));
      else
        f.deps.run = async (...args) => {
          const rows = await run(...args);
          if (args[0].includes("SELECT * FROM match_state_write_admissions"))
            f.gameplay.exec("UPDATE match_state_control SET epoch = epoch + 1");
          return rows;
        };
      await assert.rejects(
        manageMatchState(
          { operation: "inspect-admissions", directory: output },
          f.deps,
        ),
        /requires-durable-import-identity|inspection-import-changed/,
      );
      assert.equal(existsSync(output), false);
    });
  }
});

test("inspection refuses unsafe output directories and never writes D1", async (t) => {
  const f = fixture();
  t.after(f.close);
  await assert.rejects(
    manageMatchState(
      {
        operation: "inspect-admissions",
        directory: resolve(import.meta.dirname),
      },
      f.deps,
    ),
    /artifact directory/,
  );
  assert.ok(f.queries.every((sql) => /^SELECT\b/.test(sql.trim())));
});
