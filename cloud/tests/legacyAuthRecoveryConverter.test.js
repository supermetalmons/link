"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  MAX_JOB_LOGIN_UIDS,
  PENDING_FIELDS,
  ConversionBlocked,
  collectCandidatePage,
  convertLegacyAuthRecoveryPage,
  decodeCursor,
  encodeCursor,
  parseArgs,
} = require("../admin/convertLegacyAuthRecoveryJobs");

const key = (collection, id) => `${collection}/${id}`;
const clone = (value) => structuredClone(value);
const own = (value, field) =>
  Object.prototype.hasOwnProperty.call(value, field);

const claimBacklog = (id, targetProfileId, failedLoginUids, extra = {}) => ({
  collection: "authClaimSyncBacklog",
  id,
  data: {
    opId: id,
    targetProfileId,
    sourceProfileId: targetProfileId,
    failedLoginUids,
    status: "pending",
    createdAtMs: 10,
    updatedAtMs: 20,
    ...extra,
  },
});

const gameBacklog = (id, sourceProfileId, targetProfileId) => ({
  collection: "authMergeGameBacklog",
  id,
  data: {
    opId: id,
    sourceProfileId,
    targetProfileId,
    status: "pending",
    createdAtMs: 10,
    updatedAtMs: 20,
  },
});

const profile = (id, logins = [], extra = {}) => ({
  collection: "users",
  id,
  data: { logins, ...extra },
});

const mergeTarget = (sourceProfileId, targetProfileId) => ({
  collection: "profileMergeTargets",
  id: sourceProfileId,
  data: { sourceProfileId, targetProfileId },
});

const prize = (
  profileId,
  {
    assignedAtMs = 100,
    eventId = "NN3eRzoZo80",
    place = 1,
    prizeId = "1092",
  } = {},
) => ({
  eventId,
  profileId,
  place,
  prizeId,
  assignedAtMs,
});

const createMemory = ({ documents = [], prizes = {}, beforeCommit } = {}) => {
  const records = new Map();
  let version = 0;
  for (const document of documents) {
    version += 1;
    records.set(key(document.collection, document.id), {
      collection: document.collection,
      id: document.id,
      data: clone(document.data),
      version: String(version),
    });
  }
  let commits = 0;
  const listDocuments = async (collection, after, limit) =>
    Array.from(records.values())
      .filter((document) => document.collection === collection)
      .filter((document) => document.id > after)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(({ id }) => ({ id }));
  const readDocument = async (collection, id) => {
    const document = records.get(key(collection, id));
    return document
      ? { id, data: clone(document.data), version: document.version }
      : null;
  };
  const readPrizes = async (profileId) => clone(prizes[profileId] ?? null);
  const commitConversion = async (input) => {
    if (beforeCommit) {
      await beforeCommit(input, records);
    }
    for (const expected of input.expectedDocuments) {
      const current = records.get(key(expected.collection, expected.id));
      if (
        Boolean(current) !== expected.exists ||
        (current?.version ?? null) !== expected.version
      ) {
        throw new ConversionBlocked("concurrent-firestore-change");
      }
    }
    const nextRecords = new Map(records);
    version += 1;
    nextRecords.set(key("authRecoveryJobs", input.canonicalProfileId), {
      collection: "authRecoveryJobs",
      id: input.canonicalProfileId,
      data: clone(input.job),
      version: String(version),
    });
    const candidateKey = key(input.candidate.collection, input.candidate.id);
    if (input.clearPendingFields) {
      const candidate = nextRecords.get(candidateKey);
      const data = clone(candidate.data);
      for (const field of PENDING_FIELDS) {
        delete data[field];
      }
      version += 1;
      nextRecords.set(candidateKey, {
        ...candidate,
        data,
        version: String(version),
      });
    } else {
      nextRecords.delete(candidateKey);
    }
    records.clear();
    for (const [recordKey, document] of nextRecords) {
      records.set(recordKey, document);
    }
    commits += 1;
  };
  return {
    adapters: {
      listDocuments,
      readDocument,
      readPrizes,
      commitConversion,
      now: () => 1_000,
    },
    commits: () => commits,
    data: (collection, id) => records.get(key(collection, id))?.data,
    has: (collection, id) => records.has(key(collection, id)),
    records,
  };
};

const options = (overrides = {}) => ({
  after: "",
  dryRun: true,
  limit: 100,
  ...overrides,
});

