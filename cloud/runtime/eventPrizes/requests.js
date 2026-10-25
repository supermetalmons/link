// Generated from src/eventPrizes/requests.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWithdrawalRequest = readWithdrawalRequest;
const trimmed = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
function readWithdrawalRequest(value) {
  const fields = value && typeof value === "object" ? value : {};
  return {
    eventId: trimmed(fields.eventId),
    prizeId: trimmed(fields.prizeId),
    solanaAddress: trimmed(fields.solanaAddress),
  };
}
