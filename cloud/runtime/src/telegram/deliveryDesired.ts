import { retryDocument } from "./deliveryState.js";
import type { TelegramDeliveryDocument } from "./records.js";
import {
  messageRateLimitProof,
  rateLimitProofRetryAt,
  messageSettlementOwnerInput,
  lockedDesiredRetryInput,
  deferredDesiredRetryInput,
} from "./retryRecords.js";
import { readMessageApplied } from "./records.js";
import {
  messageDeliveryDocument,
  messageDesiredDocument,
  type TelegramMessageDocument,
} from "./records.js";
import {
  acquireDesiredRecord,
  finishDesiredRecord,
  recordDesiredRetryProof,
  recordDesiredRetryState,
  markAppliedStateUnknownRecord,
  clearMissingAppliedRecord,
} from "./deliveryDesiredRecords.js";
import { messageDocument } from "./records.js";
import { updateTelegramApplied } from "./records.js";
import type { TransactionResult } from "../transactions.js";
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
import { createTelegramSendDelivery } from "./deliverySend.js";
import {
  ensureCommitted,
  normalizeString,
  readDelivery,
  type DeliveredOptions,
  type DesiredAcquireDecision,
  type DesiredContext,
  type FinishStatusInput,
  DeliverySnapshot,
} from "./deliveryState.js";
import type {
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
import {
  acquiredDesiredView,
  type RetainedDesiredView,
} from "./desiredRecords.js";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
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
  } = control;
  const {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    resumeRateLimitProof,
  } = recovery;
  const acquire = async (
    messageKey: string,
    ownerToken: string,
    nowMs: number,
  ): Promise<
    TransactionResult<TelegramMessageDocument> & {
      decision: DesiredAcquireDecision;
    }
  > => {
    let acquireDecision: DesiredAcquireDecision = "missing";
    const result = await transact(messageKey, (record) =>
      acquireDesiredRecord(messageDocument(record), {
        leaseTtlMs,
        nowMs,
        ownerToken,
        observeDecision: (value) => {
          acquireDecision = value;
        },
      }),
    );
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
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        finishDesiredRecord(messageDocument(record), delivery, {
          apiGateSettleOwner,
          clearAppliedStateUnknown,
          desired,
          nowMs,
          receipt,
          result,
          status,
        }),
      ),
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
    currentDelivery: TelegramDeliveryDocument | DeliverySnapshot;
    apiGateOwner?: string;
    proofTaskKind?: "desired" | "pending-delete";
    pendingDeleteId?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: retryDocument(currentDelivery),
      failure: result,
      target: { kind: proofTaskKind, safeRejectedAttemptId, pendingDeleteId },
      messageKey,
      revision: desired.revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await updateOwned(messageKey, ownerToken, (record, delivery) =>
            recordDesiredRetryProof(messageDocument(record), delivery, {
              apiGateOwner,
              barrierRetryNotBeforeMs,
              desired,
              ownerToken,
              pendingDeleteId,
              proofTaskKind,
              retryState,
              safeRejectedAttemptId,
            }),
          ),
          "rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await updateOwned(
          messageKey,
          ownerToken,
          (record, delivery) =>
            recordDesiredRetryState(messageDocument(record), delivery, {
              desired,
              finalizedAtMs,
              preserveApiGateIdentity,
              result,
              retryState,
            }),
        );
        if (!finalization.committed) {
          const current = await repository.getMessage(messageKey);
          const currentDeliveryState = readDelivery(
            messageDeliveryDocument(current),
          );
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentDeliveryState.retrySequence) >=
              retryState.retrySequence &&
            currentDeliveryState.apiGateProofOwner !==
              normalizeString(apiGateOwner);
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
  }: DesiredContext & {
    currentDelivery: TelegramDeliveryDocument | DeliverySnapshot;
  }) => {
    const deadlineAtMs = resolveRetryDeadlineAtMs(currentDelivery);
    const checkedAtMs = now();
    if (!deadlineAtMs || checkedAtMs < deadlineAtMs) {
      return null;
    }
    const result = { code: "safe-retry-window-exhausted" };
    const current = readDelivery(currentDelivery);
    const apiGateOwner = current.apiGateOwner;
    const proofGateOwner = current.apiGateProofOwner;
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
  }: DesiredContext & {
    operation: "edit" | "delete";
    apiGateOwner: string;
  }) => {
    const markedAtMs = now();
    return ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        markAppliedStateUnknownRecord(messageDocument(record), delivery, {
          apiGateOwner,
          desired,
          markedAtMs,
          operation,
        }),
      ),
      "applied-state-unknown-not-persisted",
    );
  };
  const markDelivered = (
    messageKey: string,
    ownerToken: string,
    desired: RetainedDesiredView,
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
    currentDelivery: TelegramDeliveryDocument | DeliverySnapshot;
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
        owner: messageSettlementOwnerInput(acquired.value, field),
      });
      acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    }
    if (
      (acquired.decision === "invalid" ||
        acquired.decision === "retry-exhausted") &&
      normalizeString(
        readProperty(
          messageDeliveryDocument(acquired.value),
          "apiGateSettleOwner",
        ),
      )
    ) {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: messageSettlementOwnerInput(
          acquired.value,
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
        owner: messageSettlementOwnerInput(
          acquired.value,
          "apiGateSettleOwner",
        ),
      });
      return { status: "uncertain", reason: "abandoned-send-in-flight" };
    }
    if (acquired.decision === "pending-rate-limit-proof-pending") {
      const proof = messageRateLimitProof(
        messageDeliveryDocument(acquired.value),
        true,
      );
      await resumeRateLimitProof({
        messageKey: normalizedMessageKey,
        proof,
        requestedRevision,
        nowMs,
        target: { kind: "pending-delete" },
      });
      return {
        status: "retryable",
        reason: "pending-rate-limit-proof-pending",
        retryAtMs: rateLimitProofRetryAt(proof),
        scheduled: true,
      };
    }
    if (acquired.decision === "rate-limit-proof-pending") {
      const proof = messageRateLimitProof(
        messageDeliveryDocument(acquired.value),
      );
      await resumeRateLimitProof({
        messageKey: normalizedMessageKey,
        proof,
        requestedRevision,
        nowMs,
        target: { kind: "desired" },
      });
      return {
        status: "retryable",
        reason: "rate-limit-proof-pending",
        retryAtMs: rateLimitProofRetryAt(proof),
        scheduled: true,
      };
    }
    if (acquired.decision === "locked") {
      const lockedGateOwner = normalizeString(
        readProperty(messageDeliveryDocument(acquired.value), "apiGateOwner"),
      );
      const lockedGateGeneration = normalizeString(
        readProperty(
          messageDeliveryDocument(acquired.value),
          "apiGateGeneration",
        ),
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        (normalizeString(apiGateReclaimOwner) === lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration === normalizeString(requestedGeneration)));
      const lockedRetryAtMs =
        normalizeTimestamp(
          readProperty(
            messageDeliveryDocument(acquired.value),
            "leaseExpiresAtMs",
          ),
        ) || nowMs + 1000;
      await scheduleExactRetry(
        lockedDesiredRetryInput(acquired.value, {
          messageKey: normalizedMessageKey,
          revision: requestedRevision || "latest",
          retryStartedAtMs,
          retryDeadlineAtMs,
          retryAtMs: lockedRetryAtMs,
          retrySequence,
          sourceGeneration: requestedGeneration,
          apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
        }),
      );
      return {
        status: "retryable",
        reason: "locked",
        retryAtMs: lockedRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "deferred") {
      const deferredRetryAtMs =
        Number(
          readProperty(messageDeliveryDocument(acquired.value), "retryAtMs"),
        ) || null;
      await scheduleExactRetry(
        deferredDesiredRetryInput(acquired.value, {
          messageKey: normalizedMessageKey,
          revision:
            normalizeString(
              readProperty(messageDesiredDocument(acquired.value), "revision"),
            ) ||
            requestedRevision ||
            "latest",
          retryAtMs: deferredRetryAtMs,
          sourceGeneration: requestedGeneration,
        }),
      );
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

    let record = messageDocument(acquired.value);
    const settledSupersededGate = await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "apiGateSettleOwner",
      owner: messageSettlementOwnerInput(record, "apiGateSettleOwner"),
    });
    if (settledSupersededGate) {
      record = messageDocument(settledSupersededGate.value);
    }
    const desired = acquiredDesiredView(record);
    const applied = readMessageApplied(record);
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
        currentDelivery: messageDeliveryDocument(record),
        preserveApiGateIdentity: readDelivery(messageDeliveryDocument(record))
          .hasRawApiGateOwner,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        reason: "global-retry-after",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }

    const chatId = desired.resolveDestination(resolveDestination);
    if (!normalizeString(chatId)) {
      const result = {
        code: "missing-destination",
        description: `Telegram destination ${desired.destinationDescription} is not configured`,
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
      if (!applied.hasMessageId()) {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          receipt: { kind: "clear" },
        });
        return { status: "delivered" };
      }
      return runDelete({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId: applied.chatId || chatId,
        messageId: applied.messageId,
        nowMs,
        currentDelivery: messageDeliveryDocument(record),
        requestedGeneration,
        apiGateReclaimOwner,
      });
    }

    if (!applied.hasMessageId()) {
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

    const appliedTargetMismatch = desired.appliedTargetMismatch(
      applied.retainedDocument(),
      chatId,
    );
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
        previousApplied: applied.retainedDocument(),
        nowMs,
        requestedGeneration,
      });
    }

    if (
      desired.matchesAppliedContent(applied.retainedDocument()) &&
      !readDelivery(messageDeliveryDocument(record)).hasAppliedStateUnknown
    ) {
      await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
        receipt: {
          kind: "set",
          value: updateTelegramApplied(applied.retainedDocument(), {
            revision: desired.revision,
            appliedAtMs: nowMs,
          }),
        },
      });
      return { status: "delivered", reason: "already-current" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      currentDelivery: messageDeliveryDocument(record),
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
    const editResult = await client.editTelegramMessage(
      desired.editInput(applied.chatId || chatId, applied.messageId),
    );
    if (editResult.ok) {
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        receipt: {
          kind: "set",
          value: desired.refreshAppliedReceipt(
            applied.retainedDocument(),
            applied.chatId || chatId,
            nowMs,
          ),
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
          (record, delivery) =>
            clearMissingAppliedRecord(messageDocument(record), delivery, {
              apiGateOwner,
            }),
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
