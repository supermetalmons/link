// Generated from src/eventProjectionOutboxRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retainEventProjectionOutbox = retainEventProjectionOutbox;
exports.createEventProfileGameProjectionRequest =
  createEventProfileGameProjectionRequest;
exports.createEventTelegramProjectionRequest =
  createEventTelegramProjectionRequest;
function retainEventProjectionOutbox(_kind, value) {
  return value;
}
function createEventProfileGameProjectionRequest(value) {
  return retainEventProjectionOutbox("profile-game", value);
}
function createEventTelegramProjectionRequest(value) {
  return retainEventProjectionOutbox("telegram", value);
}
