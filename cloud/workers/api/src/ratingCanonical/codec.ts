import {
  createEmptyRatingPayload,
  parseCanonicalRatingPayload,
} from "../profileCanonical/contracts.ts";
import type { canonicalRatingProjectionFields } from "../profileCanonical/accountingRecords.ts";
import {
  parseCanonicalRatingUpdateRow,
  ratingWriteRow,
} from "../profileCanonical/accountingRecords.ts";
import type {
  CanonicalRatingUpdateSnapshot,
  CanonicalRatingUpdateValue,
  CanonicalProfileSnapshot,
} from "../profileCanonical/types.ts";
import type {
  RatingProfile,
  RatingUpdateData,
  RatingCompletionPatch,
  RatingLeaseInput,
} from "../ratingStateContracts.ts";

export function ratingProfileFromSnapshot(
  value: {
    profile: Pick<
      CanonicalProfileSnapshot,
      "profile" | "gameplayEmoji" | "sortPresence" | "sortValues"
    >;
  } | null,
): RatingProfile | null {
  if (!value) return null;
  const snapshot = value.profile,
    profile = snapshot.profile;
  return {
    aura: profile.aura,
    emoji: snapshot.gameplayEmoji,
    eth: profile.eth ?? "",
    sol: profile.sol ?? "",
    username: profile.username ?? "",
    nonce: snapshot.sortPresence.nonce ? (snapshot.sortValues.nonce ?? 0) : -1,
    profileId: profile.id,
    rating:
      snapshot.sortPresence.rating && snapshot.sortValues.rating !== null
        ? snapshot.sortValues.rating
        : 1500,
    totalManaPoints: profile.totalManaPoints,
  };
}

export function ratingData(
  snapshot: CanonicalRatingUpdateSnapshot,
): RatingUpdateData {
  const fields = snapshot.payload;
  return {
    completedAtMs: snapshot.completedAtMs,
    eventId: fields.eventId,
    eventOwned: fields.eventOwned,
    eventProgressReason: fields.eventProgressReason,
    eventProgressState: snapshot.eventProgressState,
    eventProgressUpdatedAtMs: snapshot.eventProgressUpdatedAtMs,
    eventProgressVersion: snapshot.eventProgressVersion,
    historicalMatchArchiveVersion:
      fields.historicalMatchPair === null ? null : 1,
    inviteId: snapshot.inviteId,
    historicalMatchPair: fields.historicalMatchPair,
    isEventMatch: fields.isEventMatch,
    leaseExpiresAtMs: snapshot.leaseExpiresAtMs,
    matchId: snapshot.matchId,
    opponentId: snapshot.opponentId,
    opponentManaPoints: fields.opponentManaPoints,
    opponentProfileId: snapshot.opponentProfileId,
    ownerToken: snapshot.ownerToken,
    playerId: snapshot.playerId,
    playerManaPoints: fields.playerManaPoints,
    playerProfileId: snapshot.playerProfileId,
    profileGameProjectionReason: fields.profileGameProjectionReason,
    profileGameProjectionState: snapshot.profileGameProjectionState,
    profileGameProjectionUpdatedAtMs: snapshot.profileGameProjectionUpdatedAtMs,
    profileGameProjectionVersion: snapshot.profileGameProjectionVersion,
    shouldUpdateFebruaryChallenge: fields.shouldUpdateFebruaryChallenge,
    startedAtMs: snapshot.startedAtMs,
    status: snapshot.status,
    telegramDeliveryVersion: fields.telegramDeliveryVersion,
    telegramProjectionReason: fields.telegramProjectionReason,
    telegramProjectionState: snapshot.telegramProjectionState,
    telegramProjectionUpdatedAtMs: snapshot.telegramProjectionUpdatedAtMs,
    telegramProjectionVersion: snapshot.telegramProjectionVersion,
    updateRatingMessage: fields.updateRatingMessage,
  };
}

export function validateRatingValue(
  value: CanonicalRatingUpdateValue,
): CanonicalRatingUpdateValue {
  const { revision: _revision, ...validated } = parseCanonicalRatingUpdateRow({
    ...ratingWriteRow(value),
    revision: 1,
  });
  return validated;
}