test("parses bounded arguments and opaque cursors", async () => {
  assert.deepEqual(parseArgs([]), {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: 20,
  });
  const cursor = encodeCursor({ collectionIndex: 1, after: "operation-1" });
  assert.deepEqual(decodeCursor(cursor), {
    collectionIndex: 1,
    after: "operation-1",
  });
  assert.deepEqual(
    parseArgs([
      "--project",
      "project",
      "--database-url",
      "https://database.test",
      "--after",
      cursor,
      "--limit",
      "1",
      "--execute",
    ]),
    {
      adminArgs: [
        "--project",
        "project",
        "--database-url",
        "https://database.test",
      ],
      after: cursor,
      dryRun: false,
      limit: 1,
    },
  );
  for (const argv of [
    ["--limit", "0"],
    ["--limit", "101"],
    ["--limit", "1", "--limit", "2"],
    ["--dry-run", "--execute"],
  ]) {
    assert.throws(() => parseArgs(argv), TypeError);
  }
  assert.throws(() => decodeCursor("operation-1"), /invalid-cursor/);

  const memory = createMemory({
    documents: [
      claimBacklog("a", "profile-a", ["uid-a"]),
      claimBacklog("b", "profile-b", ["uid-b"]),
    ],
  });
  const first = await collectCandidatePage({
    after: "",
    limit: 1,
    listDocuments: memory.adapters.listDocuments,
  });
  assert.deepEqual(first.candidates, [
    { collection: "authClaimSyncBacklog", id: "a" },
  ]);
  assert.equal(first.hasMore, true);
  const second = await collectCandidatePage({
    after: first.nextCursor,
    limit: 1,
    listDocuments: memory.adapters.listDocuments,
  });
  assert.deepEqual(second.candidates, [
    { collection: "authClaimSyncBacklog", id: "b" },
  ]);
  assert.notEqual(second.nextCursor, first.nextCursor);
});

