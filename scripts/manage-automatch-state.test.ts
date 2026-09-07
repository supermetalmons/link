import assert from "node:assert/strict";
import {
  chmodSync,
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
import {
  ROOTS,
  LEGACY_RETIREMENT_MS,
  createRemoteDependencies,
  createSqlDependencies,
  loadExport,
  manageAutomatchState,
  normalizeReference,
  normalizeSourcePage,
  parseArgs,
  type Dependencies,
  type RecordValue,
  type Root,
} from "./manage-automatch-state.ts";
import {
  canonicalJson,
  compareFirebaseKeys,
  digest,
  type SqlRunner,
} from "./manage-wager-state.ts";

const VERSION = "ed41f283-8a34-4674-8bf4-a4774b1d0196";
const OTHER_VERSION = "ad41f283-8a34-4674-8bf4-a4774b1d0196";
function harness(t: test.TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), "automatch-migration-test-"));
  const db = new DatabaseSync(":memory:");
  for (const migration of [
    "0007_gameplay_coordination.sql",
    "0009_automatch_state.sql",
    "0011_game_session_writer_fence.sql",
    "0012_automatch_admission_audit.sql",
  ])
    db.exec(
      readFileSync(resolve("cloud/workers/api/migrations", migration), "utf8"),
    );
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let nowMs = 2_000_000;
  let deployed = VERSION;
  let paused = true;
  let rules = true;
  let sqlInterceptor:
    | ((sql: string, execute: () => RecordValue[]) => Promise<RecordValue[]>)
    | undefined;
  const calls: string[] = [];
  const log: RecordValue[] = [];
  const sources: Record<Root, Record<string, unknown>> = {
    automatch: {
      "10": {
        uid: "host",
        password: "secret",
        hostColor: "white",
        timestamp: 99,
      },
      "2": { uid: "other", timestamp: 10 },
    },
    telegramAutomatches: {
      "10": {
        status: "pending",
        generation: 3,
        unknown: { retained: [false, null, 7] },
      },
    },
    "telegramProjectionOutbox/automatch": {
      "10": { requestId: "telegram-op", updatedAtMs: 12 },
      malformed: false,
    },
    "profileGameProjectionOutbox/automatch": {
      manual: {
        requestId: "manual-op",
        historicalMatches: {
          old: {
            hostPlayerId: "host",
            guestPlayerId: "guest",
            finalizedAtMs: 1,
          },
        },
      },
    },
    gameplayMutationReceipts: {
      operation: {
        kind: "invite-create",
        inviteId: "manual",
        completedAtMs: 5,
        response: { ok: true },
      },
      "receipt-only": { retained: true },
    },
    gameplayMutationReceiptExpirations: {
      operation: { completedAtMs: 5 },
      "expiration-only": { completedAtMs: 6 },
    },
  };
  const invites: Record<string, unknown> = {
    "10": {
      hostId: "host",
      password: "secret",
      hostColor: "white",
      automatchStateHint: "pending",
    },
    "2": { hostId: "other" },
    manual: { hostId: "host", guestId: "guest" },
  };
  const matches: Record<string, RecordValue> = {
    "10": { fen: "initial", gameVariant: "Classic" },
    "2": { fen: "initial" },
  };
  const readSource = async (
    root: Root,
    after: string | null,
    pageSize: number,
  ) => {
    const keys = Object.keys(sources[root])
      .sort(compareFirebaseKeys)
      .filter((key) => after === null || compareFirebaseKeys(key, after) >= 0)
      .slice(0, pageSize + (after === null ? 0 : 1));
    return Object.fromEntries(keys.map((key) => [key, sources[root][key]]));
  };
  const run: SqlRunner = async (sql, database, params = []) => {
    assert.equal(database, "mons-link-profile-games");
    calls.push(sql);
    const execute = () => db.prepare(sql).all(...params) as RecordValue[];
    return sqlInterceptor ? sqlInterceptor(sql, execute) : execute();
  };
  const dependencies: Dependencies = createSqlDependencies(
    run,
    {
      async assertDeployment(version) {
        if (version !== deployed) throw new Error("deployment mismatch");
      },
      async assertQueuesPaused() {
        if (!paused) throw new Error("queues running");
      },
      async assertRules() {
        if (!rules) throw new Error("legacy rules");
      },
      readSource,
      async readReference(inviteId, queue) {
        return normalizeReference(queue, invites[inviteId], matches[inviteId]);
      },
      async readEvidencePath(path) {
        if (path.startsWith("invites/")) return invites[path.slice(8)] || null;
        const root = [...ROOTS]
          .sort((a, b) => b.length - a.length)
          .find((root) => path.startsWith(root + "/"));
        return root
          ? (sources[root][path.slice(root.length + 1)] ?? null)
          : null;
      },
    },
    () => nowMs,
  );
  dependencies.log = (value) => log.push(value);
  const command = (operation: string, extra: string[] = []) =>
    manageAutomatchState(parseArgs([`--${operation}`, ...extra]), dependencies);
  const stage = async () => {
    await command("stage", ["--candidate-version-id", VERSION]);
    nowMs += LEGACY_RETIREMENT_MS;
  };
  const freeze = async () => {
    await stage();
    await command("freeze");
  };
  const exportSource = async () =>
    command("export", [
      "--directory",
      directory,
      "--candidate-version-id",
      VERSION,
      "--page-size",
      "1",
    ]);
  const importSource = async () =>
    command("import", ["--directory", directory]);
  const verify = async () =>
    command("verify", [
      "--directory",
      directory,
      "--candidate-version-id",
      VERSION,
    ]);
  const activate = async () =>
    command("activate", [
      "--directory",
      directory,
      "--candidate-version-id",
      VERSION,
    ]);
  return {
    directory,
    db,
    sources,
    matches,
    invites,
    log,
    calls,
    dependencies,
    command,
    stage,
    freeze,
    exportSource,
    importSource,
    verify,
    activate,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
    setRules: (value: boolean) => {
      rules = value;
    },
    setDeployment: (value: string) => {
      deployed = value;
    },
    interceptSql: (value: typeof sqlInterceptor) => {
      sqlInterceptor = value;
    },
  };
}

