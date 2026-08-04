"use strict";

const PROFILE_MERGE_TARGETS_COLLECTION = "profileMergeTargets";
const MAX_PROFILE_MERGE_TARGET_HOPS = 32;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const getProfileMergeTargetId = (value) => {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return normalizeString(value.targetProfileId);
};

const resolveProfileMergeTargetPath = async ({
  profileId,
  readMergeTarget,
  maxHops = MAX_PROFILE_MERGE_TARGET_HOPS,
}) => {
  let currentProfileId = normalizeString(profileId);
  if (!currentProfileId) {
    return [];
  }
  if (typeof readMergeTarget !== "function") {
    throw new Error("profile-merge-target-reader-required");
  }

  const profileIds = [];
  const visitedProfileIds = new Set();
  const normalizedMaxHops = Math.max(1, Math.floor(Number(maxHops)) || 1);
  let followedTargets = 0;
  while (true) {
    if (visitedProfileIds.has(currentProfileId)) {
      throw new Error("profile-merge-target-cycle");
    }
    visitedProfileIds.add(currentProfileId);
    profileIds.push(currentProfileId);
    const nextProfileId = getProfileMergeTargetId(
      await readMergeTarget(currentProfileId),
    );
    if (!nextProfileId) {
      return profileIds;
    }
    followedTargets += 1;
    if (followedTargets > normalizedMaxHops) {
      throw new Error("profile-merge-target-depth-exceeded");
    }
    currentProfileId = nextProfileId;
  }
};

const resolveProfileMergeTargetId = async (options) => {
  const profileIds = await resolveProfileMergeTargetPath(options);
  return profileIds[profileIds.length - 1] || "";
};

module.exports = {
  MAX_PROFILE_MERGE_TARGET_HOPS,
  PROFILE_MERGE_TARGETS_COLLECTION,
  getProfileMergeTargetId,
  resolveProfileMergeTargetId,
  resolveProfileMergeTargetPath,
};
