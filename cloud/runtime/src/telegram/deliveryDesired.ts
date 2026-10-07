import type { TransactionResult } from "../transactions.js";
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
import { createTelegramSendDelivery } from "./deliverySend.js";
import {
  asObject,
  ensureCommitted,
  normalizeString,
  omitKeys,
  preserveSendEvidence,
  readDelivery,
  readPendingDelete,
  validateDesiredForDelivery,
  writeDelivery,
  type DeliveredOptions,
  type DeliveryTransition,
  type DesiredAcquireDecision,
  type DesiredContext,
  type FinishStatusInput,
  type RawRecord,
} from "./deliveryState.js";
import type {
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
import type { TelegramDesired } from "./desiredStateCore.js";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
} from "./taskKinds.js";
import { readProperty } from "./values.js";
export function createTelegramDesiredDelivery({
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
}: {
  repository: TelegramRepository;
  client: TelegramClient;
  resolveDestination: (destination: string) => string;
  now: () => number;
  createOwnerToken: () => string;
  createAttemptId: () => string;
  logger: Pick<Console, "error" | "info">;
  leaseTtlMs: number;
  localRetryBarrier: TelegramLocalRetryBarrier;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "updateOwned"
    | "retryCoordinator"
    | "prepareDesiredApiGateIdentity"
    | "settlePersistedApiGate"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "logFailure"
    | "scheduleExactRetry"
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
  recovery: TelegramDeliveryRecovery;
}) {
  const {
    transact,
    updateOwned,
    retryCoordinator,
    prepareDesiredApiGateIdentity,
    settlePersistedApiGate,
    acquireApiGate,
    buildGateBlockedFailure,
    logFailure,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    applyPendingDeleteRetryWindowProof,
  } = recovery;
  const acquire = async (
    messageKey: string,
    ownerToken: string,
    nowMs: number,
  ): Promise<
    TransactionResult<RawRecord> & { decision: DesiredAcquireDecision }
  > => {
    let acquireDecision: DesiredAcquireDecision = "missing";
    const result = await transact(messageKey, (record) => {
      const desired = asObject(record.desired);
      const delivery = readDelivery(record.delivery);
      const desiredRevision = normalizeString(desired.revision);
      const leaseExpiresAtMs = Number(delivery.leaseExpiresAtMs) || 0;
      if (normalizeString(delivery.apiGateSettleOwner)) {
        acquireDecision = "desired-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (normalizeString(delivery.pendingDeleteApiGateSettleOwner)) {
        acquireDecision = "pending-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.status === "processing" &&
        normalizeString(delivery.leaseOwner) !== ownerToken &&
        leaseExpiresAtMs > nowMs
      ) {
        acquireDecision = "locked";
        return { commit: false, decision: acquireDecision };
      }
      const currentApiGateOwner =
        normalizeString(delivery.apiGateOwner) ||
        normalizeString(readProperty(delivery.sendInFlight, "apiGateOwner"));
      const currentProofGateOwner = normalizeString(
        readProperty(delivery.apiGateProofRequired, "owner"),
      );
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        acquireDecision = "rate-limit-proof-pending";
        return { commit: false, decision: acquireDecision };
      }
      const pendingDelete = readPendingDelete(delivery.pendingDelete);
      const pendingApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const pendingProofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      if (
        pendingApiGateOwner &&
        pendingApiGateOwner === pendingProofGateOwner
      ) {
        acquireDecision = "pending-rate-limit-proof-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        pendingApiGateOwner &&
        pendingDelete.status === "processing" &&
        normalizeTimestamp(pendingDelete.leaseExpiresAtMs) <= nowMs
      ) {
        acquireDecision = "pending-api-gate-settle-pending";
        return {
          value: {
            ...record,
            delivery: {
              ...delivery.source,
              pendingDelete: omitKeys(pendingDelete, [
                "apiGateOwner",
                "apiGateGeneration",
              ]),
              pendingDeleteApiGateSettleOwner: pendingApiGateOwner,
            },
          },
          decision: acquireDecision,
        };
      }
      if (delivery.sendInFlight) {
        const sendInFlight = asObject(delivery.sendInFlight);
        const sendApiGateOwner = normalizeString(sendInFlight.apiGateOwner);
        const revision =
          desiredRevision || normalizeString(delivery.revision) || "invalid";
        acquireDecision = "in-flight-uncertain";
        if (delivery.status === "uncertain") {
          if (normalizeString(delivery.revision) === revision) {
            return { commit: false, decision: acquireDecision };
          }
          return {
            value: {
              ...record,
              delivery: writeDelivery({
                ...delivery.source,
                status: "uncertain",
                revision,
                attempts: 0,
                sendInFlight: preserveSendEvidence(sendInFlight),
              }),
            },
            decision: acquireDecision,
          };
        }
        return {
          value: {
            ...record,
            delivery: writeDelivery({
              ...omitKeys(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "retryAtMs",
              ]),
              status: "uncertain",
              revision,
              uncertainAtMs: nowMs,
              uncertainReason: "abandoned-send-in-flight",
              sendInFlight: preserveSendEvidence(sendInFlight),
              ...(sendApiGateOwner
                ? { apiGateSettleOwner: sendApiGateOwner }
                : {}),
              lastError: {
                code: "abandoned-send-in-flight",
                atMs: nowMs,
              },
            }),
          },
          decision: acquireDecision,
        };
      }
      if (!validateDesiredForDelivery(desired)) {
        acquireDecision = "invalid";
        const apiGateOwner = normalizeString(delivery.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        return {
          value: {
            ...record,
            delivery: writeDelivery({
              ...omitRetryState(
                omitKeys(delivery, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "lastError",
                  ...(shouldSettleApiGate
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
                    : []),
                ]),
              ),
              ...(shouldSettleApiGate
                ? { apiGateSettleOwner: apiGateOwner }
                : {}),
              status: "terminal",
              revision: desiredRevision || "invalid",
              attempts: normalizeAttempts(delivery.attempts),
              lastError: {
                code: "invalid-desired-state",
                atMs: nowMs,
              },
            }),
          },
          decision: acquireDecision,
        };
      }
      const revision = desired.revision;
      if (
        delivery.revision === revision &&
        ["pending", "processing", "retryable"].includes(
          delivery.status as string,
        ) &&
        resolveRetryDeadlineAtMs(delivery) > 0 &&
        resolveRetryDeadlineAtMs(delivery) <= nowMs
      ) {
        acquireDecision = "retry-exhausted";
        const apiGateOwner = normalizeString(delivery.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        return {
          value: {
            ...record,
            delivery: writeDelivery({
              ...omitRetryState(
                omitKeys(delivery, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "sendInFlight",
                  ...(shouldSettleApiGate
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
                    : []),
                ]),
              ),
              ...(shouldSettleApiGate
                ? { apiGateSettleOwner: apiGateOwner }
                : {}),
              status: "terminal",
              revision,
              deadLetterAtMs: nowMs,
              lastError: {
                code: "safe-retry-window-exhausted",
                atMs: nowMs,
              },
            }),
          },
          decision: acquireDecision,
        };
      }
      if (
        delivery.revision === revision &&
        delivery.status === "retryable" &&
        Number(delivery.retryAtMs) > nowMs
      ) {
        acquireDecision = "deferred";
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.revision === revision &&
        (delivery.status === "terminal" ||
          delivery.status === "uncertain" ||
          delivery.status === "delivered")
      ) {
        acquireDecision = "settled";
        return { commit: false, decision: acquireDecision };
      }
      const deliveryForAcquire = delivery;
      acquireDecision = "acquired";
      const sameRevision = deliveryForAcquire.revision === revision;
      const proofRequiredOwner = normalizeString(
        readProperty(deliveryForAcquire.apiGateProofRequired, "owner"),
      );
      const previousApiGateOwner = normalizeString(
        deliveryForAcquire.apiGateOwner,
      );
      const supersededApiGateOwner =
        normalizeString(deliveryForAcquire.apiGateSettleOwner) ||
        (sameRevision || previousApiGateOwner === proofRequiredOwner
          ? ""
          : previousApiGateOwner);
      const deliveryForRevision = sameRevision
        ? deliveryForAcquire
        : omitRetryState(
            omitKeys(deliveryForAcquire, [
              "safeRejectionAtMs",
              "safeRejectionRecoveredAtMs",
              "apiGateOwner",
              "apiGateGeneration",
              "apiGateStartedAtMs",
              "apiGateSettleOwner",
            ]),
          );
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitKeys(deliveryForRevision, [
              "retryAtMs",
              "lastError",
              "deadLetterAtMs",
            ]),
            ...(supersededApiGateOwner
              ? { apiGateSettleOwner: supersededApiGateOwner }
              : {}),
            status: "processing",
            revision,
            attempts: sameRevision
              ? normalizeAttempts(deliveryForRevision.attempts) + 1
              : 1,
            leaseOwner: ownerToken,
            leaseExpiresAtMs: nowMs + leaseTtlMs,
            startedAtMs: nowMs,
          }),
        },
        decision: acquireDecision,
      };
    });
    return { ...result, decision: acquireDecision };
  };
  const finishStatus = async ({
    messageKey,
    ownerToken,
    desired,
    status,
    nowMs,
    result,
    receipt,
    clearAppliedStateUnknown = false,
    apiGateSettleOwner = "",
  }: FinishStatusInput) =>
    ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
        const latestRevision = normalizeString(
          readProperty(record.desired, "revision"),
        );
        const desiredStillLatest = latestRevision === desired.revision;
        const revision = desiredStillLatest ? desired.revision : latestRevision;
        const transition: DeliveryTransition =
          status === "uncertain"
            ? {
                status,
                revision,
                sendInFlight: preserveSendEvidence(
                  delivery.sendInFlight,
                  Object.hasOwn(delivery.source, "sendInFlight"),
                ),
              }
            : !desiredStillLatest
              ? { status: "pending", revision }
              : status === "delivered"
                ? { status, revision, deliveredAtMs: nowMs }
                : { status, revision };
        const nextDelivery = writeDelivery({
          ...omitRetryState(
            omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "lastError",
              "uncertainAtMs",
              "uncertainReason",
              "deadLetterAtMs",
              "apiGateOwner",
              "apiGateGeneration",
              "apiGateStartedAtMs",
              ...(clearAppliedStateUnknown ? ["appliedStateUnknown"] : []),
              ...(status === "uncertain" ? [] : ["sendInFlight"]),
            ]),
          ),
          ...transition,
          ...(normalizeString(apiGateSettleOwner)
            ? { apiGateSettleOwner }
            : {}),
        });
        if (!desiredStillLatest) {
          nextDelivery.attempts = 0;
          delete nextDelivery.deliveredAtMs;
        }
        if (status === "delivered" && desiredStillLatest) {
          nextDelivery.deliveredAtMs = nowMs;
        }
        if (
          ((desiredStillLatest && status === "terminal") ||
            status === "uncertain") &&
          result
        ) {
          nextDelivery.lastError = buildErrorState(result, nowMs);
        }
        if (status === "uncertain") {
          nextDelivery.uncertainAtMs = nowMs;
          nextDelivery.uncertainReason =
            normalizeString(result?.code) || "ambiguous-send";
        }
        if (
          desiredStillLatest &&
          status === "terminal" &&
          result?.code === "safe-retry-window-exhausted"
        ) {
          nextDelivery.deadLetterAtMs = nowMs;
        }
        const nextRecord: RawRecord = {
          ...record,
          delivery: nextDelivery,
        };
        if (receipt?.kind === "clear") {
          delete nextRecord.applied;
        } else if (receipt?.kind === "set") {
          nextRecord.applied = receipt.value;
        }
        return nextRecord;
      }),
      `${status}-finalization-failed`,
    );
  const finishStatusAndSettleApiGate = async (input: FinishStatusInput) => {
    const owner = normalizeString(input.apiGateSettleOwner);
    const finalized = await finishStatus(input);
    if (owner) {
      await settlePersistedApiGate({
        messageKey: input.messageKey,
        field: "apiGateSettleOwner",
        owner,
      });
    }
    return finalized;
  };
  const finishRetryable = async ({
    messageKey,
    ownerToken,
    desired,
    result,
    safeRejectedAttemptId = "",
    currentDelivery,
    apiGateOwner = "",
    proofTaskKind = TELEGRAM_DESIRED_TASK_KIND,
    pendingDeleteId = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }: DesiredContext & {
    result: TelegramRetryFailure;
    safeRejectedAttemptId?: string;
    currentDelivery: unknown;
    apiGateOwner?: string;
    proofTaskKind?: "desired" | "pending-delete";
    pendingDeleteId?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: asObject(currentDelivery),
      failure: result,
      target: { kind: proofTaskKind, safeRejectedAttemptId, pendingDeleteId },
      messageKey,
      revision: desired.revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await updateOwned(messageKey, ownerToken, (record, delivery) => ({
            ...record,
            delivery: {
              ...delivery.source,
              apiGateProofRequired: {
                owner: apiGateOwner,
                retryNotBeforeMs: barrierRetryNotBeforeMs,
                revision: desired.revision,
                proofTaskKind,
                ...retryState,
                ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
                ...(pendingDeleteId ? { pendingDeleteId } : {}),
                ...(!safeRejectedAttemptId
                  ? { retryProofLeaseOwner: ownerToken }
                  : {}),
              },
            },
          })),
          "rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await updateOwned(
          messageKey,
          ownerToken,
          (record, delivery) => {
            const latestRevision = normalizeString(
              readProperty(record.desired, "revision"),
            );
            const desiredStillLatest = latestRevision === desired.revision;
            return {
              ...record,
              delivery: writeDelivery({
                ...omitRetryState(
                  omitKeys(delivery, [
                    "leaseOwner",
                    "leaseExpiresAtMs",
                    "lastError",
                    "sendInFlight",
                    ...(preserveApiGateIdentity
                      ? []
                      : [
                          "apiGateOwner",
                          "apiGateGeneration",
                          "apiGateStartedAtMs",
                          "apiGateProofRequired",
                          "apiGateSettleOwner",
                        ]),
                  ]),
                ),
                ...(desiredStillLatest
                  ? {
                      status: "retryable" as const,
                      revision: desired.revision,
                      attempts: normalizeAttempts(delivery.attempts),
                      ...retryState,
                    }
                  : {
                      status: "pending" as const,
                      revision: latestRevision,
                      attempts: 0,
                    }),
                ...(desiredStillLatest
                  ? {
                      lastError: buildErrorState(result, finalizedAtMs),
                      ...(result?.code === "rate-limited"
                        ? { safeRejectionAtMs: finalizedAtMs }
                        : {}),
                    }
                  : {}),
              }),
            };
          },
        );
        if (!finalization.committed) {
          const current = asObject(await repository.getMessage(messageKey));
          const currentDeliveryState = readDelivery(current.delivery);
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentDeliveryState.retrySequence) >=
              retryState.retrySequence &&
            normalizeString(
              readProperty(currentDeliveryState.apiGateProofRequired, "owner"),
            ) !== normalizeString(apiGateOwner);
          if (!proofAlreadyApplied) {
            ensureCommitted(finalization, "retryable-finalization-failed");
          }
        }
      },
    });
  };
  const finishExpiredOwnedRetryWindow = async ({
    messageKey,
    ownerToken,
    desired,
    currentDelivery,
  }: DesiredContext & { currentDelivery: unknown }) => {
    const deadlineAtMs = resolveRetryDeadlineAtMs(currentDelivery);
    const checkedAtMs = now();
    if (!deadlineAtMs || checkedAtMs < deadlineAtMs) {
      return null;
    }
    const result = { code: "safe-retry-window-exhausted" };
    const current = asObject(currentDelivery);
    const apiGateOwner = normalizeString(current.apiGateOwner);
    const proofGateOwner = normalizeString(
      readProperty(current.apiGateProofRequired, "owner"),
    );
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs: checkedAtMs,
      apiGateSettleOwner:
        apiGateOwner && apiGateOwner !== proofGateOwner ? apiGateOwner : "",
    });
    return { status: "terminal", reason: result.code };
  };
  const markAppliedStateUnknown = async ({
    messageKey,
    ownerToken,
    desired,
    operation,
    apiGateOwner,
  }: DesiredContext & { operation: string; apiGateOwner: string }) => {
    const markedAtMs = now();
    return ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => ({
        ...record,
        delivery: {
          ...delivery.source,
          appliedStateUnknown: {
            revision: desired.revision,
            operation,
            apiGateOwner,
            markedAtMs,
          },
        },
      })),
      "applied-state-unknown-not-persisted",
    );
  };
  const markDelivered = (
    messageKey: string,
    ownerToken: string,
    desired: TelegramDesired,
    nowMs: number,
    options: DeliveredOptions = {},
  ) =>
    finishStatus({
      messageKey,
      ownerToken,
      desired,
      status: "delivered",
      receipt: { kind: "preserve" },
      nowMs,
      ...options,
    });
  const runDelete = async ({
    messageKey,
    ownerToken,
    desired,
    chatId,
    messageId,
    nowMs,
    currentDelivery,
    requestedGeneration,
    apiGateReclaimOwner,
  }: DesiredContext & {
    chatId: string;
    messageId: number;
    nowMs: number;
    currentDelivery: unknown;
    requestedGeneration?: string;
    apiGateReclaimOwner?: string;
  }) => {
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey,
      revision: desired.revision,
      operation: "delete",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const callAtMs = now();
    if (
      resolveRetryDeadlineAtMs(gateIdentity.delivery) > 0 &&
      resolveRetryDeadlineAtMs(gateIdentity.delivery) <= callAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: callAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey,
      ownerToken,
      desired,
      operation: "delete",
      apiGateOwner,
    });
    const result = await client.deleteTelegramMessage({ chatId, messageId });
    if (result.ok) {
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        receipt: { kind: "clear" },
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(messageKey, "terminal", result);
    return { status: "terminal", reason: result.code };
  };
  const { runSend } = createTelegramSendDelivery({
    client,
    now,
    createAttemptId,
    control,
    operations: {
      finishExpiredOwnedRetryWindow,
      finishRetryable,
      finishStatusAndSettleApiGate,
    },
  });
  const reconcileDesired = async (
    {
      messageKey,
      requestedRevision = "",
      safeRejectedAttemptId = "",
      retryStartedAtMs = 0,
      retryDeadlineAtMs = 0,
      retryAtMs = 0,
      retrySequence = 0,
      retryProofLeaseOwner = "",
      requestedGeneration = "",
      taskKind = TELEGRAM_DESIRED_TASK_KIND,
      apiGateReclaimOwner = "",
      apiGateSettleOwner = "",
    }: TelegramReconcileInput = { messageKey: "" },
  ) => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    const nowMs = now();
    if (normalizeString(apiGateSettleOwner)) {
      await repository.releaseApiGate(apiGateSettleOwner);
    }
    await applySafeRetryProof(normalizedMessageKey, {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    });
    if (taskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND) {
      await applyDesiredRetryWindowProof(normalizedMessageKey, {
        requestedRevision,
        safeRejectedAttemptId,
        retryStartedAtMs,
        retryDeadlineAtMs,
        retryAtMs,
        retrySequence,
        retryProofLeaseOwner,
        apiGateReclaimOwner,
      });
    }
    const recovery = await applyManualRecovery(normalizedMessageKey);
    await settleManualApiGateRelease(
      normalizedMessageKey,
      recovery.apiGateReleaseOwner,
    );
    if (recovery.processed && !recovery.shouldContinue) {
      return { status: "terminal", reason: "manually-abandoned" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const ownerToken = createOwnerToken();
    let acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    for (let settlementCount = 0; settlementCount < 2; settlementCount += 1) {
      const field =
        acquired.decision === "desired-api-gate-settle-pending"
          ? "apiGateSettleOwner"
          : acquired.decision === "pending-api-gate-settle-pending"
            ? "pendingDeleteApiGateSettleOwner"
            : "";
      if (!field) {
        break;
      }
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field,
        owner: readProperty(readProperty(acquired.value, "delivery"), field),
      });
      acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    }
    if (
      (acquired.decision === "invalid" ||
        acquired.decision === "retry-exhausted") &&
      normalizeString(
        readProperty(acquired.value?.delivery, "apiGateSettleOwner"),
      )
    ) {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: readProperty(
          readProperty(acquired.value, "delivery"),
          "apiGateSettleOwner",
        ),
      });
    }
    if (acquired.decision === "invalid") {
      return { status: "terminal", reason: "invalid-desired-state" };
    }
    if (acquired.decision === "in-flight-uncertain") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: readProperty(acquired.value?.delivery, "apiGateSettleOwner"),
      });
      return { status: "uncertain", reason: "abandoned-send-in-flight" };
    }
    if (acquired.decision === "pending-rate-limit-proof-pending") {
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
        pendingDeleteId: normalizeString(proof.pendingDeleteId),
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
          pendingDeleteId: proof.pendingDeleteId,
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
        reason: "pending-rate-limit-proof-pending",
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (acquired.decision === "rate-limit-proof-pending") {
      const proof = asObject(
        readProperty(acquired.value?.delivery, "apiGateProofRequired"),
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
        safeRejectedAttemptId: normalizeString(proof.safeRejectedAttemptId),
        retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
        proofTaskKind: TELEGRAM_DESIRED_TASK_KIND,
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
        await applySafeRetryProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
          safeRejectedAttemptId: proof.safeRejectedAttemptId,
          ...proofRetryState,
        });
        await applyDesiredRetryWindowProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
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
        reason: "rate-limit-proof-pending",
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (acquired.decision === "locked") {
      const lockedGateOwner = normalizeString(
        readProperty(acquired.value?.delivery, "apiGateOwner"),
      );
      const lockedGateGeneration = normalizeString(
        readProperty(acquired.value?.delivery, "apiGateGeneration"),
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        (normalizeString(apiGateReclaimOwner) === lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration === normalizeString(requestedGeneration)));
      const lockedRetryAtMs =
        normalizeTimestamp(
          readProperty(acquired.value?.delivery, "leaseExpiresAtMs"),
        ) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision: requestedRevision || "latest",
        taskKind: TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs:
            readProperty(acquired.value?.delivery, "retryStartedAtMs") ||
            retryStartedAtMs,
          retryDeadlineAtMs:
            readProperty(acquired.value?.delivery, "retryDeadlineAtMs") ||
            retryDeadlineAtMs,
          retryAtMs: lockedRetryAtMs,
          retrySequence:
            readProperty(acquired.value?.delivery, "retrySequence") ??
            retrySequence,
        },
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return {
        status: "retryable",
        reason: "locked",
        retryAtMs: lockedRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "deferred") {
      const deferredRetryAtMs =
        Number(readProperty(acquired.value?.delivery, "retryAtMs")) || null;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        taskKind: TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs: readProperty(
            acquired.value?.delivery,
            "retryStartedAtMs",
          ),
          retryDeadlineAtMs: readProperty(
            acquired.value?.delivery,
            "retryDeadlineAtMs",
          ),
          retryAtMs: deferredRetryAtMs,
          retrySequence: readProperty(
            acquired.value?.delivery,
            "retrySequence",
          ),
        },
        sourceGeneration: requestedGeneration,
      });
      return {
        status: "retryable",
        reason: "retry-after",
        retryAtMs: deferredRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "retry-exhausted") {
      return {
        status: "terminal",
        reason: "safe-retry-window-exhausted",
      };
    }
    if (acquired.decision === "settled") {
      return { status: "settled" };
    }
    if (acquired.decision !== "acquired") {
      return { status: "skipped", reason: "missing" };
    }

    let record = asObject(acquired.value);
    const settledSupersededGate = await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "apiGateSettleOwner",
      owner: readProperty(record.delivery, "apiGateSettleOwner"),
    });
    if (settledSupersededGate) {
      record = asObject(settledSupersededGate.value);
    }
    const desired = asObject(record.desired) as TelegramDesired;
    const applied = asObject(record.applied);
    if (
      requestedRevision &&
      requestedRevision !== desired.revision &&
      typeof logger?.info === "function"
    ) {
      logger.info("telegram:delivery:stale-task", {
        messageKey: normalizedMessageKey,
      });
    }

    const barrierCheckedAtMs = now();
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        currentDelivery: record.delivery,
        preserveApiGateIdentity: Boolean(
          readProperty(record.delivery, "apiGateOwner"),
        ),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        reason: "global-retry-after",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }

    const chatId = resolveDestination(desired.destination);
    if (!normalizeString(chatId)) {
      const result = {
        code: "missing-destination",
        description: `Telegram destination ${desired.destination} is not configured`,
      };
      await finishStatus({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs,
      });
      logFailure(normalizedMessageKey, "terminal", result);
      return { status: "terminal", reason: result.code };
    }

    if (desired.operation === "delete") {
      if (
        typeof applied.messageId !== "number" ||
        !Number.isInteger(applied.messageId) ||
        applied.messageId <= 0
      ) {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          receipt: { kind: "clear" },
        });
        return { status: "delivered" };
      }
      return runDelete({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId: normalizeString(applied.chatId) || chatId,
        messageId: applied.messageId,
        nowMs,
        currentDelivery: record.delivery,
        requestedGeneration,
        apiGateReclaimOwner,
      });
    }

    if (
      typeof applied.messageId !== "number" ||
      !Number.isInteger(applied.messageId) ||
      applied.messageId <= 0
    ) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          receipt: { kind: "clear" },
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }

    const appliedTargetMismatch =
      normalizeString(applied.instanceKey) !== desired.instanceKey ||
      normalizeString(applied.destination) !== desired.destination ||
      (normalizeString(applied.chatId) &&
        normalizeString(applied.chatId) !== chatId);
    if (appliedTargetMismatch) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs);
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: applied,
        nowMs,
        requestedGeneration,
      });
    }

    if (
      applied.contentHash === desired.contentHash &&
      !readProperty(record.delivery, "appliedStateUnknown")
    ) {
      await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
        receipt: {
          kind: "set",
          value: {
            ...applied,
            revision: desired.revision,
            appliedAtMs: nowMs,
          },
        },
      });
      return { status: "delivered", reason: "already-current" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      currentDelivery: record.delivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey: normalizedMessageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision: desired.revision,
      operation: "edit",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const editCallAtMs = now();
    if (
      resolveRetryDeadlineAtMs(gateIdentity.delivery) > 0 &&
      resolveRetryDeadlineAtMs(gateIdentity.delivery) <= editCallAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: editCallAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      operation: "edit",
      apiGateOwner,
    });
    const editResult = await client.editTelegramMessage({
      chatId: normalizeString(applied.chatId) || chatId,
      messageId: applied.messageId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    });
    if (editResult.ok) {
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        receipt: {
          kind: "set",
          value: {
            ...applied,
            destination: desired.destination,
            chatId: normalizeString(applied.chatId) || chatId,
            instanceKey: desired.instanceKey,
            revision: desired.revision,
            contentHash: desired.contentHash,
            appliedAtMs: nowMs,
          },
        },
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (editResult.classification === "missing") {
      if (desired.ifMissing === "skip") {
        await finishStatusAndSettleApiGate({
          messageKey: normalizedMessageKey,
          ownerToken,
          desired,
          status: "delivered",
          nowMs,
          receipt: { kind: "clear" },
          clearAppliedStateUnknown: true,
          apiGateSettleOwner: apiGateOwner,
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      ensureCommitted(
        await updateOwned(
          normalizedMessageKey,
          ownerToken,
          (record, delivery) => {
            const nextRecord: RawRecord = {
              ...record,
              delivery: {
                ...omitKeys(delivery, [
                  "apiGateOwner",
                  "apiGateGeneration",
                  "apiGateStartedAtMs",
                  "appliedStateUnknown",
                ]),
                apiGateSettleOwner: apiGateOwner,
              },
            };
            delete nextRecord.applied;
            return nextRecord;
          },
        ),
        "missing-edit-transition-not-persisted",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: apiGateOwner,
      });
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }
    if (editResult.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: editResult,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      status: "terminal",
      result: editResult,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(normalizedMessageKey, "terminal", editResult);
    return { status: "terminal", reason: editResult.code };
  };
  return { reconcileDesired };
}
