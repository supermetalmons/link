// Generated from src/telegram/records.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppliedMessageSnapshot =
  exports.readTelegramControlDocument =
  exports.readTelegramMessageDocument =
    void 0;
exports.messageDocument = messageDocument;
exports.controlDocument = controlDocument;
exports.apiGateDocument = apiGateDocument;
exports.sendEvidenceDocument = sendEvidenceDocument;
exports.updateTelegramApplied = updateTelegramApplied;
exports.messageDeliveryDocument = messageDeliveryDocument;
exports.messageDesiredDocument = messageDesiredDocument;
exports.messageDesiredRevision = messageDesiredRevision;
exports.messageAppliedDocument = messageAppliedDocument;
exports.messageRecoveryResultDocument = messageRecoveryResultDocument;
exports.readMessageApplied = readMessageApplied;
exports.telegramApiGateOwner = telegramApiGateOwner;
exports.updateTelegramMessage = updateTelegramMessage;
exports.updateTelegramControl = updateTelegramControl;
exports.clearTelegramApiGate = clearTelegramApiGate;
var recordCodec_js_1 = require("./recordCodec.js");
Object.defineProperty(exports, "readTelegramMessageDocument", {
  enumerable: true,
  get: function () {
    return recordCodec_js_1.readTelegramMessageDocument;
  },
});
Object.defineProperty(exports, "readTelegramControlDocument", {
  enumerable: true,
  get: function () {
    return recordCodec_js_1.readTelegramControlDocument;
  },
});
function messageDocument(value) {
  return value ?? { schemaVersion: 1 };
}
function controlDocument(value) {
  return value ?? { schemaVersion: 1 };
}
function apiGateDocument(value) {
  return value;
}
function sendEvidenceDocument(value) {
  return value;
}
function updateTelegramApplied(current, fields) {
  return { ...current, ...fields };
}
function messageDeliveryDocument(value) {
  return value?.delivery ?? {};
}
function messageDesiredDocument(value) {
  return value?.desired;
}
function messageDesiredRevision(value) {
  return value?.desired?.revision ?? "";
}
function messageAppliedDocument(value) {
  return value?.applied;
}
function messageRecoveryResultDocument(value) {
  return value?.manualRecoveryResult;
}
class AppliedMessageSnapshot {
  document;
  constructor(document) {
    this.document = document;
  }
  get chatId() {
    return this.document?.chatId ?? "";
  }
  get messageId() {
    return this.document?.messageId;
  }
  hasMessageId() {
    return this.document !== undefined;
  }
  retainedDocument() {
    if (!this.document) throw new TypeError("telegram-applied-message-missing");
    return this.document;
  }
}
exports.AppliedMessageSnapshot = AppliedMessageSnapshot;
function readMessageApplied(value) {
  return new AppliedMessageSnapshot(value.applied);
}
function telegramApiGateOwner(value) {
  return value?.owner ?? "";
}
function updateTelegramMessage(current, fields) {
  return { ...current, ...fields };
}
function updateTelegramControl(current, fields) {
  return { ...current, ...fields };
}
function clearTelegramApiGate(current) {
  const output = { ...current };
  delete output.apiGate;
  return output;
}
