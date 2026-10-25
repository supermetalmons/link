import {
  retainCanonicalRatingPayload,
  type CanonicalRatingPayloadDocument,
} from "../profileCanonical/retainedRecords.ts";
import type { canonicalRatingProjectionFields } from "../profileCanonical/accounting.ts";
import {
  isHistoricalMatchPair,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
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
} from "../ratingContracts.ts";

function payloadFields(
  value: CanonicalRatingPayloadDocument,
): Record<string, unknown> {
  const retained: unknown = value;
  return retained as Record<string, unknown>;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableProfileId(value: unknown): string | null {
  return string(value) || null;
}

function projectionState(value: unknown): "dead" | "done" | "pending" | null {
  return value === "dead" || value === "done" || value === "pending"
    ? value
    : null;
}

function projectionVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

export function ratingProfileFromSnapshot(
  value: {
    profile: Pick<
      CanonicalProfileSnapshot,
      "profile" | "gameplayEmoji" | "sortPresence" | "sortValues"
    >;
  } | null,
): RatingProfile | null {
  if (!value) return null;
  const snapshot = value.profile;
  const profile = snapshot.profile;
  return {
    aura: profile.aura || "",
    emoji: snapshot.gameplayEmoji,
    eth: profile.eth || "",
    nonce: snapshot.sortPresence.nonce ? (snapshot.sortValues.nonce ?? 0) : -1,
    profileId: profile.id,
    rating:
      snapshot.sortPresence.rating && snapshot.sortValues.rating !== null
        ? snapshot.sortValues.rating
        : 1500,
    sol: profile.sol || "",
    totalManaPoints: profile.totalManaPoints,
    username: profile.username || "",
  };
}

export function ratingData(
  snapshot: CanonicalRatingUpdateSnapshot,
): RatingUpdateData {
  const fields = payloadFields(snapshot.payload);
  const historicalMatchArchiveVersion = Object.hasOwn(
    fields,
    "historicalMatchArchiveVersion",
  )
    ? typeof fields.historicalMatchArchiveVersion === "number" &&
      Number.isSafeInteger(fields.historicalMatchArchiveVersion)
      ? fields.historicalMatchArchiveVersion
      : -1
    : undefined;
  const historicalMatchPair: HistoricalMatchPair | undefined =
    isHistoricalMatchPair(fields.historicalMatchPair)
      ? fields.historicalMatchPair
      : undefined;
  return {
    completedAtMs: number(fields.completedAtMs),
    eventId: string(fields.eventId),
    eventOwned: fields.eventOwned === true,
    eventProgressReason: string(fields.eventProgressReason),
    eventProgressState: string(fields.eventProgressState),
    eventProgressUpdatedAtMs: number(fields.eventProgressUpdatedAtMs),
    eventProgressVersion: number(fields.eventProgressVersion),
    ...(historicalMatchArchiveVersion === undefined
      ? {}
      : { historicalMatchArchiveVersion }),
    inviteId: string(fields.inviteId) || snapshot.inviteId,
    ...(historicalMatchPair ? { historicalMatchPair } : {}),
    isEventMatch: fields.isEventMatch === true,
    leaseExpiresAtMs: snapshot.leaseExpiresAtMs,
    matchId: string(fields.matchId) || snapshot.matchId,
    opponentId: string(fields.opponentId) || snapshot.opponentId,
    ...(typeof fields.opponentManaPoints === "number" &&
    Number.isFinite(fields.opponentManaPoints)
      ? { opponentManaPoints: fields.opponentManaPoints }
      : {}),
    opponentProfileId:
      string(fields.opponentProfileId) || snapshot.opponentProfileId || "",
    ownerToken: string(fields.ownerToken) || snapshot.ownerToken,
    playerId: string(fields.playerId) || snapshot.playerId,
    ...(typeof fields.playerManaPoints === "number" &&
    Number.isFinite(fields.playerManaPoints)
      ? { playerManaPoints: fields.playerManaPoints }
      : {}),
    playerProfileId:
      string(fields.playerProfileId) || snapshot.playerProfileId || "",
    profileGameProjectionReason: string(fields.profileGameProjectionReason),
    profileGameProjectionState:
      string(fields.profileGameProjectionState) ||
      snapshot.profileGameProjectionState ||
      "",
    profileGameProjectionUpdatedAtMs:
      snapshot.profileGameProjectionUpdatedAtMs || 0,
    profileGameProjectionVersion: snapshot.profileGameProjectionVersion || 0,
    shouldUpdateFebruaryChallenge:
      fields.shouldUpdateFebruaryChallenge === true,
    startedAtMs: snapshot.startedAtMs,
    status: snapshot.status,
    telegramDeliveryVersion:
      number(fields.telegramDeliveryVersion) > 0
        ? number(fields.telegramDeliveryVersion)
        : null,
    telegramProjectionReason: string(fields.telegramProjectionReason),
    telegramProjectionState:
      string(fields.telegramProjectionState) ||
      snapshot.telegramProjectionState ||
      "",
    telegramProjectionUpdatedAtMs: snapshot.telegramProjectionUpdatedAtMs || 0,
    telegramProjectionVersion: snapshot.telegramProjectionVersion || 0,
    updateRatingMessage: string(fields.updateRatingMessage),
  };
}

export function ratingValue(
  operationId: string,
  document: CanonicalRatingPayloadDocument,
): CanonicalRatingUpdateValue {
  const fields = payloadFields(document);
  const status = fields.status === "done" ? "done" : "processing";
  const startedAtMs = number(fields.startedAtMs);
  const completedAtMs =
    status === "done" ? nullableNumber(fields.completedAtMs) : null;
  if (status === "done" && completedAtMs === null) {
    throw new TypeError("invalid-canonical-rating-completion");
  }
  return {
    operationId,
    payload: document,
    status,
    inviteId: string(fields.inviteId),
    matchId: string(fields.matchId),
    playerId: string(fields.playerId),
    opponentId: string(fields.opponentId),
    playerProfileId: nullableProfileId(fields.playerProfileId),
    opponentProfileId: nullableProfileId(fields.opponentProfileId),
    ownerUid: string(fields.ownerUid),
    ownerToken: string(fields.ownerToken),
    startedAtMs,
    updatedAtMs: number(fields.updatedAtMs),
    leaseExpiresAtMs: number(fields.leaseExpiresAtMs),
    completedAtMs,
    telegramProjectionState: projectionState(fields.telegramProjectionState),
    telegramProjectionUpdatedAtMs: nullableNumber(
      fields.telegramProjectionUpdatedAtMs,
    ),
    telegramProjectionVersion: projectionVersion(
      fields.telegramProjectionVersion,
    ),
    profileGameProjectionState: projectionState(
      fields.profileGameProjectionState,
    ),
    profileGameProjectionUpdatedAtMs: nullableNumber(
      fields.profileGameProjectionUpdatedAtMs,
    ),
    profileGameProjectionVersion: projectionVersion(
      fields.profileGameProjectionVersion,
    ),
    eventProgressState: projectionState(fields.eventProgressState),
    eventProgressUpdatedAtMs: nullableNumber(fields.eventProgressUpdatedAtMs),
    eventProgressVersion: projectionVersion(fields.eventProgressVersion),
  };
}

function mergedRatingFields(
  snapshot: CanonicalRatingUpdateSnapshot,
  patch: RatingCompletionPatch | RatingProjectionPatch,
): CanonicalRatingUpdateValue {
  return ratingValue(
    snapshot.operationId,
    retainCanonicalRatingPayload({
      ...snapshot.payload,
      updatedAtMs: snapshot.updatedAtMs,
      ...patch,
    }),
  );
}

export function mergedRatingValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  patch: RatingCompletionPatch,
): CanonicalRatingUpdateValue {
  return mergedRatingFields(snapshot, patch);
}

