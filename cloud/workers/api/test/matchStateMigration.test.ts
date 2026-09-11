import assert from "node:assert/strict";
import test from "node:test";
import { createMatchPresentationMigrationSignature } from "../src/matchPresentationMigrationAuth.ts";
import {
  createMatchStateMigrationSignature,
  verifyMatchStateMigrationSignature,
} from "../src/matchStateMigrationAuth.ts";
import {
  matchStateDigest,
  parseMatchStateMigrationRequest,
} from "../src/matchStateMigration.ts";

test("match migration signatures cannot cross the presentation migration domain", async () => {
  const timestamp = "1800000000";
  const body = '{"operation":"import"}';
  const own = await createMatchStateMigrationSignature(
    body,
    "secret",
    timestamp,
  );
  assert.equal(
    await verifyMatchStateMigrationSignature(
      body,
      "secret",
      timestamp,
      own,
      Number(timestamp) * 1000,
    ),
    true,
  );
  const other = await createMatchPresentationMigrationSignature(
    body,
    "secret",
    timestamp,
  );
  assert.equal(
    await verifyMatchStateMigrationSignature(
      body,
      "secret",
      timestamp,
      other,
      Number(timestamp) * 1000,
    ),
    false,
  );
  assert.equal(
    await verifyMatchStateMigrationSignature(
      body + " ",
      "secret",
      timestamp,
      own,
      Number(timestamp) * 1000,
    ),
    false,
  );
  assert.equal(
    await verifyMatchStateMigrationSignature(
      body,
      "secret",
      timestamp,
      own,
      Number(timestamp) * 1000 + 301000,
    ),
    false,
  );
});

test("migration bundle parser verifies exact source contents including empty rooms", async () => {
  const bundle = {
    inviteId: "game",
    epoch: 2,
    importId: "import",
    records: [],
    claims: [],
  };
  const request = {
    schemaVersion: 1,
    operation: "import",
    ownerToken: "00000000-0000-4000-8000-000000000001",
    sourceDigest: "a".repeat(64),
    bundle: {
      ...bundle,
      digest: await matchStateDigest(bundle),
      recordCount: 0,
      claimCount: 0,
    },
  };
  assert.deepEqual(
    await parseMatchStateMigrationRequest(JSON.stringify(request)),
    request,
  );
  await assert.rejects(
    parseMatchStateMigrationRequest(
      JSON.stringify({
        ...request,
        bundle: { ...request.bundle, digest: "b".repeat(64) },
      }),
    ),
    /digest-conflict/,
  );
  await assert.rejects(
    parseMatchStateMigrationRequest(
      JSON.stringify({ ...request, unreviewed: true }),
    ),
    /invalid/,
  );
});
