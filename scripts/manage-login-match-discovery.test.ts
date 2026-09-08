import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";
import {
  compatible,
  exportedRows,
  inventory,
  inventoryKeys,
  loadExport,
  manageLoginMatchDiscovery,
  parseArgs,
  parseShallowKeys,
  type Dependencies,
} from "./manage-login-match-discovery.ts";
import { matchDiscoverySortKey } from "../cloud/functions/shared/login-match-discovery.js";

const VERSION = "11111111-1111-4111-8111-111111111111";

test("legacy discovery migration cannot scan retained Firebase invites after source activation", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TABLE invite_source_control (singleton INTEGER, backend TEXT); INSERT INTO invite_source_control VALUES (1, 'd1');",
  );
  await assert.rejects(
    f.command("preflight"),
    /Firebase invite-source scans are retired/,
  );
  assert.equal(f.reads.length, 0);
  await manageLoginMatchDiscovery({ operation: "status" }, f.dependencies);
});

function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(resolve(tmpdir(), "mons-discovery-test-"));
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE automatch_runtime_control (singleton INTEGER PRIMARY KEY, backend TEXT); INSERT INTO automatch_runtime_control VALUES (1, 'd1');",
  );
  db.exec(
    "CREATE TABLE game_session_transitions (transition_id TEXT PRIMARY KEY, invite_id TEXT, payload_json TEXT, status TEXT, created_at_ms INTEGER, updated_at_ms INTEGER);",
  );
  for (const file of [
    "0014_login_match_discovery.sql",
    "0015_login_match_discovery_control.sql",
    "0016_login_match_discovery_completion_guard.sql",
    "0017_login_match_discovery_guard_path.sql",
  ])
    db.exec(
      readFileSync(
        resolve(import.meta.dirname, "../cloud/workers/api/migrations", file),
        "utf8",
      ),
    );
  const source = new Map<string, string[]>([
    ["players", ["unlinked", "deleted-auth", "linked", "empty"]],
    ["invites", ["plain", "prefix", "prefix1", "123", "1234"]],
    ["players/unlinked/matches", ["plain", "plain1", "prefix12", "missing"]],
    ["players/deleted-auth/matches", ["1234", "prefix"]],
    ["players/linked/matches", ["plain20"]],
    ["players/empty/matches", []],
  ]);
  const reads: string[] = [];
  const logs: unknown[] = [];
  let clock = 100;
  const dependencies: Dependencies = {
    now: () => clock++,
    log: (value) => logs.push(value),
    assertDeployment: async (value) => assert.equal(value, VERSION),
    async run(sql, database, bindings = []) {
      assert.equal(database, "mons-link-profile-games");
      return db.prepare(sql).all(...bindings) as Record<string, unknown>[];
    },
    async *streamKeys(path) {
      reads.push(path);
      for (const key of source.get(path) || []) yield key;
    },
    async inviteExists(inviteId) {
      return source.get("invites")!.includes(inviteId);
    },
  };
  const command = async (
    operation: "preflight" | "export" | "import" | "verify" | "activate",
  ) =>
    manageLoginMatchDiscovery(
      {
        operation,
        directory,
        ...(["preflight", "verify", "activate"].includes(operation)
          ? { candidateVersionId: VERSION }
          : {}),
      },
      dependencies,
    );
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, source, reads, logs, dependencies, command };
}

test("discovery operator requires explicit credential and capture scope", () => {
  assert.equal(parseArgs(["--status"]).operation, "status");
  assert.throws(
    () => parseArgs(["--export", "--directory", "/private/export"]),
    /explicit/,
  );
  assert.throws(
    () => parseArgs(["--preflight", "--directory", "/private/export"]),
    /candidate/,
  );
  assert.throws(
    () => parseArgs(["--status", "--directory", "/private/export"]),
    /no options/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--import",
        "--directory",
        "/private/export",
        "--firebase-credentials",
        "/private/account.json",
      ]),
    /does not read/,
  );
  assert.equal(
    parseArgs([
      "--export",
      "--directory",
      "/private/export",
      "--firebase-credentials",
      "/private/account.json",
    ]).operation,
    "export",
  );
});

