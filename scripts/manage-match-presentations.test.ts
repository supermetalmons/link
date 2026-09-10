import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
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
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  checkReadback,
  absentMetadataReferences,
  createProductionDependencies,
  exportedRows,
  loadExport,
  manageMatchPresentations,
  matchesCanonicalActor,
  parseArgs,
  providerModulesDigest,
  verifyWriterProof,
  seedDigest,
  signedMigrationRequest,
  type Arguments,
  type BridgeRequest,
  type Dependencies,
  type ReadbackRow,
  type SourceRow,
} from "./manage-match-presentations.ts";

import { digest, writePrivateImmutable } from "./manage-wager-state.ts";

const VERSION = "11111111-1111-4111-8111-111111111111";
const OTHER_VERSION = "22222222-2222-4222-8222-222222222222";
const SECRET = "appearance-migration-test-secret-32-characters";
const keyOf = (uid: string, matchId: string) => JSON.stringify([uid, matchId]);

function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(resolve(tmpdir(), "mons-appearances-test-"));
  const db = new DatabaseSync(":memory:");
  const events = new DatabaseSync(":memory:");
  const profiles = new DatabaseSync(":memory:");
  profiles.exec(
    "CREATE TABLE profile_records (profile_id TEXT PRIMARY KEY, state TEXT, merged_into_profile_id TEXT); CREATE TABLE profile_login_owners (login_uid TEXT PRIMARY KEY, profile_id TEXT, revision INTEGER);",
  );
  db.exec(
    "CREATE TABLE invite_sources (invite_id TEXT PRIMARY KEY, source_json TEXT); CREATE TABLE invite_source_control (singleton INTEGER, backend TEXT); INSERT INTO invite_source_control VALUES (1, 'd1'); CREATE TABLE login_match_discovery_control (singleton INTEGER, discovery_backend TEXT); INSERT INTO login_match_discovery_control VALUES (1, 'd1'); CREATE TABLE automatch_runtime_control (singleton INTEGER, backend TEXT); INSERT INTO automatch_runtime_control VALUES (1, 'd1'); CREATE TABLE event_transition_receipt_control (singleton INTEGER, state TEXT); INSERT INTO event_transition_receipt_control VALUES (1, 'active'); CREATE TABLE login_match_discovery (login_uid TEXT, match_id TEXT, invite_id TEXT, resolution TEXT, provenance TEXT DEFAULT 'capture', PRIMARY KEY(login_uid, match_id)); CREATE TABLE game_session_transitions (transition_id TEXT PRIMARY KEY, invite_id TEXT, payload_json TEXT, status TEXT);",
  );
  db.exec(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../cloud/workers/api/migrations/0021_match_presentations.sql",
      ),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../cloud/workers/api/migrations/0022_match_presentation_source_exceptions.sql",
      ),
      "utf8",
    ),
  );
  events.exec(
    "CREATE TABLE event_transition_intents (transition_id TEXT PRIMARY KEY, intent_json TEXT, status TEXT);",
  );
  const source = new Map<string, Record<string, unknown>>();
  const appearances = new Map<
    string,
    { seed: string; presentation: Record<string, unknown> }
  >();
  const reads: string[] = [];
  const bridgeRequests: BridgeRequest[] = [];
  const logs: Record<string, unknown>[] = [];
  let now = 1000;
  let failRead: string | null = null;
  let failRegistration = false;
  const addInvite = (
    id: string,
    host: string,
    guest?: string,
    hostRematches = "",
    guestRematches = "",
  ) => {
    db.prepare(
      "INSERT INTO invite_sources VALUES (?, ?) ON CONFLICT(invite_id) DO UPDATE SET source_json = excluded.source_json",
    ).run(
      id,
      JSON.stringify({
        hostId: host,
        ...(guest ? { guestId: guest } : {}),
        hostRematches,
        guestRematches,
      }),
    );
  };
  const addMatch = (
    inviteId: string,
    matchId: string,
    actorUid: string,
    emojiId = 9,
    aura = "",
  ) => {
    source.set(keyOf(actorUid, matchId), {
      color: "white",
      emojiId,
      aura,
      fen: "",
      flatMovesString: "",
    });
    db.prepare(
      "INSERT INTO login_match_discovery (login_uid, match_id, invite_id, resolution) VALUES (?, ?, ?, 'resolved')",
    ).run(actorUid, matchId, inviteId);
    const row = { inviteId, matchId, actorUid, emojiId, aura };
    return { ...row, seedDigest: seedDigest(row) };
  };
  const register = (
    row: SourceRow,
    provenance = "creation",
    sourceId = "transition-proof",
  ) => {
    db.prepare(
      "INSERT INTO match_presentation_registrations VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(
      row.inviteId,
      row.matchId,
      row.actorUid,
      row.seedDigest,
      provenance,
      sourceId,
      now++,
    );
    const id = keyOf(row.actorUid, row.matchId);
    if (!appearances.has(id))
      appearances.set(id, {
        seed: row.seedDigest,
        presentation: {
          matchId: row.matchId,
          actorUid: row.actorUid,
          emojiId: row.emojiId,
          aura: row.aura,
          revision: 0,
        },
      });
  };
  addInvite("paired", "host", "guest", "1", "");
  addMatch("paired", "paired", "host", 4, "rainbow");
  addMatch("paired", "paired", "guest", 8);
  addMatch("paired", "paired1", "host", 5);
  addInvite("waiting", "anonymous");
  addMatch("waiting", "waiting", "anonymous", 2);
  const dependencies: Dependencies = {
    now: () => now++,
    log: (value) => logs.push(value),
    assertDeployment: async (value) => assert.equal(value, VERSION),
    auditWriters: async (value) => {
      assert.equal(value, VERSION);
      return { proven: true, pinnedVersions: [OTHER_VERSION] };
    },
    async run(sql, database, bindings = []) {
      assert.ok(
        database === "mons-link-profile-games" ||
          database === "mons-link-events" ||
          database === "mons-link-profiles",
      );
      return (
        database === "mons-link-profiles"
          ? profiles
          : database === "mons-link-events"
            ? events
            : db
      )
        .prepare(sql)
        .all(...bindings) as Record<string, unknown>[];
    },
    async *streamKeys(path) {
      reads.push(path);
      assert.ok(
        path === "players" || /^players\/[^/]+\/matches$/.test(path),
        "no Firebase invite reads",
      );
      const keys = new Set<string>();
      for (const key of source.keys()) {
        const [uid, matchId] = JSON.parse(key);
        if (path === "players") keys.add(uid);
        else if (path === `players/${uid}/matches`) keys.add(matchId);
      }
      for (const key of keys) yield key;
    },
    async readMatch(uid, matchId) {
      reads.push(`players/${uid}/matches/${matchId}`);
      if (keyOf(uid, matchId) === failRead) {
        failRead = null;
        throw new Error("interrupted Firebase read");
      }
      return source.get(keyOf(uid, matchId)) || null;
    },
    async bridge(request) {
      bridgeRequests.push(request);
      const control = db
        .prepare("SELECT * FROM match_presentation_control")
        .get()!;
      assert.equal(control.phase, "capture");
      assert.equal(control.migration_id, request.migrationId);
      assert.equal(control.source_digest, request.sourceDigest);
      const results: ReadbackRow[] = [];
      for (const row of request.rows) {
        const id = keyOf(row.actorUid, row.matchId);
        if (request.operation === "import") {
          if (!appearances.has(id))
            appearances.set(id, {
              seed: row.seedDigest,
              presentation: {
                matchId: row.matchId,
                actorUid: row.actorUid,
                emojiId: row.emojiId,
                aura: row.aura,
                revision: 0,
              },
            });
          if (failRegistration) {
            failRegistration = false;
            throw new Error("D1 unavailable after DO initialization");
          }
          register(
            row,
            "backfill",
            `backfill:${request.migrationId}:${row.seedDigest}`,
          );
        }
        const registered = db
          .prepare(
            "SELECT * FROM match_presentation_registrations WHERE invite_id = ? AND match_id = ? AND actor_uid = ?",
          )
          .get(row.inviteId, row.matchId, row.actorUid);
        const appearance = appearances.get(id);
        if (!registered || !appearance || appearance.seed !== row.seedDigest)
          throw new Error("missing registered Durable Object seed");
        results.push({
          inviteId: row.inviteId,
          matchId: row.matchId,
          actorUid: row.actorUid,
          seedDigest: String(registered.seed_digest),
          provenance: registered.provenance as "creation" | "backfill",
          sourceId: String(registered.source_id),
          presentation: appearance.presentation,
        });
      }
      return results;
    },
  };
  const command = (
    operation: Arguments["operation"],
    other: Partial<Arguments> = {},
  ) =>
    manageMatchPresentations(
      {
        operation,
        directory,
        ...(["preflight", "enable-capture", "verify", "activate"].includes(
          operation,
        )
          ? { candidateVersionId: VERSION }
          : {}),
        ...other,
      },
      dependencies,
    );
  t.after(() => {
    db.close();
    events.close();
    profiles.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    db,
    events,
    profiles,
    source,
    appearances,
    reads,
    logs,
    dependencies,
    command,
    addInvite,
    addMatch,
    register,
    bridgeRequests,
    interruptRead(uid: string, matchId: string) {
      failRead = keyOf(uid, matchId);
    },
    interruptRegistration() {
      failRegistration = true;
    },
  };
}

