const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const {
  compareProjectionMaps,
  isFirestoreProjectionSafeToDelete,
  parseArgs,
} = require("./migrate-profile-games-d1.ts");

function row(profileId: string, projectionId: string, status = "waiting") {
  return {
    profile_id: profileId,
    projection_id: projectionId,
    entity_type: "game",
    status,
    sort_bucket: status === "active" ? 40 : 30,
    list_sort_at_ms: 1_000,
    updated_at_ms: 1_000,
    version: 1,
    payload_json: JSON.stringify({ projectionId, status }),
  };
}

test("profile game migration CLI defaults destructive commands to dry-run", () => {
  assert.deepEqual(parseArgs(["backfill"]), {
    adminArgs: [],
    command: "backfill",
    execute: false,
  });
  assert.deepEqual(
    parseArgs([
      "cleanup-firestore",
      "--execute",
      "--project",
      "mons-link",
      "--token-file",
      "/secure/token",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      command: "cleanup-firestore",
      execute: true,
      tokenFile: "/secure/token",
    },
  );
  assert.throws(() => parseArgs(["verify", "--execute"]), TypeError);
  assert.throws(() => parseArgs(["backfill", "--execute", "--dry-run"]));
  assert.throws(() => parseArgs(["unknown"]));
});

test("profile game migration parity reports every difference class", () => {
  const firestore = new Map([
    ["profile-1\u0000one", row("profile-1", "one")],
    ["profile-1\u0000two", row("profile-1", "two")],
  ]);
  const d1 = new Map([
    ["profile-1\u0000two", row("profile-1", "two", "active")],
    ["profile-2\u0000three", row("profile-2", "three")],
  ]);
  assert.deepEqual(compareProjectionMaps(firestore, d1), {
    firestore: 2,
    d1: 2,
    missing: ["profile-1\u0000one"],
    extra: ["profile-2\u0000three"],
    mismatched: ["profile-1\u0000two"],
  });
});

test("profile game cleanup rejects equal-timestamp payload mismatches", () => {
  const expected = row("profile-1", "one");
  const mismatched = {
    ...expected,
    payload_json: JSON.stringify({ projectionId: "one", status: "active" }),
  };
  assert.equal(
    isFirestoreProjectionSafeToDelete(expected, mismatched, undefined),
    false,
  );
  assert.equal(
    isFirestoreProjectionSafeToDelete(expected, expected, undefined),
    true,
  );
  assert.equal(
    isFirestoreProjectionSafeToDelete(
      expected,
      { ...mismatched, updated_at_ms: 1_001 },
      undefined,
    ),
    true,
  );
  assert.equal(
    isFirestoreProjectionSafeToDelete(expected, undefined, 1_000),
    true,
  );
});