test("exports all six roots and preserves waiting players, unknown state, shared receipts and orphan expirations", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  const manifest = loadExport(h.directory);
  assert.equal(manifest.roots.length, 6);
  assert.deepEqual(
    manifest.roots.map((value) => value.count),
    [2, 1, 2, 1, 2, 2],
  );
  assert.equal(
    manifest.pages.filter((value) => value.root === "automatch")[0].lastKey,
    "2",
  );
  await h.importSource();
  await h.importSource();
  await h.verify();
  await h.activate();
  await h.activate();
  const status = await h.dependencies.status();
  assert.equal(status.control.backend, "d1");
  assert.equal(status.control.state, "frozen");
  assert.equal(status.control.epoch, 2);
  assert.equal(status.control.sourceDigest, manifest.sourceDigest);
  const waiting = h.db
    .prepare(
      "SELECT payload_json FROM automatch_entries WHERE record_key = '10'",
    )
    .get()!;
  assert.deepEqual(
    JSON.parse(String(waiting.payload_json)),
    h.sources.automatch["10"],
  );
  const receipts = h.db
    .prepare("SELECT * FROM game_session_mutation_receipts ORDER BY record_key")
    .all();
  assert.equal(receipts.length, 3);
  assert.equal(receipts[0].payload_json, null);
  assert.equal(receipts[2].expiration_json, null);
  await h.command("resume", ["--candidate-version-id", VERSION]);
  assert.equal((await h.dependencies.status()).control.state, "active");
  await assert.rejects(h.exportSource(), /retired|frozen/);
  assert.throws(
    () => h.db.exec("UPDATE automatch_runtime_control SET backend = 'rtdb'"),
    /cannot return/,
  );
  const output = JSON.stringify(h.log);
  for (const secret of ["secret", "telegram-op", "manual-op", "hostPlayerId"])
    assert.ok(!output.includes(secret));
});

