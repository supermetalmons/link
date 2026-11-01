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
  exports.PendingDeleteSnapshot =
  exports.DeliverySnapshot =
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
exports.omitKeys = omitKeys;
exports.documentFields = documentFields;
const crypto = __importStar(require("node:crypto"));
const client_js_1 = require("./client.js");
const values_js_1 = require("./values.js");
const recordCodec_js_1 = require("./recordCodec.js");
function preserveSendEvidence(value, present = true) {
  return present ? value : undefined;
}
function writeDelivery(transition) {
  const output = { ...transition };
  if ("sendInFlight" in output && output.sendInFlight === undefined)
    Reflect.deleteProperty(output, "sendInFlight");
  const value = (0, recordCodec_js_1.readTelegramDelivery)(output);
  if (!value) throw new TypeError("invalid-telegram-delivery-transition");
  return value;
}
function writeCleanup(transition) {
  const value = (0, recordCodec_js_1.readTelegramCleanup)(transition);
  if (!value) throw new TypeError("invalid-telegram-cleanup-transition");
  return value;
}
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
exports.normalizeString = normalizeString;
const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
class RetrySnapshot {
  document;
  constructor(document = {}) {
    this.document = document;
  }
  get present() {
    return Object.keys(this.document).length > 0;
  }
  get attempts() {
    return this.document.attempts ?? 0;
  }
  get leaseOwner() {
    return this.document.leaseOwner ?? "";
  }
  get leaseExpiresAtMs() {
    return this.document.leaseExpiresAtMs ?? 0;
  }
  get retryStartedAtMs() {
    return this.document.retryStartedAtMs ?? 0;
  }
  get retryDeadlineAtMs() {
    return this.document.retryDeadlineAtMs ?? 0;
  }
  get retryAtMs() {
    return this.document.retryAtMs ?? 0;
  }
  get retrySequence() {
    return this.document.retrySequence ?? 0;
  }
  retryTimestampOr(field, fallback) {
    return this.document[field] ?? fallback ?? 0;
  }
  retrySequenceOr(fallback) {
    return this.document.retrySequence ?? fallback ?? 0;
  }
  get apiGateOwner() {
    return this.document.apiGateOwner ?? "";
  }
  get apiGateGeneration() {
    return this.document.apiGateGeneration ?? "";
  }
  get apiGateStartedAtMs() {
    return this.document.apiGateStartedAtMs ?? 0;
  }
  get apiGateProofRequired() {
    return this.document.apiGateProofRequired;
  }
  get apiGateProofOwner() {
    return this.document.apiGateProofRequired?.owner ?? "";
  }
}
function deliveryDocument(value) {
  return value.document;
}
function pendingDeleteDocument(value) {
  return value.document;
}
function retryDocument(value) {
  return value instanceof DeliverySnapshot ||
    value instanceof PendingDeleteSnapshot
    ? value.document
    : value;
}
class DeliverySnapshot extends RetrySnapshot {
  get status() {
    const status = this.document.status;
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
    return this.status ?? "missing";
  }
  get revision() {
    return typeof this.document.revision === "string"
      ? this.document.revision
      : undefined;
  }
  matchesRevision(revision) {
    return (
      typeof this.document.revision === "string" &&
      (0, exports.normalizeString)(this.document.revision) === revision
    );
  }
  get sendInFlight() {
    return this.document.sendInFlight;
  }
  get hasSendInFlight() {
    return Boolean(this.document.sendInFlight);
  }
  get hasAppliedStateUnknown() {
    return Boolean(this.document.appliedStateUnknown);
  }
  get hasRawApiGateOwner() {
    return Boolean(this.document.apiGateOwner);
  }
  sendInFlightMatchesRevision(revision) {
    return (
      (0, values_js_1.readProperty)(this.document.sendInFlight, "revision") ===
      revision
    );
  }
  preservedSendInFlight() {
    return preserveSendEvidence(
      this.document.sendInFlight,
      Object.hasOwn(this.document, "sendInFlight"),
    );
  }
  get pendingDelete() {
    return new PendingDeleteSnapshot(this.document.pendingDelete);
  }
  get orphanedDeletes() {
    return this.document.orphanedDeletes ?? {};
  }
  get apiGateSettleOwner() {
    return (0, exports.normalizeString)(this.document.apiGateSettleOwner);
  }
  get pendingDeleteApiGateSettleOwner() {
    return (0, exports.normalizeString)(
      this.document.pendingDeleteApiGateSettleOwner,
    );
  }
  get apiGateReleaseOwner() {
    return (0, exports.normalizeString)(this.document.apiGateReleaseOwner);
  }
  get lastRecoveryRequestId() {
    return (0, exports.normalizeString)(this.document.lastRecoveryRequestId);
  }
  settlementOwner(field) {
    return (0, exports.normalizeString)(this.document[field]);
  }
}
exports.DeliverySnapshot = DeliverySnapshot;
class PendingDeleteSnapshot extends RetrySnapshot {
  get status() {
    const status = this.document.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable"
      ? status
      : undefined;
  }
  get kind() {
    return this.present ? (this.status ?? "missing") : "missing";
  }
  get pendingDeleteId() {
    return (0, exports.normalizeString)(this.document.pendingDeleteId);
  }
  get chatIdText() {
    return (0, exports.normalizeString)(this.document.chatId);
  }
  get numericMessageId() {
    return Number(this.document.messageId);
  }
  deleteInput() {
    if (!this.document.chatId || !this.document.messageId)
      throw new TypeError("telegram-cleanup-identity-missing");
    return (0, client_js_1.retainTelegramDeleteInput)({
      chatId: this.document.chatId,
      messageId: this.document.messageId,
    });
  }
}
exports.PendingDeleteSnapshot = PendingDeleteSnapshot;
function readDelivery(value) {
  return value instanceof DeliverySnapshot
    ? value
    : new DeliverySnapshot(value ?? {});
}
function readPendingDelete(value) {
  return value instanceof PendingDeleteSnapshot
    ? value
    : new PendingDeleteSnapshot(value ?? {});
}
function omitKeys(value, keys) {
  const source =
    value instanceof DeliverySnapshot || value instanceof PendingDeleteSnapshot
      ? value.document
      : value;
  const output = { ...source };
  for (const key of keys) Reflect.deleteProperty(output, key);
  return output;
}
const buildPendingDeleteId = ({ chatId, messageId }) =>
  hashValue(
    `${(0, exports.normalizeString)(chatId)}:${Number(messageId)}`,
  ).slice(0, 32);
