const { MATCH_TIMER_TERMINAL } = require("@mons/shared/timers");
const { loadMonsRules, movesFromFlatString } = require("./monsRules");

const isNonEmptyString = (value) => typeof value === "string" && value !== "";
const normalizeColor = (value) =>
  value === "white" || value === "black" ? value : null;

async function resolveMatchWinner(matchData, opponentMatchData) {
  if (!matchData || !opponentMatchData) {
    return { winner: null, reason: "missing-match" };
  }

  if (
    matchData.status === "surrendered" ||
    opponentMatchData.timer === MATCH_TIMER_TERMINAL
  ) {
    return { winner: "opponent", reason: "surrender-or-timer" };
  }

  if (
    opponentMatchData.status === "surrendered" ||
    matchData.timer === MATCH_TIMER_TERMINAL
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

  const mons = await loadMonsRules();
  const playerSubmission = {
    fen: matchData.fen,
    moves: movesFromFlatString(matchData.flatMovesString),
  };
  const opponentSubmission = {
    fen: opponentMatchData.fen,
    moves: movesFromFlatString(opponentMatchData.flatMovesString),
  };
  const resolution = mons.resolveMatch(
    playerColor === "white"
      ? { white: playerSubmission, black: opponentSubmission }
      : { white: opponentSubmission, black: playerSubmission },
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

module.exports = {
  resolveMatchWinner,
};