test("streaming shallow parser accepts complete object/null and rejects malformed, nested or truncated inventories", async () => {
  const read = async (chunks: string[]) => {
    const keys: string[] = [];
    for await (const key of parseShallowKeys(Readable.from(chunks)))
      keys.push(key);
    return keys;
  };
  assert.deepEqual(await read(['{"nu', 'meric1":true,"💫":', "true}"]), [
    "numeric1",
    "💫",
  ]);
  assert.deepEqual(await read(["null"]), []);
  assert.deepEqual(await read(["{}"]), []);
  for (const value of [
    '{"nested":{"x":true}}',
    '["x"]',
    '{"x":false}',
    '{"x":true',
    '{"a/b":true}',
    `{"${"x".repeat(769)}":true}`,
  ])
    await assert.rejects(read([value]));
});

test("inventory pages are bounded, UTF-16 sorted, complete, and resumed without rereading", async (t) => {
  const f = fixture(t);
  f.source.set(
    "players",
    Array.from({ length: 501 }, (_, index) => `uid-${index}`).concat([
      "💫",
      "\uffff",
    ]),
  );
  const result = await inventory(f.directory, "players", f.dependencies);
  assert.equal(result.pages.length, 3);
  assert.deepEqual(
    result.pages.map((page) => page.count),
    [200, 200, 103],
  );
  assert.deepEqual(
    [...inventoryKeys(f.directory, result)],
    f.source.get("players")!.toSorted(),
  );
  const reads = f.reads.length;
  assert.deepEqual(
    await inventory(f.directory, "players", f.dependencies),
    result,
  );
  assert.equal(f.reads.length, reads);
});

test("failed streaming inventory cannot publish completion and restarts from its source", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    inventory(f.directory, "players", {
      ...f.dependencies,
      async *streamKeys() {
        yield "partial";
        throw new Error("connection-cut");
      },
    }),
    /connection-cut/,
  );
  assert.equal(
    readdirSync(f.directory).some((file) => file.endsWith("complete.json")),
    false,
  );
  const result = await inventory(f.directory, "players", f.dependencies);
  assert.deepEqual(
    [...inventoryKeys(f.directory, result)],
    f.source.get("players")!.toSorted(),
  );
});

test("inventory restart after page publication tolerates source growth without changing old pages", async (t) => {
  const f = fixture(t);
  const first = await inventory(f.directory, "players", f.dependencies);
  const oldPages = first.pages.map((proof) =>
    readFileSync(resolve(f.directory, proof.file), "utf8"),
  );
  const completion = readdirSync(f.directory).find((name) =>
    name.endsWith("-complete.json"),
  )!;
  rmSync(resolve(f.directory, completion));
  f.source.get("players")!.push("a-new-player");
  const next = await inventory(f.directory, "players", f.dependencies);
  assert.equal(next.count, first.count + 1);
  assert.deepEqual(
    [...inventoryKeys(f.directory, next)],
    f.source.get("players")!.toSorted(),
  );
  assert.notEqual(first.pages[0].file, next.pages[0].file);
  assert.deepEqual(
    first.pages.map((proof) =>
      readFileSync(resolve(f.directory, proof.file), "utf8"),
    ),
    oldPages,
  );
});

test("player exports use at most eight source streams and preserve deterministic manifest ordering", async (t) => {
  const f = fixture(t);
  const players = Array.from({ length: 25 }, (_, index) => `player-${index}`);
  f.source.set("players", players.toReversed());
  for (const player of players)
    f.source.set(`players/${player}/matches`, ["plain"]);
  let active = 0;
  let maximum = 0;
  const dependencies: Dependencies = {
    ...f.dependencies,
    async *streamKeys(path) {
      if (!path.endsWith("/matches")) {
        yield* f.dependencies.streamKeys(path);
        return;
      }
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yield* f.dependencies.streamKeys(path);
      } finally {
        active--;
      }
    },
  };
  await f.command("preflight");
  await manageLoginMatchDiscovery(
    { operation: "export", directory: f.directory },
    dependencies,
  );
  assert.equal(maximum, 8);
  const manifest = loadExport(f.directory);
  assert.deepEqual(
    [...exportedRows(f.directory, manifest)].map((row) => row.loginUid),
    players.toSorted(),
  );
});

