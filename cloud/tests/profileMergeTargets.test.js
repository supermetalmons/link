"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getProfileMergeTargetId,
  orderProfileMergeCleanupIds,
  resolveProfileMergeTargetId,
  resolveProfileMergeTargetPath,
} = require("../functions/profileMergeTargets");

const resolveFrom = (profileId, targets, options = {}) =>
  resolveProfileMergeTargetId({
    profileId,
    readMergeTarget: async (candidateProfileId) =>
      targets[candidateProfileId] || null,
    ...options,
  });

const resolvePathFrom = (profileId, targets, options = {}) =>
  resolveProfileMergeTargetPath({
    profileId,
    readMergeTarget: async (candidateProfileId) =>
      targets[candidateProfileId] || null,
    ...options,
  });

test("reads merge targets from stored records", () => {
  assert.equal(
    getProfileMergeTargetId({ targetProfileId: " target " }),
    "target",
  );
  assert.equal(getProfileMergeTargetId("target"), "target");
  assert.equal(getProfileMergeTargetId({ targetProfileId: "" }), "");
});

test("keeps profiles without a merge target unchanged", async () => {
  assert.equal(await resolveFrom("source", {}), "source");
  assert.deepEqual(await resolvePathFrom("source", {}), ["source"]);
});

test("resolves chained profile merges to the final target", async () => {
  assert.equal(
    await resolveFrom("source", {
      source: { targetProfileId: "middle" },
      middle: { targetProfileId: "target" },
    }),
    "target",
  );
  assert.equal(
    await resolveFrom(
      "source",
      {
        source: { targetProfileId: "middle" },
        middle: { targetProfileId: "target" },
      },
      { maxHops: 2 },
    ),
    "target",
  );
});

test("returns every profile in a chained merge", async () => {
  assert.deepEqual(
    await resolvePathFrom(
      "source",
      {
        source: { targetProfileId: "middle" },
        middle: { targetProfileId: "target" },
      },
      { maxHops: 2 },
    ),
    ["source", "middle", "target"],
  );
});

test("orders merge sources before canonical projection owners", () => {
  assert.deepEqual(
    orderProfileMergeCleanupIds(
      ["target", "source", "older-source", "target"],
      ["target"],
    ),
    ["source", "older-source", "target"],
  );
});

test("returns an empty merge path for an invalid profile", async () => {
  assert.deepEqual(await resolvePathFrom(" ", {}), []);
});

test("rejects cyclic profile merge targets", async () => {
  const targets = {
    source: { targetProfileId: "target" },
    target: { targetProfileId: "source" },
  };
  await assert.rejects(
    resolveFrom("source", targets),
    /profile-merge-target-cycle/,
  );
  await assert.rejects(
    resolvePathFrom("source", targets),
    /profile-merge-target-cycle/,
  );
});

test("rejects merge target chains beyond the configured limit", async () => {
  const targets = {
    source: { targetProfileId: "middle" },
    middle: { targetProfileId: "target" },
  };
  await assert.rejects(
    resolveFrom("source", targets, { maxHops: 1 }),
    /profile-merge-target-depth-exceeded/,
  );
  await assert.rejects(
    resolvePathFrom("source", targets, { maxHops: 1 }),
    /profile-merge-target-depth-exceeded/,
  );
});