test("operator validates scope and preflight does not activate capture", async (t) => {
  assert.throws(
    () => parseArgs(["--status", "--directory", "/private/test"]),
    /no options/,
  );
  assert.throws(
    () => parseArgs(["--enable-capture", "--directory", "/private/test"]),
    /candidate/,
  );
  assert.throws(
    () => parseArgs(["--export", "--directory", "relative"]),
    /absolute/,
  );
  assert.equal(
    parseArgs(["--export", "--directory", "/private/test"]).operation,
    "export",
  );
  const f = fixture(t);
  await f.command("preflight");
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "legacy",
  );
  await f.command("enable-capture");
  const before = f.db.prepare("SELECT * FROM match_presentation_control").get();
  await f.command("enable-capture");
  assert.deepEqual(
    f.db.prepare("SELECT * FROM match_presentation_control").get(),
    before,
  );
  assert.equal(f.reads.length, 0);
});

test("complete import includes anonymous actors and one-sided rematches, preserving edits and capture provenance", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  await f.command("export");
  const manifest = loadExport(f.directory);
  const rows = [...exportedRows(f.directory, manifest)];
  assert.equal(manifest.sourceCount, 4);
  assert.ok(rows.some((row) => row.actorUid === "anonymous"));
  assert.equal(rows.filter((row) => row.matchId === "paired1").length, 1);
  assert.ok(f.reads.every((path) => !path.startsWith("invites")));
  const host = rows.find(
    (row) => row.actorUid === "host" && row.matchId === "paired",
  )!;
  f.register(host);
  f.appearances.get(keyOf("host", "paired"))!.presentation = {
    matchId: "paired",
    actorUid: "host",
    emojiId: 777,
    aura: "edited",
    revision: 12,
  };
  await f.command("import");
  const requests = f.bridgeRequests.length;
  await f.command("import");
  assert.ok(
    f.bridgeRequests
      .slice(requests)
      .every((request) => request.operation === "readback"),
  );
  assert.equal(
    f.appearances.get(keyOf("host", "paired"))!.presentation.revision,
    12,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT provenance FROM match_presentation_registrations WHERE actor_uid = 'host' AND match_id = 'paired'",
      )
      .get()!.provenance,
    "creation",
  );
  await f.command("activate");
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "durable",
  );
  await f.command("activate");
  await assert.rejects(f.command("export"), /cannot be reverted/);
});

test("interrupted export resumes immutable pages without skipping remaining keys", async (t) => {
  const f = fixture(t);
  f.addInvite(
    "bulk",
    "bulk-user",
    undefined,
    Array.from({ length: 102 }, (_, i) => i + 1).join(";"),
  );
  for (let i = 0; i <= 102; i++)
    f.addMatch("bulk", i ? `bulk${i}` : "bulk", "bulk-user");
  await f.command("enable-capture");
  f.interruptRead("bulk-user", "bulk97");
  await assert.rejects(f.command("export"), /interrupted Firebase read/);
  const completedReads = f.reads.filter(
    (path) => path === "players/bulk-user/matches/bulk1",
  ).length;
  assert.equal(completedReads, 1);
  await f.command("export");
  const manifest = loadExport(f.directory);
  assert.equal(manifest.sourceCount, 107);
  assert.equal(
    f.reads.filter((path) => path === "players/bulk-user/matches/bulk1").length,
    1,
  );
  assert.ok(
    readdirSync(f.directory).some((file) => file.startsWith("player-")),
  );
});

test("uncertain DO-success/D1-failure retries preserve subsequent appearance edits", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  await f.command("export");
  f.interruptRegistration();
  await assert.rejects(f.command("import"), /D1 unavailable/);
  const stored = [...f.appearances.values()][0];
  stored.presentation = { ...stored.presentation, emojiId: 999, revision: 3 };
  await f.command("import");
  assert.equal(stored.presentation.emojiId, 999);
  assert.equal(stored.presentation.revision, 3);
  await f.command("verify");
});