test("legacy retirement prerequisite, rules and Queue states fail closed without sleeping or changing unrelated controls", async (t) => {
  const h = harness(t);
  await h.command("stage", ["--candidate-version-id", VERSION]);
  await assert.rejects(h.command("freeze"), /retirement prerequisite/);
  assert.equal((await h.dependencies.status()).control.state, "active");
  h.advance(LEGACY_RETIREMENT_MS);
  h.setRules(false);
  await assert.rejects(h.command("freeze"), /legacy rules/);
  h.setRules(true);
  await h.command("freeze");
  h.setPaused(false);
  await assert.rejects(h.exportSource(), /queues running/);
  assert.equal(readdirSync(h.directory).length, 0);
  assert.ok(h.calls.every((sql) => !sql.includes("profile_canonical_control")));
});

test("unresolved durable admissions block export, import, verification, activation and resume even if old", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  h.db.exec(
    "INSERT INTO automatch_write_admissions (admission_id,epoch,freeze_generation,backend,kind,created_at_ms) VALUES ('old',1,0,'rtdb','receipt-gc',0)",
  );
  for (const operation of [
    h.exportSource,
    h.importSource,
    h.verify,
    h.activate,
  ])
    await assert.rejects(operation(), /unresolved admissions/);
  await assert.rejects(
    h.command("resume", ["--candidate-version-id", VERSION]),
    /unresolved admissions/,
  );
  assert.equal((await h.dependencies.status()).control.backend, "rtdb");
});

test("source, stable reference, destination, candidate and freeze generation drift prevent activation", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  h.sources.telegramAutomatches.extra = { mutated: true };
  await assert.rejects(h.activate(), /source.*changed/);
  delete h.sources.telegramAutomatches.extra;
  h.invites["10"] = { ...(h.invites["10"] as RecordValue), guestId: "guest" };
  await assert.rejects(h.verify(), /source.*changed/);
  delete (h.invites["10"] as RecordValue).guestId;
  h.db.exec(
    "UPDATE automatch_telegram_sources SET payload_json = '{}' WHERE record_key = '10'",
  );
  await assert.rejects(h.verify(), /destination differs/);
  h.db
    .prepare(
      "UPDATE automatch_telegram_sources SET payload_json = ? WHERE record_key = '10'",
    )
    .run(canonicalJson(h.sources.telegramAutomatches["10"]));
  h.setDeployment(OTHER_VERSION);
  await assert.rejects(h.activate(), /deployment mismatch/);
  h.setDeployment(VERSION);
  h.db.exec(
    "UPDATE automatch_runtime_control SET freeze_generation=freeze_generation+1",
  );
  await assert.rejects(h.verify(), /epoch or candidate changed/);
});

test("live match moves can evolve during frozen snapshot verification without invalidating stable references", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  h.matches["10"].fen = "moved";
  h.matches["10"].flatMovesString = "more moves";
  h.matches["10"].timer = "changed";
  h.matches["10"].status = "surrendered";
  await h.verify();
  h.matches["10"].sessionCreation = "foreign";
  await assert.rejects(h.verify(), /source.*changed/);
});

test("interrupted paged exports and partially imported receipt components resume with original evidence", async (t) => {
  const h = harness(t);
  await h.freeze();
  const read = h.dependencies.readSource;
  let fail = true;
  h.dependencies.readSource = async (root, after, limit) => {
    if (root === "telegramAutomatches" && fail) {
      fail = false;
      throw new Error("interrupted");
    }
    return read(root, after, limit);
  };
  await assert.rejects(h.exportSource(), /interrupted/);
  await h.exportSource();
  const insert = h.dependencies.importEntry;
  let imports = 0;
  h.dependencies.importEntry = async (...args) => {
    await insert(...args);
    if (++imports === 7) throw new Error("ambiguous import");
  };
  await assert.rejects(h.importSource(), /ambiguous import/);
  h.dependencies.importEntry = insert;
  await h.importSource();
  await h.verify();
});

