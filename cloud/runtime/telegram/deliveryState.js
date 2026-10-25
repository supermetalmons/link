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
  exports.hashValue =
  exports.normalizeString =
    void 0;
exports.preserveSendEvidence = preserveSendEvidence;
exports.writeDelivery = writeDelivery;
exports.writeCleanup = writeCleanup;
exports.deliveryDocument = deliveryDocument;
exports.pendingDeleteDocument = pendingDeleteDocument;
exports.retryDocument = retryDocument;
exports.readDelivery = readDelivery;
exports.readPendingDelete = readPendingDelete;
const crypto = __importStar(require("node:crypto"));
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const client_js_1 = require("./client.js");
const values_js_1 = require("./values.js");
const sendEvidence = Symbol("telegram-send-evidence");
function preserveSendEvidence(value, present = true) {
  return { [sendEvidence]: { value, present } };
}
function writeDelivery(transition) {
  if (transition.status !== "uncertain") {
    const retained = transition;
    return retained;
  }
  const evidence = transition.sendInFlight[sendEvidence];
  const output = { ...transition };
  if (evidence.present) output.sendInFlight = evidence.value;
  else delete output.sendInFlight;
  return output;
}
function writeCleanup(transition) {
  const retained = transition;
  return retained;
}
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
exports.normalizeString = normalizeString;
const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
exports.hashValue = hashValue;
const snapshotSources = new WeakMap();
const asObject = (value) =>
  value instanceof StoredSnapshot
    ? snapshotSources.get(value)
    : value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
class StoredSnapshot {
  constructor(value) {
    snapshotSources.set(this, asObject(value));
  }
  get present() {
    return Object.keys(snapshotSources.get(this)).length > 0;
  }
}
function deliveryDocument(value) {
  return snapshotSources.get(value);
}
function pendingDeleteDocument(value) {
  return snapshotSources.get(value);
}
function retryDocument(value) {
  return asObject(value);
}
class RetrySnapshot extends StoredSnapshot {
  get attempts() {
    return (0, deliveryPolicy_js_1.normalizeAttempts)(
      snapshotSources.get(this).attempts,
    );
  }
  get leaseOwner() {
    return (0, exports.normalizeString)(snapshotSources.get(this).leaseOwner);
  }
  get leaseExpiresAtMs() {
    return Number(snapshotSources.get(this).leaseExpiresAtMs) || 0;
  }
  get retryStartedAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      snapshotSources.get(this).retryStartedAtMs,
    );
  }
  get retryDeadlineAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      snapshotSources.get(this).retryDeadlineAtMs,
    );
  }
  get retryAtMs() {
    return Number(snapshotSources.get(this).retryAtMs);
  }
  get retrySequence() {
    return (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      snapshotSources.get(this).retrySequence,
    );
  }
  retryTimestampOr(field, fallback) {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      snapshotSources.get(this)[field] || fallback,
    );
  }
  retrySequenceOr(fallback) {
    return (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      snapshotSources.get(this).retrySequence ?? fallback,
    );
  }
  get apiGateOwner() {
    return (0, exports.normalizeString)(snapshotSources.get(this).apiGateOwner);
  }
  get apiGateGeneration() {
    return (0, exports.normalizeString)(
      snapshotSources.get(this).apiGateGeneration,
    );
  }
  get apiGateStartedAtMs() {
    return (0, deliveryPolicy_js_1.normalizeTimestamp)(
      snapshotSources.get(this).apiGateStartedAtMs,
    );
  }
  get apiGateProofRequired() {
    return snapshotSources.get(this).apiGateProofRequired;
  }
  get apiGateProofOwner() {
    return (0, exports.normalizeString)(
      (0, values_js_1.readProperty)(
        snapshotSources.get(this).apiGateProofRequired,
        "owner",
      ),
    );
  }
}
class DeliverySnapshot extends RetrySnapshot {
  get status() {
    const status = snapshotSources.get(this).status;
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
    return typeof snapshotSources.get(this).revision === "string"
      ? snapshotSources.get(this).revision
      : undefined;
  }
  matchesRevision(revision) {
    return (
      typeof snapshotSources.get(this).revision === "string" &&
      (0, exports.normalizeString)(snapshotSources.get(this).revision) ===
        revision
    );
  }
  get sendInFlight() {
    return snapshotSources.get(this).sendInFlight;
  }
  get hasSendInFlight() {
    return Boolean(snapshotSources.get(this).sendInFlight);
  }
  get hasAppliedStateUnknown() {
    return Boolean(snapshotSources.get(this).appliedStateUnknown);
  }
  get hasRawApiGateOwner() {
    return Boolean(snapshotSources.get(this).apiGateOwner);
  }
  sendInFlightMatchesRevision(revision) {
    return (
      (0, values_js_1.readProperty)(
        snapshotSources.get(this).sendInFlight,
        "revision",
      ) === revision
    );
  }
  preservedSendInFlight() {
    return preserveSendEvidence(
      snapshotSources.get(this).sendInFlight,
      Object.hasOwn(snapshotSources.get(this), "sendInFlight"),
    );
  }
  get pendingDelete() {
    return new PendingDeleteSnapshot(snapshotSources.get(this).pendingDelete);
  }
  get orphanedDeletes() {
    return asObject(snapshotSources.get(this).orphanedDeletes);
  }
  get apiGateSettleOwner() {
    return (0, exports.normalizeString)(
      snapshotSources.get(this).apiGateSettleOwner,
    );
  }
  get pendingDeleteApiGateSettleOwner() {
    return (0, exports.normalizeString)(
      snapshotSources.get(this).pendingDeleteApiGateSettleOwner,
    );
  }
  get apiGateReleaseOwner() {
    return (0, exports.normalizeString)(
      snapshotSources.get(this).apiGateReleaseOwner,
    );
  }
  get lastRecoveryRequestId() {
    return (0, exports.normalizeString)(
      snapshotSources.get(this).lastRecoveryRequestId,
    );
  }
  settlementOwner(field) {
    return (0, exports.normalizeString)(snapshotSources.get(this)[field]);
  }
}
exports.DeliverySnapshot = DeliverySnapshot;
class PendingDeleteSnapshot extends RetrySnapshot {
  get status() {
    const status = snapshotSources.get(this).status;
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
    return (0, exports.normalizeString)(
      snapshotSources.get(this).pendingDeleteId,
    );
  }
  get chatIdText() {
    return (0, exports.normalizeString)(snapshotSources.get(this).chatId);
  }
  get numericMessageId() {
    return Number(snapshotSources.get(this).messageId);
  }
  deleteInput() {
    return (0, client_js_1.retainTelegramDeleteInput)({
      chatId: snapshotSources.get(this).chatId,
      messageId: snapshotSources.get(this).messageId,
    });
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
  const output = { ...asObject(value) };
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
  const value = asObject(pendingDelete);
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
  const queue = asObject(value.pendingDeleteQueue);
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
  const value = asObject(delivery);
  const currentPendingDelete = asObject(value.pendingDelete);
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
      ...asObject(value.pendingDeleteQueue),
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
  const value = asObject(desired);
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