test("source reconciliation rejects raw orphans, malformed records and unreferenced rematches", async (t) => {
  for (const kind of [
    "orphan",
    "malformed",
    "uncommitted",
    "ambiguous",
  ] as const) {
    await t.test(kind, async (child) => {
      const f = fixture(child);
      if (kind === "orphan")
        f.source.set(keyOf("anonymous", "orphan"), { color: "white" });
      if (kind === "malformed")
        f.source.set(keyOf("anonymous", "waiting"), { emojiId: 2 });
      if (kind === "uncommitted") f.addMatch("paired", "paired2", "guest");
      if (kind === "ambiguous") {
        f.addInvite("paired1", "host");
      }
      await f.command("enable-capture");
      await assert.rejects(
        f.command("export"),
        /missing|malformed|ambiguous|uncommitted/,
      );
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM match_presentation_registrations",
          )
          .get()!.count,
        0,
      );
    });
  }
});

test("ensured rematch actors are imported before they approve their own rematch", async (t) => {
  const f = fixture(t);
  f.addMatch("paired", "paired1", "guest");
  await f.command("enable-capture");
  await f.command("export");
  await f.command("import");
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM match_presentation_registrations WHERE match_id = 'paired1'",
      )
      .get()!.count,
    2,
  );
});

test("archive-only appearance and missing independent Firebase coverage cannot grant registration", async (t) => {
  const f = fixture(t);
  f.source.delete(keyOf("guest", "paired"));
  f.appearances.set(keyOf("guest", "paired"), {
    seed: "0".repeat(64),
    presentation: {
      matchId: "paired",
      actorUid: "guest",
      emojiId: 9,
      aura: "",
      revision: 0,
    },
  });
  await f.command("enable-capture");
  await assert.rejects(
    f.command("export"),
    /archive-only evidence cannot register/,
  );
});

test("pending manual and event creations block migration until recovered", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  f.db
    .prepare("INSERT INTO game_session_transitions VALUES (?, ?, ?, 'pending')")
    .run(
      "pending",
      "waiting",
      JSON.stringify({
        creations: [{ path: "players/anonymous/matches/waiting" }],
      }),
    );
  await assert.rejects(f.command("export"), /pending player creation/);
  f.db.prepare("DELETE FROM game_session_transitions").run();
  f.events
    .prepare("INSERT INTO event_transition_intents VALUES (?, ?, 'pending')")
    .run(
      "event-pending",
      JSON.stringify({
        rtdbEffects: { "players/new/matches/event-new": { color: "white" } },
      }),
    );
  await assert.rejects(f.command("export"), /pending player creation/);
  f.events.prepare("DELETE FROM event_transition_intents").run();
  await f.command("export");
});

test("only whole-record event creations block export with the production intent schema", async (t) => {
  const cases = [
    {
      name: "pending timer",
      status: "pending",
      path: "players/new/matches/event-new/timer",
      value: "gg",
      blocked: false,
    },
    {
      name: "dead timer",
      status: "dead",
      path: "players/new/matches/event-new/timer",
      value: "gg",
      blocked: false,
    },
    {
      name: "nested object",
      status: "pending",
      path: "players/new/matches/event-new/timer",
      value: {},
      blocked: false,
    },
    {
      name: "nonobject match effect",
      status: "pending",
      path: "players/new/matches/event-new",
      value: null,
      blocked: false,
    },
    {
      name: "pending match creation",
      status: "pending",
      path: "players/new/matches/event-new",
      value: { color: "white" },
      blocked: true,
    },
    {
      name: "dead match creation",
      status: "dead",
      path: "players/new/matches/event-new",
      value: { color: "white" },
      blocked: true,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const f = fixture(subtest);
      const events = new DatabaseSync(":memory:");
      subtest.after(() => events.close());
      events.exec(
        readFileSync(
          resolve(
            import.meta.dirname,
            "../cloud/workers/api/event-migrations/0001_event_store.sql",
          ),
          "utf8",
        ),
      );
      events
        .prepare(
          "INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json) VALUES ('event', 'active', 0, 0, '{}')",
        )
        .run();
      events
        .prepare(
          "INSERT INTO event_transition_intents (transition_id, event_id, expected_revision, status, intent_json, created_at_ms, updated_at_ms) VALUES ('intent', 'event', 1, ?, ?, 0, 0)",
        )
        .run(
          entry.status,
          JSON.stringify({ rtdbEffects: { [entry.path]: entry.value } }),
        );
      const originalRun = f.dependencies.run;
      f.dependencies.run = async (sql, database, bindings = []) =>
        database === "mons-link-events"
          ? (events.prepare(sql).all(...bindings) as Record<string, unknown>[])
          : originalRun(sql, database, bindings);
      await f.command("enable-capture");
      if (entry.blocked) {
        await assert.rejects(f.command("export"), /pending player creation/);
      } else {
        await f.command("export");
        assert.equal(loadExport(f.directory).sourceCount, 4);
      }
    });
  }
});

test("verification accounts for captured concurrent creations and rejects uncaptured records", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  await f.command("export");
  await f.command("import");
  f.addInvite("new", "new-anonymous");
  const row = f.addMatch("new", "new", "new-anonymous");
  await assert.rejects(
    f.command("verify"),
    /missing registered Durable Object seed/,
  );
  f.register(row);
  await f.command("verify");
  const verification = f.logs.findLast(
    (value) => value.operation === "verify",
  )!;
  assert.equal(verification.captureCount, 1);
  f.source.get(keyOf("anonymous", "waiting"))!.emojiId = 543;
  await assert.rejects(f.command("activate"), /seed|changed/);
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "capture",
  );
});

test("tampered protected pages, missing registered state and cross-actor readback fail verification", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  await f.command("export");
  const manifest = loadExport(f.directory);
  const row = [...exportedRows(f.directory, manifest)][0];
  const valid: ReadbackRow = {
    ...row,
    provenance: "backfill",
    sourceId: "proof",
    presentation: {
      matchId: row.matchId,
      actorUid: row.actorUid,
      emojiId: 200,
      aura: "changed",
      revision: 900,
    },
  };
  checkReadback([row], [valid]);
  assert.throws(
    () =>
      checkReadback(
        [row],
        [
          {
            ...valid,
            presentation: {
              ...(valid.presentation as object),
              actorUid: "other",
            },
          },
        ],
      ),
    /actor isolation/,
  );
  assert.throws(
    () => checkReadback([row], [{ ...valid, seedDigest: "0".repeat(64) }]),
    /seed/,
  );
  const proof = manifest.playerExports[0];
  const path = resolve(f.directory, proof.file);
  writeFileSync(path, "{}\n", { mode: 0o600 });
  assert.throws(() => loadExport(f.directory), /digest mismatch/);
});

