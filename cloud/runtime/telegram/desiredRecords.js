// Generated from src/telegram/desiredRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquiredDesiredView = acquiredDesiredView;
const records_js_1 = require("./records.js");
const fields = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const normalizedString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
class AcquiredDesired {
  document;
  constructor(document) {
    this.document = document;
  }
  get revision() {
    return fields(this.document).revision;
  }
  get operation() {
    return fields(this.document).operation;
  }
  get ifMissing() {
    return fields(this.document).ifMissing;
  }
  get instanceKey() {
    return fields(this.document).instanceKey;
  }
  get text() {
    return fields(this.document).text;
  }
  get destinationDescription() {
    return `${fields(this.document).destination}`;
  }
  resolveDestination(resolve) {
    return Reflect.apply(resolve, undefined, [
      fields(this.document).destination,
    ]);
  }
  matchesAppliedContent(applied) {
    return fields(applied).contentHash === fields(this.document).contentHash;
  }
  appliedTargetMismatch(applied, chatId) {
    const current = fields(applied);
    const desired = fields(this.document);
    return (
      normalizedString(current.instanceKey) !== desired.instanceKey ||
      normalizedString(current.destination) !== desired.destination ||
      (normalizedString(current.chatId) &&
        normalizedString(current.chatId) !== chatId)
    );
  }
  sendInput(chatId) {
    const desired = fields(this.document);
    return {
      chatId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    };
  }
  editInput(chatId, messageId) {
    const desired = fields(this.document);
    return {
      chatId,
      messageId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    };
  }
  createSendMarker(attemptId, chatId, nowMs) {
    const desired = fields(this.document);
    const marker = {
      attemptId,
      revision: desired.revision,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      contentHash: desired.contentHash,
      startedAtMs: nowMs,
      apiGateOwner: `send:${attemptId}`,
    };
    return marker;
  }
  createAppliedReceipt(chatId, messageId, nowMs) {
    const desired = fields(this.document);
    const receipt = {
      destination: desired.destination,
      chatId,
      messageId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt;
  }
  refreshAppliedReceipt(applied, chatId, nowMs) {
    const desired = fields(this.document);
    const receipt = {
      ...fields(applied),
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      revision: desired.revision,
      contentHash: desired.contentHash,
      appliedAtMs: nowMs,
    };
    return receipt;
  }
}
function acquiredDesiredView(message) {
  const value = new AcquiredDesired(
    (0, records_js_1.messageDesiredDocument)(message),
  );
  return value;
}