test("preflight requires deployed capture and real guard; repeats preserve original evidence", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.command("export"), /preflight/);
  await f.command("preflight");
  const first = f.db
    .prepare("SELECT * FROM login_match_discovery_control")
    .get();
  await f.command("preflight");
  assert.deepEqual(
    f.db.prepare("SELECT * FROM login_match_discovery_control").get(),
    first,
  );
  f.db.exec("DROP TRIGGER login_match_discovery_completion_guard");
  await assert.rejects(f.command("export"), /completion guard/);
});

test("complete rehearsal preserves anonymous/deleted users, ambiguity, exact matches, and active capture extras", async (t) => {
  const f = fixture(t);
  await f.command("preflight");
  await f.command("export");
  const manifest = loadExport(f.directory);
  const rows = [...exportedRows(f.directory, manifest)];
  assert.equal(manifest.playerCount, 4);
  assert.equal(manifest.matchCount, 7);
  assert.deepEqual(
    rows.find((row) => row.matchId === "prefix12"),
    {
      loginUid: "unlinked",
      matchId: "prefix12",
      matchSortKey: matchDiscoverySortKey("prefix12"),
      inviteId: null,
      resolution: "ambiguous",
    },
  );
  assert.equal(rows.find((row) => row.matchId === "1234")?.inviteId, "1234");
  const sourceReads = f.reads.length;
  await f.command("export");
  assert.equal(f.reads.length, sourceReads);
  await f.command("import");
  await f.command("import");
  f.source.get("players")!.push("new-anonymous");
  f.source.set("players/new-anonymous/matches", ["plain2"]);
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
    )
    .run("new-anonymous", "plain2", matchDiscoverySortKey("plain2"), "plain");
  await f.command("verify");
  assert.equal(
    f.db
      .prepare("SELECT discovery_backend FROM login_match_discovery_control")
      .get()?.discovery_backend,
    "rtdb",
  );
  await f.command("activate");
  await f.command("activate");
  assert.equal(
    f.db
      .prepare("SELECT discovery_backend FROM login_match_discovery_control")
      .get()?.discovery_backend,
    "d1",
  );
  await assert.rejects(f.command("import"), /activated/);
});

test("import never changes a conflicting captured mapping", async (t) => {
  const f = fixture(t);
  await f.command("preflight");
  await f.command("export");
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
    )
    .run("deleted-auth", "1234", matchDiscoverySortKey("1234"), "123");
  await assert.rejects(f.command("import"), /conflicting/);
  assert.equal(
    f.db
      .prepare(
        "SELECT invite_id FROM login_match_discovery WHERE match_id = '1234'",
      )
      .get()?.invite_id,
    "123",
  );
});

test("export uses a concurrent capture when its exact invite was absent from the inventory", async (t) => {
  const f = fixture(t);
  const inviteId = "12345678901";
  f.source.set("players", ["unlinked"]);
  f.source.set("invites", ["1234567890"]);
  f.source.set("players/unlinked/matches", [inviteId]);
  await f.command("preflight");
  await manageLoginMatchDiscovery(
    { operation: "export", directory: f.directory },
    {
      ...f.dependencies,
      async *streamKeys(path) {
        if (path === "players/unlinked/matches") {
          f.source.get("invites")!.push(inviteId);
          f.db
            .prepare(
              "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
            )
            .run(
              "unlinked",
              inviteId,
              matchDiscoverySortKey(inviteId),
              inviteId,
            );
        }
        yield* f.dependencies.streamKeys(path);
      },
    },
  );
  const manifest = loadExport(f.directory);
  assert.equal([...exportedRows(f.directory, manifest)][0].inviteId, inviteId);
  await f.command("export");
  assert.deepEqual(loadExport(f.directory), manifest);
  await f.command("import");
  await f.command("import");
  await f.command("verify");
  await f.command("activate");
});

