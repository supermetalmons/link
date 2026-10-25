import type { EventPrizeStandard } from "../shared/event-prizes.js";

declare const withdrawalDocument: unique symbol;
declare const completedWithdrawalWrite: unique symbol;

export type WithdrawalDocument = { readonly [withdrawalDocument]: true };
export type CompletedWithdrawalDocument = WithdrawalDocument & {
  readonly [completedWithdrawalWrite]: true;
};
export type WithdrawalStatus =
  "blocked" | "completed" | "processing" | "submitted";

type SourceRecord = Record<string, unknown>;

const source = (value: WithdrawalDocument | null | undefined): SourceRecord =>
  (value ?? {}) as object as SourceRecord;
const trimmed = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

export function readWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null {
  return value !== null && typeof value === "object"
    ? (value as WithdrawalDocument)
    : null;
}

export function readStoredWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null {
  return Array.isArray(value) ? null : readWithdrawalDocument(value);
}

export function storedWithdrawalMatchesIdentity(
  value: WithdrawalDocument,
  eventId: string,
  prizeId: string,
): boolean {
  const record = source(value);
  return (
    record.eventId === eventId &&
    record.prizeId === prizeId &&
    ["blocked", "completed", "processing", "submitted"].includes(
      String(record.status),
    )
  );
}

export function withdrawalStatus(
  value: WithdrawalDocument | null | undefined,
): WithdrawalStatus | null {
  const status = source(value).status;
  return status === "blocked" ||
    status === "completed" ||
    status === "processing" ||
    status === "submitted"
    ? status
    : null;
}

export function withdrawalExecutionStatus(
  value: WithdrawalDocument | null | undefined,
): string {
  return trimmed(source(value).status);
}

export function withdrawalIdentity(
  value: WithdrawalDocument | null | undefined,
) {
  const record = source(value);
  return {
    eventId: trimmed(record.eventId),
    prizeId: trimmed(record.prizeId),
    assetAddress: trimmed(record.assetAddress),
    assetStandard: trimmed(record.assetStandard),
  };
}

export function withdrawalOwnership(
  value: WithdrawalDocument | null | undefined,
) {
  const record = source(value);
  return {
    profileId: trimmed(record.profileId),
    entitledProfileId: trimmed(record.entitledProfileId),
    requesterUid: trimmed(record.requesterUid),
  };
}

export function withdrawalRecipientAddress(
  value: WithdrawalDocument | null | undefined,
): string {
  return trimmed(source(value).recipientAddress);
}

export function withdrawalLeaseId(
  value: WithdrawalDocument | null | undefined,
): string {
  return trimmed(source(value).leaseId);
}

export function withdrawalLeaseExpiresAtMs(value: WithdrawalDocument): number {
  return Number(source(value).leaseExpiresAtMs) || 0;
}

export function withdrawalPlace(
  value: WithdrawalDocument | null | undefined,
): number {
  return Number(source(value).place);
}

export function withdrawalStartedAtForClaim(
  value: WithdrawalDocument,
  nowMs: number,
): number {
  const startedAtMs = source(value).startedAtMs;
  return Number.isFinite(startedAtMs)
    ? Math.floor(startedAtMs as number)
    : nowMs;
}

export function withdrawalSubmittedAtForPersistence(
  value: WithdrawalDocument,
  now: () => number,
): number {
  const submittedAtMs = source(value).submittedAtMs;
  return Number.isFinite(submittedAtMs) && (submittedAtMs as number) > 0
    ? Math.floor(submittedAtMs as number)
    : now();
}

export function withdrawalStartedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number {
  return Number(source(value).startedAtMs) || completedAtMs;
}

export function withdrawalSubmittedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number {
  return Number(source(value).submittedAtMs) || completedAtMs;
}

export function withdrawalStorageUpdatedAtMs(
  value: WithdrawalDocument,
): number {
  return Number(source(value).updatedAtMs);
}

export type WithdrawalSubmissionEvidence = {
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

export function withdrawalSubmissionStrings(
  value: WithdrawalDocument | null | undefined,
) {
  const record = source(value);
  return {
    signedTransactionBase64: trimmed(record.signedTransactionBase64),
    transactionSignature: trimmed(record.transactionSignature),
    blockhash: trimmed(record.blockhash),
  };
}

export function withdrawalLastValidBlockHeight(
  value: WithdrawalDocument | null | undefined,
): number {
  return Number(source(value).lastValidBlockHeight);
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
  const identity = withdrawalIdentity(value);
  return {
    eventId: identity.eventId,
    prizeId: identity.prizeId,
    assetAddress: identity.assetAddress,
    recipientAddress: withdrawalRecipientAddress(value),
    transactionSignature:
      withdrawalSubmissionStrings(value).transactionSignature,
  };
}

export type WithdrawalClaimFields = {
  status?: never;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard | "";
  entitledProfileId: string;
  profileId: string;
  place: number;
  recipientAddress: string;
  requesterUid: string;
  leaseId: string;
  leaseExpiresAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
};

function writeWithdrawalClaim(
  previous: WithdrawalDocument | null,
  value: WithdrawalClaimFields,
  status: "processing" | "submitted",
): WithdrawalDocument {
  return readWithdrawalDocument({
    ...(previous ? source(previous) : {}),
    eventId: value.eventId,
    prizeId: value.prizeId,
    assetAddress: value.assetAddress,
    ...(value.assetStandard ? { assetStandard: value.assetStandard } : {}),
    entitledProfileId: value.entitledProfileId,
    profileId: value.profileId,
    place: value.place,
    recipientAddress: value.recipientAddress,
    requesterUid: value.requesterUid,
    status,
    leaseId: value.leaseId,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    startedAtMs: value.startedAtMs,
    updatedAtMs: value.updatedAtMs,
  })!;
}

export function writeProcessingWithdrawal(
  value: WithdrawalClaimFields,
): WithdrawalDocument {
  return writeWithdrawalClaim(null, value, "processing");
}

export function writeReacquiredSubmittedWithdrawal(
  previous: WithdrawalDocument,
  value: WithdrawalClaimFields,
): WithdrawalDocument {
  return writeWithdrawalClaim(previous, value, "submitted");
}

export function writeBlockedWithdrawal(
  current: WithdrawalDocument,
  observedOwner: string,
  updatedAtMs: number,
): WithdrawalDocument {
  return readWithdrawalDocument({
    ...source(current),
    status: "blocked",
    observedOwner,
    updatedAtMs,
    leaseId: null,
    leaseExpiresAtMs: null,
  })!;
}

export function writeSubmittedWithdrawal(
  current: WithdrawalDocument,
  evidence: WithdrawalSubmissionEvidence,
  submittedAtMs: number,
  updatedAtMs: number,
): WithdrawalDocument {
  return readWithdrawalDocument({
    ...source(current),
    status: "submitted",
    transactionSignature: evidence.transactionSignature,
    signedTransactionBase64: evidence.signedTransactionBase64,
    blockhash: evidence.blockhash,
    lastValidBlockHeight: evidence.lastValidBlockHeight,
    submittedAtMs,
    updatedAtMs,
  })!;
}

export type CompletedWithdrawalWrite = {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard | "";
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

export function writeCompletedWithdrawal(
  value: CompletedWithdrawalWrite,
): CompletedWithdrawalDocument {
  return value as object as CompletedWithdrawalDocument;
}
