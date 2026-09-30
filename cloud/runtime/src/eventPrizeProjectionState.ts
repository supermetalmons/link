import {
  getEventPrizeDefinition,
  isEventPrizeStandard,
} from "@mons/shared/event-prizes";

export type PrizeWithdrawalProjectionRecord = {
  eventId?: unknown;
  prizeId?: unknown;
  assetAddress?: unknown;
  assetStandard?: unknown;
  status?: unknown;
};

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
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
) =>
  normalizeString(value?.eventId) === normalizeString(eventId) &&
  normalizeString(value?.prizeId) === normalizeString(prizeId);

const isWithdrawalRecordForPrize = (
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
  assetAddress: unknown,
) => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const expectedAssetStandard = getEventPrizeAssetStandard(eventId, prizeId);
  const recordedAssetStandard = normalizeString(value.assetStandard);
  const assetStandardMatches =
    (isEventPrizeStandard(recordedAssetStandard) &&
      recordedAssetStandard === expectedAssetStandard) ||
    (!recordedAssetStandard && expectedAssetStandard === "core");
  return (
    assetStandardMatches &&
    normalizeString(value.eventId) === normalizeString(eventId) &&
    normalizeString(value.prizeId) === normalizeString(prizeId) &&
    normalizeString(value.assetAddress) === normalizeString(assetAddress)
  );
};

const isCompletedEventPrizeWithdrawal = (
  value: PrizeWithdrawalProjectionRecord | null | undefined,
  eventId: unknown,
  prizeId: unknown,
) => {
  const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
  return (
    Boolean(assetAddress) &&
    value?.status === "completed" &&
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
  withdrawals:
    Record<string, PrizeWithdrawalProjectionRecord> | null | undefined;
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