test("seed digest and purpose-bound signature use immutable fields and exact request bytes", () => {
  const value = {
    inviteId: "invite",
    matchId: "invite1",
    actorUid: "uid",
    emojiId: 17,
    aura: "rainbow",
  };
  const row = { ...value, seedDigest: seedDigest(value) };
  assert.equal(
    row.seedDigest,
    createHash("sha256")
      .update(JSON.stringify(["invite", "invite1", "uid", 17, "rainbow"]))
      .digest("hex"),
  );
  const request: BridgeRequest = {
    schemaVersion: 1,
    operation: "import",
    migrationId: VERSION,
    sourceDigest: "1".repeat(64),
    rows: [row],
  };
  const signed = signedMigrationRequest(request, SECRET, 12345);
  assert.equal(
    signed.headers["X-Mons-Migration-Signature"],
    createHmac("sha256", SECRET)
      .update(`mons-match-presentations-v1\n12345\n${signed.body}`)
      .digest("base64url"),
  );
  assert.notEqual(
    signed.headers["X-Mons-Migration-Signature"],
    signedMigrationRequest({ ...request, operation: "readback" }, SECRET, 12345)
      .headers["X-Mons-Migration-Signature"],
  );
  assert.throws(
    () => signedMigrationRequest({ ...request, rows: [] }, SECRET, 12345),
    /batch limits/,
  );
  assert.equal(
    matchesCanonicalActor("invite", "invite1", "guest", {
      hostId: "host",
      guestId: "guest",
      hostRematches: "1",
      guestRematches: "",
    }),
    true,
  );
});

test("bridge normalizes secret whitespace before validation and signing", async () => {
  const prior = process.env.MATCH_PRESENTATION_MIGRATION_SECRET;
  const value = {
    inviteId: "invite",
    matchId: "invite",
    actorUid: "uid",
    emojiId: 17,
    aura: "",
  };
  const request: BridgeRequest = {
    schemaVersion: 1,
    operation: "readback",
    migrationId: VERSION,
    sourceDigest: "1".repeat(64),
    rows: [{ ...value, seedDigest: seedDigest(value) }],
  };
  let calls = 0;
  const dependencies = createProductionDependencies(
    undefined,
    async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("X-Mons-Migration-Signature"),
        createHmac("sha256", SECRET)
          .update(
            `mons-match-presentations-v1\n${headers.get("X-Mons-Migration-Timestamp")}\n${init?.body}`,
          )
          .digest("base64url"),
      );
      return Response.json({ ok: true, rows: [] });
    },
  );
  try {
    for (const secret of [SECRET, `${SECRET}\n`, ` \t${SECRET}\r\n`]) {
      process.env.MATCH_PRESENTATION_MIGRATION_SECRET = secret;
      assert.deepEqual(await dependencies.bridge(request), []);
    }
    for (const secret of [" \t\r\n", ` ${"s".repeat(31)}\n`]) {
      process.env.MATCH_PRESENTATION_MIGRATION_SECRET = secret;
      await assert.rejects(
        dependencies.bridge(request),
        /required|invalid migration signing credential/,
      );
    }
    assert.equal(calls, 3);
  } finally {
    if (prior === undefined)
      delete process.env.MATCH_PRESENTATION_MIGRATION_SECRET;
    else process.env.MATCH_PRESENTATION_MIGRATION_SECRET = prior;
  }
});

test("bridge authorization failures are sanitized and credentials never enter URLs", async () => {
  const prior = process.env.MATCH_PRESENTATION_MIGRATION_SECRET;
  process.env.MATCH_PRESENTATION_MIGRATION_SECRET = SECRET;
  try {
    const dependencies = createProductionDependencies(
      undefined,
      async (input, init) => {
        assert.equal(
          String(input),
          "https://api.mons.link/internal/match-presentations/migration",
        );
        assert.equal(init?.redirect, "error");
        assert.ok(!(String(input) + String(init?.body)).includes(SECRET));
        return new Response(
          JSON.stringify({
            error: "private failure details",
            credential: SECRET,
          }),
          { status: 403 },
        );
      },
    );
    const value = {
      inviteId: "invite",
      matchId: "invite",
      actorUid: "uid",
      emojiId: 17,
      aura: "",
    };
    await assert.rejects(
      dependencies.bridge({
        schemaVersion: 1,
        operation: "readback",
        migrationId: VERSION,
        sourceDigest: "1".repeat(64),
        rows: [{ ...value, seedDigest: seedDigest(value) }],
      }),
      (error: unknown) =>
        error instanceof Error &&
        /authentication failed/.test(error.message) &&
        !error.message.includes(SECRET),
    );
  } finally {
    if (prior === undefined)
      delete process.env.MATCH_PRESENTATION_MIGRATION_SECRET;
    else process.env.MATCH_PRESENTATION_MIGRATION_SECRET = prior;
  }
});

function writerFixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(
    resolve(tmpdir(), "mons-appearance-writer-test-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workflowId = "33333333-3333-4333-8333-333333333333";
  const modules = [
    {
      name: "index.js",
      content_type: "application/javascript+module",
      content_base64: Buffer.from(
        "export default {fetch(){return new Response('ready')}}",
      ).toString("base64"),
    },
  ];
  const sourceFile = resolve(directory, "provider-source.json");
  writePrivateImmutable(sourceFile, {
    success: true,
    result: { id: VERSION, modules },
  });
  const bindingFile = resolve(directory, "registration.json");
  const binding = {
    workerVersion: VERSION,
    response: {
      success: true,
      result: {
        id: workflowId,
        name: "mons-link-event-progress",
        script_name: "mons-link-api",
        class_name: "EventProgressWorkflow",
        version_id: OTHER_VERSION,
      },
    },
  };
  writePrivateImmutable(bindingFile, binding);
  const proof = {
    workerVersionId: VERSION,
    scriptEtag: "a".repeat(64),
    workflowVersionId: OTHER_VERSION,
    workflowId,
    className: "EventProgressWorkflow",
    workflowCreatedOn: "2026-09-10T00:00:00.000Z",
    source: { file: sourceFile, sha256: providerModulesDigest(modules) },
    binding: { file: bindingFile, digest: digest(binding) },
    review: {
      guardCompatibleDiscovery: true,
      atomicEventPublication: true,
      recoverableIntent: true,
      captureAware: true,
    },
  };
  const responses = new Map<string, Record<string, unknown>>([
    [
      `workers/workers/mons-link-api/versions/${VERSION}?include=modules`,
      { success: true, result: { id: VERSION, modules } },
    ],
    [
      `workers/scripts/mons-link-api/versions/${VERSION}`,
      {
        success: true,
        result: {
          id: VERSION,
          resources: { script: { etag: proof.scriptEtag } },
        },
      },
    ],
    [
      `workflows/mons-link-event-progress/versions/${OTHER_VERSION}`,
      {
        success: true,
        result: {
          id: OTHER_VERSION,
          workflow_id: workflowId,
          class_name: proof.className,
          created_on: proof.workflowCreatedOn,
        },
      },
    ],
    [
      "workflows/mons-link-event-progress",
      {
        success: true,
        result: {
          id: workflowId,
          script_name: "mons-link-api",
          class_name: proof.className,
        },
      },
    ],
    [
      "workflows/mons-link-event-progress/instances?per_page=100&page=1",
      {
        success: true,
        result: [
          {
            id: "waiting-instance",
            version_id: OTHER_VERSION,
            status: "waiting",
          },
        ],
        result_info: { count: 1, page: 1, per_page: 100, total_count: 1 },
      },
    ],
  ]);
  responses.set(
    "workflows/mons-link-event-progress/versions?per_page=100&page=1",
    {
      success: true,
      result: [
        {
          id: OTHER_VERSION,
          workflow_id: workflowId,
          class_name: proof.className,
        },
      ],
    },
  );
  responses.set(
    "workflows/mons-link-event-progress/instances?per_page=100&page=2",
    {
      success: true,
      result: [],
      result_info: { count: 0, page: 2, per_page: 100, total_count: 101 },
    },
  );
  const evidenceFile = resolve(directory, "writers.json");
  writePrivateImmutable(evidenceFile, {
    schemaVersion: 1,
    candidate: proof,
    writers: [proof],
  });
  const cloudflare = async (path: string) => {
    const value = responses.get(path);
    assert.ok(value, `unexpected provider path ${path}`);
    return value;
  };
  return {
    directory,
    proof,
    binding,
    bindingFile,
    evidenceFile,
    cloudflare,
    responses,
    modules,
  };
}

test("writer audit binds reviewed modules to exact provider versions and retained Workflow acknowledgements", async (t) => {
  const f = writerFixture(t);
  await verifyWriterProof(f.proof, f.cloudflare, false);
  await verifyWriterProof(f.proof, f.cloudflare, true);
  const original = f.responses.get(
    `workers/workers/mons-link-api/versions/${VERSION}?include=modules`,
  )!;
  f.responses.set(
    `workers/workers/mons-link-api/versions/${VERSION}?include=modules`,
    {
      success: true,
      result: {
        id: VERSION,
        modules: [
          {
            ...f.modules[0],
            content_base64:
              Buffer.from("other version code").toString("base64"),
          },
        ],
      },
    },
  );
  await assert.rejects(
    verifyWriterProof(f.proof, f.cloudflare, false),
    /does not match the provider/,
  );
  f.responses.set(
    `workers/workers/mons-link-api/versions/${VERSION}?include=modules`,
    original,
  );
  const wrongBinding = {
    ...f.binding,
    workerVersion: "44444444-4444-4444-8444-444444444444",
  };
  const wrongFile = resolve(f.directory, "wrong-binding.json");
  writePrivateImmutable(wrongFile, wrongBinding);
  await assert.rejects(
    verifyWriterProof(
      {
        ...f.proof,
        binding: { file: wrongFile, digest: digest(wrongBinding) },
      },
      f.cloudflare,
      false,
    ),
    /does not bind/,
  );
  await assert.rejects(
    verifyWriterProof(
      {
        ...f.proof,
        review: { ...f.proof.review, atomicEventPublication: false },
      },
      f.cloudflare,
      false,
    ),
    /incomplete/,
  );
});

test("production writer audit distinguishes Worker and Workflow IDs and rejects uncovered pinned versions", async (t) => {
  const f = writerFixture(t);
  const prior = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "writer-test-token";
  try {
    const dependencies = createProductionDependencies(
      undefined,
      async (input) => {
        const url = new URL(String(input));
        const path =
          url.pathname.split("/accounts/")[1].split("/").slice(1).join("/") +
          url.search;
        return Response.json(await f.cloudflare(path));
      },
      f.evidenceFile,
    );
    const proof = await dependencies.auditWriters(VERSION);
    assert.equal(proof.workflowCount, 1);
    f.responses.set(
      "workflows/mons-link-event-progress/instances?per_page=100&page=1",
      {
        success: true,
        result: [
          {
            id: "unreviewed",
            version_id: "55555555-5555-4555-8555-555555555555",
            status: "waiting",
          },
        ],
        result_info: { count: 1, page: 1, per_page: 100, total_count: 1 },
      },
    );
    await assert.rejects(
      dependencies.auditWriters(VERSION),
      /unproven version-pinned event writer/,
    );
    f.responses.set(
      "workflows/mons-link-event-progress/instances?per_page=100&page=1",
      {
        success: true,
        result: Array.from({ length: 100 }, (_, i) => ({
          id: `complete-${i}`,
          version_id: OTHER_VERSION,
          status: "complete",
        })),
        result_info: { count: 100, page: 1, per_page: 100, total_count: 101 },
      },
    );
    await assert.rejects(
      dependencies.auditWriters(VERSION),
      /continuation proof/,
    );
  } finally {
    if (prior === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = prior;
  }
});

test("unexpected imported registration outside the manifest blocks activation", async (t) => {
  const f = fixture(t);
  await f.command("enable-capture");
  await f.command("export");
  await f.command("import");
  const control = f.db
    .prepare("SELECT migration_id FROM match_presentation_control")
    .get()!;
  const value = {
    inviteId: "waiting",
    matchId: "waiting",
    actorUid: "fabricated",
    emojiId: 9,
    aura: "",
  };
  const row = { ...value, seedDigest: seedDigest(value) };
  f.register(
    row,
    "backfill",
    `backfill:${control.migration_id}:${row.seedDigest}`,
  );
  await assert.rejects(
    f.command("activate"),
    /outside the immutable source manifest/,
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "capture",
  );
});

test("provider module hashing handles production-size modules without regex recursion", () => {
  const content = Buffer.alloc(6 * 1024 * 1024, 97);
  const module = {
    name: "index.js",
    content_type: "application/javascript+module",
    content_base64: content.toString("base64"),
  };
  assert.equal(
    providerModulesDigest([module]),
    digest([
      {
        name: module.name,
        contentType: module.content_type,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ]),
  );
  for (const invalid of ["YQ==\n", "YR==", "YQ=", "YQ$=", "YQ===", "YQ==YQ=="])
    assert.throws(
      () => providerModulesDigest([{ ...module, content_base64: invalid }]),
      /invalid|noncanonical/,
    );
});

function exceptionFixture(t: { after(callback: () => void): void }) {
  const f = fixture(t);
  f.profiles
    .prepare("INSERT INTO profile_records VALUES (?, 'active', NULL)")
    .run("guest-profile");
  f.profiles
    .prepare("INSERT INTO profile_login_owners VALUES (?, ?, ?)")
    .run("guest", "guest-profile", 5);
  const declarations = [];
  for (const [uid, disposition, reason, color] of [
    ["copy-alias", "alias", "linked-login-copy", "white"],
    ["copy-conflict", "archive", "conflicting-color", "black"],
    ["copy-unowned", "archive", "no-canonical-owner", "white"],
  ] as const) {
    f.addMatch("paired", "paired", uid, 8);
    const raw = f.source.get(keyOf(uid, "paired"))!;
    raw.color = color;
    raw.unknownLegacyField = { kept: [1, "two", null] };
    if (uid !== "copy-unowned")
      f.profiles
        .prepare("INSERT INTO profile_login_owners VALUES (?, ?, ?)")
        .run(uid, "guest-profile", 2);
    declarations.push({
      inviteId: "paired",
      matchId: "paired",
      actorUid: uid,
      disposition,
      reason,
      sourceDigest: digest(raw),
      ...(disposition === "alias" ? { canonicalActorUid: "guest" } : {}),
    });
  }
  const exceptionFile = resolve(f.directory, "reviewed-exceptions.json");
  writePrivateImmutable(exceptionFile, {
    schemaVersion: 1,
    exceptions: declarations,
  });
  return { ...f, exceptionFile, declarations };
}

test("reviewed aliases and archived conflicts preserve every physical source without adding live actors", async (t) => {
  const f = exceptionFixture(t);
  await f.command("enable-capture");
  await assert.rejects(f.command("export"), /canonical actor membership/);
  await f.command("export", { sourceExceptions: f.exceptionFile });
  const manifest = loadExport(f.directory);
  const rows = [...exportedRows(f.directory, manifest)];
  assert.equal(manifest.sourceCount, 7);
  assert.equal(rows.filter((row) => row.exception).length, 3);
  const guest = rows.find(
    (row) => row.actorUid === "guest" && row.matchId === "paired",
  )!;
  f.register(guest);
  f.appearances.get(keyOf("guest", "paired"))!.presentation = {
    matchId: "paired",
    actorUid: "guest",
    emojiId: 999,
    aura: "edited",
    revision: 8,
  };
  await f.command("import");
  const before = f.db
    .prepare(
      "SELECT * FROM match_presentation_source_exceptions ORDER BY actor_uid",
    )
    .all();
  await f.command("import");
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM match_presentation_source_exceptions ORDER BY actor_uid",
      )
      .all(),
    before,
  );
  assert.equal(before.length, 3);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .get()!.count,
    4,
  );
  for (const stored of before)
    assert.deepEqual(
      JSON.parse(String(stored.source_json)),
      f.source.get(keyOf(String(stored.actor_uid), String(stored.match_id))),
    );
  assert.ok(
    f.bridgeRequests.every((request) =>
      request.rows.every(
        (row) =>
          !row.actorUid.startsWith("copy-") && row.exception === undefined,
      ),
    ),
  );
  assert.equal(
    f.appearances.get(keyOf("guest", "paired"))!.presentation.revision,
    8,
  );
  await f.command("activate", { sourceExceptions: f.exceptionFile });
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "durable",
  );
  assert.equal(f.source.size, 7);
});

