import * as crypto from "node:crypto";
import { createTelegramCleanupDelivery } from "./deliveryCleanup.js";
import { createTelegramDeliveryControl } from "./deliveryControl.js";
import { createTelegramDesiredDelivery } from "./deliveryDesired.js";
import {
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  createTelegramLocalRetryBarrier,
  normalizeRetrySequence,
} from "./deliveryPolicy.js";
import { createTelegramDeliveryRecovery } from "./deliveryRecovery.js";
import {
  asObject,
  normalizeString,
  readPendingDelete,
  resolvePendingDeleteId,
} from "./deliveryState.js";
import type {
  TelegramEngineOptions,
  TelegramEngineResult,
  TelegramReconcileInput,
} from "./deliveryTypes.js";
import {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
} from "./desiredStateCore.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
} from "./taskKinds.js";
import { readProperty } from "./values.js";
export type {
  TelegramApiGateResult,
  TelegramEngineOptions,
  TelegramEngineResult,
  TelegramReconcileInput,
  TelegramRepository,
  TelegramRetrySchedule,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";

const TELEGRAM_LEASE_TTL_MS = 60_000;
const moduleRetryBarrier = createTelegramLocalRetryBarrier();
const createTelegramDeliveryEngine: (input: TelegramEngineOptions) => {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
} = ({
  repository,
  client,
  resolveDestination = resolveTelegramDestination,
  now = Date.now,
  createOwnerToken = () => crypto.randomUUID(),
  createAttemptId = () => crypto.randomUUID(),
  scheduleRetry = async () => ({ scheduled: true }),
  logger = console,
  leaseTtlMs = TELEGRAM_LEASE_TTL_MS,
  localRetryBarrier = moduleRetryBarrier,
}: Partial<TelegramEngineOptions> = {}): {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
} => {
  if (!repository || typeof repository.transactMessage !== "function") {
    throw new TypeError("repository.transactMessage is required");
  }
  if (
    !client ||
    typeof client.sendTelegramMessage !== "function" ||
    typeof client.editTelegramMessage !== "function" ||
    typeof client.deleteTelegramMessage !== "function"
  ) {
    throw new TypeError("complete Telegram client is required");
  }
  if (
    typeof repository.getRetryNotBeforeMs !== "function" ||
    typeof repository.extendRetryNotBeforeMs !== "function" ||
    typeof repository.acquireApiGate !== "function" ||
    typeof repository.releaseApiGate !== "function" ||
    typeof repository.extendRetryBarrierAndReleaseApiGate !== "function"
  ) {
    throw new TypeError("repository delivery control methods are required");
  }
  if (
    !localRetryBarrier ||
    typeof localRetryBarrier.getRetryNotBeforeMs !== "function" ||
    typeof localRetryBarrier.extendRetryNotBeforeMs !== "function"
  ) {
    throw new TypeError("local retry barrier methods are required");
  }
  if (typeof scheduleRetry !== "function") {
    throw new TypeError("scheduleRetry is required");
  }

  const control = createTelegramDeliveryControl({
    repository,
    logger,
    now,
    scheduleRetry,
    localRetryBarrier,
  });
  const recovery = createTelegramDeliveryRecovery({ repository, now, control });
  const { reconcileDesired } = createTelegramDesiredDelivery({
    repository,
    client,
    resolveDestination,
    now,
    createOwnerToken,
    createAttemptId,
    logger,
    leaseTtlMs,
    localRetryBarrier,
    control,
    recovery,
  });
  const { reconcilePendingDelete } = createTelegramCleanupDelivery({
    repository,
    client,
    now,
    createOwnerToken,
    leaseTtlMs,
    localRetryBarrier,
    control,
    recovery,
  });
  const {
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
    scheduleExactRetry,
  } = control;
  const reconcile = async (
    input: TelegramReconcileInput = { messageKey: "" },
  ): Promise<TelegramEngineResult> => {
    let effectiveInput = input;
    if (input.taskKind === TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND) {
      const proofTaskKind = normalizeString(input.proofTaskKind);
      if (
        proofTaskKind !== TELEGRAM_DESIRED_TASK_KIND &&
        proofTaskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND
      ) {
        return { status: "skipped", reason: "invalid-rate-limit-proof" };
      }
      const barrierProof = await applyRateLimitBarrierProof({
        barrierProofOwner: input.barrierProofOwner,
        barrierRetryNotBeforeMs: input.barrierRetryNotBeforeMs,
      });
      if (!barrierProof.applied) {
        if (normalizeString(barrierProof.gate?.owner)) {
          return { status: "settled", reason: "stale-rate-limit-proof" };
        }
        const error = Object.assign(new Error("rate-limit-proof-not-applied"), {
          code: "rate-limit-proof-not-applied",
          retryable: true,
        });
        throw error;
      }
      await clearAppliedRateLimitProofMarker(
        input.messageKey,
        input.barrierProofOwner,
      );
      effectiveInput = { ...input, taskKind: proofTaskKind };
    }
    const desiredResult = await reconcileDesired(effectiveInput);
    if (
      desiredResult.status === "uncertain" ||
      desiredResult.status === "retryable" ||
      desiredResult.status === "skipped"
    ) {
      return desiredResult;
    }
    const record = asObject(
      await repository.getMessage(effectiveInput.messageKey),
    );
    const pendingDelete = readPendingDelete(
      readProperty(record.delivery, "pendingDelete"),
    );
    if (!pendingDelete.present) {
      return desiredResult;
    }
    const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
    if (effectiveInput.taskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND) {
      await scheduleExactRetry({
        messageKey: effectiveInput.messageKey,
        revision:
          normalizeString(readProperty(record.desired, "revision")) ||
          normalizeString(effectiveInput.requestedRevision) ||
          "latest",
        taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryAtMs: now(),
          retrySequence: normalizeRetrySequence(pendingDelete.retrySequence),
        },
        pendingDeleteId,
        sourceGeneration: effectiveInput.requestedGeneration,
      });
      return { ...desiredResult, cleanupScheduled: true };
    }
    const cleanupResult = await reconcilePendingDelete({
      messageKey: effectiveInput.messageKey,
      requestedRevision: effectiveInput.requestedRevision,
      requestedPendingDeleteId: effectiveInput.pendingDeleteId,
      requestedGeneration: effectiveInput.requestedGeneration,
      retryStartedAtMs: effectiveInput.retryStartedAtMs,
      retryDeadlineAtMs: effectiveInput.retryDeadlineAtMs,
      retryAtMs: effectiveInput.retryAtMs,
      retrySequence: effectiveInput.retrySequence,
      retryProofLeaseOwner: effectiveInput.retryProofLeaseOwner,
      apiGateReclaimOwner: effectiveInput.apiGateReclaimOwner,
    });
    let cleanupScheduled = false;
    if (cleanupResult.status === "settled") {
      const refreshed = asObject(
        await repository.getMessage(effectiveInput.messageKey),
      );
      const nextPendingDelete = readPendingDelete(
        readProperty(refreshed.delivery, "pendingDelete"),
      );
      if (nextPendingDelete.present) {
        const nextPendingDeleteId = resolvePendingDeleteId(nextPendingDelete);
        await scheduleExactRetry({
          messageKey: effectiveInput.messageKey,
          revision:
            normalizeString(readProperty(refreshed.desired, "revision")) ||
            normalizeString(effectiveInput.requestedRevision) ||
            "latest",
          taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
          retryState: {
            retryAtMs: now(),
            retrySequence: normalizeRetrySequence(
              nextPendingDelete.retrySequence,
            ),
          },
          pendingDeleteId: nextPendingDeleteId,
          sourceGeneration: effectiveInput.requestedGeneration,
        });
        cleanupScheduled = true;
      }
    }
    return {
      ...desiredResult,
      cleanup: cleanupResult,
      ...(cleanupScheduled ? { cleanupScheduled: true } : {}),
    };
  };
  return { reconcile };
};

export {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_LEASE_TTL_MS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
