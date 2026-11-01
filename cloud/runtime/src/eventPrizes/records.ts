import {
  isEventPrizeStandard,
  type EventPrizeStandard,
} from "../shared/event-prizes.js";
import { isValidSolanaAddress } from "../shared/solana.js";

export type WithdrawalStatus =
  "blocked" | "completed" | "processing" | "submitted";
type WithdrawalBlockReason = "asset-owner-mismatch" | "canonical-data-cutover";
export type WithdrawalSubmissionEvidence = {
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
};
type WithdrawalIdentity = {
  schemaVersion: 1;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard;
  entitledProfileId: string;
  profileId: string;
  place: 1 | 2 | 3;
  recipientAddress: string;
  requesterUid: string;
  startedAtMs: number;
  updatedAtMs: number;
};
type NoSubmission = {
  transactionSignature: null;
  signedTransactionBase64: null;
  blockhash: null;
  lastValidBlockHeight: null;
  submittedAtMs: null;
};
type SubmittedEvidence = WithdrawalSubmissionEvidence & {
  submittedAtMs: number;
};
type NoBlock = {
  observedOwner: null;
  blockReason: null;
  blockedAtMs: null;
  sourceDigest: null;
};
type NoLease = { leaseId: null; leaseExpiresAtMs: null };
export type ProcessingWithdrawalDocument = WithdrawalIdentity &
  NoSubmission &
  NoBlock & {
    status: "processing";
    leaseId: string;
    leaseExpiresAtMs: number;
    completedAtMs: null;
  };
export type SubmittedWithdrawalDocument = WithdrawalIdentity &
  SubmittedEvidence &
  NoBlock & {
    status: "submitted";
    leaseId: string;
    leaseExpiresAtMs: number;
    completedAtMs: null;
  };
export type CompletedWithdrawalDocument = WithdrawalIdentity &
  NoLease &
  NoBlock & {
    status: "completed";
    transactionSignature: string;
    signedTransactionBase64: string | null;
    blockhash: string | null;
    lastValidBlockHeight: number | null;
    submittedAtMs: number;
    completedAtMs: number;
  };
export type BlockedWithdrawalDocument = WithdrawalIdentity &
  NoLease & {
    status: "blocked";
    transactionSignature: string | null;
    signedTransactionBase64: string | null;
    blockhash: string | null;
    lastValidBlockHeight: number | null;
    submittedAtMs: number | null;
    completedAtMs: null;
    observedOwner: string | null;
    blockReason: WithdrawalBlockReason;
    blockedAtMs: number;
    sourceDigest: string | null;
  };
export type WithdrawalDocument =
  | ProcessingWithdrawalDocument
  | SubmittedWithdrawalDocument
  | CompletedWithdrawalDocument
  | BlockedWithdrawalDocument;

const KEYS = [
  "schemaVersion",
  "eventId",
  "prizeId",
  "assetAddress",
  "assetStandard",
  "entitledProfileId",
  "profileId",
  "place",
  "recipientAddress",
  "requesterUid",
  "startedAtMs",
  "updatedAtMs",
  "status",
  "leaseId",
  "leaseExpiresAtMs",
  "transactionSignature",
  "signedTransactionBase64",
  "blockhash",
  "lastValidBlockHeight",
  "submittedAtMs",
  "completedAtMs",
  "observedOwner",
  "blockReason",
  "blockedAtMs",
  "sourceDigest",
] as const;
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const key = (value: unknown): value is string =>
  text(value) && !value.includes("/");
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const address = (value: unknown): value is string =>
  text(value) && isValidSolanaAddress(value);
const base64 = (value: unknown): value is string =>
  text(value) &&
  value.length <= 2_000_000 &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );

function isWithdrawalDocument(value: unknown): value is WithdrawalDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(row, key)) ||
    row.schemaVersion !== 1 ||
    !key(row.eventId) ||
    !key(row.prizeId) ||
    !address(row.assetAddress) ||
    !isEventPrizeStandard(row.assetStandard) ||
    !key(row.entitledProfileId) ||
    !key(row.profileId) ||
    (row.place !== 1 && row.place !== 2 && row.place !== 3) ||
    !address(row.recipientAddress) ||
    !key(row.requesterUid) ||
    !integer(row.startedAtMs) ||
    !integer(row.updatedAtMs) ||
    row.updatedAtMs < row.startedAtMs
  )
    return false;
  const noSubmission =
    row.transactionSignature === null &&
    row.signedTransactionBase64 === null &&
    row.blockhash === null &&
    row.lastValidBlockHeight === null &&
    row.submittedAtMs === null;
  const signature = text(row.transactionSignature);
  const submittedTime =
    integer(row.submittedAtMs) &&
    row.submittedAtMs >= row.startedAtMs &&
    row.submittedAtMs <= row.updatedAtMs;
  const signedEvidence =
    base64(row.signedTransactionBase64) &&
    address(row.blockhash) &&
    integer(row.lastValidBlockHeight);
  const noSignedEvidence =
    row.signedTransactionBase64 === null &&
    row.blockhash === null &&
    row.lastValidBlockHeight === null;
  const noBlock =
    row.observedOwner === null &&
    row.blockReason === null &&
    row.blockedAtMs === null &&
    row.sourceDigest === null;
  if (row.status === "processing" || row.status === "submitted") {
    if (
      !text(row.leaseId) ||
      !integer(row.leaseExpiresAtMs) ||
      row.leaseExpiresAtMs < row.startedAtMs ||
      row.completedAtMs !== null ||
      !noBlock
    )
      return false;
    return row.status === "processing"
      ? noSubmission
      : signature && submittedTime && signedEvidence;
  }
  if (row.leaseId !== null || row.leaseExpiresAtMs !== null) return false;
  if (row.status === "completed")
    return (
      noBlock &&
      signature &&
      submittedTime &&
      (signedEvidence || noSignedEvidence) &&
      integer(row.completedAtMs) &&
      integer(row.submittedAtMs) &&
      row.completedAtMs >= row.submittedAtMs &&
      row.completedAtMs <= row.updatedAtMs
    );
  if (
    row.status !== "blocked" ||
    row.completedAtMs !== null ||
    !integer(row.blockedAtMs) ||
    row.blockedAtMs < row.startedAtMs ||
    row.blockedAtMs > row.updatedAtMs ||
    (row.observedOwner !== null && !address(row.observedOwner)) ||
    !(
      noSubmission ||
      (signature && submittedTime && (signedEvidence || noSignedEvidence))
    )
  )
    return false;
  return row.blockReason === "asset-owner-mismatch"
    ? address(row.observedOwner) && row.sourceDigest === null
    : row.blockReason === "canonical-data-cutover" &&
        typeof row.sourceDigest === "string" &&
        /^[a-f0-9]{64}$/.test(row.sourceDigest);
}

export function readWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null {
  return isWithdrawalDocument(value) ? value : null;
}
export function readStoredWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null {
  return readWithdrawalDocument(value);
}
function requireDocument(value: unknown): WithdrawalDocument {
  const document = readWithdrawalDocument(value);
  if (!document) throw new TypeError("invalid-canonical-withdrawal");
  return document;
}
export function storedWithdrawalMatchesIdentity(
  value: WithdrawalDocument,
  eventId: string,
  prizeId: string,
): boolean {
  return value.eventId === eventId && value.prizeId === prizeId;
}
export function withdrawalStatus(
  value: WithdrawalDocument | null | undefined,
): WithdrawalStatus | null {
  return value?.status ?? null;
}
export function withdrawalExecutionStatus(
  value: WithdrawalDocument | null | undefined,
): WithdrawalStatus | "" {
  return value?.status ?? "";
}
export function withdrawalIdentity(
  value: WithdrawalDocument | null | undefined,
) {
  return {
    eventId: value?.eventId ?? "",
    prizeId: value?.prizeId ?? "",
    assetAddress: value?.assetAddress ?? "",
    assetStandard: value?.assetStandard ?? "",
  };
}
export function withdrawalOwnership(
  value: WithdrawalDocument | null | undefined,
) {
  return {
    profileId: value?.profileId ?? "",
    entitledProfileId: value?.entitledProfileId ?? "",
    requesterUid: value?.requesterUid ?? "",
  };
}
export function withdrawalRecipientAddress(
  value: WithdrawalDocument | null | undefined,
): string {
  return value?.recipientAddress ?? "";
}
export function withdrawalLeaseId(
  value: WithdrawalDocument | null | undefined,
): string {
  return value?.leaseId ?? "";
}
export function withdrawalLeaseExpiresAtMs(
  value: WithdrawalDocument | null | undefined,
): number {
  return value?.leaseExpiresAtMs ?? 0;
}
export function withdrawalPlace(
  value: WithdrawalDocument | null | undefined,
): number {
  return value?.place ?? 0;
}
export function withdrawalStartedAtForClaim(
  value: WithdrawalDocument | null,
  nowMs: number,
): number {
  return value?.startedAtMs ?? nowMs;
}
export function withdrawalSubmittedAtForPersistence(
  value: WithdrawalDocument,
  now: () => number,
): number {
  return value.submittedAtMs ?? now();
}
export function withdrawalStartedAtForCompletion(
  value: WithdrawalDocument,
  _completedAtMs: number,
): number {
  return value.startedAtMs;
}
export function withdrawalSubmittedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number {
  return value.submittedAtMs ?? completedAtMs;
}
export function withdrawalStorageUpdatedAtMs(
  value: WithdrawalDocument,
): number {
  return value.updatedAtMs;
}
export function withdrawalSubmissionStrings(
  value: WithdrawalDocument | null | undefined,
) {
  return {
    signedTransactionBase64: value?.signedTransactionBase64 ?? "",
    transactionSignature: value?.transactionSignature ?? "",
    blockhash: value?.blockhash ?? "",
  };
}
export function withdrawalLastValidBlockHeight(
  value: WithdrawalDocument | null | undefined,
): number | null {
  return value?.lastValidBlockHeight ?? null;
}
export type WithdrawalResponseFields = {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};
export function withdrawalResponseFields(
  value: WithdrawalDocument,
): WithdrawalResponseFields {
  if (value.status !== "completed")
    throw new TypeError("withdrawal-not-completed");
  return {
    eventId: value.eventId,
    prizeId: value.prizeId,
    assetAddress: value.assetAddress,
    recipientAddress: value.recipientAddress,
    transactionSignature: value.transactionSignature,
  };
}
export type WithdrawalClaimFields = Omit<
  WithdrawalIdentity,
  "schemaVersion"