test("export retries contested prefixes after delayed capture without replacing inventories", async (t) => {
  for (const inviteMaterialized of [false, true]) {
    await t.test(`invite materialized: ${inviteMaterialized}`, async (t) => {
      const f = fixture(t);
      const inviteId = "12345678901";
      f.source.set("players", ["unlinked"]);
      f.source.set("invites", ["1234567890"]);
      f.source.set("players/unlinked/matches", [inviteId]);
      await f.command("preflight");
      f.db
        .prepare(
          "INSERT INTO game_session_transitions VALUES ('creating', ?, ?, 'pending', 200, 200)",
        )
        .run(
          inviteId,
          JSON.stringify({
            creations: [{ path: `players/unlinked/matches/${inviteId}` }],
          }),
        );
      await assert.rejects(
        manageLoginMatchDiscovery(
          { operation: "export", directory: f.directory },
          {
            ...f.dependencies,
            async *streamKeys(path) {
              if (path === "players/unlinked/matches" && inviteMaterialized)
                f.source.get("invites")!.push(inviteId);
              yield* f.dependencies.streamKeys(path);
            },
          },
        ),
        /pending session transitions.*before export/,
      );
      assert.equal(
        readdirSync(f.directory).some((file) => file.startsWith("player-")),
        false,
      );
      const sourceReads = f.reads.length;
      if (!inviteMaterialized) f.source.get("invites")!.push(inviteId);
      f.db
        .prepare(
          "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 201)",
        )
        .run("unlinked", inviteId, matchDiscoverySortKey(inviteId), inviteId);
      f.db.exec(
        "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'creating'",
      );
      await f.command("export");
      assert.equal(f.reads.length, sourceReads);
      assert.equal(
        [...exportedRows(f.directory, loadExport(f.directory))][0].inviteId,
        inviteId,
      );
      await f.command("import");
      await f.command("import");
      await f.command("activate");
    });
  }
});

test("export refreshes exact invite evidence before delayed event capture", async (t) => {
  const f = fixture(t);
  const inviteId = "12345678901";
  f.source.set("players", ["unlinked"]);
  f.source.set("invites", ["1234567890"]);
  f.source.set("players/unlinked/matches", [inviteId]);
  await f.command("preflight");
  await manageLoginMatchDiscovery(
    { operation: "export", directory: f.directory },
    {
      ...f.dependencies,
      async *streamKeys(path) {
        if (path === "players/unlinked/matches")
          f.source.get("invites")!.push(inviteId);
        yield* f.dependencies.streamKeys(path);
      },
    },
  );
  assert.equal(
    [...exportedRows(f.directory, loadExport(f.directory))][0].inviteId,
    inviteId,
  );
  await f.command("import");
  f.db.exec("UPDATE login_match_discovery SET provenance = 'capture'");
  await f.command("import");
  await f.command("activate");
});

test("export keeps capture queries bounded and rejects different existing invite mappings", async (t) => {
  const f = fixture(t);
  f.source.set("players", ["unlinked"]);
  f.source.set("invites", ["plain", "other"]);
  f.source.set(
    "players/unlinked/matches",
    Array.from({ length: 201 }, (_, index) => `plain${index + 1}`),
  );
  const batches: number[] = [];
  await f.command("preflight");
  const dependencies: Dependencies = {
    ...f.dependencies,
    async run(sql, database, bindings = []) {
      if (sql.startsWith("SELECT * FROM login_match_discovery WHERE"))
        batches.push(JSON.parse(String(bindings[0])).length);
      return f.dependencies.run(sql, database, bindings);
    },
  };
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
    )
    .run("unlinked", "plain1", matchDiscoverySortKey("plain1"), "other");
  await assert.rejects(
    manageLoginMatchDiscovery(
      { operation: "export", directory: f.directory },
      dependencies,
    ),
    /conflicting captured discovery mapping/,
  );
  assert.equal(
    f.db.prepare("SELECT invite_id FROM login_match_discovery").get()
      ?.invite_id,
    "other",
  );
  f.db.exec("DELETE FROM login_match_discovery");
  batches.length = 0;
  await manageLoginMatchDiscovery(
    { operation: "export", directory: f.directory },
    dependencies,
  );
  assert.deepEqual(batches, [100, 100, 1]);
});

test("export preserves a published page when capture changes before a later-page retry", async (t) => {
  const f = fixture(t);
  const matches = Array.from(
    { length: 201 },
    (_, index) => `plain${index + 1}`,
  ).toSorted();
  f.source.set("players", ["unlinked"]);
  f.source.set("invites", ["plain"]);
  f.source.set("players/unlinked/matches", matches);
  await f.command("preflight");
  await assert.rejects(
    manageLoginMatchDiscovery(
      { operation: "export", directory: f.directory },
      {
        ...f.dependencies,
        async inviteExists(inviteId) {
          if (inviteId === matches[200]) throw new Error("source-interrupted");
          return f.dependencies.inviteExists(inviteId);
        },
      },
    ),
    /source-interrupted/,
  );
  const pageFile = readdirSync(f.directory).find((file) =>
    /^player-.*-0\.json$/.test(file),
  )!;
  const original = readFileSync(resolve(f.directory, pageFile), "utf8");
  f.source.get("invites")!.push(matches[0]);
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
    )
    .run("unlinked", matches[0], matchDiscoverySortKey(matches[0]), matches[0]);
  await f.command("export");
  assert.equal(readFileSync(resolve(f.directory, pageFile), "utf8"), original);
  const rows = [...exportedRows(f.directory, loadExport(f.directory))];
  assert.equal(rows.length, 201);
  assert.equal(rows[0].inviteId, "plain");
  await assert.rejects(f.command("import"), /conflicting discovery mapping/);
});

