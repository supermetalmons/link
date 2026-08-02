"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getProfileMergeTargetId,
  resolveProfileMergeTargetId,
} = require("../functions/profileMergeTargets");

const resolveFrom = (profileId, targets, options = {}) =>
  resolveProfileMergeTargetId({
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

test("rejects cyclic profile merge targets", async () => {
  await assert.rejects(
    resolveFrom("source", {
      source: { targetProfileId: "target" },
      target: { targetProfileId: "source" },
    }),
    /profile-merge-target-cycle/,
  );
});

test("rejects merge target chains beyond the configured limit", async () => {
  await assert.rejects(
    resolveFrom(
      "source",
      {
        source: { targetProfileId: "middle" },
        middle: { targetProfileId: "target" },
      },
      { maxHops: 1 },
    ),
    /profile-merge-target-depth-exceeded/,
  );
});
