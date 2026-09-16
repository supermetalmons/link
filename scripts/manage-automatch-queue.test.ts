import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  execute,
  manageAutomatchQueue,
  parseArgs,
} from "./manage-automatch-queue.ts";
import type { SqlRunner } from "./operator/runtime.ts";

const directory = resolve(
  import.meta.dirname,
  "../cloud/workers/api/migrations",
);
const migrationName = "0025_automatch_fifo_queue.sql";
const version = "00000000-0000-4000-8000-000000000025";

function fixture(queueSchema = true) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (name === migrationName && !queueSchema) continue;
    db.exec(readFileSync(resolve(directory, name), "utf8"));
  }
  db.exec(
    `UPDATE automatch_runtime_control SET backend = 'd1', metadata_json = '{"retained":"keep"}'`,
  );
  const logs: Record<string, unknown>[] = [];
  const run: SqlRunner = async (sql, database, bindings = []) => {
    assert.equal(database, "mons-link-profile-games");
    return db.prepare(sql).all(...bindings);
  };
  return {
    db,
    logs,
    dependencies: {
      run,
      log: (value: Record<string, unknown>) => logs.push(value),
      now: () => 1234,
    },
  };
}

function seed(db: DatabaseSync, key = "ticket", timestamp: unknown = 10) {
  db.prepare(
    "INSERT INTO automatch_entries (record_key,payload_json,revision,updated_at_ms) VALUES (?,?,1,10)",
  ).run(key, JSON.stringify({ uid: key, timestamp, profileId: "profile" }));
}

