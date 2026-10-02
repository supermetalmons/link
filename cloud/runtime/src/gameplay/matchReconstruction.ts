import {
  buildOrderedMoveHistory,
  movesFromFlatString,
  type MatchHistoryRecord,
} from "@mons/shared/match-protocol";
export { buildOrderedMoveHistory };

export const buildOrderedMatchSubmissions = <T extends MatchHistoryRecord>(
  playerColor: unknown,
  matchData: T,
  opponentMatchData: T,
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
