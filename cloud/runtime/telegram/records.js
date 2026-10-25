// Generated from src/telegram/records.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppliedMessageSnapshot = void 0;
exports.readTelegramMessageDocument = readTelegramMessageDocument;
exports.readTelegramControlDocument = readTelegramControlDocument;
exports.messageDocument = messageDocument;
exports.controlDocument = controlDocument;
exports.apiGateDocument = apiGateDocument;
exports.appliedDocument = appliedDocument;
exports.desiredDocument = desiredDocument;
exports.updateTelegramApplied = updateTelegramApplied;
exports.sendEvidenceDocument = sendEvidenceDocument;
exports.messageDeliveryDocument = messageDeliveryDocument;
exports.messageDesiredDocument = messageDesiredDocument;
exports.messageDesiredRevision = messageDesiredRevision;
exports.messageAppliedDocument = messageAppliedDocument;
exports.messageRecoveryResultDocument = messageRecoveryResultDocument;
exports.readMessageApplied = readMessageApplied;
exports.telegramApiGateOwner = telegramApiGateOwner;
exports.updateTelegramMessage = updateTelegramMessage;
exports.omitTelegramMessageFields = omitTelegramMessageFields;
exports.updateTelegramControl = updateTelegramControl;
exports.clearTelegramApiGate = clearTelegramApiGate;
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
function readTelegramMessageDocument(value) {
  const source = record(value);
  return source;
}
function readTelegramControlDocument(value) {
  const source = record(value);
  return source;
}
function messageDocument(value) {
  return record(value) || {};
}
function controlDocument(value) {
  return record(value) || {};
}
function apiGateDocument(value) {
  return record(value) || {};
}
function appliedDocument(value) {
  return record(value) || {};
}
function desiredDocument(value) {
  return record(value) || {};
}
function updateTelegramApplied(current, fields) {
  const value = { ...current, ...fields };
  return value;
}
function sendEvidenceDocument(value) {
  return value;
}
function messageDeliveryDocument(value) {
  return record(record(value)?.delivery) || {};
}
function messageDesiredDocument(value) {
  return record(record(value)?.desired) || {};
}
function messageDesiredRevision(value) {
  const desired = record(value)?.desired;
  const revision = desired?.revision;
  return typeof revision === "string" && revision.trim() !== ""
    ? revision.trim()
    : "";
}
function messageAppliedDocument(value) {
  return record(record(value)?.applied) || {};
}
function messageRecoveryResultDocument(value) {
  return record(record(value)?.manualRecoveryResult) || {};
}
class AppliedMessageSnapshot {
  document;
  constructor(document) {
    this.document = document;
  }
  get chatId() {
    const value = record(this.document)?.chatId;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  }
  get messageId() {
    const value = record(this.document)?.messageId;
    return typeof value === "number" ? value : undefined;
  }
  hasMessageId() {
    const source = record(this.document);
    return (
      typeof source.messageId === "number" &&
      Number.isInteger(source.messageId) &&
      source.messageId > 0
    );
  }
  retainedDocument() {
    return this.document;
  }
}
exports.AppliedMessageSnapshot = AppliedMessageSnapshot;
function readMessageApplied(value) {
  return new AppliedMessageSnapshot(messageAppliedDocument(value));
}
function telegramApiGateOwner(value) {
  const retained = value;
  const evidence = retained;
  const owner = evidence?.owner;
  return typeof owner === "string" && owner.trim() !== "" ? owner.trim() : "";
}
function updateTelegramMessage(current, fields) {
  const value = { ...current, ...fields };
  return value;
}
function omitTelegramMessageFields(current, fields) {
  const output = { ...current };
  for (const field of fields) delete output[field];
  return output;
}
function updateTelegramControl(current, fields) {
  const value = { ...current, ...fields };
  return value;
}
function clearTelegramApiGate(current) {
  const output = { ...current };
  delete output.apiGate;
  return output;
}
