// Generated from src/gameplay/matchReconstruction.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOrderedMatchSubmissions =
  exports.requireLaterGameFromMatchData =
  exports.buildOrderedMoveHistory =
    void 0;
const match_protocol_1 = require("@mons/shared/match-protocol");
Object.defineProperty(exports, "buildOrderedMoveHistory", {
  enumerable: true,
  get: function () {
    return match_protocol_1.buildOrderedMoveHistory;
  },
});
class MatchReconstructionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const requireLaterGameFromMatchData = (mons, matchData, opponentMatchData) => {
  const playerGame = (0, match_protocol_1.parseGameFromMatchData)(
    mons,
    matchData,
  );
  const opponentGame = (0, match_protocol_1.parseGameFromMatchData)(
    mons,
    opponentMatchData,
  );
  if (!playerGame || !opponentGame) {
    throw new MatchReconstructionError(
      "failed-precondition",
      "something is wrong with the game state.",
    );
  }
  return (0, match_protocol_1.selectLaterGame)(playerGame, opponentGame);
};
exports.requireLaterGameFromMatchData = requireLaterGameFromMatchData;
const buildOrderedMatchSubmissions = (
  playerColor,
  matchData,
  opponentMatchData,
) => {
  const playerSubmission = {
    fen: matchData.fen,
    moves: (0, match_protocol_1.movesFromFlatString)(matchData.flatMovesString),
  };
  const opponentSubmission = {
    fen: opponentMatchData.fen,
    moves: (0, match_protocol_1.movesFromFlatString)(
      opponentMatchData.flatMovesString,
    ),
  };
  return playerColor === "white"
    ? { white: playerSubmission, black: opponentSubmission }
    : { white: opponentSubmission, black: playerSubmission };
};
exports.buildOrderedMatchSubmissions = buildOrderedMatchSubmissions;
