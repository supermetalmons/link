import assert from "node:assert/strict";
import test from "node:test";
import { createProfileProjection } from "../cloud/workers/api/src/profileProjectionModel.ts";
import {
  assertMigrationCommandSucceeded,
  buildImportSql,
  MAX_D1_IMPORT_STATEMENT_BYTES,
  parseArgs,
  profileLoginMappingDigest,
  profileSourceVersionDigest,
  PROFILE_VERIFY_PAGE_SIZE,
} from "./migrate-profile-reads.ts";

test("bounds full-payload verification pages", () => {
  assert.equal(PROFILE_VERIFY_PAGE_SIZE, 5);
  assert.equal(MAX_D1_IMPORT_STATEMENT_BYTES, 90_000);
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

test("builds idempotent content-safe profile import SQL", async () => {
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
  const sql = buildImportSql([projection], 1_000);
  assert.match(sql, /ON CONFLICT \(profile_id\) DO UPDATE/);
  assert.match(sql, /source_update_nanos >= profiles.source_update_nanos/);
  assert.match(
    sql,
    /source_update_nanos >= profiles\.source_update_nanos AND profiles\.is_deleted = 0/,
  );
  assert.match(sql, /source_update_nanos = 123456789 AND is_deleted = 0/);
  assert.match(sql, /is_deleted = 0/);
  assert.match(sql, /DELETE FROM profile_logins/);
  assert.match(sql, /DELETE FROM profile_projection_failures/);
  assert.equal(sql.match(/INSERT OR IGNORE INTO profile_logins/g)?.length, 1);
  assert.match(sql, /json_each/);
  assert.match(sql, /;\n$/);
  assert.doesNotMatch(sql, /private-login|private-user|profile-1/);
});

test("rejects projections that cannot fit one remote D1 statement", async () => {
  const projection = await createProfileProjection({
    profileId: "profile-large",
    updateTime: "2026-08-27T12:00:00.123456789Z",
    fields: {
      username: "x".repeat(MAX_D1_IMPORT_STATEMENT_BYTES),
    },
  });
  assert.throws(
    () => buildImportSql([projection], 1_000),
    /profile projection exceeds D1 import statement limit/,
  );
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
    { profileId: "profile-a", seconds: 100, nanos: 1 },
    { profileId: "profile-b", seconds: 200, nanos: 2 },
  ]);
  const changed = profileSourceVersionDigest([
    { profileId: "profile-a", seconds: 100, nanos: 2 },
    { profileId: "profile-b", seconds: 200, nanos: 1 },
  ]);
  assert.notEqual(expected, changed);
});
