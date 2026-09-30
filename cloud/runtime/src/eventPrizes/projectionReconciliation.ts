import type {
  WithdrawalData,
  WithdrawalCompletionInput,
  WithdrawalProjectionDependencies,
  WithdrawalCompletionDependencies,
} from "./types.js";

import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import {
  buildWithdrawalCompletion,
  getWithdrawalProjectionProfileIds,
} from "../eventPrizeWithdrawalState.js";

type ProjectionReconciliationInput = {
  withdrawal: WithdrawalData;
  profileIds?: readonly string[];
  eventId: string;
  prizeId: string;
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const reconcileCompletedWithdrawalProjections = async (
  { withdrawal, profileIds, eventId, prizeId }: ProjectionReconciliationInput,
  dependencies: WithdrawalProjectionDependencies,
) => {
  const {
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
        profileId: projectionProfileId,
        eventId,
        prizeId,
      }),
    ),
  );
};

const attemptCompletedWithdrawalProjectionReconciliation = async (
  args: ProjectionReconciliationInput,
  dependencies: WithdrawalProjectionDependencies,
) => {
  try {
    await reconcileCompletedWithdrawalProjections(args, dependencies);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "event_prize_withdrawal_projection_cleanup_failed",
        eventId: args.eventId,
        prizeId: args.prizeId,
        errorType:
          normalizeString(
            (error as { name?: unknown } | null | undefined)?.name,
          ) || "Error",
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
  }: WithdrawalCompletionInput,
  dependencies: WithdrawalCompletionDependencies,
) => {
  const { withdrawals, readProfileByLoginUid } = dependencies;
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
  const completed = buildWithdrawalCompletion({
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

export {
  attemptCompletedWithdrawalProjectionReconciliation,
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
};