test("RTDB resume discards unactivated imports and permits a fresh cutover", async (t) => {
  for (const progress of ["claimed", "partial", "verified"]) {
    await t.test(progress, async (t) => {
      const h = harness(t);
      await h.freeze();
      await h.exportSource();
      const original = loadExport(h.directory);
      const imported = h.dependencies.importEntry;
      if (progress !== "verified") {
        h.dependencies.importEntry = async (...args) => {
          if (progress === "partial") await imported(...args);
          throw new Error("interrupted import");
        };
        await assert.rejects(h.importSource(), /interrupted import/);
        h.dependencies.importEntry = imported;
      } else {
        await h.importSource();
        await h.verify();
      }
      h.db.exec(
        "UPDATE automatch_runtime_control SET metadata_json = json_set(metadata_json, '$.retainedEvidence', 'keep')",
      );
      const before = (await h.dependencies.status()).control;
      const files = readdirSync(h.directory).map((name) => ({
        name,
        value: readFileSync(resolve(h.directory, name), "utf8"),
      }));
      await h.command("resume", ["--candidate-version-id", VERSION]);
      const resumed = await h.dependencies.status();
      assert.equal(resumed.control.backend, "rtdb");
      assert.equal(resumed.control.state, "active");
      assert.equal(resumed.control.epoch, before.epoch);
      assert.equal(
        resumed.control.freezeGeneration,
        before.freezeGeneration + 1,
      );
      assert.equal(resumed.control.stagedAtMs, before.stagedAtMs);
      assert.equal(resumed.control.candidateVersionId, VERSION);
      assert.equal(resumed.legacyFence, true);
      assert.equal(resumed.control.importedAtMs, null);
      assert.equal(resumed.control.sourceDigest, null);
      assert.equal(resumed.control.importDigest, null);
      assert.deepEqual(resumed.control.metadata, {
        legacyStagedVersionId: VERSION,
        retainedEvidence: "keep",
      });
      for (const root of ROOTS)
        assert.equal(await h.dependencies.countDestination(root), 0);
      for (const file of files)
        assert.equal(
          readFileSync(resolve(h.directory, file.name), "utf8"),
          file.value,
        );
      h.sources.automatch["10"] = {
        ...(h.sources.automatch["10"] as RecordValue),
        timestamp: 12345,
      };
      h.advance(1000);
      await h.command("freeze");
      await assert.rejects(h.importSource(), /epoch or candidate changed/);
      const replacement = resolve(h.directory, "replacement");
      await h.command("export", [
        "--directory",
        replacement,
        "--candidate-version-id",
        VERSION,
      ]);
      const next = loadExport(replacement);
      assert.notEqual(next.session.exportId, original.session.exportId);
      assert.notEqual(next.sourceDigest, original.sourceDigest);
      await h.command("import", ["--directory", replacement]);
      await h.command("activate", [
        "--directory",
        replacement,
        "--candidate-version-id",
        VERSION,
      ]);
      assert.equal((await h.dependencies.status()).control.backend, "d1");
    });
  }
});

test("RTDB import reset remains frozen and retryable across interrupted writes", async (t) => {
  for (const interruption of [
    "fence-response",
    "delete-before",
    "delete-response",
    "resume-response",
  ]) {
    await t.test(interruption, async (t) => {
      const h = harness(t);
      await h.freeze();
      await h.exportSource();
      await h.importSource();
      const manifest = loadExport(h.directory);
      const insert = h.db.prepare(
        "INSERT INTO automatch_entries VALUES (?, '{}', 1, 0)",
      );
      for (let index = 0; index < 1001; index++) insert.run(`extra-${index}`);
      let interrupted = false;
      h.interceptSql(async (sql, execute) => {
        const matches =
          interruption === "fence-response"
            ? sql.startsWith(
                "UPDATE automatch_runtime_control SET freeze_generation = freeze_generation + 1",
              )
            : interruption === "resume-response"
              ? sql.startsWith(
                  "UPDATE automatch_runtime_control SET state = 'active', source_digest = NULL",
                )
              : sql.startsWith("DELETE FROM automatch_entries");
        if (!interrupted && matches) {
          interrupted = true;
          if (interruption !== "delete-before") execute();
          throw new Error("reset interrupted");
        }
        return execute();
      });
      await assert.rejects(
        h.command("resume", ["--candidate-version-id", VERSION]),
        /reset interrupted/,
      );
      const interruptedControl = (await h.dependencies.status()).control;
      assert.equal(interrupted, true);
      if (interruption === "resume-response") {
        assert.equal(interruptedControl.state, "active");
      } else {
        assert.equal(interruptedControl.state, "frozen");
        assert.equal(
          interruptedControl.metadata.importResetGeneration,
          interruptedControl.freezeGeneration,
        );
        for (const operation of [
          h.exportSource,
          h.importSource,
          h.verify,
          h.activate,
        ])
          await assert.rejects(operation(), /reset is incomplete/);
        const currentGeneration = {
          ...manifest,
          session: {
            ...manifest.session,
            freezeGeneration: interruptedControl.freezeGeneration,
          },
        };
        await assert.rejects(
          h.dependencies.beginImport(currentGeneration),
          /control or record changed/,
        );
        await assert.rejects(
          h.dependencies.importEntry(
            "automatch",
            { key: "late", value: {} },
            currentGeneration.session,
          ),
          /control or record changed/,
        );
        await assert.rejects(
          h.dependencies.recordVerification(currentGeneration),
          /control or record changed/,
        );
        await assert.rejects(
          h.dependencies.activate(currentGeneration),
          /control or record changed/,
        );
      }
      if (interruption === "delete-response")
        assert.equal(await h.dependencies.countDestination("automatch"), 503);
      await h.command("resume", ["--candidate-version-id", VERSION]);
      const after = (await h.dependencies.status()).control;
      assert.equal(after.state, "active");
      assert.equal(after.freezeGeneration, interruptedControl.freezeGeneration);
      assert.equal(after.metadata.importResetGeneration, undefined);
      assert.equal(after.metadata.exportId, undefined);
      for (const root of ROOTS)
        assert.equal(await h.dependencies.countDestination(root), 0);
    });
  }
});

