// Generated from src/telegram/deliveryEngine.ts. Run npm run generate:runtime.
"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTelegramMessageKey =
  exports.resolveTelegramDestination =
  exports.createTelegramLocalRetryBarrier =
  exports.createTelegramDeliveryEngine =
  exports.buildTelegramSendDesired =
  exports.buildTelegramEditDesired =
  exports.buildTelegramDeleteDesired =
  exports.TELEGRAM_SCHEMA_VERSION =
  exports.TELEGRAM_SAFE_RETRY_WINDOW_MS =
  exports.TELEGRAM_SAFE_RETRY_MAX_DELAY_MS =
  exports.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND =
  exports.TELEGRAM_MESSAGE_ROOT =
  exports.TELEGRAM_LEASE_TTL_MS =
  exports.TELEGRAM_DESTINATIONS =
    void 0;
const crypto = __importStar(require("node:crypto"));
const deliveryCleanup_js_1 = require("./deliveryCleanup.js");
const deliveryControl_js_1 = require("./deliveryControl.js");
const deliveryDesired_js_1 = require("./deliveryDesired.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
Object.defineProperty(exports, "TELEGRAM_SAFE_RETRY_MAX_DELAY_MS", {
  enumerable: true,
  get: function () {
    return deliveryPolicy_js_1.TELEGRAM_SAFE_RETRY_MAX_DELAY_MS;
  },
});
Object.defineProperty(exports, "TELEGRAM_SAFE_RETRY_WINDOW_MS", {
  enumerable: true,
  get: function () {
    return deliveryPolicy_js_1.TELEGRAM_SAFE_RETRY_WINDOW_MS;
  },
});
Object.defineProperty(exports, "createTelegramLocalRetryBarrier", {
  enumerable: true,
  get: function () {
    return deliveryPolicy_js_1.createTelegramLocalRetryBarrier;
  },
});
const deliveryRecovery_js_1 = require("./deliveryRecovery.js");
const deliveryState_js_1 = require("./deliveryState.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
Object.defineProperty(exports, "TELEGRAM_DESTINATIONS", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.TELEGRAM_DESTINATIONS;
  },
});
Object.defineProperty(exports, "TELEGRAM_MESSAGE_ROOT", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.TELEGRAM_MESSAGE_ROOT;
  },
});
Object.defineProperty(exports, "TELEGRAM_SCHEMA_VERSION", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.TELEGRAM_SCHEMA_VERSION;
  },
});
Object.defineProperty(exports, "buildTelegramDeleteDesired", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.buildTelegramDeleteDesired;
  },
});
Object.defineProperty(exports, "buildTelegramEditDesired", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.buildTelegramEditDesired;
  },
});
Object.defineProperty(exports, "buildTelegramSendDesired", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.buildTelegramSendDesired;
  },
});
Object.defineProperty(exports, "resolveTelegramDestination", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.resolveTelegramDestination;
  },
});
Object.defineProperty(exports, "validateTelegramMessageKey", {
  enumerable: true,
  get: function () {
    return desiredStateCore_js_1.validateTelegramMessageKey;
  },
});
const taskKinds_js_1 = require("./taskKinds.js");
Object.defineProperty(exports, "TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND", {
  enumerable: true,
  get: function () {
    return taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND;
  },
});
const values_js_1 = require("./values.js");
const TELEGRAM_LEASE_TTL_MS = 60_000;
exports.TELEGRAM_LEASE_TTL_MS = TELEGRAM_LEASE_TTL_MS;
const moduleRetryBarrier = (0,
deliveryPolicy_js_1.createTelegramLocalRetryBarrier)();
const createTelegramDeliveryEngine = ({
  repository,
  client,
  resolveDestination = desiredStateCore_js_1.resolveTelegramDestination,
  now = Date.now,
  createOwnerToken = () => crypto.randomUUID(),
  createAttemptId = () => crypto.randomUUID(),
  scheduleRetry = async () => ({ scheduled: true }),
  logger = console,
  leaseTtlMs = TELEGRAM_LEASE_TTL_MS,
  localRetryBarrier = moduleRetryBarrier,
} = {}) => {
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
  const control = (0, deliveryControl_js_1.createTelegramDeliveryControl)({
    repository,
    logger,
    now,
    scheduleRetry,
    localRetryBarrier,
  });
  const recovery = (0, deliveryRecovery_js_1.createTelegramDeliveryRecovery)({
    repository,
    now,
    control,
  });
  const { reconcileDesired } = (0,
  deliveryDesired_js_1.createTelegramDesiredDelivery)({
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
  const { reconcilePendingDelete } = (0,
  deliveryCleanup_js_1.createTelegramCleanupDelivery)({
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
  const reconcile = async (input = { messageKey: "" }) => {
    let effectiveInput = input;
    if (input.taskKind === taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND) {
      const proofTaskKind = (0, deliveryState_js_1.normalizeString)(
        input.proofTaskKind,
      );
      if (
        proofTaskKind !== taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND &&
        proofTaskKind !== taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND
      ) {
        return { status: "skipped", reason: "invalid-rate-limit-proof" };
      }
      const barrierProof = await applyRateLimitBarrierProof({
        barrierProofOwner: input.barrierProofOwner,
        barrierRetryNotBeforeMs: input.barrierRetryNotBeforeMs,
      });
      if (!barrierProof.applied) {
        if ((0, deliveryState_js_1.normalizeString)(barrierProof.gate?.owner)) {
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
    const record = (0, deliveryState_js_1.asObject)(
      await repository.getMessage(effectiveInput.messageKey),
    );
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      (0, values_js_1.readProperty)(record.delivery, "pendingDelete"),
    );
    if (!pendingDelete.present) {
      return desiredResult;
    }
    const pendingDeleteId = (0, deliveryState_js_1.resolvePendingDeleteId)(
      pendingDelete,
    );
    if (
      effectiveInput.taskKind !==
      taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND
    ) {
      await scheduleExactRetry({
        messageKey: effectiveInput.messageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(record.desired, "revision"),
          ) ||
          (0, deliveryState_js_1.normalizeString)(
            effectiveInput.requestedRevision,
          ) ||
          "latest",
        taskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryAtMs: now(),
          retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
            pendingDelete.retrySequence,
          ),
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
      const refreshed = (0, deliveryState_js_1.asObject)(
        await repository.getMessage(effectiveInput.messageKey),
      );
      const nextPendingDelete = (0, deliveryState_js_1.readPendingDelete)(
        (0, values_js_1.readProperty)(refreshed.delivery, "pendingDelete"),
      );
      if (nextPendingDelete.present) {
        const nextPendingDeleteId = (0,
        deliveryState_js_1.resolvePendingDeleteId)(nextPendingDelete);
        await scheduleExactRetry({
          messageKey: effectiveInput.messageKey,
          revision:
            (0, deliveryState_js_1.normalizeString)(
              (0, values_js_1.readProperty)(refreshed.desired, "revision"),
            ) ||
            (0, deliveryState_js_1.normalizeString)(
              effectiveInput.requestedRevision,
            ) ||
            "latest",
          taskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
          retryState: {
            retryAtMs: now(),
            retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
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
exports.createTelegramDeliveryEngine = createTelegramDeliveryEngine;
