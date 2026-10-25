import { observeManualRecoveryResult } from "./deliveryRecoveryRecords.js";
import {
  captureSafeRetryProof,
  safeRetryProofIdentity,
  captureDesiredWindowProof,
  desiredWindowProofState,
  captureCleanupWindowProof,
  cleanupWindowProofState,
  readRateLimitRetryState,
  resumedRateLimitRetryInput,
  rateLimitBarrierInput,
  desiredSafeProofInput,
  desiredWindowProofInput,
  cleanupWindowProofInput,
  rateLimitProofOwner,
  type RetainedTelegramProofInput,
  type RetainedTelegramOwner,
} from "./retryRecords.js";
import type { TelegramRetryProofDocument } from "./records.js";

import {
  applySafeRetryProofRecord,
  applyDesiredRetryProofRecord,
  applyManualRecoveryRecord,
  settleManualGateReleaseRecord,
  applyCleanupRetryProofRecord,
} from "./deliveryRecoveryRecords.js";
import { messageDocument } from "./records.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";

import {
  ensureCommitted,
  normalizeString,
  type ProofInput,
} from "./deliveryState.js";
import type { TelegramRepository } from "./deliveryTypes.js";

type RateLimitProofRecoveryInput = {
  messageKey: string;
  proof: TelegramRetryProofDocument;
  requestedRevision: string;
  nowMs: number;
  target:
    | { kind: "desired" }
    | { kind: "pending-delete"; requestedPendingDeleteId?: string };
};

export function createTelegramDeliveryRecovery({
  repository,
  now,
  control,
}: {
  repository: TelegramRepository;
  now: () => number;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "scheduleExactRetry"
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
}) {
  const {
    transact,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const applySafeRetryProof = async (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
  ) => {
    const application = captureSafeRetryProof(input);
    const { normalizedAttemptId, normalizedRevision } =
      safeRetryProofIdentity(application);
    if (!normalizedAttemptId || !normalizedRevision) return { applied: false };
    let applied = false;
    const result = await transact(messageKey, (record) =>
      applySafeRetryProofRecord(messageDocument(record), {
        normalizedAttemptId,
        normalizedRevision,
        now,
        application,
        markApplied: () => {
          applied = true;
        },
      }),
    );
    return { applied: applied && result.committed };
  };
  const applyDesiredRetryWindowProof = async (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
  ) => {
    const application = captureDesiredWindowProof(input);
    const state = desiredWindowProofState(application);
    if (!state) return { applied: false };
    const { normalizedRevision, proofRetryState } = state;
    let applied = false;
    const result = await transact(messageKey, (record) =>
      applyDesiredRetryProofRecord(messageDocument(record), {
        normalizedRevision,
        now,
        proofRetryState,
        application,
        markApplied: () => {
          applied = true;
        },
      }),
    );
    return { applied: applied && result.committed };
  };
  const applyManualRecovery = async (messageKey: string) => {
    const processedAtMs = now();
    const result = await transact(messageKey, (record) =>
      applyManualRecoveryRecord(messageDocument(record), { processedAtMs }),
    );
    return observeManualRecoveryResult(result);
  };
  const settleManualApiGateRelease = async (
    messageKey: string,
    ownerInput: string | RetainedTelegramOwner | undefined,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await repository.releaseApiGate(owner);
    ensureCommitted(
      await transact(messageKey, (record) =>
        settleManualGateReleaseRecord(messageDocument(record), { owner }),
      ),
      "manual-gate-release-finalization-failed",
    );
  };
  const applyPendingDeleteRetryWindowProof = async (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
  ) => {
    const application = captureCleanupWindowProof(input);
    const state = cleanupWindowProofState(application);
    if (!state) return { applied: false };
    const { normalizedPendingDeleteId, proofRetryState } = state;
    let applied = false;
    const result = await transact(messageKey, (record) =>
      applyCleanupRetryProofRecord(messageDocument(record), {
        normalizedPendingDeleteId,
        now,
        proofRetryState,
        application,
        markApplied: () => {
          applied = true;
        },
      }),
    );
    return { applied: applied && result.committed };
  };
  const resumeRateLimitProof = async ({
    messageKey,
    proof,
    requestedRevision,
    nowMs,
    target,
  }: RateLimitProofRecoveryInput): Promise<void> => {
    const proofRetryState = readRateLimitRetryState(proof);
    await scheduleExactRetry(
      resumedRateLimitRetryInput(proof, {
        messageKey,
        requestedRevision,
        nowMs,
        target,
        retryState: proofRetryState,
      }),
    );
    let barrierProof = { applied: false };
    try {
      barrierProof = await applyRateLimitBarrierProof(
        rateLimitBarrierInput(proof),
      );
    } catch (_error) {
      barrierProof = { applied: false };
    }
    if (!barrierProof.applied) return;
    if (target.kind === "desired") {
      await applySafeRetryProof(
        messageKey,
        desiredSafeProofInput(proof, proofRetryState),
      );
      await applyDesiredRetryWindowProof(
        messageKey,
        desiredWindowProofInput(proof, proofRetryState),
      );
    } else {
      await applyPendingDeleteRetryWindowProof(
        messageKey,
        cleanupWindowProofInput(proof, proofRetryState, target),
      );
    }
    await clearAppliedRateLimitProofMarker(
      messageKey,
      rateLimitProofOwner(proof),
    );
  };
  return {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    applyPendingDeleteRetryWindowProof,
    resumeRateLimitProof,
  };
}
export type TelegramDeliveryRecovery = ReturnType<
  typeof createTelegramDeliveryRecovery
>;