test("RTDB reset fences already prepared import, verification and activation SQL", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  await h.verify();
  const manifest = loadExport(h.directory);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pending = 0;
  let checked = false;
  h.interceptSql(async (sql, execute) => {
    if (
      sql.startsWith("INSERT INTO automatch_entries") ||
      sql.startsWith(
        "UPDATE automatch_runtime_control SET metadata_json = json_set(metadata_json, '$.verifiedEpoch'",
      ) ||
      sql.startsWith("UPDATE automatch_runtime_control SET backend = 'd1'")
    ) {
      if (++pending === 3) ready.resolve();
      await release.promise;
      return execute();
    }
    const result = execute();
    if (!checked && sql.startsWith("DELETE FROM automatch_entries")) {
      checked = true;
      release.resolve();
      await Promise.all(outcomes);
      assert.equal(await h.dependencies.countDestination("automatch"), 0);
    }
    return result;
  });
  const outcomes = [
    h.dependencies.importEntry(
      "automatch",
      { key: "late", value: { uid: "host" } },
      manifest.session,
    ),
    h.dependencies.recordVerification(manifest),
    h.dependencies.activate(manifest),
  ].map((operation) => assert.rejects(operation, /control or record changed/));
  await ready.promise;
  await h.command("resume", ["--candidate-version-id", VERSION]);
  await Promise.all(outcomes);
  assert.equal(checked, true);
  assert.equal((await h.dependencies.status()).control.backend, "rtdb");
});

test("D1 resume preserves activated rows and never runs import cleanup", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  await h.activate();
  const before = (await h.dependencies.status()).control;
  const rows = ROOTS.map((root) => h.sources[root]);
  const callCount = h.calls.length;
  await h.command("resume", ["--candidate-version-id", VERSION]);
  const after = (await h.dependencies.status()).control;
  assert.deepEqual(after, { ...before, state: "active" });
  assert.ok(
    h.calls.slice(callCount).every((sql) => !sql.startsWith("DELETE FROM ")),
  );
  for (const [index, root] of ROOTS.entries()) {
    const expected = rows[index];
    const actual = await h.dependencies.readDestination(
      root,
      Object.keys(expected),
    );
    assert.deepEqual(
      Object.fromEntries(actual.map(({ key, value }) => [key, value])),
      expected,
    );
  }
});

test("conflicting and extra D1 data fail instead of being overwritten", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  h.db.exec("INSERT INTO automatch_entries VALUES ('10','{}',1,0)");
  await assert.rejects(h.importSource(), /record changed/);
  assert.equal(
    h.db
      .prepare(
        "SELECT payload_json FROM automatch_entries WHERE record_key='10'",
      )
      .get()!.payload_json,
    "{}",
  );
  h.db.exec("DELETE FROM automatch_entries");
  await h.importSource();
  h.db.exec("INSERT INTO automatch_entries VALUES ('extra','{}',1,0)");
  await assert.rejects(h.verify(), /missing or extra/);
});

