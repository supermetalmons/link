// Generated from src/shared/timers.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStartMatchTimerResponse =
  exports.isStartMatchTimerRequest =
  exports.isClaimMatchVictoryByTimerResponse =
  exports.isClaimMatchVictoryByTimerRequest =
  exports.isMatchTimerTerminal =
  exports.parseStrictMatchTimer =
  exports.parseMatchTimer =
  exports.formatMatchTimer =
  exports.MATCH_TIMER_CLAIM_ROOT =
  exports.MATCH_TIMER_TERMINAL =
  exports.MATCH_TIMER_DURATION_SECONDS =
  exports.MATCH_TIMER_DURATION_MS =
    void 0;
const ids_js_1 = require("./ids.js");
const MATCH_TIMER_DURATION_MS = 90000;
exports.MATCH_TIMER_DURATION_MS = MATCH_TIMER_DURATION_MS;
const MATCH_TIMER_DURATION_SECONDS = MATCH_TIMER_DURATION_MS / 1000;
exports.MATCH_TIMER_DURATION_SECONDS = MATCH_TIMER_DURATION_SECONDS;
const MATCH_TIMER_TERMINAL = "gg";
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
const formatMatchTimer = (turnNumber, targetTimestamp) =>
  `${turnNumber};${targetTimestamp}`;
exports.formatMatchTimer = formatMatchTimer;
const parseMatchTimer = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const [turnNumber, targetTimestamp] = value.split(";").map(Number);
  if (
    typeof turnNumber !== "number" ||
    Number.isNaN(turnNumber) ||
    typeof targetTimestamp !== "number" ||
    Number.isNaN(targetTimestamp)
  ) {
    return null;
  }
  return {
    turnNumber,
    targetTimestamp,
  };
};
exports.parseMatchTimer = parseMatchTimer;
const isMatchTimerTerminal = (value) => value === MATCH_TIMER_TERMINAL;
exports.isMatchTimerTerminal = isMatchTimerTerminal;
const parseStrictMatchTimer = (value) => {
  if (typeof value !== "string" || !/^\d+;\d+$/.test(value)) {
    return null;
  }
  const parsed = parseMatchTimer(value);
  return parsed !== null &&
    Number.isSafeInteger(parsed.turnNumber) &&
    parsed.turnNumber >= 0 &&
    Number.isSafeInteger(parsed.targetTimestamp) &&
    parsed.targetTimestamp > 0
    ? parsed
    : null;
};
exports.parseStrictMatchTimer = parseStrictMatchTimer;
const isStartMatchTimerRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "matchId", "inviteId"]) &&
  (0, ids_js_1.isSafeRecordKey)(value.playerId) &&
  (0, ids_js_1.isSafeRecordKey)(value.opponentId) &&
  (0, ids_js_1.isSafeRecordKey)(value.matchId) &&
  (0, ids_js_1.isSafeRecordKey)(value.inviteId) &&
  value.playerId.trim() !== value.opponentId.trim();
exports.isStartMatchTimerRequest = isStartMatchTimerRequest;
const isClaimMatchVictoryByTimerRequest = isStartMatchTimerRequest;
exports.isClaimMatchVictoryByTimerRequest = isClaimMatchVictoryByTimerRequest;
const isStartMatchTimerResponse = (value) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "timer", "duration"]) ||
    value.ok !== true ||
    value.duration !== MATCH_TIMER_DURATION_MS
  ) {
    return false;
  }
  return parseStrictMatchTimer(value.timer) !== null;
};
exports.isStartMatchTimerResponse = isStartMatchTimerResponse;
const isClaimMatchVictoryByTimerResponse = (value) =>
  isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === true;
exports.isClaimMatchVictoryByTimerResponse = isClaimMatchVictoryByTimerResponse;
