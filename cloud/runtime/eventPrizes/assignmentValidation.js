// Generated from src/eventPrizes/assignmentValidation.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePrizeAssignment = void 0;
const errors_js_1 = require("./errors.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const validatePrizeAssignment = ({
  assignment,
  eventId,
  prizeId,
  profileId,
}) => {
  const fields = assignment;
  const place = Number(fields?.place);
  if (
    !assignment ||
    normalizeString(fields?.eventId) !== eventId ||
    normalizeString(fields?.prizeId) !== prizeId ||
    normalizeString(fields?.profileId) !== profileId ||
    (place !== 1 && place !== 2 && place !== 3)
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "not-found",
      "Event prize not found.",
    );
  }
  return place;
};
exports.validatePrizeAssignment = validatePrizeAssignment;
