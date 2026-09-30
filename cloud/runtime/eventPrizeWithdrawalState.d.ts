// Generated from src/eventPrizeWithdrawalState.ts. Run npm run generate:runtime.
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
declare const EVENT_PRIZE_ADMIN_WALLET =
  "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";
declare const WITHDRAWAL_LEASE_MS: number;
declare const normalizeSolanaAddress: (value: unknown) => string;
declare const decodeAdminSecretKey: (value: unknown) => Uint8Array | null;
declare const isWithdrawalRecordOwnedByRequest: (
  value: unknown,
  profileId: unknown,
  requesterUid: unknown,
  canonicalRecordProfileId?: unknown,
  canonicalRecordSourceProfileId?: unknown,
) => boolean | "";
declare const getWithdrawalProjectionProfileIds: ({
  withdrawal,
  profileIds,
}: {
  withdrawal: WithdrawalData | null | undefined;
  profileIds?: unknown;
}) => string[];
declare const buildWithdrawalCompletion: ({
  withdrawal,
  profileId,
  eventId,
  prizeId,
  assetAddress,
  recipientAddress,
  transactionSignature,
  completedAtMs,
}: WithdrawalCompletionInput & {
  completedAtMs: number;
}) => {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: string;
  profileId: string;
  entitledProfileId: string;
  place: number;
  recipientAddress: string;
  requesterUid: string;
  status: "completed";
  transactionSignature: string;
  startedAtMs: number;
  submittedAtMs: number;
  completedAtMs: number;
  updatedAtMs: number;
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
declare const decideWithdrawalClaim: ({
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
}: WithdrawalClaimInput) => WithdrawalClaimDecision;
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
