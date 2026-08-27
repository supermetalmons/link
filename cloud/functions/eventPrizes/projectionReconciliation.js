"use strict";

const { EventPrizeWithdrawalError: HttpsError } = require("./errors");
const {
  buildWithdrawalCompletionUpdates,
  getWithdrawalProjectionProfileIds,
} = require("../eventPrizeWithdrawalState");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const reconcileCompletedWithdrawalProjections = async (
  { withdrawal, profileIds, eventId, prizeId },
  dependencies,
) => {
  const {
    admin,
    removeMatchingProfileEventPrizeAssignment,
    resolveCanonicalProfilePath,
  } = dependencies;
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

const attemptCompletedWithdrawalProjectionReconciliation = async (
  args,
  dependencies,
) => {
  try {
    await reconcileCompletedWithdrawalProjections(args, dependencies);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "event_prize_withdrawal_projection_cleanup_failed",
        eventId: args.eventId,
        prizeId: args.prizeId,
        errorType: normalizeString(error?.name) || "Error",
      }),
    );
  }
};

const finalizeWithdrawal = async (
  {
    withdrawal,
    profileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature,
  },
  dependencies,
) => {
  const { admin, readProfileByLoginUid } = dependencies;
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
    console.warn(
      JSON.stringify({
        event: "event_prize_withdrawal_profile_refresh_failed",
        eventId,
        prizeId,
        profileId: canonicalProfileId,
      }),
    );
  }
  if (!canonicalProfileId) {
    throw new HttpsError("internal", "The prize profile is unavailable.");
  }
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds: [profileId, canonicalProfileId],
  });
  const completedAtMs = (dependencies.now || Date.now)();
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
  await reconcileCompletedWithdrawalProjections(
    {
      withdrawal: completed,
      profileIds: projectionProfileIds,
      eventId,
      prizeId,
    },
    dependencies,
  );
  return completed;
};

module.exports = {
  attemptCompletedWithdrawalProjectionReconciliation,
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
};
