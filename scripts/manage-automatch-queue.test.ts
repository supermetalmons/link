import { activateStrictLocalSchemaFixture } from "./test-fixtures/strict-local-schema.ts";
import { parseAutomatchRecord } from "../cloud/runtime/automatchRecords.js";
import { inviteDocumentFixture } from "../cloud/workers/api/test/inviteDocumentFixture.ts";
import { serializeGameSessionIntent } from "../cloud/workers/api/src/gameSessionIntentRecords.ts";
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
const migrationName = readdirSync(directory).find((name) =>
  name.startsWith("0031_"),
)!;
const version = "00000000-0000-4000-8000-000000000025";

function fixture(queueSchema = true) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (name === migrationName && !queueSchema) break;
    if (name.endsWith("_retire_canonical_source_tables.sql"))
      db.exec(
        "UPDATE application_data_control SET generation = 3, data_epoch = 1",
      );
    if (name === "0039_retire_canonical_timer_starts.sql")
      activateStrictLocalSchemaFixture(db);
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
    },
  };
}

function automatchEntry(fields: Record<string, unknown>) {
  return parseAutomatchRecord("automatch", {
    schemaVersion: 1,
    uid: "host",
    profileId: null,
    timestamp: 10,
    rating: 1500,
    hostColor: "white",
    password: "fixture-password",
    gameVariant: "Classic",
    telegramDeliveryVersion: null,
    username: "",
    ethAddress: "",
    solAddress: "",
    emojiId: 1,
    ...fields,
  });
}

function seed(db: DatabaseSync, key = "ticket", timestamp: unknown = 10) {
  db.prepare(
    "INSERT INTO automatch_entries_canonical (record_key,payload_json,revision,updated_at_ms) VALUES (?,?,1,10)",
  ).run(
    key,
    JSON.stringify(
      automatchEntry({
        uid: key,
        timestamp,
        profileId: "profile",
      }),
    ),
  );
}

test("queue inspection uses Wrangler OAuth and only reads without an environment token", () => {
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
      import { activateStrictLocalSchemaFixture } from "./scripts/test-fixtures/strict-local-schema.ts";
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
      for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
        if (name.endsWith("_retire_canonical_source_tables.sql")) db.exec("UPDATE application_data_control SET generation = 3, data_epoch = 1");
        if (name === "0039_retire_canonical_timer_starts.sql") activateStrictLocalSchemaFixture(db);
        db.exec(readFileSync(directory + "/" + name, "utf8"));
      }
      db.exec("UPDATE automatch_runtime_control SET backend = 'd1'");
      db.exec("PRAGMA query_only = ON");
      let parameterizedReads = 0;
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.headers.Authorization, "Bearer test-oauth-token");
        const { sql, params } = JSON.parse(init.body);
        assert.ok(sql.startsWith("SELECT"), "REST transport must remain read-only");
        if (params.length && sql.startsWith("SELECT")) parameterizedReads++;
        return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all(...params) }] });
      };
      const { execute } = await import(${JSON.stringify(new URL("./manage-automatch-queue.ts", import.meta.url).href)});
      await assert.rejects(execute(["--activate", "--candidate-version-id", ${JSON.stringify(version)}]), /use --inspect/);
      assert.equal(authCalls, 0);
      await execute(["--inspect"]);
      assert.equal(authCalls, 1);
      assert.equal(parameterizedReads, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_write_context").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_data_admissions").get().count, 0);
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
  assert.equal(JSON.parse(child.stdout).mode, "fifo");
});

test("queue operator rejects invalid arguments before provider access", async () => {
  assert.deepEqual(parseArgs(["--inspect"]), { operation: "inspect" });
  for (const args of [
    [],
    ["--activate"],
    ["--activate", "--candidate-version-id", version],
    ["--activate", "--candidate-version-id", "invalid"],
    ["--inspect", "--extra"],
  ]) {
    await assert.rejects(execute(args), /use --inspect/);
  }
});