> & { status?: never; leaseId: string; leaseExpiresAtMs: number };
const noSubmission: NoSubmission = {
  transactionSignature: null,
  signedTransactionBase64: null,
  blockhash: null,
  lastValidBlockHeight: null,
  submittedAtMs: null,
};
const noBlock: NoBlock = {
  observedOwner: null,
  blockReason: null,
  blockedAtMs: null,
  sourceDigest: null,
};
export function writeProcessingWithdrawal(
  value: WithdrawalClaimFields,
): ProcessingWithdrawalDocument {
  const result = requireDocument({
    ...value,
    ...noSubmission,
    ...noBlock,
    schemaVersion: 1,
    status: "processing",
    completedAtMs: null,
  });
  if (result.status !== "processing")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
export function writeReacquiredSubmittedWithdrawal(
  previous: WithdrawalDocument,
  value: WithdrawalClaimFields,
): SubmittedWithdrawalDocument {
  if (previous.status !== "submitted")
    throw new TypeError("withdrawal-not-submitted");
  const result = requireDocument({
    ...previous,
    ...value,
    schemaVersion: 1,
    status: "submitted",
  });
  if (result.status !== "submitted")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
export function writeBlockedWithdrawal(
  current: WithdrawalDocument,
  observedOwner: string,
  updatedAtMs: number,
): BlockedWithdrawalDocument {
  const result = requireDocument({
    ...current,
    status: "blocked",
    observedOwner,
    updatedAtMs,
    leaseId: null,
    leaseExpiresAtMs: null,
    completedAtMs: null,
    blockReason: "asset-owner-mismatch",
    blockedAtMs: updatedAtMs,
    sourceDigest: null,
  });
  if (result.status !== "blocked")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
export function writeSubmittedWithdrawal(
  current: WithdrawalDocument,
  evidence: WithdrawalSubmissionEvidence,
  submittedAtMs: number,
  updatedAtMs: number,
): SubmittedWithdrawalDocument {
  if (current.status !== "processing" && current.status !== "submitted")
    throw new TypeError("withdrawal-not-processing");
  const result = requireDocument({
    ...current,
    ...evidence,
    status: "submitted",
    submittedAtMs,
    updatedAtMs,
  });
  if (result.status !== "submitted")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
export type CompletedWithdrawalWrite = Omit<
  WithdrawalIdentity,
  "schemaVersion"
> & {
  status: "completed";
  transactionSignature: string;
  startedAtMs: number;
  submittedAtMs: number;
  completedAtMs: number;
  updatedAtMs: number;
  signedTransactionBase64: string | null;
  blockhash: string | null;
  lastValidBlockHeight: number | null;
};
export function writeCompletedWithdrawal(
  value: CompletedWithdrawalWrite,
): CompletedWithdrawalDocument {
  const result = requireDocument({
    ...value,
    ...noBlock,
    schemaVersion: 1,
    leaseId: null,
    leaseExpiresAtMs: null,
  });
  if (result.status !== "completed")
    throw new TypeError("invalid-canonical-withdrawal");
  return result;
}