exports.buildPendingDeleteId = buildPendingDeleteId;
const buildApiGateOwner = (...parts) =>
  `api_${hashValue(parts.map((part) => String(part ?? "")).join(":"))}`;
exports.buildApiGateOwner = buildApiGateOwner;
const resolvePendingDeleteId = (pendingDelete) => {
  const value =
    pendingDelete instanceof PendingDeleteSnapshot
      ? pendingDelete.document
      : pendingDelete;
  return value.pendingDeleteId ?? "";
};
exports.resolvePendingDeleteId = resolvePendingDeleteId;
const promotePendingDeleteQueue = (input) => {
  const delivery = input instanceof DeliverySnapshot ? input.document : input;
  const value = omitKeys(delivery, ["pendingDelete"]);
  const queue = value.pendingDeleteQueue ?? {};
  const [nextPendingDeleteId] = Object.keys(queue).sort();
  if (!nextPendingDeleteId) return omitKeys(value, ["pendingDeleteQueue"]);
  const nextQueue = omitKeys(queue, [nextPendingDeleteId]);
  return {
    ...omitKeys(value, ["pendingDeleteQueue"]),
    pendingDelete: queue[nextPendingDeleteId],
    ...(Object.keys(nextQueue).length > 0
      ? { pendingDeleteQueue: nextQueue }
      : {}),
  };
};
exports.promotePendingDeleteQueue = promotePendingDeleteQueue;
const appendPendingDelete = (delivery, pendingDelete) => {
  if (!delivery.pendingDelete) return { ...delivery, pendingDelete };
  if (delivery.pendingDelete.pendingDeleteId === pendingDelete.pendingDeleteId)
    return delivery;
  return {
    ...delivery,
    pendingDeleteQueue: {
      ...delivery.pendingDeleteQueue,
      [pendingDelete.pendingDeleteId]: pendingDelete,
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
const validateDesiredForDelivery = (desired) =>
  (0, recordCodec_js_1.readTelegramDesired)(desired) !== null;
exports.validateDesiredForDelivery = validateDesiredForDelivery;
function documentFields(value) {
  return value instanceof DeliverySnapshot ||
    value instanceof PendingDeleteSnapshot
    ? value.document
    : (value ?? {});
}
