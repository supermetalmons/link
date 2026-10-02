// Generated from src/matchOutcome.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveMatchWinner = resolveMatchWinner;
const timers_1 = require("@mons/shared/timers");
const monsRules_js_1 = require("./monsRules.js");
const matchReconstruction_js_1 = require("./gameplay/matchReconstruction.js");
const isNonEmptyString = (value) => typeof value === "string" && value !== "";
const normalizeColor = (value) =>
  value === "white" || value === "black" ? value : null;
async function resolveMatchWinner(matchData, opponentMatchData) {
  if (!matchData || !opponentMatchData) {
    return { winner: null, reason: "missing-match" };
  }
  if (
    matchData.status === "surrendered" ||
    opponentMatchData.timer === timers_1.MATCH_TIMER_TERMINAL
  ) {
    return { winner: "opponent", reason: "surrender-or-timer" };
  }
  if (
    opponentMatchData.status === "surrendered" ||
    matchData.timer === timers_1.MATCH_TIMER_TERMINAL
  ) {
    return { winner: "player", reason: "surrender-or-timer" };
  }
  const playerColor = normalizeColor(matchData.color);
  const opponentColor = normalizeColor(opponentMatchData.color);
  if (!playerColor || !opponentColor) {
    return { winner: null, reason: "missing-color" };
  }
  if (playerColor === opponentColor) {
    return { winner: null, reason: "invalid-colors" };
  }
  if (
    !isNonEmptyString(matchData.fen) ||
    !isNonEmptyString(opponentMatchData.fen)
  ) {
    return { winner: null, reason: "missing-fen" };
  }
  const mons = await (0, monsRules_js_1.loadMonsRules)();
  const resolution = mons.resolveMatch(
    (0, matchReconstruction_js_1.buildOrderedMatchSubmissions)(
      playerColor,
      matchData,
      opponentMatchData,
    ),
  );
  if (resolution.kind === "winner") {
    const winnerColor = resolution.winner;
    return {
      winner:
        playerColor === winnerColor
          ? "player"
          : opponentColor === winnerColor
            ? "opponent"
            : null,
      reason: "winner-color",
    };
  }
  return {
    winner: null,
    reason: resolution.kind === "invalid" ? "invalid-game" : "pending",
  };
}
