// Generated from src/eventPrizeWithdrawalState.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSolanaAddress =
  exports.isWithdrawalRecordOwnedByRequest =
  exports.isWithdrawalRecordForPrize =
  exports.isMatchingProfileEventPrizeAssignment =
  exports.isCompletedEventPrizeWithdrawal =
  exports.getWithdrawalProjectionProfileIds =
  exports.getEventPrizeAssetStandard =
  exports.getEventPrizeAssetAddress =
  exports.getCompletedEventPrizeProjectionCleanupRequest =
  exports.filterProjectableEventPrizeAssignments =
  exports.decideWithdrawalClaim =
  exports.decodeAdminSecretKey =
  exports.buildWithdrawalCompletion =
  exports.WITHDRAWAL_LEASE_MS =
  exports.EVENT_PRIZE_ADMIN_WALLET =
    void 0;
const eventPrizeProjectionState_js_1 = require("./eventPrizeProjectionState.js");
Object.defineProperty(exports, "filterProjectableEventPrizeAssignments", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.filterProjectableEventPrizeAssignments;
  },
});
Object.defineProperty(
  exports,
  "getCompletedEventPrizeProjectionCleanupRequest",
  {
    enumerable: true,
    get: function () {
      return eventPrizeProjectionState_js_1.getCompletedEventPrizeProjectionCleanupRequest;
    },
  },
);
Object.defineProperty(exports, "getEventPrizeAssetAddress", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.getEventPrizeAssetAddress;
  },
});
Object.defineProperty(exports, "getEventPrizeAssetStandard", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.getEventPrizeAssetStandard;
  },
});
Object.defineProperty(exports, "isCompletedEventPrizeWithdrawal", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.isCompletedEventPrizeWithdrawal;
  },
});
Object.defineProperty(exports, "isMatchingProfileEventPrizeAssignment", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.isMatchingProfileEventPrizeAssignment;
  },
});
Object.defineProperty(exports, "isWithdrawalRecordForPrize", {
  enumerable: true,
  get: function () {
    return eventPrizeProjectionState_js_1.isWithdrawalRecordForPrize;
  },
});
const solana_1 = require("@mons/shared/solana");
const EVENT_PRIZE_ADMIN_WALLET = "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";
exports.EVENT_PRIZE_ADMIN_WALLET = EVENT_PRIZE_ADMIN_WALLET;
const WITHDRAWAL_LEASE_MS = 5 * 60 * 1000;
exports.WITHDRAWAL_LEASE_MS = WITHDRAWAL_LEASE_MS;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const decodeBase58Bytes = (value) => {
  const encoded = normalizeString(value);
  if (!encoded) return null;
  const bytes = [0];
  for (const character of encoded) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (
    let index = 0;
    encoded[index] === "1" && index < encoded.length - 1;
    index += 1
  ) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
};
const normalizeSolanaAddress = (value) => {
  const address = normalizeString(value);
  return (0, solana_1.isValidSolanaAddress)(address) ? address : "";
};
exports.normalizeSolanaAddress = normalizeSolanaAddress;
const decodeAdminSecretKey = (value) => {
  const bytes = decodeBase58Bytes(value);
  return bytes?.length === 64 ? bytes : null;
};
exports.decodeAdminSecretKey = decodeAdminSecretKey;
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
exports.isWithdrawalRecordOwnedByRequest = isWithdrawalRecordOwnedByRequest;
const getWithdrawalProjectionProfileIds = ({ withdrawal, profileIds }) =>
  Array.from(
    new Set(
      [withdrawal?.entitledProfileId, withdrawal?.profileId]
        .concat(Array.isArray(profileIds) ? profileIds : [])
        .map(normalizeString)
        .filter(Boolean),
    ),
  );
exports.getWithdrawalProjectionProfileIds = getWithdrawalProjectionProfileIds;
const buildWithdrawalCompletion = ({
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
    assetStandard: (0,
    eventPrizeProjectionState_js_1.getEventPrizeAssetStandard)(
      eventId,
      prizeId,
    ),
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
  return completed;
};
exports.buildWithdrawalCompletion = buildWithdrawalCompletion;
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
  const recordMatchesPrize = (0,
  eventPrizeProjectionState_js_1.isWithdrawalRecordForPrize)(
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
  const assetStandard = (0,
  eventPrizeProjectionState_js_1.getEventPrizeAssetStandard)(eventId, prizeId);
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
exports.decideWithdrawalClaim = decideWithdrawalClaim;
