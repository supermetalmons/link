// Generated from src/telegram/deliveryDesired.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDesiredDelivery = createTelegramDesiredDelivery;
const deliveryState_js_1 = require("./deliveryState.js");
const retryRecords_js_1 = require("./retryRecords.js");
const records_js_1 = require("./records.js");
const records_js_2 = require("./records.js");
const deliveryDesiredRecords_js_1 = require("./deliveryDesiredRecords.js");
const records_js_3 = require("./records.js");
const records_js_4 = require("./records.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliverySend_js_1 = require("./deliverySend.js");
const deliveryState_js_2 = require("./deliveryState.js");
const desiredRecords_js_1 = require("./desiredRecords.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
function createTelegramDesiredDelivery({
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
  const acquire = async (messageKey, ownerToken, nowMs) => {
    let acquireDecision = "missing";
    const result = await transact(messageKey, (record) =>
      (0, deliveryDesiredRecords_js_1.acquireDesiredRecord)(
        (0, records_js_3.messageDocument)(record),
        {
          leaseTtlMs,
          nowMs,
          ownerToken,
          observeDecision: (value) => {
            acquireDecision = value;
          },
        },
      ),
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
  }) =>
    (0, deliveryState_js_2.ensureCommitted)(
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        (0, deliveryDesiredRecords_js_1.finishDesiredRecord)(
          (0, records_js_3.messageDocument)(record),
          delivery,
          {
            apiGateSettleOwner,
            clearAppliedStateUnknown,
            desired,
            nowMs,
            receipt,
            result,
            status,
          },
        ),
      ),
      `${status}-finalization-failed`,
    );
  const finishStatusAndSettleApiGate = async (input) => {
    const owner = (0, deliveryState_js_2.normalizeString)(
      input.apiGateSettleOwner,
    );
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
    proofTaskKind = taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
    pendingDeleteId = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }) => {
    return retryCoordinator.finish({
      current: (0, deliveryState_js_1.retryDocument)(currentDelivery),
      failure: result,
      target: { kind: proofTaskKind, safeRejectedAttemptId, pendingDeleteId },
      messageKey,
      revision: desired.revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        (0, deliveryState_js_2.ensureCommitted)(
          await updateOwned(messageKey, ownerToken, (record, delivery) =>
            (0, deliveryDesiredRecords_js_1.recordDesiredRetryProof)(
              (0, records_js_3.messageDocument)(record),
              delivery,
              {
                apiGateOwner,
                barrierRetryNotBeforeMs,
                desired,
                ownerToken,
                pendingDeleteId,
                proofTaskKind,
                retryState,
                safeRejectedAttemptId,
              },
            ),
          ),
          "rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await updateOwned(
          messageKey,
          ownerToken,
          (record, delivery) =>
            (0, deliveryDesiredRecords_js_1.recordDesiredRetryState)(
              (0, records_js_3.messageDocument)(record),
              delivery,
              {
                desired,
                finalizedAtMs,
                preserveApiGateIdentity,
                result,
                retryState,
              },
            ),
        );
        if (!finalization.committed) {
          const current = await repository.getMessage(messageKey);
          const currentDeliveryState = (0, deliveryState_js_2.readDelivery)(
            (0, records_js_2.messageDeliveryDocument)(current),
          );
          const proofAlreadyApplied =
            rateLimited &&
            (0, deliveryPolicy_js_1.normalizeRetrySequence)(
              currentDeliveryState.retrySequence,
            ) >= retryState.retrySequence &&
            currentDeliveryState.apiGateProofOwner !==
              (0, deliveryState_js_2.normalizeString)(apiGateOwner);
          if (!proofAlreadyApplied) {
            (0, deliveryState_js_2.ensureCommitted)(
              finalization,
              "retryable-finalization-failed",
            );
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
  }) => {
    const deadlineAtMs = (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
      currentDelivery,
    );
    const checkedAtMs = now();
    if (!deadlineAtMs || checkedAtMs < deadlineAtMs) {
      return null;
    }
    const result = { code: "safe-retry-window-exhausted" };
    const current = (0, deliveryState_js_2.readDelivery)(currentDelivery);
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
  }) => {
    const markedAtMs = now();
    return (0, deliveryState_js_2.ensureCommitted)(
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        (0, deliveryDesiredRecords_js_1.markAppliedStateUnknownRecord)(
          (0, records_js_3.messageDocument)(record),
          delivery,
          {
            apiGateOwner,
            desired,
            markedAtMs,
            operation,
          },
        ),
      ),
      "applied-state-unknown-not-persisted",
    );
  };
  const markDelivered = (
    messageKey,
    ownerToken,
    desired,
    nowMs,
    options = {},
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
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(gateIdentity.delivery) >
        0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
        gateIdentity.delivery,
      ) <= callAtMs
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
  const { runSend } = (0, deliverySend_js_1.createTelegramSendDelivery)({
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
      taskKind = taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
      apiGateReclaimOwner = "",
      apiGateSettleOwner = "",
    } = { messageKey: "" },
  ) => {
    const normalizedMessageKey = (0,
    desiredStateCore_js_1.validateTelegramMessageKey)(messageKey);
    const nowMs = now();
    if ((0, deliveryState_js_2.normalizeString)(apiGateSettleOwner)) {
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
    if (taskKind !== taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND) {
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
        owner: (0, retryRecords_js_1.messageSettlementOwnerInput)(
          acquired.value,
          field,
        ),
      });
      acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    }
    if (
      (acquired.decision === "invalid" ||
        acquired.decision === "retry-exhausted") &&
      (0, deliveryState_js_2.normalizeString)(
        (0, values_js_1.readProperty)(
          (0, records_js_2.messageDeliveryDocument)(acquired.value),
          "apiGateSettleOwner",
        ),
      )
    ) {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: (0, retryRecords_js_1.messageSettlementOwnerInput)(
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
        owner: (0, retryRecords_js_1.messageSettlementOwnerInput)(
          acquired.value,
          "apiGateSettleOwner",
        ),
      });
      return { status: "uncertain", reason: "abandoned-send-in-flight" };
    }
    if (acquired.decision === "pending-rate-limit-proof-pending") {
      const proof = (0, retryRecords_js_1.messageRateLimitProof)(
        (0, records_js_2.messageDeliveryDocument)(acquired.value),
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
        retryAtMs: (0, retryRecords_js_1.rateLimitProofRetryAt)(proof),
        scheduled: true,
      };
    }
    if (acquired.decision === "rate-limit-proof-pending") {
      const proof = (0, retryRecords_js_1.messageRateLimitProof)(
        (0, records_js_2.messageDeliveryDocument)(acquired.value),
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
        retryAtMs: (0, retryRecords_js_1.rateLimitProofRetryAt)(proof),
        scheduled: true,
      };
    }
    if (acquired.decision === "locked") {
      const lockedGateOwner = (0, deliveryState_js_2.normalizeString)(
        (0, values_js_1.readProperty)(
          (0, records_js_2.messageDeliveryDocument)(acquired.value),
          "apiGateOwner",
        ),
      );
      const lockedGateGeneration = (0, deliveryState_js_2.normalizeString)(
        (0, values_js_1.readProperty)(
          (0, records_js_2.messageDeliveryDocument)(acquired.value),
          "apiGateGeneration",
        ),
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        ((0, deliveryState_js_2.normalizeString)(apiGateReclaimOwner) ===
          lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration ===
              (0, deliveryState_js_2.normalizeString)(requestedGeneration)));
      const lockedRetryAtMs =
        (0, deliveryPolicy_js_1.normalizeTimestamp)(
          (0, values_js_1.readProperty)(
            (0, records_js_2.messageDeliveryDocument)(acquired.value),
            "leaseExpiresAtMs",
          ),
        ) || nowMs + 1000;
      await scheduleExactRetry(
        (0, retryRecords_js_1.lockedDesiredRetryInput)(acquired.value, {
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
          (0, values_js_1.readProperty)(
            (0, records_js_2.messageDeliveryDocument)(acquired.value),
            "retryAtMs",
          ),
        ) || null;
      await scheduleExactRetry(
        (0, retryRecords_js_1.deferredDesiredRetryInput)(acquired.value, {
          messageKey: normalizedMessageKey,
          revision:
            (0, deliveryState_js_2.normalizeString)(
              (0, values_js_1.readProperty)(
                (0, records_js_2.messageDesiredDocument)(acquired.value),
                "revision",
              ),
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
    let record = (0, records_js_3.messageDocument)(acquired.value);
    const settledSupersededGate = await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "apiGateSettleOwner",
      owner: (0, retryRecords_js_1.messageSettlementOwnerInput)(
        record,
        "apiGateSettleOwner",
      ),
    });
    if (settledSupersededGate) {
      record = (0, records_js_3.messageDocument)(settledSupersededGate.value);
    }
    const desired = (0, desiredRecords_js_1.acquiredDesiredView)(record);
    const applied = (0, records_js_1.readMessageApplied)(record);
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
        currentDelivery: (0, records_js_2.messageDeliveryDocument)(record),
        preserveApiGateIdentity: (0, deliveryState_js_2.readDelivery)(
          (0, records_js_2.messageDeliveryDocument)(record),
        ).hasRawApiGateOwner,
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
    if (!(0, deliveryState_js_2.normalizeString)(chatId)) {
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
        currentDelivery: (0, records_js_2.messageDeliveryDocument)(record),
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
      !(0, deliveryState_js_2.readDelivery)(
        (0, records_js_2.messageDeliveryDocument)(record),
      ).hasAppliedStateUnknown
    ) {
      await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
        receipt: {
          kind: "set",
          value: (0, records_js_4.updateTelegramApplied)(
            applied.retainedDocument(),
            {
              revision: desired.revision,
              appliedAtMs: nowMs,
            },
          ),
        },
      });
      return { status: "delivered", reason: "already-current" };
    }
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      currentDelivery: (0, records_js_2.messageDeliveryDocument)(record),
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
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(gateIdentity.delivery) >
        0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
        gateIdentity.delivery,
      ) <= editCallAtMs
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
      (0, deliveryState_js_2.ensureCommitted)(
        await updateOwned(
          normalizedMessageKey,
          ownerToken,
          (record, delivery) =>
            (0, deliveryDesiredRecords_js_1.clearMissingAppliedRecord)(
              (0, records_js_3.messageDocument)(record),
              delivery,
              {
                apiGateOwner,
              },
            ),
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
