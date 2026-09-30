import type {
  WithdrawalData,
  WithdrawalCompletionInput,
} from "./eventPrizes/types.js";

import {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
} from "./eventPrizeProjectionState.js";
import { isValidSolanaAddress } from "@mons/shared/solana";

const EVENT_PRIZE_ADMIN_WALLET = "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";
const WITHDRAWAL_LEASE_MS = 5 * 60 * 1000;

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const decodeBase58Bytes = (value: unknown): Uint8Array | null => {
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

const normalizeSolanaAddress = (value: unknown): string => {
  const address = normalizeString(value);
  return isValidSolanaAddress(address) ? address : "";
};

const decodeAdminSecretKey = (value: unknown): Uint8Array | null => {
  const bytes = decodeBase58Bytes(value);
  return bytes?.length === 64 ? bytes : null;
};

const isWithdrawalRecordOwnedByRequest = (
  value: unknown,
  profileId: unknown,
  requesterUid: unknown,
  canonicalRecordProfileId?: unknown,
  canonicalRecordSourceProfileId?: unknown,
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
  const recordProfileId = normalizeString((value as WithdrawalData).profileId);
  return (
    (normalizedProfileId &&
      (recordProfileId === normalizedProfileId ||
        (normalizedCanonicalRecordSourceProfileId &&
          recordProfileId === normalizedCanonicalRecordSourceProfileId &&
          normalizedCanonicalRecordProfileId === normalizedProfileId))) ||
    (normalizedRequesterUid &&
      normalizeString((value as WithdrawalData).requesterUid) ===
        normalizedRequesterUid)
  );
};

const getWithdrawalProjectionProfileIds = ({
  withdrawal,
  profileIds,
}: {
  withdrawal: WithdrawalData | null | undefined;
  profileIds?: unknown;
}) =>
  Array.from(
    new Set(
      [withdrawal?.entitledProfileId, withdrawal?.profileId]
        .concat(Array.isArray(profileIds) ? profileIds : [])
        .map(normalizeString)
        .filter(Boolean),
    ),
  );

const buildWithdrawalCompletion = ({
  withdrawal,
  profileId,
  eventId,
  prizeId,
  assetAddress,
  recipientAddress,
  transactionSignature,
  completedAtMs,
}: WithdrawalCompletionInput & { completedAtMs: number }) => {
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
    status: "completed" as const,
    transactionSignature,
    startedAtMs: Number(withdrawal.startedAtMs) || completedAtMs,
    submittedAtMs: Number(withdrawal.submittedAtMs) || completedAtMs,
    completedAtMs,
    updatedAtMs: completedAtMs,
  };
  return completed;
};

export type WithdrawalClaimInput = {
  current: unknown;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  profileId: string;
  place: number;
  recipientAddress: string;
  requesterUid: string;
  canonicalRecordProfileId?: string;
  canonicalRecordSourceProfileId?: string;
  leaseId: string;
  nowMs: number;
};

export type WithdrawalClaimDecision = {
  kind:
    | "completed"
    | "forbidden"
    | "blocked"
    | "destination-mismatch"
    | "busy"
    | "acquired";
  value: WithdrawalData;
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
}: WithdrawalClaimInput): WithdrawalClaimDecision => {
  const existing = (
    current && typeof current === "object" ? current : {}
  ) as WithdrawalData;
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
          ? Math.floor(existing.startedAtMs as number)
          : nowMs,
      updatedAtMs: nowMs,
    },
  };
};

export {
  EVENT_PRIZE_ADMIN_WALLET,
  WITHDRAWAL_LEASE_MS,
  buildWithdrawalCompletion,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  getWithdrawalProjectionProfileIds,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
};