export function mergedRatingValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  patch: RatingCompletionPatch,
): CanonicalRatingUpdateValue {
  if (snapshot.status !== "processing")
    throw new TypeError("invalid-canonical-rating-completion");
  const prior = snapshot.payload;
  const value: CanonicalRatingUpdateValue = {
    ...snapshot,
    status: "done",
    completedAtMs: patch.completedAtMs,
    blockedAtMs: null,
    blockReason: null,
    updatedAtMs: patch.updatedAtMs,
    leaseExpiresAtMs: patch.leaseExpiresAtMs,
    inviteId: patch.inviteId ?? snapshot.inviteId,
    matchId: patch.matchId ?? snapshot.matchId,
    playerId: patch.playerId ?? snapshot.playerId,
    opponentId: patch.opponentId ?? snapshot.opponentId,
    playerProfileId:
      patch.playerProfileId === undefined
        ? snapshot.playerProfileId
        : patch.playerProfileId || null,
    opponentProfileId:
      patch.opponentProfileId === undefined
        ? snapshot.opponentProfileId
        : patch.opponentProfileId || null,
    profileGameProjectionState: patch.profileGameProjectionState ?? null,
    profileGameProjectionUpdatedAtMs:
      patch.profileGameProjectionUpdatedAtMs ?? null,
    profileGameProjectionVersion: patch.profileGameProjectionVersion ?? null,
    telegramProjectionState: patch.telegramProjectionState ?? null,
    telegramProjectionUpdatedAtMs: patch.telegramProjectionUpdatedAtMs ?? null,
    telegramProjectionVersion: patch.telegramProjectionVersion ?? null,
    eventProgressState: patch.eventProgressState ?? null,
    eventProgressUpdatedAtMs: patch.eventProgressUpdatedAtMs ?? null,
    eventProgressVersion: patch.eventProgressVersion ?? null,
    payload: parseCanonicalRatingPayload({
      schemaVersion: 1,
      eventId: patch.eventId === undefined ? prior.eventId : patch.eventId,
      eventOwned: patch.eventOwned ?? prior.eventOwned,
      isEventMatch: patch.isEventMatch ?? prior.isEventMatch,
      result: patch.result ?? prior.result,
      canUpdateRatings: patch.canUpdateRatings ?? prior.canUpdateRatings,
      didApplyRatingDelta:
        patch.didApplyRatingDelta ?? prior.didApplyRatingDelta,
      winnerDisplayName: patch.winnerDisplayName ?? prior.winnerDisplayName,
      loserDisplayName: patch.loserDisplayName ?? prior.loserDisplayName,
      winnerNewRating:
        patch.winnerNewRating === undefined
          ? prior.winnerNewRating
          : patch.winnerNewRating,
      loserNewRating:
        patch.loserNewRating === undefined
          ? prior.loserNewRating
          : patch.loserNewRating,
      playerManaPoints: patch.playerManaPoints ?? prior.playerManaPoints,
      opponentManaPoints: patch.opponentManaPoints ?? prior.opponentManaPoints,
      shouldUpdateFebruaryChallenge:
        patch.shouldUpdateFebruaryChallenge ??
        prior.shouldUpdateFebruaryChallenge,
      updateRatingMessage:
        patch.updateRatingMessage ?? prior.updateRatingMessage,
      telegramDeliveryVersion:
        patch.telegramDeliveryVersion === undefined
          ? prior.telegramDeliveryVersion
          : patch.telegramDeliveryVersion,
      historicalMatchPair:
        patch.historicalMatchPair ?? prior.historicalMatchPair,
      profileGameProjectionReason: patch.profileGameProjectionReason ?? null,
      telegramProjectionReason: patch.telegramProjectionReason ?? null,
      eventProgressReason: patch.eventProgressReason ?? null,
    }),
  };
  return validateRatingValue(value);
}

type RatingProjectionFields = ReturnType<
  typeof canonicalRatingProjectionFields
>;

export function claimedRatingProjectionValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  fields: RatingProjectionFields,
  claimedAtMs: number,
): CanonicalRatingUpdateValue {
  if (snapshot.status !== "done" || snapshot[fields.state] !== "pending")
    throw new TypeError("rating-projection-not-pending");
  return validateRatingValue({ ...snapshot, [fields.updated]: claimedAtMs });
}

export function markedRatingProjectionValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  fields: RatingProjectionFields,
  state: "dead" | "done",
  updatedAtMs: number,
  reason: string | undefined,
): CanonicalRatingUpdateValue {
  if (snapshot.status !== "done" || snapshot[fields.state] === "cancelled")
    throw new TypeError("rating-projection-unavailable");
  return validateRatingValue({
    ...snapshot,
    [fields.state]: state,
    [fields.updated]: updatedAtMs,
    payload: { ...snapshot.payload, [fields.reason]: reason ?? null },
  });
}

export function ratingLeaseValue(
  snapshot: CanonicalRatingUpdateSnapshot | null,
  input: RatingLeaseInput,
  attemptNowMs: number,
): CanonicalRatingUpdateValue {
  if (snapshot !== null && snapshot.status !== "processing")
    throw new TypeError("rating-operation-not-retryable");
  return validateRatingValue({
    operationId: `${input.inviteId}__${input.matchId}`,
    inviteId: input.inviteId,
    matchId: input.matchId,
    playerId: input.playerId,
    opponentId: input.opponentId,
    playerProfileId: snapshot?.playerProfileId ?? null,
    opponentProfileId: snapshot?.opponentProfileId ?? null,
    ownerUid: input.ownerUid,
    ownerToken: input.ownerToken,
    status: "processing",
    startedAtMs: snapshot?.startedAtMs ?? attemptNowMs,
    updatedAtMs: attemptNowMs,
    leaseExpiresAtMs: attemptNowMs + input.leaseMs,
    completedAtMs: null,
    blockedAtMs: null,
    blockReason: null,
    payload: snapshot?.payload ?? createEmptyRatingPayload(),
    profileGameProjectionState: null,
    profileGameProjectionUpdatedAtMs: null,
    profileGameProjectionVersion: null,
    telegramProjectionState: null,
    telegramProjectionUpdatedAtMs: null,
    telegramProjectionVersion: null,
    eventProgressState: null,
    eventProgressUpdatedAtMs: null,
    eventProgressVersion: null,
  });
}
