"use strict";

class EventPrizeWithdrawalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EventPrizeWithdrawalError";
    this.code = code;
  }
}

module.exports = { EventPrizeWithdrawalError };