test("artifact tampering, unsafe modes and altered resumed source are rejected", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  const manifest = loadExport(h.directory);
  const file = resolve(h.directory, "root-0-page-000000.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.entries[0].value.changed = true;
  writeFileSync(file, JSON.stringify(data));
  assert.throws(() => loadExport(h.directory), /page proof mismatch/);
  chmodSync(resolve(h.directory, "manifest.json"), 0o644);
  assert.throws(() => loadExport(h.directory), /private regular/);
  assert.ok(manifest.sourceDigest);
});

test("legacy rows and release evidence block freeze until exact audited reconciliation", async (t) => {
  const h = harness(t);
  h.db.exec(
    "INSERT INTO game_session_mutation_locks (lock_id,owner_id,operation_id,expires_at_ms) VALUES ('manual','old-owner','operation',1)",
  );
  await h.stage();
  await assert.rejects(h.command("freeze"), /legacy writer evidence remains/);
  assert.throws(
    () =>
      h.db.exec(
        "INSERT INTO game_session_mutation_locks (lock_id,owner_id,operation_id,expires_at_ms) VALUES ('new','owner','op',9)",
      ),
    /writer-disabled/,
  );
  const evidenceDirectory = resolve(h.directory, "evidence");
  await h.command("inspect-legacy", ["--directory", evidenceDirectory]);
  const file = resolve(evidenceDirectory, readdirSync(evidenceDirectory)[0]);
  await assert.rejects(
    h.command("reconcile-legacy", ["--evidence", file]),
    /completed-request evidence/,
  );
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.requestFinishedAtMs = 2_000_000;
  evidence.completionEvidence = {
    kind: "operator-investigation",
    reference: "protected-log:invocation-1",
    explanation:
      "Request completion and exact receipt plus invite state reconciled.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  await h.command("reconcile-legacy", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).legacyLocks, 0);
  const released = h.db
    .prepare("SELECT evidence_digest FROM game_session_legacy_releases")
    .get()!;
  assert.equal(released.evidence_digest, digest(evidence));
  await h.command("freeze");
});

test("parser and source pagination enforce exact operations, protected evidence and integer-key ordering", () => {
  assert.throws(() => parseArgs(["--freeze", "--resume"]));
  assert.throws(
    () => parseArgs(["--export", "--directory", "/tmp/example"]),
    /candidate/,
  );
  assert.throws(
    () => parseArgs(["--stage", "--candidate-version-id", "token"]),
    /UUID/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--import",
        "--directory",
        "/tmp/example",
        "--firebase-credentials",
        "/tmp/key",
      ]),
    /does not use/,
  );
  assert.throws(() => parseArgs(["--reconcile-legacy"]), /evidence/);
  assert.deepEqual(
    normalizeSourcePage(
      { "10": false, "2": 7 },
      "automatch",
      0,
      null,
      2,
    ).entries.map((value) => value.key),
    ["2", "10"],
  );
  assert.throws(
    () => normalizeSourcePage({ "10": false }, "automatch", 1, "2", 2),
    /cursor changed/,
  );
});

