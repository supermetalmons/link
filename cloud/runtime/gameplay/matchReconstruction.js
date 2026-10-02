// Generated from src/gameplay/matchReconstruction.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOrderedMatchSubmissions = exports.buildOrderedMoveHistory = void 0;
const match_protocol_1 = require("@mons/shared/match-protocol");
Object.defineProperty(exports, "buildOrderedMoveHistory", {
  enumerable: true,
  get: function () {
    return match_protocol_1.buildOrderedMoveHistory;
  },
});
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
