// Generated from src/shared/timers.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isClaimMatchVictoryByTimerResponse =
  exports.isStartMatchTimerResponse =
  exports.isStartMatchTimerRequest =
  exports.isClaimMatchVictoryByTimerRequest =
  exports.parseStrictMatchTimer =
  exports.parseMatchTimer =
  exports.formatMatchTimer =
  exports.MATCH_TIMER_CLAIM_ROOT =
  exports.MATCH_TIMER_TERMINAL =
  exports.MATCH_TIMER_DURATION_SECONDS =
  exports.MATCH_TIMER_DURATION_MS =
    void 0;
exports.isMatchTimer = isMatchTimer;
exports.isRunningMatchTimer = isRunningMatchTimer;
exports.matchTimersEqual = matchTimersEqual;
exports.isTimerClaim = isTimerClaim;
const ids_js_1 = require("./ids.js");
const MATCH_TIMER_DURATION_MS = 90000;
exports.MATCH_TIMER_DURATION_MS = MATCH_TIMER_DURATION_MS;
const MATCH_TIMER_DURATION_SECONDS = MATCH_TIMER_DURATION_MS / 1000;
exports.MATCH_TIMER_DURATION_SECONDS = MATCH_TIMER_DURATION_SECONDS;
const MATCH_TIMER_TERMINAL = Object.freeze({
  state: "finished",
});
exports.MATCH_TIMER_TERMINAL = MATCH_TIMER_TERMINAL;
const MATCH_TIMER_CLAIM_ROOT = "matchTimerClaims";
exports.MATCH_TIMER_CLAIM_ROOT = MATCH_TIMER_CLAIM_ROOT;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};
const integer = (value, minimum = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const key = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  (0, ids_js_1.isSafeRecordKey)(value);
function isMatchTimer(value) {
  if (!isRecord(value)) return false;
  if (value.state === "idle" || value.state === "finished")
    return hasExactKeys(value, ["state"]);
  return (
    value.state === "running" &&
    hasExactKeys(value, ["state", "turnNumber", "deadlineAtMs"]) &&
    integer(value.turnNumber) &&
    integer(value.deadlineAtMs, 1)
  );
}
function isRunningMatchTimer(value) {
  return isMatchTimer(value) && value.state === "running";
}
function matchTimersEqual(left, right) {
  return (
    left.state === right.state &&
    (left.state !== "running" ||
      (right.state === "running" &&
        left.turnNumber === right.turnNumber &&
        left.deadlineAtMs === right.deadlineAtMs))
  );
}
function isTimerClaim(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "status",
      "inviteId",
      "playerId",
      "opponentId",
      "timer",
      "turnNumber",
      "claimedAtMs",
      "expiresAtMs",
    ]) ||
    value.schemaVersion !== 1 ||
    !key(value.inviteId) ||
    !key(value.playerId) ||
    !key(value.opponentId) ||
    value.playerId === value.opponentId ||
    !integer(value.turnNumber) ||
    !isMatchTimer(value.timer) ||
    value.timer.state === "idle" ||
    (value.timer.state === "running" &&
      value.timer.turnNumber !== value.turnNumber)
  )
    return false;
  return value.status === "pending"
    ? value.timer.state === "running" &&
        value.claimedAtMs === null &&
        integer(value.expiresAtMs)
    : value.status === "claimed" &&
        integer(value.claimedAtMs) &&
        value.expiresAtMs === null;
}
const formatMatchTimer = (turnNumber, deadlineAtMs) => {
  const timer = {
    state: "running",
    turnNumber,
    deadlineAtMs,
  };
  if (!isRunningMatchTimer(timer)) throw new TypeError("invalid-match-timer");
  return timer;
};
exports.formatMatchTimer = formatMatchTimer;
const parseMatchTimer = (value) => (isRunningMatchTimer(value) ? value : null);
exports.parseMatchTimer = parseMatchTimer;
const parseStrictMatchTimer = parseMatchTimer;
exports.parseStrictMatchTimer = parseStrictMatchTimer;
const isStartMatchTimerRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "matchId", "inviteId"]) &&
  key(value.playerId) &&
  key(value.opponentId) &&
  key(value.matchId) &&
  key(value.inviteId) &&
  value.playerId !== value.opponentId;
exports.isStartMatchTimerRequest = isStartMatchTimerRequest;
const isClaimMatchVictoryByTimerRequest = isStartMatchTimerRequest;
exports.isClaimMatchVictoryByTimerRequest = isClaimMatchVictoryByTimerRequest;
const isStartMatchTimerResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "timer", "duration"]) &&
  value.ok === true &&
  value.duration === MATCH_TIMER_DURATION_MS &&
  isRunningMatchTimer(value.timer);
exports.isStartMatchTimerResponse = isStartMatchTimerResponse;
const isClaimMatchVictoryByTimerResponse = (value) =>
  isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === true;
exports.isClaimMatchVictoryByTimerResponse = isClaimMatchVictoryByTimerResponse;
