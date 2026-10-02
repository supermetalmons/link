// Generated from src/telegram/taskIdentity.ts. Run npm run generate:runtime.
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
exports.normalizeTaskPayload =
  exports.normalizeOptionalTimestamp =
  exports.buildTelegramDeliveryTaskId =
    void 0;
const values_js_1 = require("./values.js");
const crypto = __importStar(require("node:crypto"));
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const taskKinds_js_1 = require("./taskKinds.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeTaskKind = (value) => {
  const taskKind =
    normalizeString(value) || taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND;
  if (!taskKinds_js_1.TELEGRAM_TASK_KINDS.has(taskKind)) {
    throw new TypeError("invalid Telegram task kind");
  }
  return taskKind;
};
const normalizeRetrySequence = (value) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError("retrySequence must be a non-negative integer");
  }
  return number;
};
const normalizeOptionalTimestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};
exports.normalizeOptionalTimestamp = normalizeOptionalTimestamp;
const normalizeTaskPayload = (input) => {
  const messageKey = (0, desiredStateCore_js_1.validateTelegramMessageKey)(
    (0, values_js_1.readProperty)(input, "messageKey"),
  );
  const revision = normalizeString(
    (0, values_js_1.readProperty)(input, "revision"),
  );
  const generation = normalizeString(
    (0, values_js_1.readProperty)(input, "generation"),
  );
  if (!revision || !generation) {
    throw new TypeError("revision and generation are required");
  }
  const taskKind = normalizeTaskKind(
    (0, values_js_1.readProperty)(input, "taskKind"),
  );
  const retrySequence = normalizeRetrySequence(
    (0, values_js_1.readProperty)(input, "retrySequence") ?? 0,
  );
  const payload = {
    messageKey,
    revision,
    taskKind,
    retrySequence,
    generation,
  };
  for (const field of [
    "retryStartedAtMs",
    "retryDeadlineAtMs",
    "retryAtMs",
    "barrierRetryNotBeforeMs",
  ]) {
    const value = normalizeOptionalTimestamp(
      (0, values_js_1.readProperty)(input, field),
    );
    if (value > 0) {
      payload[field] = value;
    }
  }
  for (const field of [
    "safeRejectedAttemptId",
    "pendingDeleteId",
    "retryProofLeaseOwner",
    "barrierProofOwner",
    "apiGateReclaimOwner",
    "apiGateSettleOwner",
  ]) {
    const value = normalizeString((0, values_js_1.readProperty)(input, field));
    if (value) {
      payload[field] = value;
    }
  }
  const proofTaskKind = normalizeString(
    (0, values_js_1.readProperty)(input, "proofTaskKind"),
  );
  if (proofTaskKind) {
    if (
      proofTaskKind !== taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND &&
      proofTaskKind !== taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND
    ) {
      throw new TypeError("invalid Telegram proof task kind");
    }
    payload.proofTaskKind = proofTaskKind;
  }
  if (
    taskKind === taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND &&
    (!payload.proofTaskKind ||
      !payload.barrierProofOwner ||
      !payload.barrierRetryNotBeforeMs)
  ) {
    throw new TypeError("complete rate-limit proof is required");
  }
  return payload;
};
exports.normalizeTaskPayload = normalizeTaskPayload;
const buildTelegramDeliveryTaskId = (input) => {
  const payload = normalizeTaskPayload(input);
  const cleanupIdentity =
    payload.safeRejectedAttemptId || payload.pendingDeleteId || "none";
  return `tg_${crypto
    .createHash("sha256")
    .update(
      [
        payload.messageKey,
        payload.revision,
        payload.taskKind,
        payload.retrySequence,
        payload.generation,
        cleanupIdentity,
        payload.retryProofLeaseOwner || "none",
        payload.proofTaskKind || "none",
        payload.barrierProofOwner || "none",
        payload.barrierRetryNotBeforeMs || 0,
        payload.apiGateReclaimOwner || "none",
        payload.apiGateSettleOwner || "none",
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 40)}`;
};
exports.buildTelegramDeliveryTaskId = buildTelegramDeliveryTaskId;
