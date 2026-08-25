"use strict";

const bs58 = require("bs58");
const {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
} = require("./eventPrizeProjectionState");
const { isValidSolanaAddress } = require("@mons/shared/solana");

const EVENT_PRIZE_ADMIN_WALLET = "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";
const WITHDRAWAL_LEASE_MS = 5 * 60 * 1000;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const decodeBase58Bytes = (value) => {
  try {
    return bs58.default.decode(normalizeString(value));
  } catch {
    return null;
  }
};

const normalizeSolanaAddress = (value) => {
  const address = normalizeString(value);
  return isValidSolanaAddress(address) ? address : "";
};

const decodeAdminSecretKey = (value) => {
  const bytes = decodeBase58Bytes(value);
  return bytes?.length === 64 ? bytes : null;
};

const getEventPrizeWithdrawalPath = (eventId, prizeId) =>
  `eventPrizeWithdrawals/${normalizeString(eventId)}/${normalizeString(prizeId)}`;

const isWithdrawalRecordOwnedByRequest = (
  value,
  profileId,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
) => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const normalizedProfileId = normalizeString(profileId);
  const normalizedRequesterUid = normalizeString(requesterUid);
  const normalizedCanonicalRecordProfileId = normalizeString(
    canonicalRecordProfileId,
  );
  const normalizedCanonicalRecordSourceProfileId = normalizeString(
    canonicalRecordSourceProfileId,
  );
  const recordProfileId = normalizeString(value.profileId);
  return (
    (normalizedProfileId &&
      (recordProfileId === normalizedProfileId ||
        (normalizedCanonicalRecordSourceProfileId &&
          recordProfileId === normalizedCanonicalRecordSourceProfileId &&
          normalizedCanonicalRecordProfileId === normalizedProfileId))) ||
    (normalizedRequesterUid &&
      normalizeString(value.requesterUid) === normalizedRequesterUid)
  );
};

const getWithdrawalProjectionProfileIds = ({ withdrawal, profileIds }) =>
  Array.from(
    new Set(
      [withdrawal?.entitledProfileId, withdrawal?.profileId]
        .concat(Array.isArray(profileIds) ? profileIds : [])
        .map(normalizeString)
        .filter(Boolean),
    ),
  );

const buildWithdrawalCompletionUpdates = ({
  withdrawal,
  profileId,
  eventId,
  prizeId,
  assetAddress,
  recipientAddress,
  transactionSignature,
  completedAtMs,
}) => {
  const entitledProfileId =
    normalizeString(withdrawal.entitledProfileId) ||
    normalizeString(withdrawal.profileId) ||
    profileId;
  const completed = {
    eventId,
    prizeId,
    assetAddress,
    assetStandard: getEventPrizeAssetStandard(eventId, prizeId),
    profileId,
    entitledProfileId,
    place: Number(withdrawal.place),
    recipientAddress,
    requesterUid: normalizeString(withdrawal.requesterUid),
    status: "completed",
    transactionSignature,
    startedAtMs: Number(withdrawal.startedAtMs) || completedAtMs,
    submittedAtMs: Number(withdrawal.submittedAtMs) || completedAtMs,
    completedAtMs,
    updatedAtMs: completedAtMs,
  };
  const updates = {
    [getEventPrizeWithdrawalPath(eventId, prizeId)]: completed,
  };
  return {
    completed,
    updates,
  };
};

const decideWithdrawalClaim = ({
  current,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
  leaseId,
  nowMs,
}) => {
  const existing = current && typeof current === "object" ? current : {};
  const existingProfileId = normalizeString(existing.profileId);
  const existingRecipientAddress = normalizeString(existing.recipientAddress);
  const existingLeaseId = normalizeString(existing.leaseId);
  const leaseExpiresAtMs = Number(existing.leaseExpiresAtMs) || 0;
  const recordMatchesPrize = isWithdrawalRecordForPrize(
    existing,
    eventId,
    prizeId,
    assetAddress,
  );
  const recordOwnedByRequest = isWithdrawalRecordOwnedByRequest(
    existing,
    profileId,
    requesterUid,
    canonicalRecordProfileId,
    canonicalRecordSourceProfileId,
  );

  if (existing.status === "completed") {
    return recordMatchesPrize && recordOwnedByRequest
      ? { kind: "completed", value: existing }
      : { kind: "forbidden", value: existing };
  }
  if (existing.status === "blocked") {
    return recordMatchesPrize && recordOwnedByRequest
      ? { kind: "blocked", value: existing }
      : { kind: "forbidden", value: existing };
  }
  if (existing.status === "submitted") {
    if (!recordMatchesPrize || !recordOwnedByRequest) {
      return { kind: "forbidden", value: existing };
    }
    if (existingRecipientAddress !== recipientAddress) {
      return { kind: "destination-mismatch", value: existing };
    }
  } else if (
    existing.status === "processing" &&
    leaseExpiresAtMs > nowMs &&
    existingLeaseId &&
    existingLeaseId !== leaseId
  ) {
    if (
      !recordMatchesPrize ||
      !recordOwnedByRequest ||
      existingRecipientAddress !== recipientAddress
    ) {
      return { kind: "busy", value: existing };
    }
  }

  const preserveSubmitted = existing.status === "submitted";
  const assetStandard = getEventPrizeAssetStandard(eventId, prizeId);
  return {
    kind: "acquired",
    value: {
      ...(preserveSubmitted ? existing : {}),
      eventId,
      prizeId,
      assetAddress,
      ...(assetStandard ? { assetStandard } : {}),
      entitledProfileId: preserveSubmitted
        ? normalizeString(existing.entitledProfileId) || existingProfileId
        : profileId,
      profileId,
      place,
      recipientAddress,
      requesterUid,
      status: preserveSubmitted ? "submitted" : "processing",
      leaseId,
      leaseExpiresAtMs: nowMs + WITHDRAWAL_LEASE_MS,
      startedAtMs:
        preserveSubmitted && Number.isFinite(existing.startedAtMs)
          ? Math.floor(existing.startedAtMs)
          : nowMs,
      updatedAtMs: nowMs,
    },
  };
};

module.exports = {
  EVENT_PRIZE_ADMIN_WALLET,
  WITHDRAWAL_LEASE_MS,
  buildWithdrawalCompletionUpdates,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  getEventPrizeWithdrawalPath,
  getWithdrawalProjectionProfileIds,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
};
