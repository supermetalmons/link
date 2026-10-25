// Generated from src/eventPrizeProjectionState.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWithdrawalRecordForPrize =
  exports.isMatchingProfileEventPrizeAssignment =
  exports.isCompletedEventPrizeWithdrawal =
  exports.getEventPrizeAssetStandard =
  exports.getEventPrizeAssetAddress =
  exports.getCompletedEventPrizeProjectionCleanupRequest =
  exports.filterProjectableEventPrizeAssignments =
    void 0;
const event_prizes_1 = require("@mons/shared/event-prizes");
const records_js_1 = require("./eventPrizes/records.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const getEventPrizeAssetAddress = (eventId, prizeId) =>
  normalizeString(
    (0, event_prizes_1.getEventPrizeDefinition)(eventId, prizeId)?.assetAddress,
  );
exports.getEventPrizeAssetAddress = getEventPrizeAssetAddress;
const getEventPrizeAssetStandard = (eventId, prizeId) => {
  const standard = normalizeString(
    (0, event_prizes_1.getEventPrizeDefinition)(eventId, prizeId)?.standard,
  );
  return (0, event_prizes_1.isEventPrizeStandard)(standard) ? standard : "";
};
exports.getEventPrizeAssetStandard = getEventPrizeAssetStandard;
const isMatchingProfileEventPrizeAssignment = (value, eventId, prizeId) => {
  const identity = value;
  return (
    normalizeString(identity?.eventId) === normalizeString(eventId) &&
    normalizeString(identity?.prizeId) === normalizeString(prizeId)
  );
};
exports.isMatchingProfileEventPrizeAssignment =
  isMatchingProfileEventPrizeAssignment;
const isWithdrawalRecordForPrize = (value, eventId, prizeId, assetAddress) => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const expectedAssetStandard = getEventPrizeAssetStandard(eventId, prizeId);
  const identity = (0, records_js_1.withdrawalIdentity)(value);
  const recordedAssetStandard = identity.assetStandard;
  const assetStandardMatches =
    ((0, event_prizes_1.isEventPrizeStandard)(recordedAssetStandard) &&
      recordedAssetStandard === expectedAssetStandard) ||
    (!recordedAssetStandard && expectedAssetStandard === "core");
  return (
    assetStandardMatches &&
    identity.eventId === normalizeString(eventId) &&
    identity.prizeId === normalizeString(prizeId) &&
    identity.assetAddress === normalizeString(assetAddress)
  );
};
exports.isWithdrawalRecordForPrize = isWithdrawalRecordForPrize;
const isCompletedEventPrizeWithdrawal = (value, eventId, prizeId) => {
  const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
  return (
    Boolean(assetAddress) &&
    (0, records_js_1.withdrawalStatus)(value) === "completed" &&
    isWithdrawalRecordForPrize(value, eventId, prizeId, assetAddress)
  );
};
exports.isCompletedEventPrizeWithdrawal = isCompletedEventPrizeWithdrawal;
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
exports.filterProjectableEventPrizeAssignments =
  filterProjectableEventPrizeAssignments;
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
exports.getCompletedEventPrizeProjectionCleanupRequest =
  getCompletedEventPrizeProjectionCleanupRequest;
