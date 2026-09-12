import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMigrationDirection,
  parseMigrationArguments,
  publicationReceipt,
} from "./operator.ts";
import type { MigrationManifest } from "./state.ts";

function manifest(
  records: Record<string, unknown> = {},
  phases: MigrationManifest["phases"] = {},
): MigrationManifest {
  return {
    schemaVersion: 1,
    revision: 0,
    previousDigest: null,
    runId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-09-12T00:00:00Z",
    accountId: "a".repeat(32),
    workerName: "mons-link-api",
    originalVersionId: "22222222-2222-4222-8222-222222222222",
    namespaceId: "b".repeat(32),
    configuration: {},
    databases: [],
    queues: [],
    controls: {},
    phases,
    versions: {},
    records,
  };
}

test("a recorded cutover intent prevents reverse migration even before promotion is acknowledged", () => {
  const state = manifest({ cutoverStartedAt: "2026-09-12T01:00:00Z" });
  for (const phase of ["prepare", "quiesce", "copy", "verify"] as const)
    assert.throws(() => assertMigrationDirection(state, phase));
  assert.doesNotThrow(() => assertMigrationDirection(state, "cutover"));
  assert.doesNotThrow(() => assertMigrationDirection(state, "resume"));
  assert.doesNotThrow(() => assertMigrationDirection(state, "status"));
});

test("partial maintenance cannot be mistaken for an unused rehearsal target", () => {
  assert.throws(() =>
    assertMigrationDirection(
      manifest({ quiesceStartedAt: "2026-09-12T01:00:00Z" }),
      "prepare",
    ),
  );
  assert.doesNotThrow(() =>
    assertMigrationDirection(
      manifest({ quiesceStartedAt: "2026-09-12T01:00:00Z" }),
      "quiesce",
    ),
  );
});

test("resume intent prevents replaying cutover and source promotion", () => {
  const state = manifest({ resumeStartedAt: "2026-09-12T02:00:00Z" });
  for (const phase of [
    "prepare",
    "quiesce",
    "copy",
    "verify",
    "cutover",
  ] as const)
    assert.throws(() => assertMigrationDirection(state, phase));
  assert.doesNotThrow(() => assertMigrationDirection(state, "resume"));
});

test("migration CLI requires an explicit protected-directory target and rejects ambiguous arguments", () => {
  for (const args of [
    [],
    ["copy"],
    ["copy", "--directory", "relative"],
    ["copy", "--directory", "/private/tmp/a", "--directory", "/private/tmp/b"],
    ["copy", "--directory", "/private/tmp/a", "--sql", "DELETE FROM data"],
  ])
    assert.throws(() => parseMigrationArguments(args));
  const parsed = parseMigrationArguments([
    "verify",
    "--directory",
    "/private/tmp/migration",
    "--bridge-secret-file",
    "/private/secret",
  ]);
  assert.equal(parsed.phase, "verify");
  assert.equal(parsed.directory, "/private/tmp/migration");
  assert.equal(parsed.bridgeSecretFile, "/private/secret");
});

test("first publication and receipt-based retry produce identical immutable evidence", () => {
  const receipt = {
    name: "mons-link-event-progress",
    workerVersionId: "a",
    workflowVersionId: "b",
    previousWorkflowVersionId: "c",
  };
  const first = {
    ...receipt,
    workflowId: "provider-owned",
    publishBody: {
      script_name: "mons-link-api",
      class_name: "EventProgressWorkflow",
    },
  };
  assert.deepEqual(publicationReceipt(first), publicationReceipt(receipt));
  assert.throws(() =>
    publicationReceipt({ ...receipt, workflowVersionId: undefined }),
  );
});
