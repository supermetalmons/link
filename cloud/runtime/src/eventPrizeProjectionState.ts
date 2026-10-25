import {
  getEventPrizeDefinition,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";
import {
  withdrawalIdentity,
  withdrawalStatus,
  type WithdrawalDocument,
} from "./eventPrizes/records.js";

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const getEventPrizeAssetAddress = (eventId: unknown, prizeId: unknown) =>
  normalizeString(getEventPrizeDefinition(eventId, prizeId)?.assetAddress);

const getEventPrizeAssetStandard = (eventId: unknown, prizeId: unknown) => {
  const standard = normalizeString(
    getEventPrizeDefinition(eventId, prizeId)?.standard,
  );
  return isEventPrizeStandard(standard) ? standard : "";
};

const isMatchingProfileEventPrizeAssignment = (
  value: unknown,
  eventId: unknown,
  prizeId: unknown,
) => {
  const identity = value as
    { eventId?: unknown; prizeId?: unknown } | null | undefined;
  return (
    normalizeString(identity?.eventId) === normalizeString(eventId) &&
    normalizeString(identity?.prizeId) === normalizeString(prizeId)
  );
};

const isWithdrawalRecordForPrize = (
  value: WithdrawalDocument | null | undefined,
  eventId: unknown,
  prizeId: unknown,
  assetAddress: unknown,
) => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const expectedAssetStandard = getEventPrizeAssetStandard(eventId, prizeId);
  const identity = withdrawalIdentity(value);
  const recordedAssetStandard = identity.assetStandard;
  const assetStandardMatches =
    (isEventPrizeStandard(recordedAssetStandard) &&
      recordedAssetStandard === expectedAssetStandard) ||
    (!recordedAssetStandard && expectedAssetStandard === "core");
  return (
    assetStandardMatches &&
    identity.eventId === normalizeString(eventId) &&
    identity.prizeId === normalizeString(prizeId) &&
    identity.assetAddress === normalizeString(assetAddress)
  );
};

const isCompletedEventPrizeWithdrawal = (
  value: WithdrawalDocument | null | undefined,
  eventId: unknown,
  prizeId: unknown,
) => {
  const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
  return (
    Boolean(assetAddress) &&
    withdrawalStatus(value) === "completed" &&
    isWithdrawalRecordForPrize(value, eventId, prizeId, assetAddress)
  );
};

const filterProjectableEventPrizeAssignments = <
  T extends { prizeId?: unknown } | null,
>({
  eventId,
  assignments,
  withdrawals,
}: {
  eventId: unknown;
  assignments: Record<string, T> | null | undefined;
  withdrawals: Record<string, WithdrawalDocument> | null | undefined;
}): Record<string, T> => {
  const projectable: Record<string, T> = {};
  for (const [place, assignment] of Object.entries(assignments || {})) {
    const prizeId = normalizeString(assignment?.prizeId);
    if (
      prizeId &&
      !isCompletedEventPrizeWithdrawal(withdrawals?.[prizeId], eventId, prizeId)
    ) {
      projectable[place] = assignment;
    }
  }
  return projectable;
};

const getCompletedEventPrizeProjectionCleanupRequest = <T extends object>({
  eventId,
  eventStatus,
  assignments,
}: {
  eventId: unknown;
  eventStatus: unknown;
  assignments: T | null | undefined;
}) => {
  const normalizedEventId = normalizeString(eventId);
  if (
    !normalizedEventId ||
    normalizeString(eventStatus) !== "ended" ||
    !assignments ||
    Object.keys(assignments).length === 0
  ) {
    return null;
  }
  return { eventId: normalizedEventId, assignments };
};

export {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
};
