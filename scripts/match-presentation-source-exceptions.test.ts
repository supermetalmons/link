import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATION_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_DIGEST = "a".repeat(64);
const COLUMNS = [
  "migration_id",
  "invite_id",
  "match_id",
  "actor_uid",
  "disposition",
  "seed_digest",
  "source_digest",
  "source_json",
  "evidence_json",
  "canonical_actor_uid",
  "canonical_seed_digest",
  "manifest_digest",
  "imported_at_ms",
] as const;
type ExceptionRow = Record<(typeof COLUMNS)[number], string | number | null>;

function fixture(t: { after(callback: () => void): void }, capture = true) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const directory = resolve(
    import.meta.dirname,
    "../cloud/workers/api/migrations",
  );
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(resolve(directory, file), "utf8"));
  if (capture) {
    db.prepare(
      `UPDATE match_presentation_control
       SET phase = 'capture', migration_id = ?,
           candidate_version_id = '22222222-2222-4222-8222-222222222222',
           capture_started_at_ms = 1, source_digest = ?
       WHERE singleton = 1`,
    ).run(MIGRATION_ID, MANIFEST_DIGEST);
  }
  return db;
}

function exception(overrides: Partial<ExceptionRow> = {}): ExceptionRow {
  return {
    migration_id: MIGRATION_ID,
    invite_id: "invite",
    match_id: "invite",
    actor_uid: "alias",
    disposition: "alias",
    seed_digest: "b".repeat(64),
    source_digest: "c".repeat(64),
    source_json: JSON.stringify({
      version: 2,
      color: "white",
      emojiId: 9,
      aura: "",
      fen: "original-position",
      flatMovesString: "first-move",
      retainedExtra: { value: true },
    }),
    evidence_json: JSON.stringify({
      reason: "linked-login-copy",
      profileId: "profile",
    }),
    canonical_actor_uid: "canonical",
    canonical_seed_digest: "d".repeat(64),
    manifest_digest: MANIFEST_DIGEST,
    imported_at_ms: 10,
    ...overrides,
  };
}

function insert(db: DatabaseSync, row: ExceptionRow, replace = false) {
  return db
    .prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO match_presentation_source_exceptions
     (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    )
    .run(...COLUMNS.map((column) => row[column]));
}

function register(db: DatabaseSync, actorUid: string, matchId = "invite") {
  return db
    .prepare(
      `INSERT INTO match_presentation_registrations
     (invite_id, match_id, actor_uid, seed_digest, provenance, source_id, registered_at_ms)
     VALUES ('invite', ?, ?, ?, 'creation', 'source', 10)`,
    )
    .run(matchId, actorUid, "d".repeat(64));
}

function activate(db: DatabaseSync) {
  db.prepare(
    `UPDATE match_presentation_control
     SET phase = 'durable', source_count = 2, verification_digest = ?,
         verified_at_ms = 20, activated_at_ms = 21
     WHERE singleton = 1`,
  ).run("e".repeat(64));
}

test("source exceptions preserve full raw records without creating live actors or requiring import order", (t) => {
  const db = fixture(t);
  const alias = exception();
  const archive = exception({
    actor_uid: "orphan",
    disposition: "archive",
    canonical_actor_uid: null,
    canonical_seed_digest: null,
    evidence_json: JSON.stringify({ reason: "no-canonical-owner" }),
  });
  insert(db, alias);
  insert(db, archive);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .get()!.count,
    0,
  );
  const stored = db
    .prepare(
      "SELECT * FROM match_presentation_source_exceptions ORDER BY actor_uid",
    )
    .all();
  assert.deepEqual(
    stored.map((row) => ({ ...row })),
    [alias, archive],
  );
  assert.equal(register(db, "canonical").changes, 1);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM match_presentation_registrations")
      .get()!.count,
    1,
  );
});

test("exception imports require matching capture authority and manifest", (t) => {
  const legacy = fixture(t, false);
  assert.throws(
    () => insert(legacy, exception()),
    /exception-import-unavailable/,
  );
  const db = fixture(t);
  assert.throws(
    () => insert(db, exception({ migration_id: "other" })),
    /exception-import-unavailable/,
  );
  assert.throws(
    () => insert(db, exception({ manifest_digest: "f".repeat(64) })),
    /exception-import-unavailable/,
  );
  insert(db, exception());
  activate(db);
  assert.throws(
    () => insert(db, exception({ imported_at_ms: 30 })),
    /exception-import-unavailable/,
  );
  assert.throws(
    () => insert(db, exception({ actor_uid: "later" })),
    /exception-import-unavailable/,
  );
});

test("identical exception retries preserve the original receipt while conflicting replacements fail", (t) => {
  const db = fixture(t);
  const original = exception();
  insert(db, original);
  assert.equal(insert(db, exception({ imported_at_ms: 100 })).changes, 0);
  assert.equal(insert(db, exception({ imported_at_ms: 200 }), true).changes, 0);
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT * FROM match_presentation_source_exceptions")
        .get()!,
    },
    original,
  );
  for (const change of [
    { invite_id: "other" },
    { seed_digest: "e".repeat(64) },
    { source_digest: "e".repeat(64) },
    { source_json: "{}" },
    { evidence_json: "{}" },
    { canonical_actor_uid: "other" },
    { canonical_seed_digest: "e".repeat(64) },
    {
      disposition: "archive",
      canonical_actor_uid: null,
      canonical_seed_digest: null,
    },
  ]) {
    assert.throws(
      () => insert(db, exception(change), true),
      /exception-conflict/,
    );
  }
  assert.throws(
    () =>
      db.exec(
        "UPDATE match_presentation_source_exceptions SET imported_at_ms = 100",
      ),
    /exception-immutable/,
  );
  assert.throws(
    () => db.exec("DELETE FROM match_presentation_source_exceptions"),
    /exception-immutable/,
  );
});

test("exception and live registration cannot share a physical actor match in either order", (t) => {
  const first = fixture(t);
  register(first, "alias");
  assert.throws(() => insert(first, exception()), /exception-live-actor/);
  for (const disposition of ["alias", "archive"]) {
    const db = fixture(t);
    insert(
      db,
      exception(
        disposition === "archive"
          ? {
              disposition,
              canonical_actor_uid: null,
              canonical_seed_digest: null,
            }
          : {},
      ),
    );
    assert.throws(() => register(db, "alias"), /exception-live-actor/);
    assert.equal(register(db, "canonical").changes, 1);
  }
});

test("exception schema rejects malformed records and accidental archive aliases", (t) => {
  const invalid: Partial<ExceptionRow>[] = [
    { disposition: "unknown" },
    { disposition: "archive" },
    { canonical_actor_uid: null },
    { canonical_seed_digest: null },
    { canonical_actor_uid: "alias" },
    { source_json: "[]" },
    { evidence_json: "[]" },
    { seed_digest: "not-a-digest" },
    { source_digest: "G".repeat(64) },
    { imported_at_ms: -1 },
    { imported_at_ms: 1.5 },
    { actor_uid: "nested/actor" },
  ];
  for (const fields of invalid) {
    const db = fixture(t);
    assert.throws(
      () => insert(db, exception(fields)),
      /CHECK constraint failed/,
    );
  }
});