test("remote preflight checks exact 100% version, disabled previews, both paused queues and deployed rules", async () => {
  const urls: string[] = [];
  let mixed = false;
  let pause = true;
  const deps = createRemoteDependencies(undefined, {
    apiToken: "private-token",
    firebaseToken: async () => "private-firebase-token",
    config: { account_id: "a".repeat(32), name: "mons-link-api" },
    fetcher: async (input) => {
      const url = new URL(String(input));
      urls.push(url.pathname);
      let result: unknown;
      if (url.pathname.endsWith("/deployments"))
        result = {
          deployments: [
            {
              versions: mixed
                ? [
                    { version_id: VERSION, percentage: 90 },
                    { version_id: OTHER_VERSION, percentage: 10 },
                  ]
                : [{ version_id: VERSION, percentage: 100 }],
            },
          ],
        };
      else if (url.pathname.endsWith("/subdomain"))
        result = { enabled: false, previews_enabled: false };
      else if (url.pathname.endsWith("/queues"))
        result = [
          { queue_id: "one", queue_name: "mons-link-profile-game-projection" },
          { queue_id: "two", queue_name: "mons-link-telegram-projection" },
        ];
      else if (url.pathname.includes("/queues/"))
        result = { settings: { delivery_paused: pause } };
      else if (url.pathname === "/.settings/rules.json")
        return new Response(readFileSync("cloud/database.rules.json", "utf8"));
      else throw new Error("unexpected URL");
      return Response.json({ success: true, result });
    },
  });
  await deps.assertDeployment(VERSION);
  await deps.assertQueuesPaused();
  await deps.assertRules();
  mixed = true;
  await assert.rejects(deps.assertDeployment(VERSION), /sole 100%/);
  pause = false;
  await assert.rejects(deps.assertQueuesPaused(), /pause the two/);
  assert.ok(!urls.join(" ").includes("private"));
});

test("compatible staged refinements preserve the original fenced retirement evidence", async (t) => {
  const h = harness(t);
  await h.stage();
  const original = (await h.dependencies.status()).control;
  h.setDeployment(OTHER_VERSION);
  await h.command("stage", ["--candidate-version-id", OTHER_VERSION]);
  const updated = (await h.dependencies.status()).control;
  assert.equal(updated.stagedAtMs, original.stagedAtMs);
  assert.equal(updated.metadata.legacyStagedVersionId, VERSION);
  assert.equal(updated.candidateVersionId, OTHER_VERSION);
  await h.command("freeze");
});

test("repair-forward resume adopts only the exact deployed D1 candidate and preserves original activation proof", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  await h.activate();
  const original = (await h.dependencies.status()).control;
  assert.equal(original.metadata.activationCandidateVersionId, VERSION);
  h.setDeployment(OTHER_VERSION);
  await assert.rejects(
    h.command("resume", ["--candidate-version-id", VERSION]),
    /deployment mismatch/,
  );
  await h.command("resume", ["--candidate-version-id", OTHER_VERSION]);
  const repaired = (await h.dependencies.status()).control;
  assert.equal(repaired.candidateVersionId, OTHER_VERSION);
  assert.equal(repaired.metadata.activationCandidateVersionId, VERSION);
  assert.equal(repaired.sourceDigest, original.sourceDigest);
  await h.activate();
  await h.command("freeze", ["--candidate-version-id", OTHER_VERSION]);
  assert.equal((await h.dependencies.status()).control.state, "frozen");
});

test("activation rejects advanced destination revisions even when record contents are unchanged", async (t) => {
  const h = harness(t);
  await h.freeze();
  await h.exportSource();
  await h.importSource();
  h.db.exec(
    "UPDATE game_session_mutation_receipts SET expiration_revision = 2 WHERE record_key = 'operation'",
  );
  await assert.rejects(h.activate(), /destination differs/);
  assert.equal((await h.dependencies.status()).control.backend, "rtdb");
});