test("reviewed exceptions require exact current ownership, appearance, classification and physical target", async (t) => {
  for (const failure of [
    "ownership",
    "both-participants",
    "color",
    "appearance",
    "source",
    "target",
  ] as const)
    await t.test(failure, async (child) => {
      const f = exceptionFixture(child);
      if (failure === "ownership")
        f.profiles
          .prepare(
            "DELETE FROM profile_login_owners WHERE login_uid = 'copy-alias'",
          )
          .run();
      if (failure === "both-participants")
        f.profiles
          .prepare(
            "INSERT INTO profile_login_owners VALUES ('host', 'guest-profile', 1)",
          )
          .run();
      if (failure === "color")
        f.source.get(keyOf("guest", "paired"))!.color = "black";
      if (failure === "appearance")
        f.source.get(keyOf("guest", "paired"))!.aura = "different";
      if (failure === "source")
        f.source.get(keyOf("copy-unowned", "paired"))!.unknownLegacyField =
          "changed";
      if (failure === "target") f.source.delete(keyOf("guest", "paired"));
      await f.command("enable-capture");
      await assert.rejects(
        f.command("export", { sourceExceptions: f.exceptionFile }),
        /reviewed|alias|record|ownership/,
      );
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM match_presentation_source_exceptions",
          )
          .get()!.count,
        0,
      );
    });
});

test("interrupted exception archival resumes and fresh verification rejects changed preserved records", async (t) => {
  const f = exceptionFixture(t);
  await f.command("enable-capture");
  await f.command("export", { sourceExceptions: f.exceptionFile });
  const run = f.dependencies.run;
  let interrupt = true;
  f.dependencies.run = async (sql, database, bindings) => {
    const result = await run(sql, database, bindings);
    if (
      interrupt &&
      sql.startsWith("INSERT INTO match_presentation_source_exceptions")
    ) {
      interrupt = false;
      throw new Error("lost archive acknowledgment");
    }
    return result;
  };
  await assert.rejects(f.command("import"), /lost archive acknowledgment/);
  const saved = f.db
    .prepare("SELECT * FROM match_presentation_source_exceptions")
    .get();
  await f.command("import");
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM match_presentation_source_exceptions WHERE actor_uid = ?",
      )
      .get(String(saved!.actor_uid)),
    saved,
  );
  await f.command("verify", { sourceExceptions: f.exceptionFile });
  f.source.get(keyOf("copy-unowned", "paired"))!.unknownLegacyField =
    "changed after archival";
  await assert.rejects(
    f.command("activate", { sourceExceptions: f.exceptionFile }),
    /reviewed exception source changed/,
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "capture",
  );
});

test("exception evidence cannot omit reviewed physical keys or silently add unknown records", async (t) => {
  const f = exceptionFixture(t);
  f.source.delete(keyOf("copy-unowned", "paired"));
  f.db
    .prepare(
      "DELETE FROM login_match_discovery WHERE login_uid = 'copy-unowned'",
    )
    .run();
  await f.command("enable-capture");
  await assert.rejects(
    f.command("export", { sourceExceptions: f.exceptionFile }),
    /exception inventory is incomplete/,
  );
});

