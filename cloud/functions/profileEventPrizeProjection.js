"use strict";

const admin = require("./firebaseAdmin");
const { buildProfileEventPrizeMergeCopies } = require("./eventPrizeAwards");
const {
  PROFILE_MERGE_TARGETS_COLLECTION,
  resolveProfileMergeTargetId,
} = require("./profileMergeTargets");
const { readProfileByLoginUid } = require("./profileLookup");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const resolveCanonicalProfileId = async (profileId) => {
  const firestore = admin.firestore();
  return resolveProfileMergeTargetId({
    profileId,
    readMergeTarget: async (candidateProfileId) => {
      const snapshot = await firestore
        .collection(PROFILE_MERGE_TARGETS_COLLECTION)
        .doc(candidateProfileId)
        .get();
      return snapshot.exists ? snapshot.data() : null;
    },
  });
};

const resolveProfileEventPrizeOwnerId = async ({ profileId, eventId }) => {
  const normalizedProfileId = normalizeString(profileId);
  const normalizedEventId = normalizeString(eventId);
  if (!normalizedProfileId) {
    return "";
  }
  const mappedProfileId = await resolveCanonicalProfileId(normalizedProfileId);
  if (mappedProfileId && mappedProfileId !== normalizedProfileId) {
    return mappedProfileId;
  }
  if (!normalizedEventId) {
    return normalizedProfileId;
  }

  const participantSnapshot = await admin
    .database()
    .ref(`events/${normalizedEventId}/participants/${normalizedProfileId}`)
    .once("value");
  const participant = participantSnapshot.val();
  const loginUid = normalizeString(participant?.loginUid);
  if (!loginUid) {
    return normalizedProfileId;
  }
  const currentProfileSnapshot = await readProfileByLoginUid(loginUid, []);
  return normalizeString(currentProfileSnapshot?.id) || normalizedProfileId;
};

const copyProfileEventPrizeAssignment = async ({
  sourceProfileId,
  targetProfileId,
  eventId,
  sourceAssignment,
}) => {
  const normalizedSourceProfileId = normalizeString(sourceProfileId);
  const normalizedTargetProfileId = normalizeString(targetProfileId);
  const normalizedEventId = normalizeString(eventId);
  if (
    !normalizedSourceProfileId ||
    !normalizedTargetProfileId ||
    !normalizedEventId ||
    normalizedSourceProfileId === normalizedTargetProfileId
  ) {
    return false;
  }
  const copies = buildProfileEventPrizeMergeCopies({
    targetProfileId: normalizedTargetProfileId,
    sourceProfileId: normalizedSourceProfileId,
    targetPrizes: {},
    sourcePrizes: { [normalizedEventId]: sourceAssignment },
  });
  const copy = copies[normalizedEventId];
  if (!copy) {
    return false;
  }

  const result = await admin
    .database()
    .ref(`profileEventPrizes/${normalizedTargetProfileId}/${normalizedEventId}`)
    .transaction((currentAssignment) => {
      const currentCopies = buildProfileEventPrizeMergeCopies({
        targetProfileId: normalizedTargetProfileId,
        sourceProfileId: normalizedSourceProfileId,
        targetPrizes: currentAssignment
          ? { [normalizedEventId]: currentAssignment }
          : {},
        sourcePrizes: { [normalizedEventId]: sourceAssignment },
      });
      return currentCopies[normalizedEventId];
    });
  return result.committed === true;
};

const copyProfileEventPrizes = async ({ sourceProfileId, targetProfileId }) => {
  const normalizedSourceProfileId = normalizeString(sourceProfileId);
  const normalizedTargetProfileId = normalizeString(targetProfileId);
  if (
    !normalizedSourceProfileId ||
    !normalizedTargetProfileId ||
    normalizedSourceProfileId === normalizedTargetProfileId
  ) {
    return 0;
  }
  const sourceSnapshot = await admin
    .database()
    .ref(`profileEventPrizes/${normalizedSourceProfileId}`)
    .once("value");
  const sourcePrizes = sourceSnapshot.val();
  const copies = buildProfileEventPrizeMergeCopies({
    targetProfileId: normalizedTargetProfileId,
    sourceProfileId: normalizedSourceProfileId,
    targetPrizes: {},
    sourcePrizes,
  });
  const results = await Promise.all(
    Object.keys(copies).map((eventId) =>
      copyProfileEventPrizeAssignment({
        sourceProfileId: normalizedSourceProfileId,
        targetProfileId: normalizedTargetProfileId,
        eventId,
        sourceAssignment: sourcePrizes[eventId],
      }),
    ),
  );
  return results.filter(Boolean).length;
};

const copyProfileEventPrizesToCanonicalTarget = async (sourceProfileId) => {
  const normalizedSourceProfileId = normalizeString(sourceProfileId);
  if (!normalizedSourceProfileId) {
    return { copiedCount: 0, targetProfileId: "" };
  }
  const targetProfileId = await resolveCanonicalProfileId(
    normalizedSourceProfileId,
  );
  if (!targetProfileId || targetProfileId === normalizedSourceProfileId) {
    return { copiedCount: 0, targetProfileId };
  }
  const copiedCount = await copyProfileEventPrizes({
    sourceProfileId: normalizedSourceProfileId,
    targetProfileId,
  });
  return { copiedCount, targetProfileId };
};

module.exports = {
  copyProfileEventPrizeAssignment,
  copyProfileEventPrizes,
  copyProfileEventPrizesToCanonicalTarget,
  resolveCanonicalProfileId,
  resolveProfileEventPrizeOwnerId,
};