test("compatible live capture upgrades unresolved backfill but never changes resolved evidence", () => {
  const source = {
    loginUid: "uid",
    matchId: "prefix12",
    matchSortKey: matchDiscoverySortKey("prefix12"),
    inviteId: null,
    resolution: "ambiguous" as const,
  };
  assert.equal(
    compatible(source, {
      ...source,
      inviteId: "prefix",
      resolution: "resolved",
      provenance: "capture",
    }),
    true,
  );
  assert.equal(
    compatible(source, {
      ...source,
      inviteId: "prefix",
      resolution: "resolved",
      provenance: "backfill",
    }),
    false,
  );
  assert.equal(
    compatible(
      { ...source, resolution: "resolved", inviteId: "prefix1" },
      {
        ...source,
        resolution: "resolved",
        inviteId: "prefix",
        provenance: "capture",
      },
    ),
    false,
  );
});

test("verification rejects missing capture, missing baseline, extra backfill, and pending transitions", async (t) => {
  const f = fixture(t);
  await f.command("preflight");
  await f.command("export");
  await f.command("import");
  f.source.set("players/empty/matches", ["plain3"]);
  await assert.rejects(f.command("verify"), /missing or conflicting/);
  f.source.set("players/empty/matches", []);
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'backfill', 200)",
    )
    .run("stray", "plain", matchDiscoverySortKey("plain"), "plain");
  await assert.rejects(f.command("verify"), /unexpected destination/);
  f.db.exec("DELETE FROM login_match_discovery WHERE login_uid = 'stray'");
  f.source.set("players/linked/matches", []);
  await assert.rejects(f.command("verify"), /disappeared/);
  f.source.set("players/linked/matches", ["plain20"]);
  f.db
    .prepare(
      "INSERT INTO game_session_transitions VALUES ('pending', 'plain', ?, 'pending', 200, 200)",
    )
    .run(JSON.stringify({ creations: [] }));
  await assert.rejects(f.command("activate"), /pending session/);
  assert.equal(
    f.db
      .prepare("SELECT discovery_backend FROM login_match_discovery_control")
      .get()?.discovery_backend,
    "rtdb",
  );
});

test("completion guard and activation handle a login UID named matches", async (t) => {
  const f = fixture(t);
  await f.command("preflight");
  await f.command("export");
  await f.command("import");
  f.db
    .prepare(
      "INSERT INTO game_session_transitions VALUES ('old', 'plain', ?, 'pending', 99, 200)",
    )
    .run(
      JSON.stringify({
        creations: [{ path: "players/matches/matches/plain" }],
      }),
    );
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'old'",
      ),
    /capture-required/,
  );
  await assert.rejects(f.command("activate"), /pending session/);
  f.db
    .prepare(
      "INSERT INTO login_match_discovery VALUES (?, ?, ?, ?, 'resolved', 'capture', 200)",
    )
    .run("matches", "plain", matchDiscoverySortKey("plain"), "plain");
  f.db.exec(
    "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'old'",
  );
  await f.command("activate");
});

test("tampered immutable artifacts and duplicate inventory keys fail before import", async (t) => {
  const f = fixture(t);
  await f.command("preflight");
  await f.command("export");
  const manifest = loadExport(f.directory);
  const proof = manifest.players.pages[0];
  writeFileSync(resolve(f.directory, proof.file), JSON.stringify(["tampered"]));
  await assert.rejects(f.command("import"), /digest mismatch/);
  f.source.set("duplicates", ["same", "same"]);
  await assert.rejects(
    inventory(f.directory, "duplicates", f.dependencies),
    /UNIQUE/,
  );
});
