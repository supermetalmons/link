const { HttpsError } = require("firebase-functions/v2/https");
const {
  buildOrderedMoveHistory,
  movesFromFlatString,
  parseGameFromMatchData,
  selectLaterGame,
} = require("@mons/shared/match-protocol");

const requireLaterGameFromMatchData = (mons, matchData, opponentMatchData) => {
  const playerGame = parseGameFromMatchData(mons, matchData);
  const opponentGame = parseGameFromMatchData(mons, opponentMatchData);
  if (!playerGame || !opponentGame) {
    throw new HttpsError(
      "failed-precondition",
      "something is wrong with the game state.",
    );
  }
  return selectLaterGame(playerGame, opponentGame);
};

const selectLaterGameForRating = (mons, matchData, opponentMatchData) => {
  const playerGame = parseGameFromMatchData(mons, matchData);
  const opponentGame = parseGameFromMatchData(mons, opponentMatchData);
  if (!playerGame && !opponentGame) {
    throw new HttpsError("internal", "Could not validate the game score.");
  }
  return selectLaterGame(playerGame, opponentGame);
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