test("inspection reports missing canonical queue schema", async () => {
  const { db, logs, dependencies } = fixture(false);
  try {
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0]!.mode, "fifo");
    assert.ok(Array.isArray(logs[0]!.missingSchemaObjects));
    assert.ok(logs[0]!.missingSchemaObjects.length > 0);
    assert.equal(logs[0]!.valid, undefined);
  } finally {
    db.close();
  }
});

test("canonical queue inspection succeeds after source entries and journals are retired", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('automatch_entries', 'game_session_transitions')",
        )
        .all(),
      [],
    );
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0]!.valid, true);
    assert.equal((logs[0]!.audit as Record<string, unknown>).live_tickets, 0);
    assert.equal(
      (logs[0]!.audit as Record<string, unknown>).pending_enqueues,
      0,
    );
  } finally {
    db.close();
  }
});

test("inspection reports FIFO independently of retained selection metadata", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    seed(db);
    for (const metadata of [
      null,
      '{"retained":"keep"}',
      '{"queueSelection":"legacy"}',
      '{"queueSelection":"fifo"}',
    ]) {
      db.prepare("UPDATE automatch_runtime_control SET metadata_json = ?").run(
        metadata,
      );
      await manageAutomatchQueue({ operation: "inspect" }, dependencies);
      assert.equal(logs.at(-1)!.mode, "fifo");
      assert.equal(logs.at(-1)!.valid, true);
      assert.equal(
        db.prepare("SELECT metadata_json FROM automatch_runtime_control").get()
          ?.metadata_json,
        metadata,
      );
    }
  } finally {
    db.close();
  }
});

test("inspection reports missing projection rows without repairing them", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    seed(db);
    db.exec("DELETE FROM automatch_live_tickets_canonical");
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0]!.valid, false);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM automatch_live_tickets_canonical",
        )
        .get()?.count,
      0,
    );
  } finally {
    db.close();
  }
});

test("inspection reports frozen control without changing it", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    db.exec("UPDATE automatch_runtime_control SET state = 'frozen'");
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0]!.state, "frozen");
    assert.equal(logs[0]!.valid, true);
    assert.equal(
      db.prepare("SELECT state FROM automatch_runtime_control").get()?.state,
      "frozen",
    );
  } finally {
    db.close();
  }
});

test("inspection reports an unrecoverable canonical pending enqueue", async () => {
  const { db, dependencies, logs } = fixture();
  try {
    const value = automatchEntry({
      uid: "pending-uid",
      timestamp: 20,
    });
    const payload = serializeGameSessionIntent({
      version: 3,
      inviteId: "pending-invite",
      inviteSourceEpoch: 1,
      transitionId: "pending",
      operationDigest: "a".repeat(64),
      resources: ["pending-invite"],
      createdAtMs: 20,
      creations: [],
      inviteMutations: [
        {
          current: { inviteId: "pending-invite", revision: 0, value: null },
          value: inviteDocumentFixture({ hostId: "pending-uid" }),
        },
      ],
      mutations: [
        {
          current: {
            root: "automatch",
            key: "pending-invite",
            value: null,
            revision: 0,
          },
          value,
        },
      ],
    });
    db.prepare(
      "INSERT INTO game_session_transitions_canonical (transition_id,invite_id,payload_json,status,created_at_ms,updated_at_ms) VALUES ('pending','pending-invite',?,'pending',20,20)",
    ).run(payload);
    await manageAutomatchQueue({ operation: "inspect" }, dependencies);
    assert.equal(logs[0]!.valid, false);
  } finally {
    db.close();
  }
});

test("canonical queue storage rejects malformed timestamps", () => {
  const { db } = fixture();
  try {
    const value = automatchEntry({
      uid: "malformed",
      timestamp: 10,
    });
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO automatch_entries_canonical (record_key,payload_json,revision,updated_at_ms) VALUES ('malformed',?,1,10)",
          )
          .run(JSON.stringify({ ...value, timestamp: "10" })),
      /constraint/i,
    );
  } finally {
    db.close();
  }
});
