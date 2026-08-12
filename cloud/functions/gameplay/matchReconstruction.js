const { HttpsError } = require("firebase-functions/v2/https");
const { movesFromFlatString } = require("../monsRules");

const parseGameFromMatchData = (mons, matchData) =>
  typeof matchData.fen === "string"
    ? mons.Game.fromFen(matchData.fen)
    : undefined;

const requireLaterGameFromMatchData = (mons, matchData, opponentMatchData) => {
  const playerGame = parseGameFromMatchData(mons, matchData);
  const opponentGame = parseGameFromMatchData(mons, opponentMatchData);
  if (!playerGame || !opponentGame) {
    throw new HttpsError(
      "failed-precondition",
      "something is wrong with the game state.",
    );
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
};

const selectLaterGameForRating = (mons, matchData, opponentMatchData) => {
  const playerGame = parseGameFromMatchData(mons, matchData);
  const opponentGame = parseGameFromMatchData(mons, opponentMatchData);
  if (!playerGame && !opponentGame) {
    throw new HttpsError("internal", "Could not validate the game score.");
  }
  if (!playerGame) {
    return opponentGame;
  }
  if (!opponentGame) {
    return playerGame;
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
};

const buildOrderedMoveHistory = (matchData, opponentMatchData) => {
  if (matchData.color === "white") {
    return {
      white: movesFromFlatString(matchData.flatMovesString),
      black: movesFromFlatString(opponentMatchData.flatMovesString),
    };
  }
  return {
    white: movesFromFlatString(opponentMatchData.flatMovesString),
    black: movesFromFlatString(matchData.flatMovesString),
  };
};

const buildOrderedMatchSubmissions = (
  playerColor,
  matchData,
  opponentMatchData,
) => {
  const playerSubmission = {
    fen: matchData.fen,
    moves: movesFromFlatString(matchData.flatMovesString),
  };
  const opponentSubmission = {
    fen: opponentMatchData.fen,
    moves: movesFromFlatString(opponentMatchData.flatMovesString),
  };
  return playerColor === "white"
    ? { white: playerSubmission, black: opponentSubmission }
    : { white: opponentSubmission, black: playerSubmission };
};

module.exports = {
  buildOrderedMatchSubmissions,
  buildOrderedMoveHistory,
  requireLaterGameFromMatchData,
  selectLaterGameForRating,
};