function insertAdmission(
  h: ReturnType<typeof harness>,
  phase: string,
  proof: unknown = null,
) {
  h.db
    .prepare(
      "INSERT INTO automatch_write_admissions (admission_id,epoch,freeze_generation,backend,kind,created_at_ms,phase,proof_json,audit_revision,updated_at_ms,completed_at_ms) VALUES ('admission-1',1,0,'rtdb','owned-patch',100,?,?,2,200,?)",
    )
    .run(
      phase,
      proof === null ? null : canonicalJson(proof),
      phase === "completed" ? 200 : null,
    );
}
async function inspectAdmission(h: ReturnType<typeof harness>) {
  const directory = resolve(h.directory, "admissions");
  await h.command("inspect-admissions", ["--directory", directory]);
  return resolve(
    directory,
    readdirSync(directory).find((name) => name.startsWith("admission-"))!,
  );
}
function completeAdmissionEvidence(file: string) {
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.requestFinishedAtMs = 1000;
  evidence.completionEvidence = {
    kind: "operator-investigation",
    reference: "protected-trace:request-1",
    explanation:
      "Original request completed; recorded write targets and operation receipt reconciled.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  return evidence;
}

test("completed and undispatched prepared admissions clear only their exact recorded proof and replay safely", async (t) => {
  for (const phase of ["completed", "prepared"]) {
    const h = harness(t);
    insertAdmission(h, phase);
    const file = await inspectAdmission(h);
    assert.equal((await h.dependencies.status()).admissions, 1);
    await h.command("reconcile-admission", ["--evidence", file]);
    assert.equal((await h.dependencies.status()).admissions, 0);
    await h.command("reconcile-admission", ["--evidence", file]);
    assert.equal(h.log.at(-1)?.alreadyAbsent, true);
    assert.ok(
      readdirSync(resolve(h.directory, "admissions")).some((name) =>
        name.startsWith("admission-reconciliation-"),
      ),
    );
  }
});

test("uncertain patch admissions require finished-request evidence and every recorded target including receipts", async (t) => {
  const h = harness(t);
  insertAdmission(h, "uncertain", {
    schemaVersion: 1,
    kind: "patch",
    updates: {
      "automatch/10": null,
      "gameplayMutationReceipts/operation": {
        completedAtMs: { ".sv": "timestamp" },
      },
    },
  });
  const file = await inspectAdmission(h);
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /finished-request evidence/,
  );
  const evidence = completeAdmissionEvidence(file);
  const saved = evidence.sources;
  evidence.sources = evidence.sources.filter(
    (source: { path: string }) =>
      !source.path.startsWith("gameplayMutationReceipts/"),
  );
  writeFileSync(file, JSON.stringify(evidence));
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /omits a recorded write target/,
  );
  evidence.sources = saved;
  writeFileSync(file, JSON.stringify(evidence));
  h.sources.automatch["10"] = { changed: true };
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /sources changed/,
  );
  h.sources.automatch["10"] = {
    uid: "host",
    password: "secret",
    hostColor: "white",
    timestamp: 99,
  };
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).admissions, 0);
});

test("transaction admissions retain bounded attempts and reject stale phase revisions before deletion", async (t) => {
  const h = harness(t);
  insertAdmission(h, "dispatching", {
    schemaVersion: 1,
    kind: "transaction",
    path: "telegramAutomatches/10",
    attempts: [
      {
        attemptId: "attempt-1",
        current: { generation: 2 },
        proposed: { generation: 3 },
        atMs: 150,
        etag: "private-etag",
      },
    ],
  });
  const file = await inspectAdmission(h);
  completeAdmissionEvidence(file);
  h.db.exec("UPDATE automatch_write_admissions SET audit_revision=3");
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /changed after inspection/,
  );
  assert.equal((await h.dependencies.status()).admissions, 1);
  assert.ok(!JSON.stringify(h.log).includes("private-etag"));
});

test("pre-audit admissions without targets require a complete external request scope and source evidence", async (t) => {
  const h = harness(t);
  insertAdmission(h, "uncertain");
  const file = await inspectAdmission(h);
  const evidence = completeAdmissionEvidence(file);
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /complete bounded target snapshot/,
  );
  evidence.sources = [
    {
      path: "gameplayMutationReceipts/operation",
      digest: digest(h.sources.gameplayMutationReceipts.operation),
    },
  ];
  writeFileSync(file, JSON.stringify(evidence));
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /complete request scope/,
  );
  evidence.scopeEvidence = {
    reference: "protected-trace:request-1",
    explanation: "Trace identifies this receipt as the only attempted write.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).admissions, 0);
});

test("staging never trusts a preexisting unfenced timestamp or accepts a caller-supplied retirement time", async (t) => {
  const h = harness(t);
  h.db.exec("UPDATE automatch_runtime_control SET staged_at_ms=1");
  await h.command("stage", ["--candidate-version-id", VERSION]);
  assert.equal((await h.dependencies.status()).control.stagedAtMs, 2_000_000);
  await assert.rejects(h.command("freeze"), /retirement prerequisite/);
  assert.throws(
    () =>
      parseArgs([
        "--stage",
        "--candidate-version-id",
        VERSION,
        "--staged-at-ms",
        "1",
      ]),
    /invalid/,
  );
});
