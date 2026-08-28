import assert from "node:assert/strict";
import test from "node:test";
import { createProfileProjection } from "../cloud/workers/api/src/profileProjectionModel.ts";
import {
  assertMigrationCommandSucceeded,
  compareUtf8,
  MAX_PROFILE_VERIFY_BATCH_BYTES,
  MAX_PROFILE_VERIFY_BATCH_ROWS,
  parseArgs,
  profileImportStatements,
  profileLoginMappingDigest,
  profileSourceVersionDigest,
  profileVerificationBatches,
} from "./migrate-profile-reads.ts";

test("bounds full-payload verification batches", () => {
  assert.equal(MAX_PROFILE_VERIFY_BATCH_BYTES, 1_000_000);
  assert.equal(MAX_PROFILE_VERIFY_BATCH_ROWS, 100);
  assert.deepEqual(
    profileVerificationBatches([
      { payloadBytes: 600_000, profileId: "a" },
      { payloadBytes: 500_000, profileId: "b" },
      { payloadBytes: 1_100_000, profileId: "c" },
    ]).map((batch) => batch.map(({ profileId }) => profileId)),
    [["a"], ["b"], ["c"]],
  );
  assert.deepEqual(
    profileVerificationBatches(
      Array.from({ length: 101 }, (_, index) => ({
        payloadBytes: 1,
        profileId: String(index),
      })),
    ).map((batch) => batch.length),
    [100, 1],
  );
});

test("parses one exact profile migration mode", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "dry-run",
    project: "mons-link",
  });
  assert.deepEqual(parseArgs(["--execute", "--project", "mons-link"]), {
    mode: "execute",
    project: "mons-link",
  });
  assert.throws(() => parseArgs(["--execute", "--project", "test-project"]));
  assert.throws(() => parseArgs(["--execute", "--verify"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("builds idempotent parameterized profile import statements", async () => {
  const projection = await createProfileProjection({
    profileId: "profile-1",
    updateTime: "2026-08-27T12:00:00.123456789Z",
    fields: {
      logins: ["private-login"],
      username: "private-user",
      rating: 1500,
      custom: { emoji: 1 },
      mining: { materials: { dust: 2 } },
    },
  });
  const statements = profileImportStatements(projection, 1_000);
  const sql = statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /ON CONFLICT \(profile_id\) DO UPDATE/);
  assert.match(sql, /projection_schema_version/);
  assert.match(sql, /projection_schema_source_seconds/);
  assert.match(sql, /profile_logins_v2/);
  assert.match(sql, /is_deleted = 0/);
  assert.match(sql, /DELETE FROM profile_logins/);
  assert.match(sql, /DELETE FROM profile_projection_failures/);
  assert.equal(
    sql.match(/INSERT OR IGNORE INTO profile_logins_v2/g)?.length,
    1,
  );
  assert.match(sql, /json_each/);
  assert.doesNotMatch(sql, /private-login|private-user|profile-1/);
  assert.equal(statements.length, 4);
  assert.ok(
    statements.every(
      ({ params, sql: statement }) =>
        (statement.match(/\?/g) || []).length === (params || []).length,
    ),
  );
  assert.ok(
    statements.some((statement) =>
      statement.params?.includes("private-login"),
    ) === false,
  );
  assert.ok(
    statements.some((statement) =>
      statement.params?.includes('["private-login"]'),
    ),
  );
});

test("parameterized import accepts large valid profile payloads", async () => {
  const projection = await createProfileProjection({
    profileId: "profile-large",
    updateTime: "2026-08-27T12:00:00.123456789Z",
    fields: {
      username: "x".repeat(200_000),
    },
  });
  const statements = profileImportStatements(projection, 1_000);
  assert.ok(
    statements[0]?.params?.some(
      (value) => typeof value === "string" && value.length > 200_000,
    ),
  );
  assert.ok(statements.every(({ sql }) => sql.length < 10_000));
});

test("uses SQLite-compatible UTF-8 binary identifier ordering", () => {
  assert.ok(compareUtf8("\uE000", "\u{10000}") < 0);
  assert.ok(compareUtf8("\u{10000}", "\uE000") > 0);
});

test("sanitizes failed D1 command output", () => {
  assert.throws(
    () =>
      assertMigrationCommandSucceeded({
        status: 1,
        signal: null,
        stderr: "private-login",
        stdout: "private-profile-payload",
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "profile D1 command exited 1" &&
      !error.message.includes("private"),
  );
});

test("login mapping digest detects mappings with unchanged counts", () => {
  const expected = profileLoginMappingDigest([
    { loginUid: "login-a", profileId: "profile-a" },
    { loginUid: "login-b", profileId: "profile-b" },
  ]);
  const swapped = profileLoginMappingDigest([
    { loginUid: "login-b", profileId: "profile-a" },
    { loginUid: "login-a", profileId: "profile-b" },
  ]);
  assert.notEqual(expected, swapped);
});

test("source version digest detects timestamp changes", () => {
  const expected = profileSourceVersionDigest([
    { profileId: "profile-a", schemaVersion: 2, seconds: 100, nanos: 1 },
    { profileId: "profile-b", schemaVersion: 2, seconds: 200, nanos: 2 },
  ]);
  const changed = profileSourceVersionDigest([
    { profileId: "profile-a", schemaVersion: 2, seconds: 100, nanos: 2 },
    { profileId: "profile-b", schemaVersion: 2, seconds: 200, nanos: 1 },
  ]);
  assert.notEqual(expected, changed);
});

test("source version digest detects schema changes", () => {
  const expected = profileSourceVersionDigest([
    { profileId: "profile-a", schemaVersion: 2, seconds: 100, nanos: 1 },
  ]);
  const changed = profileSourceVersionDigest([
    { profileId: "profile-a", schemaVersion: 1, seconds: 100, nanos: 1 },
  ]);
  assert.notEqual(expected, changed);
});