test("plain Node loads the shared TypeScript UID validator", () => {
  const validatorPath = path.resolve(
    __dirname,
    "../workers/api/src/firebaseKeys.ts",
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const validator = require(${JSON.stringify(validatorPath)}); process.exit(validator.isCanonicalFirebaseUid("uid") ? 0 : 1)`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("dry-run and execute produce the same canonical job", async () => {
  const documents = [
    claimBacklog("claim-1", "target", ["UID", "uid"]),
    profile("target", ["UID", "uid"]),
  ];
  const dryMemory = createMemory({ documents });
  const executeMemory = createMemory({ documents });
  const dry = await convertLegacyAuthRecoveryPage(
    options(),
    dryMemory.adapters,
  );
  const execute = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    executeMemory.adapters,
  );
  assert.equal(dry.complete, true);
  assert.equal(execute.complete, true);
  assert.deepEqual(dry.blockedCandidates, execute.blockedCandidates);
  assert.deepEqual(dry.results[0].job, execute.results[0].job);
  assert.deepEqual(execute.results[0].job.loginUids, ["UID", "uid"]);
  assert.equal(execute.results[0].job.sourcePhase, "finalize");
  assert.deepEqual(execute.results[0].job.sourceProfileIds, []);
  assert.equal(execute.results[0].job.phaseStartedAtMs, 1_000);
  assert.equal(execute.results[0].job.updatedAtMs, 1_000);
  assert.equal(dryMemory.has("authClaimSyncBacklog", "claim-1"), true);
  assert.equal(executeMemory.has("authClaimSyncBacklog", "claim-1"), false);
});

test("dry-run accumulates sibling work exactly like execute", async () => {
  const documents = [
    claimBacklog("claim-a", "target", ["uid-a"]),
    claimBacklog("claim-b", "target", ["uid-b"]),
    profile("target", ["uid-a", "uid-b"]),
  ];
  const dryMemory = createMemory({ documents });
  const executeMemory = createMemory({ documents });
  const dry = await convertLegacyAuthRecoveryPage(
    options(),
    dryMemory.adapters,
  );
  const execute = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    executeMemory.adapters,
  );
  assert.deepEqual(dry.results[1].job, execute.results[1].job);
  assert.deepEqual(dry.results[1].job.loginUids, ["uid-a", "uid-b"]);
});

test("never trims or collapses Firebase identities", async () => {
  const memory = createMemory({
    documents: [
      claimBacklog("bad", "target", [" uid"]),
      profile("target", ["uid", " uid"]),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.blockedCandidates, [
    {
      entityType: "authClaimSyncBacklog",
      id: "bad",
      reason: "malformed-firebase-uid",
    },
  ]);
  assert.equal(memory.has("authClaimSyncBacklog", "bad"), true);
});

test("blocks a missing canonical target and an unowned UID", async () => {
  const memory = createMemory({
    documents: [
      claimBacklog("missing", "missing-target", ["uid"]),
      claimBacklog("unowned", "target", ["other-uid"]),
      profile("target", ["uid"]),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.deepEqual(
    result.blockedCandidates.map(({ id, reason }) => ({ id, reason })),
    [
      { id: "missing", reason: "missing-canonical-profile" },
      { id: "unowned", reason: "uid-not-owned-by-canonical-profile" },
    ],
  );
});

test("fails closed on merge cycles", async () => {
  const memory = createMemory({
    documents: [
      gameBacklog("merge", "a", "b"),
      profile("a", [], { mergedIntoProfileId: "b" }),
      profile("b", [], { mergedIntoProfileId: "a" }),
      mergeTarget("a", "b"),
      mergeTarget("b", "a"),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.equal(result.blockedCandidates[0].reason, "merge-target-cycle");
  assert.equal(memory.has("authMergeGameBacklog", "merge"), true);
});

test("blocks invalid and conflicting prize assignments", async () => {
  const invalid = createMemory({
    documents: [
      gameBacklog("invalid-prize", "source", "target"),
      profile("source", [], { mergedIntoProfileId: "target" }),
      profile("target"),
      mergeTarget("source", "target"),
    ],
    prizes: {
      source: {
        NN3eRzoZo80: {
          ...prize("source"),
          prizeId: "not-a-prize",
        },
      },
    },
  });
  const invalidResult = await convertLegacyAuthRecoveryPage(
    options(),
    invalid.adapters,
  );
  assert.equal(
    invalidResult.blockedCandidates[0].reason,
    "prize-assignment-invalid",
  );

  const conflict = createMemory({
    documents: [
      gameBacklog("conflict", "source", "target"),
      profile("source", [], { mergedIntoProfileId: "target" }),
      profile("target"),
      mergeTarget("source", "target"),
    ],
    prizes: {
      source: { NN3eRzoZo80: prize("source", { prizeId: "1111" }) },
      target: { NN3eRzoZo80: prize("target", { prizeId: "1092" }) },
    },
  });
  const conflictResult = await convertLegacyAuthRecoveryPage(
    options(),
    conflict.adapters,
  );
  assert.equal(conflictResult.blockedCandidates[0].reason, "prize-conflict");
  assert.equal(conflict.has("authMergeGameBacklog", "conflict"), true);
});

test("accepts an equivalent prize assignment under the canonical profile", async () => {
  const memory = createMemory({
    documents: [
      gameBacklog("merge", "source", "target"),
      profile("source", [], { mergedIntoProfileId: "target" }),
      profile("target"),
      mergeTarget("source", "target"),
    ],
    prizes: {
      source: { NN3eRzoZo80: prize("source") },
      target: { NN3eRzoZo80: prize("target") },
    },
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.results[0].job.sourceProfileIds, ["source"]);
});

test("blocks an oversized combined recovery job", async () => {
  const existingUids = Array.from(
    { length: MAX_JOB_LOGIN_UIDS },
    (_, index) => `uid-${index}`,
  );
  const memory = createMemory({
    documents: [
      claimBacklog("claim", "target", ["new-uid"]),
      profile("target", [...existingUids, "new-uid"]),
      {
        collection: "authRecoveryJobs",
        id: "target",
        data: {
          profileId: "target",
          loginUids: existingUids,
          sourceProfileIds: [],
          sourcePhase: "finalize",
          prizeCursor: null,
          phaseStartedAtMs: 1,
          lastEnqueuedAtMs: 0,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      },
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.equal(result.blockedCandidates[0].reason, "job-too-large");
});

test("retains legacy state for an unsafe profile or malformed job", async () => {
  const unsafe = createMemory({
    documents: [
      profile("unsafe.profile", ["uid"], {
        pendingClaimSyncLogins: ["uid"],
        pendingClaimSyncOpId: "claim",
        pendingClaimSyncUpdatedAtMs: 1,
      }),
    ],
  });
  const unsafeResult = await convertLegacyAuthRecoveryPage(
    options(),
    unsafe.adapters,
  );
  assert.equal(unsafeResult.blockedCandidates[0].reason, "unsafe-profile-id");

  const malformed = createMemory({
    documents: [
      claimBacklog("claim", "target", ["uid"]),
      profile("target", ["uid"]),
      {
        collection: "authRecoveryJobs",
        id: "target",
        data: { profileId: "target", sourcePhase: "unknown" },
      },
    ],
  });
  const malformedResult = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    malformed.adapters,
  );
  assert.equal(
    malformedResult.blockedCandidates[0].reason,
    "existing-job-malformed",
  );
  assert.equal(malformed.has("authClaimSyncBacklog", "claim"), true);
});

test("never rewinds an in-progress recovery job", async () => {
  const memory = createMemory({
    documents: [
      claimBacklog("claim", "target", ["uid"]),
      profile("source", [], { mergedIntoProfileId: "target" }),
      profile("target", ["uid"]),
      mergeTarget("source", "target"),
      {
        collection: "authRecoveryJobs",
        id: "target",
        data: {
          profileId: "target",
          loginUids: [],
          sourceProfileIds: ["source"],
          sourcePhase: "games",
          prizeCursor: "NN3eRzoZo80",
          phaseStartedAtMs: 100,
          lastEnqueuedAtMs: 200,
          createdAtMs: 10,
          updatedAtMs: 100,
        },
      },
    ],
  });
  const before = clone(memory.data("authRecoveryJobs", "target"));
  const result = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    memory.adapters,
  );
  assert.equal(result.blockedCandidates[0].reason, "existing-job-in-progress");
  assert.deepEqual(memory.data("authRecoveryJobs", "target"), before);
  assert.equal(memory.has("authClaimSyncBacklog", "claim"), true);
});

test("groups a chained merge leaf-to-root under the final target", async () => {
  const memory = createMemory({
    documents: [
      gameBacklog("merge-a", "a", "b"),
      profile("a", [], { mergedIntoProfileId: "b" }),
      profile("b", [], { mergedIntoProfileId: "c" }),
      profile("c", ["uid"]),
      mergeTarget("a", "b"),
      mergeTarget("b", "c"),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options(),
    memory.adapters,
  );
  assert.equal(result.complete, true);
  assert.equal(result.results[0].profileId, "c");
  assert.deepEqual(result.results[0].job.sourceProfileIds, ["a", "b"]);
  assert.equal(result.results[0].job.sourcePhase, "prizes");
  assert.equal(result.results[0].job.prizeCursor, null);
});

test("execute atomically creates the job and removes legacy state", async () => {
  const pending = {
    pendingClaimSyncLogins: ["uid"],
    pendingClaimSyncOpId: "claim-op",
    pendingClaimSyncUpdatedAtMs: 10,
    pendingMergeGameCopySourceProfileId: "source",
    pendingMergeGameCopyOpId: "game-op",
    pendingMergeGameCopyUpdatedAtMs: 11,
    pendingMergePrizeCopyCursor: "NN3eRzoZo80",
  };
  const memory = createMemory({
    documents: [
      profile("source", [], { mergedIntoProfileId: "target" }),
      profile("target", ["uid"], pending),
      mergeTarget("source", "target"),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    memory.adapters,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(memory.data("authRecoveryJobs", "target").sourceProfileIds, [
    "source",
  ]);
  for (const field of PENDING_FIELDS) {
    assert.equal(own(memory.data("users", "target"), field), false);
  }

  const failed = createMemory({
    documents: [
      claimBacklog("claim", "target", ["uid"]),
      profile("target", ["uid"]),
    ],
    beforeCommit: async () => {
      throw new ConversionBlocked("concurrent-firestore-change");
    },
  });
  const failedResult = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    failed.adapters,
  );
  assert.equal(failedResult.complete, false);
  assert.equal(failed.has("authClaimSyncBacklog", "claim"), true);
  assert.equal(failed.has("authRecoveryJobs", "target"), false);
});

test("a clean rerun is idempotent", async () => {
  const memory = createMemory({
    documents: [
      claimBacklog("claim", "target", ["uid"]),
      profile("target", ["uid"]),
    ],
  });
  const first = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    memory.adapters,
  );
  const second = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false }),
    memory.adapters,
  );
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(memory.commits(), 1);
  assert.deepEqual(
    second.results.map(({ status }) => status),
    ["clean"],
  );
});

test("safe siblings execute while blockers retain data and the page advances", async () => {
  const memory = createMemory({
    documents: [
      claimBacklog("a-blocked", "missing", ["uid-a"]),
      claimBacklog("b-safe", "target", ["uid-b"]),
      profile("target", ["uid-b"]),
    ],
  });
  const result = await convertLegacyAuthRecoveryPage(
    options({ dryRun: false, limit: 2 }),
    memory.adapters,
  );
  assert.equal(result.complete, false);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  assert.deepEqual(result.blockedCandidates, [
    {
      entityType: "authClaimSyncBacklog",
      id: "a-blocked",
      reason: "missing-canonical-profile",
    },
  ]);
  assert.equal(memory.has("authClaimSyncBacklog", "a-blocked"), true);
  assert.equal(memory.has("authClaimSyncBacklog", "b-safe"), false);
  assert.equal(memory.has("authRecoveryJobs", "target"), true);

  const next = await convertLegacyAuthRecoveryPage(
    options({ after: result.nextCursor, dryRun: false, limit: 2 }),
    memory.adapters,
  );
  assert.notEqual(next.nextCursor, result.nextCursor);
});
