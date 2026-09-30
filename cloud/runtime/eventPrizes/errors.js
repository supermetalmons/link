// Generated from src/eventPrizes/errors.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventPrizeWithdrawalError = void 0;
class EventPrizeWithdrawalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EventPrizeWithdrawalError";
    this.code = code;
  }
}
exports.EventPrizeWithdrawalError = EventPrizeWithdrawalError;
