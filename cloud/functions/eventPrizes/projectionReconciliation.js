"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("../firebaseAdmin");
const { readProfileByLoginUid } = require("../profileLookup");
const {
  removeMatchingProfileEventPrizeAssignment,
  resolveCanonicalProfilePath,
} = require("../profileEventPrizeProjection");
const {
  buildWithdrawalCompletionUpdates,
  getWithdrawalProjectionProfileIds,
} = require("../eventPrizeWithdrawalState");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const reconcileCompletedWithdrawalProjections = async ({
  withdrawal,
  profileIds,
  eventId,
  prizeId,
}) => {
  const knownProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds,
  });
  const canonicalProfilePaths = await Promise.all(
    knownProfileIds.map(resolveCanonicalProfilePath),
  );
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds: knownProfileIds.concat(canonicalProfilePaths.flat()),
  });
  await Promise.all(
    projectionProfileIds.map((projectionProfileId) =>
      removeMatchingProfileEventPrizeAssignment({
        targetRef: admin
          .database()
          .ref(`profileEventPrizes/${projectionProfileId}/${eventId}`),
        eventId,
        prizeId,
      }),
    ),
  );
};

const attemptCompletedWithdrawalProjectionReconciliation = async (args) => {
  try {
    await reconcileCompletedWithdrawalProjections(args);
  } catch (error) {
    console.warn("event-prize-withdrawal-projection-cleanup-failed", {
      eventId: args.eventId,
      prizeId: args.prizeId,
      errorType: normalizeString(error?.name) || "Error",
    });
  }
};

const finalizeWithdrawal = async ({
  withdrawal,
  profileId,
  eventId,
  prizeId,
  assetAddress,
  recipientAddress,
  transactionSignature,
}) => {
  const requesterUid = normalizeString(withdrawal.requesterUid);
  if (!requesterUid) {
    throw new HttpsError(
      "failed-precondition",
      "The prize profile could not be verified.",
    );
  }
  let canonicalProfileId = normalizeString(profileId);
  try {
    const canonicalProfileSnapshot = await readProfileByLoginUid(
      requesterUid,
      [],
    );
    canonicalProfileId =
      normalizeString(canonicalProfileSnapshot?.id) || canonicalProfileId;
  } catch {
    console.warn("event-prize-withdrawal-profile-refresh-failed", {
      eventId,
      prizeId,
      profileId: canonicalProfileId,
    });
  }
  if (!canonicalProfileId) {
    throw new HttpsError("internal", "The prize profile is unavailable.");
  }
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds: [profileId, canonicalProfileId],
  });
  const completedAtMs = Date.now();
  const { completed, updates } = buildWithdrawalCompletionUpdates({
    withdrawal,
    profileId: canonicalProfileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature,
    completedAtMs,
  });
  await admin.database().ref().update(updates);
  await attemptCompletedWithdrawalProjectionReconciliation({
    withdrawal: completed,
    profileIds: projectionProfileIds,
    eventId,
    prizeId,
  });
  return completed;
};

module.exports = {
  attemptCompletedWithdrawalProjectionReconciliation,
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
};
