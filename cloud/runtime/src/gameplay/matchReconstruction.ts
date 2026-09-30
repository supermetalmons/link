import {
  buildOrderedMoveHistory,
  movesFromFlatString,
  parseGameFromMatchData,
  selectLaterGame,
  type MatchHistoryRecord,
} from "@mons/shared/match-protocol";
class MatchReconstructionError extends Error {
  declare readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export { buildOrderedMoveHistory };

export const requireLaterGameFromMatchData = <
  TGame extends { isLaterThan(other: TGame): boolean },
>(
  mons: { Game: { fromFen(fen: string): TGame | undefined } },
  matchData: MatchHistoryRecord | null | undefined,
  opponentMatchData: MatchHistoryRecord | null | undefined,
): TGame | undefined => {
  const playerGame = parseGameFromMatchData(mons, matchData);
  const opponentGame = parseGameFromMatchData(mons, opponentMatchData);
  if (!playerGame || !opponentGame) {
    throw new MatchReconstructionError(
      "failed-precondition",
      "something is wrong with the game state.",
    );
  }
  return selectLaterGame(playerGame, opponentGame);
};

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