test("queue inspection and activation use Wrangler OAuth without an environment token", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { readFileSync, readdirSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      let authCalls = 0;
      childProcess.spawnSync = (_command, args) => {
        assert.deepEqual(args, ["auth", "token", "--json"]);
        authCalls++;
        return { status: 0, stdout: JSON.stringify({ type: "oauth", token: "test-oauth-token" }) };
      };
      syncBuiltinESMExports();
      const db = new DatabaseSync(":memory:");
      const directory = process.argv[1];
      for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort())
        db.exec(readFileSync(directory + "/" + name, "utf8"));
      db.exec("UPDATE automatch_runtime_control SET backend = 'd1'");
      let parameterizedReads = 0;
      let writes = 0;
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.headers.Authorization, "Bearer test-oauth-token");
        const { sql, params } = JSON.parse(init.body);
        if (params.length && sql.startsWith("SELECT")) parameterizedReads++;
        if (sql.startsWith("UPDATE")) writes++;
        return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all(...params) }] });
      };
      const { execute } = await import(${JSON.stringify(new URL("./manage-automatch-queue.ts", import.meta.url).href)});
      await execute(["--inspect"]);
      await execute(["--activate", "--candidate-version-id", ${JSON.stringify(version)}]);
      assert.equal(authCalls, 2);
      assert.equal(parameterizedReads, 2);
      assert.equal(writes, 1);
      assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM automatch_runtime_control").get().metadata_json).queueSelection, "fifo");
      db.close();
    `,
      directory,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "" },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /test-oauth-token/);
});

test("queue operator rejects invalid arguments before provider access", async () => {
  assert.deepEqual(parseArgs(["--inspect"]), { operation: "inspect" });
  assert.deepEqual(
    parseArgs(["--activate", "--candidate-version-id", version]),
    { operation: "activate", candidateVersionId: version },
  );
  for (const args of [
    [],
    ["--activate"],
    ["--activate", "--candidate-version-id", "invalid"],
    ["--inspect", "--extra"],
  ]) {
    await assert.rejects(execute(args), /use --inspect/);
  }
});

test("bridge inspection works before queue schema exists and activation fails closed", async () => {
  const { db, logs, dependencies } = fixture(false);
  try {
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0].mode, "legacy");
    assert.ok(Array.isArray(logs[0].missingSchemaObjects));
    await assert.rejects(
      manageAutomatchQueue(
        { operation: "activate", candidateVersionId: version },
        dependencies,
      ),
      /schema is incomplete/,
    );
  } finally {
    db.close();
  }
});

test("migration backfills live source and pending v2 intents without changing journal payloads", async () => {
  const { db, dependencies, logs } = fixture(false);
  try {
    seed(db);
    const payload = JSON.stringify({
      version: 2,
      mutations: [
        {
          current: {
            root: "automatch",
            key: "pending-invite",
            value: null,
            revision: 0,
          },
          value: { uid: "pending-uid", timestamp: 20 },
        },
      ],
    });
    db.prepare(
      "INSERT INTO game_session_transitions (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('pending','pending-invite',?,'pending',20,20)",
    ).run(payload);
    db.exec(
      "INSERT INTO game_session_transition_resources (resource_key, transition_id) VALUES ('pending-invite', 'pending')",
    );
    db.exec(readFileSync(resolve(directory, migrationName), "utf8"));
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0].valid, true);
    assert.equal((logs[0].audit as Record<string, unknown>).live_tickets, 1);
    assert.equal(
      (logs[0].audit as Record<string, unknown>).pending_enqueues,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT payload_json FROM game_session_transitions WHERE transition_id = 'pending'",
        )
        .get()?.payload_json,
      payload,
    );
    db.exec(
      "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'pending'",
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM automatch_pending_enqueues")
        .get()?.count,
      0,
    );
  } finally {
    db.close();
  }
});

test("activation preserves metadata and sets FIFO only after a valid live audit", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    seed(db);
    await manageAutomatchQueue(
      { operation: "activate", candidateVersionId: version },
      dependencies,
    );
    const metadata = JSON.parse(
      String(
        db.prepare("SELECT metadata_json FROM automatch_runtime_control").get()
          ?.metadata_json,
      ),
    );
    assert.deepEqual(metadata, {
      retained: "keep",
      queueSelection: "fifo",
      queueSelectionCandidateVersionId: version,
      queueSelectionActivatedAtMs: 1234,
    });
    assert.equal(logs[0].mode, "fifo");
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[1].valid, true);
  } finally {
    db.close();
  }
});

test("malformed timestamps, missing projection rows, and frozen control block activation", async () => {
  for (const mutate of [
    (db: DatabaseSync) => seed(db, "malformed", "10"),
    (db: DatabaseSync) => {
      seed(db);
      db.exec("DELETE FROM automatch_live_tickets");
    },
    (db: DatabaseSync) =>
      db.exec("UPDATE automatch_runtime_control SET state = 'frozen'"),
  ]) {
    const { db, dependencies } = fixture();
    try {
      mutate(db);
      await assert.rejects(
        manageAutomatchQueue(
          { operation: "activate", candidateVersionId: version },
          dependencies,
        ),
        /active with a valid projection/,
      );
      assert.equal(
        db
          .prepare(
            "SELECT json_extract(metadata_json, '$.queueSelection') AS mode FROM automatch_runtime_control",
          )
          .get()?.mode,
        null,
      );
    } finally {
      db.close();
    }
  }
});

test("activation rechecks integrity in the update when a source changes after inspection", async () => {
  const { db, dependencies } = fixture();
  try {
    const run: SqlRunner = async (sql, database, bindings) => {
      if (sql.startsWith("UPDATE automatch_runtime_control"))
        seed(db, "late-malformed", null);
      return dependencies.run(sql, database, bindings);
    };
    await assert.rejects(
      manageAutomatchQueue(
        { operation: "activate", candidateVersionId: version },
        { ...dependencies, run },
      ),
      /not confirmed/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT json_extract(metadata_json, '$.queueSelection') AS mode FROM automatch_runtime_control",
        )
        .get()?.mode,
      null,
    );
  } finally {
    db.close();
  }
});

test("activation rejects malformed or unrecoverable pending enqueue journals", async () => {
  for (const malformed of [false, true]) {
    const { db, dependencies } = fixture();
    try {
      const payload = JSON.stringify({
        version: 2,
        mutations: [
          {
            current: {
              root: "automatch",
              key: "pending-invite",
              value: null,
              revision: 0,
            },
            value: { uid: "pending-uid", timestamp: malformed ? null : 20 },
          },
        ],
      });
      db.prepare(
        "INSERT INTO game_session_transitions (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('pending','pending-invite',?,'pending',20,20)",
      ).run(payload);
      if (malformed)
        db.exec(
          "INSERT INTO game_session_transition_resources (resource_key,transition_id) VALUES ('pending-invite','pending')",
        );
      await assert.rejects(
        manageAutomatchQueue(
          { operation: "activate", candidateVersionId: version },
          dependencies,
        ),
        /active with a valid projection/,
      );
      assert.equal(
        db
          .prepare(
            "SELECT json_extract(metadata_json, '$.queueSelection') AS mode FROM automatch_runtime_control",
          )
          .get()?.mode,
        null,
      );
    } finally {
      db.close();
    }
  }
});
