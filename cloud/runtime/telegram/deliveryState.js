// Generated from src/telegram/deliveryState.ts. Run npm run generate:runtime.
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
exports.validateDesiredForDelivery =
  exports.ensureCommitted =
  exports.appendPendingDelete =
  exports.promotePendingDeleteQueue =
  exports.resolvePendingDeleteId =
  exports.buildApiGateOwner =
  exports.buildPendingDeleteId =
  exports.omitKeys =
  exports.PendingDeleteSnapshot =
  exports.DeliverySnapshot =
  exports.asObject =
  exports.hashValue =
  exports.normalizeString =
    void 0;
exports.preserveSendEvidence = preserveSendEvidence;
exports.writeDelivery = writeDelivery;
exports.writeCleanup = writeCleanup;
exports.readDelivery = readDelivery;
exports.readPendingDelete = readPendingDelete;
const crypto = __importStar(require("node:crypto"));
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const sendEvidence = Symbol("telegram-send-evidence");
function preserveSendEvidence(value, present = true) {
  return { [sendEvidence]: { value, present } };
}
function writeDelivery(transition) {
  if (transition.status !== "uncertain") return transition;
  const evidence = transition.sendInFlight[sendEvidence];
  const output = { ...transition };
  if (evidence.present) output.sendInFlight = evidence.value;
  else delete output.sendInFlight;
  return output;
}
function writeCleanup(transition) {
  return transition;
}
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
exports.normalizeString = normalizeString;
const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
exports.hashValue = hashValue;
const asObject = (value) =>
  value instanceof StoredSnapshot
    ? value.source
    : value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