test("fresh verification rejects changed alias ownership and extra archived physical records", async (t) => {
  for (const failure of ["ownership-revision", "extra-archive"] as const)
    await t.test(failure, async (child) => {
      const f = exceptionFixture(child);
      await f.command("enable-capture");
      await f.command("export", { sourceExceptions: f.exceptionFile });
      await f.command("import");
      if (failure === "ownership-revision")
        f.profiles
          .prepare(
            "UPDATE profile_login_owners SET revision = revision + 1 WHERE login_uid = 'copy-alias'",
          )
          .run();
      else {
        const first = f.db
          .prepare(
            "SELECT * FROM match_presentation_source_exceptions WHERE disposition = 'archive' LIMIT 1",
          )
          .get()!;
        const extra = { ...first, actor_uid: "unreviewed-archive" };
        const columns = Object.keys(extra);
        f.db
          .prepare(
            `INSERT INTO match_presentation_source_exceptions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          )
          .run(...Object.values(extra));
      }
      await assert.rejects(
        f.command("activate", { sourceExceptions: f.exceptionFile }),
        /source exception ownership|unreviewed extra/,
      );
      assert.equal(
        f.db.prepare("SELECT phase FROM match_presentation_control").get()!
          .phase,
        "capture",
      );
    });
});

test("paired metadata may reference an uncreated guest without fabricating appearance", async (t) => {
  const f = fixture(t);
  f.source.delete(keyOf("guest", "paired"));
  f.db
    .prepare(
      "DELETE FROM login_match_discovery WHERE login_uid = 'guest' AND match_id = 'paired'",
    )
    .run();
  await f.command("enable-capture");
  await f.command("export");
  const manifest = loadExport(f.directory);
  assert.equal(manifest.sourceCount, 3);
  assert.deepEqual(
    [...absentMetadataReferences(f.directory, manifest)],
    [{ inviteId: "paired", matchId: "paired", actorUid: "guest" }],
  );
  await f.command("import");
  await f.command("activate");
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM match_presentation_registrations WHERE actor_uid = 'guest'",
      )
      .get()!.count,
    0,
  );
  assert.ok(
    f.bridgeRequests.every((request) =>
      request.rows.every((row) => row.actorUid !== "guest"),
    ),
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "durable",
  );
});

test("an absent metadata actor can appear later only through valid creation capture", async (t) => {
  for (const capture of [true, false])
    await t.test(
      capture ? "captured creation" : "uncaptured creation",
      async (child) => {
        const f = fixture(child);
        f.source.delete(keyOf("guest", "paired"));
        f.db
          .prepare(
            "DELETE FROM login_match_discovery WHERE login_uid = 'guest' AND match_id = 'paired'",
          )
          .run();
        await f.command("enable-capture");
        await f.command("export");
        await f.command("import");
        const guest = f.addMatch("paired", "paired", "guest", 8);
        if (capture) {
          f.register(guest);
          await f.command("activate");
          assert.equal(
            f.db.prepare("SELECT phase FROM match_presentation_control").get()!
              .phase,
            "durable",
          );
        } else {
          await assert.rejects(
            f.command("activate"),
            /missing registered|capture/,
          );
          assert.equal(
            f.db.prepare("SELECT phase FROM match_presentation_control").get()!
              .phase,
            "capture",
          );
        }
      },
    );
});

test("actual discovery evidence still requires the corresponding physical source", async (t) => {
  const f = fixture(t);
  f.source.delete(keyOf("guest", "paired"));
  await f.command("enable-capture");
  await assert.rejects(
    f.command("export"),
    /D1 discovery has no independently inventoried Firebase record/,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .get()!.count,
    0,
  );
});

function addBatchFixture(f: ReturnType<typeof fixture>) {
  f.addInvite(
    "bulk",
    "bulk-user",
    undefined,
    Array.from({ length: 420 }, (_, index) => index + 1).join(";"),
  );
  for (let index = 0; index <= 420; index++)
    f.addMatch("bulk", index ? `bulk${index}` : "bulk", "bulk-user");
}

test("canonical import uses at most four concurrent stable batches", async (t) => {
  const f = fixture(t);
  addBatchFixture(f);
  await f.command("enable-capture");
  await f.command("export");
  const bridge = f.dependencies.bridge;
  let active = 0;
  let maximum = 0;
  f.dependencies.bridge = async (request) => {
    active++;
    maximum = Math.max(maximum, active);
    await nextTurn();
    try {
      return await bridge(request);
    } finally {
      active--;
    }
  };
  await f.command("import");
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  const imported = f.bridgeRequests.filter(
    (request) => request.operation === "import",
  );
  assert.deepEqual(
    imported.map((request) => request.rows.length).sort((a, b) => a - b),
    Array.from({ length: 17 }, () => 25),
  );
  assert.equal(
    new Set(
      imported.flatMap((request) =>
        request.rows.map((row) => keyOf(row.actorUid, row.matchId)),
      ),
    ).size,
    425,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .get()!.count,
    425,
  );
});

test("partial concurrent import failure waits for all batches and resumes successful receipts before exceptions", async (t) => {
  const f = exceptionFixture(t);
  addBatchFixture(f);
  await f.command("enable-capture");
  await f.command("export", { sourceExceptions: f.exceptionFile });
  const bridge = f.dependencies.bridge;
  const run = f.dependencies.run;
  let active = 0;
  let importCalls = 0;
  let failedIdentity: string | null = null;
  f.dependencies.bridge = async (request) => {
    active++;
    const ordinal = request.operation === "import" ? ++importCalls : 0;
    await nextTurn();
    try {
      const response = await bridge(request);
      if (ordinal === 1) {
        failedIdentity = keyOf(
          request.rows[0].actorUid,
          request.rows[0].matchId,
        );
        throw new Error("uncertain concurrent batch response");
      }
      return response;
    } finally {
      active--;
    }
  };
  f.dependencies.run = async (sql, database, bindings) => {
    if (sql.startsWith("INSERT INTO match_presentation_source_exceptions")) {
      assert.equal(active, 0);
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) AS count FROM match_presentation_registrations",
          )
          .get()!.count,
        425,
      );
    }
    return run(sql, database, bindings);
  };
  await assert.rejects(
    f.command("import"),
    /uncertain concurrent batch response/,
  );
  assert.equal(active, 0);
  assert.equal(importCalls, 13);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM match_presentation_source_exceptions",
      )
      .get()!.count,
    0,
  );
  assert.equal(
    readdirSync(f.directory).filter((file) =>
      /^import-[a-f0-9]{64}\.json$/.test(file),
    ).length,
    3,
  );
  assert.ok(!readdirSync(f.directory).includes("import-complete.json"));
  assert.ok(failedIdentity);
  const appeared = f.appearances.get(failedIdentity)!;
  appeared.presentation = {
    ...appeared.presentation,
    emojiId: 999,
    revision: 7,
  };
  const previous = f.bridgeRequests.length;
  await f.command("import");
  assert.equal(active, 0);
  assert.equal(
    f.bridgeRequests
      .slice(previous)
      .filter((request) => request.operation === "import").length,
    5,
  );
  assert.equal(appeared.presentation.revision, 7);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM match_presentation_source_exceptions",
      )
      .get()!.count,
    3,
  );
  assert.ok(readdirSync(f.directory).includes("import-complete.json"));
});

test("legacy hundred-row receipts resume with read-only requests capped at twenty-five actors", async (t) => {
  const f = fixture(t);
  addBatchFixture(f);
  await f.command("enable-capture");
  await f.command("export");
  const manifest = loadExport(f.directory);
  const legacy = [...exportedRows(f.directory, manifest)].slice(0, 100);
  const legacyKeys = new Set(
    legacy.map((row) => keyOf(row.actorUid, row.matchId)),
  );
  for (const row of legacy)
    f.register(
      row,
      "backfill",
      `backfill:${manifest.migrationId}:${row.seedDigest}`,
    );
  const batchDigest = digest(legacy);
  const receiptFile = resolve(f.directory, `import-${batchDigest}.json`);
  writePrivateImmutable(receiptFile, {
    migrationId: manifest.migrationId,
    sourceDigest: manifest.sourceDigest,
    batchDigest,
    count: 100,
  });
  const retainedReceipt = readFileSync(receiptFile, "utf8");
  await f.command("import");
  const checked = new Set<string>();
  for (const request of f.bridgeRequests) {
    assert.ok(request.rows.length <= 25);
    for (const row of request.rows) {
      const identity = keyOf(row.actorUid, row.matchId);
      if (legacyKeys.has(identity)) {
        assert.equal(request.operation, "readback");
        checked.add(identity);
      }
    }
  }
  assert.equal(checked.size, 100);
  assert.equal(readFileSync(receiptFile, "utf8"), retainedReceipt);
  const progress = f.logs
    .filter(
      (value) =>
        value.operation === "import" && typeof value.sourceCount === "number",
    )
    .map((value) => Number(value.sourceCount));
  assert.equal(progress.at(-1), 425);
  assert.ok(
    progress.every((value, index) => value - (progress[index - 1] || 0) <= 100),
  );
  const beforeVerification = f.bridgeRequests.length;
  await f.command("activate");
  assert.ok(
    f.bridgeRequests
      .slice(beforeVerification)
      .every(
        (request) =>
          request.operation === "readback" && request.rows.length <= 25,
      ),
  );
});

test("verification reads stable source batches with at most four concurrent HTTP requests", async (t) => {
  const f = fixture(t);
  addBatchFixture(f);
  await f.command("enable-capture");
  await f.command("export");
  await f.command("import");
  const bridge = f.dependencies.bridge;
  const run = f.dependencies.run;
  const seen = new Set<string>();
  let active = 0;
  let maximum = 0;
  f.dependencies.bridge = async (request) => {
    assert.equal(request.operation, "readback");
    assert.ok(request.rows.length <= 25);
    active++;
    maximum = Math.max(maximum, active);
    await nextTurn();
    try {
      const result = await bridge(request);
      for (const row of request.rows) {
        const identity = keyOf(row.actorUid, row.matchId);
        assert.ok(!seen.has(identity));
        seen.add(identity);
      }
      return result;
    } finally {
      active--;
    }
  };
  f.dependencies.run = async (sql, database, bindings) => {
    if (
      sql.startsWith(
        "UPDATE match_presentation_control SET verification_digest",
      )
    ) {
      assert.equal(active, 0);
      assert.equal(seen.size, 425);
    }
    return run(sql, database, bindings);
  };
  await f.command("activate");
  assert.equal(active, 0);
  assert.equal(maximum, 4);
  assert.equal(seen.size, 425);
  const checked = f.logs
    .filter((row) => row.operation === "verify-readback")
    .map((row) => Number(row.sourceCount));
  assert.equal(checked.at(-1), 425);
  assert.ok(
    checked.every((value, index) => value - (checked[index - 1] || 0) <= 100),
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "durable",
  );
});

test("a failed verification group drains every read before rejecting without recording proof or activating", async (t) => {
  const f = exceptionFixture(t);
  addBatchFixture(f);
  f.addInvite("absent-metadata", "metadata-only-host", "metadata-only-guest");
  await f.command("enable-capture");
  await f.command("export", { sourceExceptions: f.exceptionFile });
  await f.command("import");
  const bridge = f.dependencies.bridge;
  const run = f.dependencies.run;
  const readMatch = f.dependencies.readMatch;
  let active = 0;
  let calls = 0;
  let proofWrites = 0;
  let exceptionAudits = 0;
  let absenceReads = 0;
  f.dependencies.bridge = async (request) => {
    active++;
    const ordinal = ++calls;
    await nextTurn();
    try {
      const result = await bridge(request);
      if (ordinal === 1) throw new Error("verification readback unavailable");
      return result;
    } finally {
      active--;
    }
  };
  f.dependencies.run = async (sql, database, bindings) => {
    if (
      sql.startsWith(
        "UPDATE match_presentation_control SET verification_digest",
      )
    )
      proofWrites++;
    if (
      sql ===
      "SELECT COUNT(*) AS count FROM match_presentation_source_exceptions"
    )
      exceptionAudits++;
    return run(sql, database, bindings);
  };
  f.dependencies.readMatch = async (uid, matchId) => {
    if (uid.startsWith("metadata-only-")) absenceReads++;
    return readMatch(uid, matchId);
  };
  await assert.rejects(
    f.command("activate", { sourceExceptions: f.exceptionFile }),
    /verification readback unavailable/,
  );
  assert.equal(active, 0);
  assert.equal(calls, 13);
  assert.equal(proofWrites, 0);
  assert.equal(exceptionAudits, 0);
  assert.equal(absenceReads, 0);
  assert.equal(
    f.db.prepare("SELECT phase FROM match_presentation_control").get()!.phase,
    "capture",
  );
  assert.equal(
    f.db.prepare("SELECT verified_at_ms FROM match_presentation_control").get()!
      .verified_at_ms,
    null,
  );
  assert.ok(
    readdirSync(f.directory)
      .filter((name) => name.startsWith("verify-"))
      .every(
        (name) =>
          !readdirSync(resolve(f.directory, name)).includes(
            "verification.json",
          ),
      ),
  );
});
