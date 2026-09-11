"use strict";

const {
  getEventPrizeDefinition,
  isEventPrizeStandard,
} = require("@mons/shared/event-prizes");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const getEventPrizeAssetAddress = (eventId, prizeId) =>
  normalizeString(getEventPrizeDefinition(eventId, prizeId)?.assetAddress);

const getEventPrizeAssetStandard = (eventId, prizeId) => {
  const standard = normalizeString(
    getEventPrizeDefinition(eventId, prizeId)?.standard,
  );
  return isEventPrizeStandard(standard) ? standard : "";
};

const isMatchingProfileEventPrizeAssignment = (value, eventId, prizeId) =>
  normalizeString(value?.eventId) === normalizeString(eventId) &&
  normalizeString(value?.prizeId) === normalizeString(prizeId);

const isWithdrawalRecordForPrize = (value, eventId, prizeId, assetAddress) => {
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

const isCompletedEventPrizeWithdrawal = (value, eventId, prizeId) => {
  const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
  return (
    Boolean(assetAddress) &&
    value?.status === "completed" &&
    isWithdrawalRecordForPrize(value, eventId, prizeId, assetAddress)
  );
};

const filterProjectableEventPrizeAssignments = ({
  eventId,
  assignments,
  withdrawals,
}) => {
  const projectable = {};
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

const getCompletedEventPrizeProjectionCleanupRequest = ({
  eventId,
  eventStatus,
  assignments,
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

module.exports = {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
};