type RatingProjectionFields = ReturnType<
  typeof canonicalRatingProjectionFields
>;
type RatingProjectionPatch = Partial<
  Record<RatingProjectionFields["state"], "dead" | "done">
> &
  Partial<Record<RatingProjectionFields["updated"], number>> &
  Partial<Record<RatingProjectionFields["reason"], string | null>>;

export function claimedRatingProjectionValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  fields: RatingProjectionFields,
  claimedAtMs: number,
): CanonicalRatingUpdateValue {
  return mergedRatingFields(snapshot, { [fields.updated]: claimedAtMs });
}

export function markedRatingProjectionValue(
  snapshot: CanonicalRatingUpdateSnapshot,
  fields: RatingProjectionFields,
  state: "dead" | "done",
  updatedAtMs: number,
  reason: string | undefined,
): CanonicalRatingUpdateValue {
  return mergedRatingFields(snapshot, {
    [fields.state]: state,
    [fields.updated]: updatedAtMs,
    [fields.reason]: reason?.trim() || null,
  });
}

export type RatingLeasePayloadWrite = {
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
  ownerUid: string;
  ownerToken: string;
  status: "processing";
  startedAtMs: number;
  updatedAtMs: number;
  leaseExpiresAtMs: number;
};

export function ratingLeasePayload(
  snapshot: CanonicalRatingUpdateSnapshot | null,
  input: RatingLeaseInput,
  data: RatingUpdateData | null,
  attemptNowMs: number,
): CanonicalRatingPayloadDocument {
  return retainCanonicalRatingPayload({
    ...(snapshot?.payload || {}),
    inviteId: input.inviteId,
    matchId: input.matchId,
    playerId: input.playerId,
    opponentId: input.opponentId,
    ownerUid: input.ownerUid,
    ownerToken: input.ownerToken,
    status: "processing",
    startedAtMs: data?.startedAtMs || attemptNowMs,
    updatedAtMs: attemptNowMs,
    leaseExpiresAtMs: attemptNowMs + input.leaseMs,
  } satisfies RatingLeasePayloadWrite);
}
