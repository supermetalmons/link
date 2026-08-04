"use strict";

const { onValueWritten } = require("firebase-functions/v2/database");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const {
  copyProfileEventPrizeAssignment,
  copyProfileEventPrizesToCanonicalTarget,
  removeProfileEventPrizeAssignmentIfWithdrawalCompleted,
  resolveProfileEventPrizeOwnerId,
} = require("./profileEventPrizeProjection");
const {
  PROFILE_MERGE_TARGETS_COLLECTION,
  getProfileMergeTargetId,
} = require("./profileMergeTargets");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const onProfileEventPrizeWritten = onValueWritten(
  {
    ref: "/profileEventPrizes/{profileId}/{eventId}",
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    retry: true,
  },
  async (event) => {
    if (!event.data.after.exists()) {
      return;
    }
    const sourceProfileId = normalizeString(event.params.profileId);
    const eventId = normalizeString(event.params.eventId);
    if (!sourceProfileId || !eventId) {
      return;
    }
    const sourceAssignment = event.data.after.val();
    if (
      await removeProfileEventPrizeAssignmentIfWithdrawalCompleted({
        profileId: sourceProfileId,
        eventId,
        assignment: sourceAssignment,
      })
    ) {
      return;
    }
    const targetProfileId = await resolveProfileEventPrizeOwnerId({
      profileId: sourceProfileId,
      eventId,
    });
    if (!targetProfileId || targetProfileId === sourceProfileId) {
      return;
    }
    await copyProfileEventPrizeAssignment({
      sourceProfileId,
      targetProfileId,
      eventId,
      sourceAssignment,
    });
  },
);

const onProfileMergeTargetWritten = onDocumentWritten(
  {
    document: `${PROFILE_MERGE_TARGETS_COLLECTION}/{sourceProfileId}`,
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    retry: true,
  },
  async (event) => {
    const sourceProfileId = normalizeString(event.params.sourceProfileId);
    const beforeTargetProfileId = event.data?.before?.exists
      ? getProfileMergeTargetId(event.data.before.data())
      : "";
    const afterTargetProfileId = event.data?.after?.exists
      ? getProfileMergeTargetId(event.data.after.data())
      : "";
    if (
      !sourceProfileId ||
      !afterTargetProfileId ||
      afterTargetProfileId === beforeTargetProfileId
    ) {
      return;
    }
    await copyProfileEventPrizesToCanonicalTarget(sourceProfileId);
  },
);

module.exports = {
  onProfileEventPrizeWritten,
  onProfileMergeTargetWritten,
};
