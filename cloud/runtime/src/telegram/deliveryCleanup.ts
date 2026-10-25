import { retryDocument } from "./deliveryState.js";
import type { TelegramCleanupDocument } from "./records.js";
import {
  messageRateLimitProof,
  rateLimitProofRetryAt,
  messageSettlementOwnerInput,
  type RetainedTelegramOwner,
} from "./retryRecords.js";
import { messageDeliveryDocument, messageDesiredDocument } from "./records.js";
import {
  orphanPendingDeleteRecord,
  recordCleanupRetryProof,
  recordCleanupRetryState,
  acquirePendingDeleteRecord,
  clearPendingDeleteRecord,
} from "./deliveryCleanupRecords.js";
import { messageDocument } from "./records.js";
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import {
  normalizeRetrySequence,
  normalizeTimestamp,
  resolveRetryDeadlineAtMs,
} from "./deliveryPolicy.js";
import type { TelegramDeliveryRecovery } from "./deliveryRecovery.js";
import type {
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  ensureCommitted,
  normalizeString,
  readPendingDelete,
  resolvePendingDeleteId,
  type CleanupAcquireDecision,
  PendingDeleteSnapshot,
} from "./deliveryState.js";
import type {
  TelegramCleanupResult,
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import { TELEGRAM_PENDING_DELETE_TASK_KIND } from "./taskKinds.js";
import { readProperty } from "./values.js";
export function createTelegramCleanupDelivery({
  repository,
  client,
  now,
  createOwnerToken,
  leaseTtlMs,
  localRetryBarrier,
  control,
  recovery,
}: {
  repository: TelegramRepository;
  client: TelegramClient;
  now: () => number;
  createOwnerToken: () => string;
  leaseTtlMs: number;
  localRetryBarrier: TelegramLocalRetryBarrier;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "retryCoordinator"
    | "settlePersistedApiGate"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "scheduleExactRetry"
  >;
  recovery: Pick<
    TelegramDeliveryRecovery,
    "applyPendingDeleteRetryWindowProof" | "resumeRateLimitProof"
  >;
}) {
  const {
    transact,
    retryCoordinator,
    settlePersistedApiGate,
    acquireApiGate,
    buildGateBlockedFailure,
    scheduleExactRetry,
  } = control;
  const { applyPendingDeleteRetryWindowProof, resumeRateLimitProof } = recovery;
  const orphanPendingDelete = async ({
    messageKey,
    pendingDeleteId,
    result,
    nowMs,
    ownerToken = "",
    apiGateSettleOwner = "",
  }: {
    messageKey: string;
    pendingDeleteId: string;
    result: TelegramRetryFailure;
    nowMs: number;
    ownerToken?: string;
    apiGateSettleOwner?: string | RetainedTelegramOwner;
  }) =>
    ensureCommitted(
      await transact(messageKey, (record) =>
        orphanPendingDeleteRecord(messageDocument(record), {
          apiGateSettleOwner,
          nowMs,
          ownerToken,
          pendingDeleteId,
          result,
        }),
      ),
      "pending-delete-orphan-finalization-failed",
    );
  const finishPendingDeleteRetryable = async ({
    messageKey,
    revision,
    pendingDelete,
    pendingDeleteId,
    ownerToken,
    result,
    apiGateOwner = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }: {
    messageKey: string;
    revision: string;
    pendingDelete: TelegramCleanupDocument | PendingDeleteSnapshot;
    pendingDeleteId: string;
    ownerToken: string;
    result: TelegramRetryFailure;
    apiGateOwner?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: retryDocument(pendingDelete),
      failure: result,
      target: { kind: TELEGRAM_PENDING_DELETE_TASK_KIND, pendingDeleteId },
      messageKey,
      revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await transact(messageKey, (record) =>
            recordCleanupRetryProof(messageDocument(record), {
              apiGateOwner,
              barrierRetryNotBeforeMs,
              ownerToken,
              pendingDeleteId,
              retryState,
              revision,
            }),
          ),
          "pending-rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await transact(messageKey, (record) =>
          recordCleanupRetryState(messageDocument(record), {
            finalizedAtMs,
            ownerToken,
            pendingDeleteId,
            preserveApiGateIdentity,
            result,
            retryState,
          }),
        );
        if (!finalization.committed) {
          const current = await repository.getMessage(messageKey);
          const currentPendingDelete = readPendingDelete(
            readProperty(messageDeliveryDocument(current), "pendingDelete"),
          );
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentPendingDelete.retrySequence) >=
              retryState.retrySequence &&
            currentPendingDelete.apiGateProofOwner !==
              normalizeString(apiGateOwner);
          if (!proofAlreadyApplied) {
            ensureCommitted(
              finalization,
              "pending-delete-retryable-finalization-failed",
            );
          }
        }
      },
    });
  };
  const reconcilePendingDelete = async ({
    messageKey,
    requestedRevision = "",
    requestedPendingDeleteId = "",
    requestedGeneration = "",
    retryStartedAtMs = 0,
    retryDeadlineAtMs = 0,
    retryAtMs = 0,
    retrySequence = 0,
    retryProofLeaseOwner = "",
    apiGateReclaimOwner = "",
  }: TelegramReconcileInput & {
    requestedPendingDeleteId?: string;
  }): Promise<TelegramCleanupResult> => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
      pendingDeleteId: requestedPendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    });
    const nowMs = now();
    const ownerToken = createOwnerToken();
    let decision: CleanupAcquireDecision = "missing";
    const acquired = await transact(normalizedMessageKey, (record) =>
      acquirePendingDeleteRecord(messageDocument(record), {
        leaseTtlMs,
        normalizedMessageKey,
        nowMs,
        ownerToken,
        requestedGeneration,
        requestedPendingDeleteId,
        observeDecision: (value) => {
          decision = value;
        },
      }),
    );
    if (decision === "missing" || decision === "stale") {
      return { status: "settled", cleanup: decision };
    }
    if (decision === "blocked-uncertain") {
      return { status: "uncertain", cleanup: decision };
    }
    if (decision === "rate-limit-proof-pending") {
      const proof = messageRateLimitProof(
        messageDeliveryDocument(acquired.value),
        true,
      );
      await resumeRateLimitProof({
        messageKey: normalizedMessageKey,
        proof,
        requestedRevision,
        nowMs,
        target: { kind: "pending-delete", requestedPendingDeleteId },
      });
      return {
        status: "retryable",
        cleanup: decision,
        retryAtMs: rateLimitProofRetryAt(proof),
        scheduled: true,
      };
    }
    if (decision === "invalid" || decision === "exhausted") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: messageSettlementOwnerInput(
          acquired.value,
          "pendingDeleteApiGateSettleOwner",
        ),
      });
      return { status: "settled", cleanup: decision };
    }
    if (decision === "deferred" || decision === "locked") {
      const pendingDelete = readPendingDelete(
        readProperty(messageDeliveryDocument(acquired.value), "pendingDelete"),
      );
      const lockedGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const lockedGateGeneration = normalizeString(
        pendingDelete.apiGateGeneration,
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        (normalizeString(apiGateReclaimOwner) === lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration === normalizeString(requestedGeneration)));
      const retryAtMs =
        decision === "deferred"
          ? normalizeTimestamp(pendingDelete.retryAtMs)
          : normalizeTimestamp(pendingDelete.leaseExpiresAtMs) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(
            readProperty(messageDesiredDocument(acquired.value), "revision"),
          ) ||
          requestedRevision ||
          "latest",
        taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryStartedAtMs: pendingDelete.retryTimestampOr(
            "retryStartedAtMs",
            retryStartedAtMs,
          ),
          retryDeadlineAtMs: pendingDelete.retryTimestampOr(
            "retryDeadlineAtMs",
            retryDeadlineAtMs,
          ),
          retryAtMs,
          retrySequence: pendingDelete.retrySequenceOr(retrySequence),
        },
        pendingDeleteId: resolvePendingDeleteId(pendingDelete),
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return { status: "retryable", retryAtMs, scheduled: true };
    }
    if (decision !== "acquired") {
      return { status: "settled", cleanup: "missing" };
    }
    const pendingDelete = readPendingDelete(
      readProperty(messageDeliveryDocument(acquired.value), "pendingDelete"),
    );
    const pendingDeleteId = normalizeString(pendingDelete.pendingDeleteId);
    const callAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= callAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: callAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const barrierCheckedAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= barrierCheckedAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: barrierCheckedAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(
            readProperty(messageDesiredDocument(acquired.value), "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        preserveApiGateIdentity: Boolean(pendingDelete.apiGateOwner),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
    const pendingGateGeneration = normalizeString(
      pendingDelete.apiGateGeneration,
    );
    const proofRequiredOwner = normalizeString(
      readProperty(pendingDelete.apiGateProofRequired, "owner"),
    );
    const mayReclaimApiGate =
      apiGateOwner !== "" && proofRequiredOwner !== apiGateOwner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision:
        normalizeString(
          readProperty(messageDesiredDocument(acquired.value), "revision"),
        ) ||
        requestedRevision ||
        "latest",
      operation: "pending-delete",
      owner: apiGateOwner,
      pendingDeleteId,
      reclaimOwner: mayReclaimApiGate ? apiGateOwner : "",
      taskGeneration: pendingGateGeneration,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(
            readProperty(messageDesiredDocument(acquired.value), "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const deleteCallAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= deleteCallAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: deleteCallAtMs,
        ownerToken,
        apiGateSettleOwner: apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const result = await client.deleteTelegramMessage(
      pendingDelete.deleteInput(),
    );
    if (result.ok) {
      ensureCommitted(
        await transact(normalizedMessageKey, (record) =>
          clearPendingDeleteRecord(messageDocument(record), {
            apiGateOwner,
            ownerToken,
            pendingDeleteId,
          }),
        ),
        "pending-delete-finalization-failed",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "deleted" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(
            readProperty(messageDesiredDocument(acquired.value), "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await orphanPendingDelete({
      messageKey: normalizedMessageKey,
      pendingDeleteId,
      result,
      nowMs: now(),
      ownerToken,
      apiGateSettleOwner: apiGateOwner,
    });
    await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "pendingDeleteApiGateSettleOwner",
      owner: apiGateOwner,
    });
    return { status: "settled", cleanup: "orphaned" };
  };
  return { reconcilePendingDelete };
}
