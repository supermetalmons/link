// Generated from src/eventPrizes/projectionReconciliation.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileCompletedWithdrawalProjections =
  exports.finalizeWithdrawal =
  exports.attemptCompletedWithdrawalProjectionReconciliation =
    void 0;
const errors_js_1 = require("./errors.js");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const reconcileCompletedWithdrawalProjections = async (
  { withdrawal, profileIds, eventId, prizeId },
  dependencies,
) => {
  const {
    removeMatchingProfileEventPrizeAssignment,
    resolveCanonicalProfilePath,
  } = dependencies;
  const knownProfileIds = (0,
  eventPrizeWithdrawalState_js_1.getWithdrawalProjectionProfileIds)({
    withdrawal,
    profileIds,
  });
  const canonicalProfilePaths = await Promise.all(
    knownProfileIds.map(resolveCanonicalProfilePath),
  );
  const projectionProfileIds = (0,
  eventPrizeWithdrawalState_js_1.getWithdrawalProjectionProfileIds)({
    withdrawal,
    profileIds: knownProfileIds.concat(canonicalProfilePaths.flat()),
  });
  await Promise.all(
    projectionProfileIds.map((projectionProfileId) =>
      removeMatchingProfileEventPrizeAssignment({
        profileId: projectionProfileId,
        eventId,
        prizeId,
      }),
    ),
  );
};
exports.reconcileCompletedWithdrawalProjections =
  reconcileCompletedWithdrawalProjections;
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
exports.attemptCompletedWithdrawalProjectionReconciliation =
  attemptCompletedWithdrawalProjectionReconciliation;
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
  const { withdrawals, readProfileByLoginUid } = dependencies;
  const requesterUid = normalizeString(withdrawal.requesterUid);
  if (!requesterUid) {
    throw new errors_js_1.EventPrizeWithdrawalError(
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
    throw new errors_js_1.EventPrizeWithdrawalError(
      "internal",
      "The prize profile is unavailable.",
    );
  }
  const projectionProfileIds = (0,
  eventPrizeWithdrawalState_js_1.getWithdrawalProjectionProfileIds)({
    withdrawal,
    profileIds: [profileId, canonicalProfileId],
  });
  const completedAtMs = (dependencies.now || Date.now)();
  const completed = (0,
  eventPrizeWithdrawalState_js_1.buildWithdrawalCompletion)({
    withdrawal,
    profileId: canonicalProfileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature,
    completedAtMs,
  });
  await withdrawals.replaceRecords([{ eventId, prizeId, value: completed }]);
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
exports.finalizeWithdrawal = finalizeWithdrawal;
