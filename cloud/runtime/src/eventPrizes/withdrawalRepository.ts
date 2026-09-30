import type { WithdrawalData, WithdrawalRecord } from "./types.js";
import type { WithdrawalClaimInput } from "../eventPrizeWithdrawalState.js";
import * as crypto from "node:crypto";
import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import {
  decideWithdrawalClaim,
  isWithdrawalRecordForPrize,
} from "../eventPrizeWithdrawalState.js";

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const acquireWithdrawalClaim = async ({
  withdrawalRecord,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
}: Omit<WithdrawalClaimInput, "current" | "leaseId" | "nowMs"> & {
  withdrawalRecord: WithdrawalRecord;
}): Promise<
  | { completed: WithdrawalData; leaseId?: never; withdrawal?: never }
  | { leaseId: string; withdrawal: WithdrawalData; completed?: never }
> => {
  const leaseId = crypto.randomBytes(16).toString("hex");
  const decide = (current: unknown) =>
    decideWithdrawalClaim({
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
      nowMs: Date.now(),
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withdrawalRecord.transaction((current) => {
      const decision = decide(current);
      return {
        value:
          decision.kind === "acquired" ? decision.value : (current ?? null),
      };
    });
    const withdrawal = result.value;
    if (
      result.committed &&
      normalizeString(withdrawal?.leaseId) === leaseId &&
      ["processing", "submitted"].includes(withdrawal?.status as string) &&
      isWithdrawalRecordForPrize(withdrawal, eventId, prizeId, assetAddress)
    ) {
      return { leaseId, withdrawal: withdrawal! };
    }
    const decision = decide(withdrawal);
    if (decision?.kind === "acquired") {
      continue;
    }
    if (decision?.kind === "completed") {
      return { completed: decision.value };
    }
    if (decision?.kind === "busy") {
      throw new HttpsError(
        "aborted",
        "This prize withdrawal is already being processed.",
      );
    }
    if (decision?.kind === "destination-mismatch") {
      throw new HttpsError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    if (decision?.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This prize is unavailable for withdrawal.",
      );
    }
    throw new HttpsError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  throw new HttpsError(
    "aborted",
    "Prize withdrawal changed. Please try again.",
  );
};

const releaseProcessingClaim = async ({
  withdrawalRecord,
  leaseId,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
}) => {
  await withdrawalRecord.transaction((current) => {
    if (
      current?.status === "processing" &&
      normalizeString(current.leaseId) === leaseId
    ) {
      return { value: null };
    }
    return { value: current ?? null };
  });
};

const markWithdrawalBlocked = async ({
  withdrawalRecord,
  leaseId,
  observedOwner,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  observedOwner: string;
}) => {
  await withdrawalRecord.transaction((current) => {
    if (
      !current ||
      current.status === "completed" ||
      normalizeString(current.leaseId) !== leaseId
    ) {
      return { value: current ?? null };
    }
    return {
      value: {
        ...current,
        status: "blocked",
        observedOwner,
        updatedAtMs: Date.now(),
        leaseId: null,
        leaseExpiresAtMs: null,
      },
    };
  });
};

const persistSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
  signedTransactionBase64,
  blockhash,
  lastValidBlockHeight,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}): Promise<WithdrawalData> => {
  const result = await withdrawalRecord.transaction((current) => {
    if (
      !current ||
      current.status === "completed" ||
      normalizeString(current.leaseId) !== leaseId
    ) {
      return { value: current ?? null };
    }
    return {
      value: {
        ...current,
        status: "submitted",
        transactionSignature,
        signedTransactionBase64,
        blockhash,
        lastValidBlockHeight,
        submittedAtMs:
          Number.isFinite(current.submittedAtMs) &&
          (current.submittedAtMs as number) > 0
            ? Math.floor(current.submittedAtMs as number)
            : Date.now(),
        updatedAtMs: Date.now(),
      },
    };
  });
  const persisted = result.value;
  if (
    !result.committed ||
    persisted?.status !== "submitted" ||
    normalizeString(persisted.leaseId) !== leaseId ||
    normalizeString(persisted.transactionSignature) !== transactionSignature ||
    normalizeString(persisted.signedTransactionBase64) !==
      signedTransactionBase64 ||
    normalizeString(persisted.blockhash) !== blockhash ||
    Number(persisted.lastValidBlockHeight) !== lastValidBlockHeight
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return persisted;
};

const discardDefinitiveSubmittedTransaction = async ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  transactionSignature: string;
}) => {
  const result = await withdrawalRecord.transaction((current) =>
    current?.status === "submitted" &&
    normalizeString(current.leaseId) === leaseId &&
    normalizeString(current.transactionSignature) === transactionSignature
      ? { value: null, decision: "discarded" }
      : { commit: false, decision: "stale" },
  );
  if (
    !result.committed ||
    result.decision !== "discarded" ||
    result.value !== null
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal changed. Please try again.",
    );
  }
};

export {
  acquireWithdrawalClaim,
  discardDefinitiveSubmittedTransaction,
  markWithdrawalBlocked,
  persistSubmittedTransaction,
  releaseProcessingClaim,
};
