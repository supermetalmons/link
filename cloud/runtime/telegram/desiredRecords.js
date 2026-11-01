// Generated from src/telegram/desiredRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquiredDesiredView = acquiredDesiredView;
const records_js_1 = require("./records.js");
class AcquiredDesired {
  document;
  constructor(document) {
    this.document = document;
  }
  get revision() {
    return this.document.revision;
  }
  get operation() {
    return this.document.operation;
  }
  get ifMissing() {
    return this.document.operation === "edit"
      ? this.document.ifMissing
      : undefined;
  }
  get instanceKey() {
    if (this.document.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return this.document.instanceKey;
  }
  get text() {
    if (this.document.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return this.document.text;
  }
  get destinationDescription() {
    return `${this.document.destination}`;
  }
  resolveDestination(resolve) {
    return resolve(this.document.destination);
  }
  matchesAppliedContent(applied) {
    return (
      this.document.operation !== "delete" &&
      applied.contentHash === this.document.contentHash
    );
  }
  appliedTargetMismatch(applied, chatId) {
    const current = applied;
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return (
      current.instanceKey !== desired.instanceKey ||
      current.destination !== desired.destination ||
      (current.chatId && current.chatId !== chatId)
    );
  }
  sendInput(chatId) {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return {
      chatId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview,
    };
  }
  editInput(chatId, messageId) {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    return {
      chatId,
      messageId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      disableWebPagePreview: desired.disableWebPagePreview,
    };
  }
  createSendMarker(attemptId, chatId, nowMs) {
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
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
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
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
    const desired = this.document;
    if (desired.operation === "delete")
      throw new TypeError("telegram-desired-text-required");
    const receipt = {
      ...applied,
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
  const desired = (0, records_js_1.messageDesiredDocument)(message);
  if (!desired) throw new TypeError("telegram-desired-missing");
  return new AcquiredDesired(desired);
}
