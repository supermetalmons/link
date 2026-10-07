import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import {
  buildErrorState,
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
  omitRetryState,
  resolveRetryDeadlineAtMs,
} from "./deliveryPolicy.js";
import type { TelegramDeliveryRecovery } from "./deliveryRecovery.js";
import type {
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  asObject,
  buildApiGateOwner,
  ensureCommitted,
  normalizeString,
  omitKeys,
  promotePendingDeleteQueue,
  readDelivery,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  type CleanupAcquireDecision,
} from "./deliveryState.js";
import type {
  TelegramEngineResult,
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import {
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
} from "./taskKinds.js";
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
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
  recovery: Pick<
    TelegramDeliveryRecovery,
    "applyPendingDeleteRetryWindowProof"
  >;
}) {
  const {
    transact,
    retryCoordinator,
    settlePersistedApiGate,
    acquireApiGate,
    buildGateBlockedFailure,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const { applyPendingDeleteRetryWindowProof } = recovery;
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
    apiGateSettleOwner?: unknown;
  }) =>
    ensureCommitted(
      await transact(messageKey, (record) => {
        const delivery = readDelivery(record.delivery);
        const pendingDelete = readPendingDelete(delivery.pendingDelete);
        if (
          normalizeString(pendingDelete.pendingDeleteId) !== pendingDeleteId ||
          (ownerToken &&
            normalizeString(pendingDelete.leaseOwner) !== ownerToken)
        ) {
          return { commit: false, decision: "pending-delete-lost" };
        }
        const orphanedDeletes = asObject(delivery.orphanedDeletes);
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...orphanedDeletes,
            [pendingDeleteId]: {
              ...omitRetryState(
                omitKeys(pendingDelete, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "status",
                ]),
              ),
              terminalAtMs: nowMs,
              lastError: buildErrorState(result, nowMs),
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(normalizeString(apiGateSettleOwner)
                ? { pendingDeleteApiGateSettleOwner: apiGateSettleOwner }
                : {}),
            },
          },
          decision: "pending-delete-orphaned",
        };
      }),
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
    pendingDelete: unknown;
    pendingDeleteId: string;
    ownerToken: string;
    result: TelegramRetryFailure;
    apiGateOwner?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: asObject(pendingDelete),
      failure: result,
      target: { kind: TELEGRAM_PENDING_DELETE_TASK_KIND, pendingDeleteId },
      messageKey,
      revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await transact(messageKey, (record) => {
            const delivery = readDelivery(record.delivery);
            const latestPendingDelete = readPendingDelete(
              delivery.pendingDelete,
            );
            if (
              normalizeString(latestPendingDelete.pendingDeleteId) !==
                pendingDeleteId ||
              normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
            ) {
              return { commit: false, decision: "pending-delete-lost" };
            }
            return {
              value: {
                ...record,
                delivery: {
                  ...delivery.source,
                  pendingDelete: {
                    ...latestPendingDelete.source,
                    apiGateProofRequired: {
                      owner: apiGateOwner,
                      retryNotBeforeMs: barrierRetryNotBeforeMs,
                      revision,
                      proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
                      pendingDeleteId,
                      retryProofLeaseOwner: ownerToken,
                      ...retryState,
                    },
                  },
                },
              },
              decision: "pending-rate-limit-proof-required",
            };
          }),
          "pending-rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await transact(messageKey, (record) => {
          const delivery = readDelivery(record.delivery);
          const latestPendingDelete = readPendingDelete(delivery.pendingDelete);
          if (
            normalizeString(latestPendingDelete.pendingDeleteId) !==
              pendingDeleteId ||
            normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
          ) {
            return { commit: false, decision: "pending-delete-lost" };
          }
          return {
            value: {
              ...record,
              delivery: {
                ...delivery.source,
                pendingDelete: writeCleanup({
                  ...omitRetryState(
                    omitKeys(latestPendingDelete, [
                      "leaseOwner",
                      "leaseExpiresAtMs",
                      "lastError",
                      ...(preserveApiGateIdentity
                        ? []
                        : [
                            "apiGateOwner",
                            "apiGateGeneration",
                            "apiGateStartedAtMs",
                            "apiGateProofRequired",
                          ]),
                    ]),
                  ),
                  status: "retryable",
                  ...retryState,
                  lastError: buildErrorState(result, finalizedAtMs),
                }),
              },
            },
            decision: "pending-delete-retryable",
          };
        });
        if (!finalization.committed) {
          const current = asObject(await repository.getMessage(messageKey));
          const currentPendingDelete = asObject(
            readProperty(current.delivery, "pendingDelete"),
          );
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentPendingDelete.retrySequence) >=
              retryState.retrySequence &&
            normalizeString(
              readProperty(currentPendingDelete.apiGateProofRequired, "owner"),
            ) !== normalizeString(apiGateOwner);
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
  }): Promise<TelegramEngineResult> => {
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
    const acquired = await transact(normalizedMessageKey, (record) => {
      const delivery = readDelivery(record.delivery);
      const pendingDelete = readPendingDelete(delivery.pendingDelete);
      if (delivery.status === "uncertain" || delivery.sendInFlight) {
        decision = "blocked-uncertain";
        return { commit: false, decision };
      }
      const chatId = normalizeString(pendingDelete.chatId);
      const messageId = Number(pendingDelete.messageId);
      if (!pendingDelete.present) {
        decision = "missing";
        return { commit: false, decision };
      }
      const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
      if (
        requestedPendingDeleteId &&
        requestedPendingDeleteId !== pendingDeleteId
      ) {
        decision = "stale";
        return { commit: false, decision };
      }
      const currentApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const currentProofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        decision = "rate-limit-proof-pending";
        return { commit: false, decision };
      }
      if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
        decision = "invalid";
        const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...asObject(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...pendingDelete.source,
              pendingDeleteId,
              terminalAtMs: nowMs,
              lastError: {
                code: "invalid-pending-delete",
                atMs: nowMs,
              },
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(shouldSettleApiGate
                ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
                : {}),
            },
          },
          decision,
        };
      }
      const retryDeadlineAtMs = resolveRetryDeadlineAtMs(pendingDelete);
      const leaseExpiresAtMs = normalizeTimestamp(
        pendingDelete.leaseExpiresAtMs,
      );
      if (
        pendingDelete.status === "processing" &&
        normalizeString(pendingDelete.leaseOwner) !== ownerToken &&
        leaseExpiresAtMs > nowMs
      ) {
        decision = "locked";
        return { commit: false, decision };
      }
      if (
        ["pending", "processing", "retryable"].includes(
          pendingDelete.status as string,
        ) &&
        retryDeadlineAtMs > 0 &&
        retryDeadlineAtMs <= nowMs
      ) {
        decision = "exhausted";
        const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...asObject(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...omitRetryState(pendingDelete.source),
              pendingDeleteId,
              terminalAtMs: nowMs,
              lastError: {
                code: "safe-retry-window-exhausted",
                atMs: nowMs,
              },
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(shouldSettleApiGate
                ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
                : {}),
            },
          },
          decision,
        };
      }
      if (
        pendingDelete.status === "retryable" &&
        normalizeTimestamp(pendingDelete.retryAtMs) > nowMs
      ) {
        decision = "deferred";
        return { commit: false, decision };
      }
      decision = "acquired";
      const apiGateGeneration =
        normalizeString(pendingDelete.apiGateGeneration) ||
        normalizeString(requestedGeneration) ||
        `direct:${pendingDeleteId}`;
      return {
        value: {
          ...record,
          delivery: {
            ...delivery.source,
            pendingDelete: writeCleanup({
              ...pendingDelete.source,
              pendingDeleteId,
              status: "processing",
              attempts: normalizeAttempts(pendingDelete.attempts) + 1,
              leaseOwner: ownerToken,
              leaseExpiresAtMs: nowMs + leaseTtlMs,
              startedAtMs: nowMs,
              apiGateOwner:
                normalizeString(pendingDelete.apiGateOwner) ||
                buildApiGateOwner(
                  normalizedMessageKey,
                  "pending-delete",
                  pendingDeleteId,
                  apiGateGeneration,
                ),
              apiGateGeneration,
              apiGateStartedAtMs:
                normalizeTimestamp(pendingDelete.apiGateStartedAtMs) || nowMs,
            }),
          },
        },
        decision,
      };
    });
    if (decision === "missing" || decision === "stale") {
      return { status: "settled", cleanup: decision };
    }
    if (decision === "blocked-uncertain") {
      return { status: "uncertain", cleanup: decision };
    }
    if (decision === "rate-limit-proof-pending") {
      const proof = asObject(
        readProperty(
          readProperty(acquired.value?.delivery, "pendingDelete"),
          "apiGateProofRequired",
        ),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(proof.retryAtMs),
        retrySequence: normalizeRetrySequence(proof.retrySequence),
      };
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(proof.revision) || requestedRevision || "latest",
        taskKind: TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        pendingDeleteId:
          normalizeString(proof.pendingDeleteId) || requestedPendingDeleteId,
        retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
        proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
          pendingDeleteId:
            normalizeString(proof.pendingDeleteId) || requestedPendingDeleteId,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        cleanup: decision,
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (decision === "invalid" || decision === "exhausted") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: readProperty(
          acquired.value?.delivery,
          "pendingDeleteApiGateSettleOwner",
        ),
      });
      return { status: "settled", cleanup: decision };
    }
    if (decision === "deferred" || decision === "locked") {
      const pendingDelete = readPendingDelete(
        readProperty(acquired.value?.delivery, "pendingDelete"),
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
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
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
      readProperty(acquired.value?.delivery, "pendingDelete"),
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
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
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
        normalizeString(readProperty(acquired.value?.desired, "revision")) ||
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
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
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
    const result = await client.deleteTelegramMessage({
      chatId: pendingDelete.chatId,
      messageId: pendingDelete.messageId,
    });
    if (result.ok) {
      ensureCommitted(
        await transact(normalizedMessageKey, (record) => {
          const delivery = readDelivery(record.delivery);
          const latestPendingDelete = readPendingDelete(delivery.pendingDelete);
          if (
            normalizeString(latestPendingDelete.pendingDeleteId) !==
              pendingDeleteId ||
            normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
          ) {
            return { commit: false, decision: "pending-delete-lost" };
          }
          return {
            value: {
              ...record,
              delivery: {
                ...promotePendingDeleteQueue(delivery),
                pendingDeleteApiGateSettleOwner: apiGateOwner,
              },
            },
            decision: "pending-delete-cleared",
          };
        }),
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
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
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
