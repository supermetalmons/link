import type { WithdrawalRecord } from "./types.js";
import type { WithdrawalRecordStorage } from "./storage.js";
import {
  withdrawalStatus,
  withdrawalLeaseId,
  withdrawalSubmissionStrings,
  withdrawalLastValidBlockHeight,
  withdrawalSubmittedAtForPersistence,
  writeBlockedWithdrawal,
  writeSubmittedWithdrawal,
  type WithdrawalDocument,
} from "./records.js";
import type { WithdrawalClaimInput } from "../eventPrizeWithdrawalState.js";
import * as crypto from "node:crypto";
import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import {
  decideWithdrawalClaim,
  isWithdrawalRecordForPrize,
} from "../eventPrizeWithdrawalState.js";

export function createWithdrawalRecordCommands(
  storage: WithdrawalRecordStorage,
): WithdrawalRecord {
  return {
    read: () => storage.read(),
    claim(input) {
      return storage.transaction((current) => {
        const decision = decideWithdrawalClaim({
          ...input,
          current,
          nowMs: Date.now(),
        });
        return {
          value:
            decision.kind === "acquired" ? decision.value : (current ?? null),
        };
      });
    },
    releaseProcessing(leaseId) {
      return storage.transaction((current) =>
        withdrawalStatus(current) === "processing" &&
        withdrawalLeaseId(current) === leaseId
          ? { value: null }
          : { value: current ?? null },
      );
    },
    block({ leaseId, observedOwner }) {
      return storage.transaction((current) => {
        if (
          !current ||
          withdrawalStatus(current) === "completed" ||
          withdrawalLeaseId(current) !== leaseId
        ) {
          return { value: current ?? null };
        }
        return {
          value: writeBlockedWithdrawal(current, observedOwner, Date.now()),
        };
      });
    },
    persistSubmission({ leaseId, ...evidence }) {
      return storage.transaction((current) => {
        if (
          !current ||
          withdrawalStatus(current) === "completed" ||
          withdrawalLeaseId(current) !== leaseId
        ) {
          return { value: current ?? null };
        }
        return {
          value: writeSubmittedWithdrawal(
            current,
            evidence,
            withdrawalSubmittedAtForPersistence(current, Date.now),
            Date.now(),
          ),
        };
      });
    },
    discardSubmission({ leaseId, transactionSignature }) {
      return storage.transaction((current) =>
        withdrawalStatus(current) === "submitted" &&
        withdrawalLeaseId(current) === leaseId &&
        withdrawalSubmissionStrings(current).transactionSignature ===
          transactionSignature
          ? { value: null, decision: "discarded" }
          : { commit: false, decision: "stale" },
      );
    },
  };
}

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
  | { completed: WithdrawalDocument; leaseId?: never; withdrawal?: never }
  | { leaseId: string; withdrawal: WithdrawalDocument; completed?: never }
> => {
  const leaseId = crypto.randomBytes(16).toString("hex");
  const decide = (current: WithdrawalDocument | null) =>
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
    const result = await withdrawalRecord.claim({
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
    });
    const withdrawal = result.value;
    if (
      result.committed &&
      withdrawalLeaseId(withdrawal) === leaseId &&
      (withdrawalStatus(withdrawal) === "processing" ||
        withdrawalStatus(withdrawal) === "submitted") &&
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
  await withdrawalRecord.releaseProcessing(leaseId);
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
  await withdrawalRecord.block({ leaseId, observedOwner });
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
}): Promise<WithdrawalDocument> => {
  const result = await withdrawalRecord.persistSubmission({
    leaseId,
    transactionSignature,
    signedTransactionBase64,
    blockhash,
    lastValidBlockHeight,
  });
  const persisted = result.value;
  if (
    !result.committed ||
    withdrawalStatus(persisted) !== "submitted" ||
    withdrawalLeaseId(persisted) !== leaseId ||
    withdrawalSubmissionStrings(persisted).transactionSignature !==
      transactionSignature ||
    withdrawalSubmissionStrings(persisted).signedTransactionBase64 !==
      signedTransactionBase64 ||
    withdrawalSubmissionStrings(persisted).blockhash !== blockhash ||
    withdrawalLastValidBlockHeight(persisted) !== lastValidBlockHeight
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return persisted!;
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
  const result = await withdrawalRecord.discardSubmission({
    leaseId,
    transactionSignature,
  });
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
