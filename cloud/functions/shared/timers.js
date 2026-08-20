"use strict";

const { isSafeFirebaseKey } = require("./ids");

const MATCH_TIMER_DURATION_MS = 90000;
const MATCH_TIMER_DURATION_SECONDS = MATCH_TIMER_DURATION_MS / 1000;
const MATCH_TIMER_TERMINAL = "gg";
const MATCH_TIMER_START_ROOT = "matchTimerStarts";

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

const isMatchTimerTerminal = (value) => value === MATCH_TIMER_TERMINAL;

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

const isStartMatchTimerRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "matchId", "inviteId"]) &&
  isSafeFirebaseKey(value.playerId) &&
  isSafeFirebaseKey(value.opponentId) &&
  isSafeFirebaseKey(value.matchId) &&
  isSafeFirebaseKey(value.inviteId) &&
  value.playerId.trim() !== value.opponentId.trim();

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

module.exports = {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_DURATION_SECONDS,
  MATCH_TIMER_TERMINAL,
  MATCH_TIMER_START_ROOT,
  formatMatchTimer,
  parseMatchTimer,
  parseStrictMatchTimer,
  isMatchTimerTerminal,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
};