exports.asObject = asObject;
class StoredSnapshot {
  source;
  constructor(value) {
    this.source = (0, exports.asObject)(value);
  }
  get present() {
    return Object.keys(this.source).length > 0;
  }
}
class RetrySnapshot extends StoredSnapshot {
  get attempts() {
    return (0, deliveryPolicy_js_1.normalizeAttempts)(this.source.attempts);
  }
  get leaseOwner() {
    return (0, exports.normalizeString)(this.source.leaseOwner);
  }
  get leaseExpiresAtMs() {
    return Number(this.source.leaseExpiresAtMs) || 0;
  }
  get retryStartedAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      this.source.retryStartedAtMs,
    );
  }
  get retryDeadlineAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      this.source.retryDeadlineAtMs,
    );
  }
  get retryAtMs() {
    return Number(this.source.retryAtMs);
  }
  get retrySequence() {
    return (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      this.source.retrySequence,
    );
  }
  retryTimestampOr(field, fallback) {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      this.source[field] || fallback,
    );
  }
  retrySequenceOr(fallback) {
    return (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      this.source.retrySequence ?? fallback,
    );
  }
  get apiGateOwner() {
    return (0, exports.normalizeString)(this.source.apiGateOwner);
  }
  get apiGateGeneration() {
    return (0, exports.normalizeString)(this.source.apiGateGeneration);
  }
  get apiGateStartedAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      this.source.apiGateStartedAtMs,
    );
  }
  get apiGateProofRequired() {
    return this.source.apiGateProofRequired;
  }
}
class DeliverySnapshot extends RetrySnapshot {
  get status() {
    const status = this.source.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable" ||
      status === "delivered" ||
      status === "terminal" ||
      status === "uncertain"
      ? status
      : undefined;
  }
  get kind() {
    return this.status ?? "legacy";
  }
  get revision() {
    return typeof this.source.revision === "string"
      ? this.source.revision
      : undefined;
  }
  matchesRevision(revision) {
    return (
      typeof this.source.revision === "string" &&
      (0, exports.normalizeString)(this.source.revision) === revision
    );
  }
  get sendInFlight() {
    return this.source.sendInFlight;
  }
  get pendingDelete() {
    return new PendingDeleteSnapshot(this.source.pendingDelete);
  }
  get orphanedDeletes() {
    return (0, exports.asObject)(this.source.orphanedDeletes);
  }
  get apiGateSettleOwner() {
    return (0, exports.normalizeString)(this.source.apiGateSettleOwner);
  }
  get pendingDeleteApiGateSettleOwner() {
    return (0, exports.normalizeString)(
      this.source.pendingDeleteApiGateSettleOwner,
    );
  }
  get apiGateReleaseOwner() {
    return (0, exports.normalizeString)(this.source.apiGateReleaseOwner);
  }
  get lastRecoveryRequestId() {
    return (0, exports.normalizeString)(this.source.lastRecoveryRequestId);
  }
  settlementOwner(field) {
    return (0, exports.normalizeString)(this.source[field]);
  }
}
exports.DeliverySnapshot = DeliverySnapshot;
class PendingDeleteSnapshot extends RetrySnapshot {
  get status() {
    const status = this.source.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable"
      ? status
      : undefined;
  }
  get kind() {
    return this.present ? (this.status ?? "legacy") : "missing";
  }
  get pendingDeleteId() {
    return (0, exports.normalizeString)(this.source.pendingDeleteId);
  }
  get chatId() {
    return this.source.chatId;
  }
  get messageId() {
    return this.source.messageId;
  }
}
exports.PendingDeleteSnapshot = PendingDeleteSnapshot;
function readDelivery(value) {
  return new DeliverySnapshot(value);
}
function readPendingDelete(value) {
  return new PendingDeleteSnapshot(value);
}
const omitKeys = (value, keys) => {
  const output = { ...(0, exports.asObject)(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};
exports.omitKeys = omitKeys;
const buildPendingDeleteId = ({ chatId, messageId }) =>
  (0, exports.hashValue)(
    `${(0, exports.normalizeString)(chatId)}:${Number(messageId)}`,
  ).slice(0, 32);
exports.buildPendingDeleteId = buildPendingDeleteId;
const buildApiGateOwner = (...parts) =>
  `api_${(0, exports.hashValue)(parts.map((part) => String(part ?? "")).join(":"))}`;
exports.buildApiGateOwner = buildApiGateOwner;
const resolvePendingDeleteId = (pendingDelete) => {
  const value = (0, exports.asObject)(pendingDelete);
  return (
    (0, exports.normalizeString)(value.pendingDeleteId) ||
    (0, exports.hashValue)(
      JSON.stringify({
        chatId: (0, exports.normalizeString)(value.chatId),
        messageId: value.messageId ?? null,
        instanceKey: (0, exports.normalizeString)(value.instanceKey),
      }),
    ).slice(0, 32)
  );
};
exports.resolvePendingDeleteId = resolvePendingDeleteId;
const promotePendingDeleteQueue = (delivery) => {
  const value = (0, exports.omitKeys)(delivery, ["pendingDelete"]);
  const queue = (0, exports.asObject)(value.pendingDeleteQueue);
  const [nextPendingDeleteId] = Object.keys(queue).sort();
  if (!nextPendingDeleteId) {
    return (0, exports.omitKeys)(value, ["pendingDeleteQueue"]);
  }
  const nextQueue = (0, exports.omitKeys)(queue, [nextPendingDeleteId]);
  return {
    ...(0, exports.omitKeys)(value, ["pendingDeleteQueue"]),
    pendingDelete: queue[nextPendingDeleteId],
    ...(Object.keys(nextQueue).length > 0
      ? { pendingDeleteQueue: nextQueue }
      : {}),
  };
};
exports.promotePendingDeleteQueue = promotePendingDeleteQueue;
const appendPendingDelete = (delivery, pendingDelete) => {
  const value = (0, exports.asObject)(delivery);
  const currentPendingDelete = (0, exports.asObject)(value.pendingDelete);
  if (Object.keys(currentPendingDelete).length === 0) {
    return { ...value, pendingDelete };
  }
  const pendingDeleteId = (0, exports.resolvePendingDeleteId)(pendingDelete);
  if (
    (0, exports.resolvePendingDeleteId)(currentPendingDelete) ===
    pendingDeleteId
  ) {
    return value;
  }
  return {
    ...value,
    pendingDeleteQueue: {
      ...(0, exports.asObject)(value.pendingDeleteQueue),
      [pendingDeleteId]: pendingDelete,
    },
  };
};
exports.appendPendingDelete = appendPendingDelete;
const ensureCommitted = (result, code) => {
  if (result?.committed) {
    return result;
  }
  const error = Object.assign(new Error(code), { code, retryable: true });
  throw error;
};
exports.ensureCommitted = ensureCommitted;
const validateDesiredForDelivery = (desired) => {
  const value = (0, exports.asObject)(desired);
  if (
    value.schemaVersion !== desiredStateCore_js_1.TELEGRAM_SCHEMA_VERSION ||
    !(0, exports.normalizeString)(value.revision) ||
    !(0, exports.normalizeString)(value.sourceRevision) ||
    !Object.hasOwn(
      desiredStateCore_js_1.TELEGRAM_DESTINATIONS,
      value.destination,
    ) ||
    !["send", "edit", "delete"].includes(value.operation)
  ) {
    return false;
  }
  if (value.operation === "delete") {
    return true;
  }
  return (
    (0, exports.normalizeString)(value.instanceKey) !== "" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    (value.parseMode === undefined || value.parseMode === "HTML") &&
    (value.operation !== "edit" ||
      value.ifMissing === "send" ||
      value.ifMissing === "skip")
  );
};
exports.validateDesiredForDelivery = validateDesiredForDelivery;
