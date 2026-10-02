// Generated from src/gameplay/matchReconstruction.ts. Run npm run generate:runtime.
import {
  buildOrderedMoveHistory,
  type MatchHistoryRecord,
} from "@mons/shared/match-protocol";
export { buildOrderedMoveHistory };
export declare const buildOrderedMatchSubmissions: <
  T extends MatchHistoryRecord,
>(
  playerColor: unknown,
  matchData: T,
  opponentMatchData: T,
) => {
  white: {
    fen: unknown;
    moves: string[];
  };
  black: {
    fen: unknown;
    moves: string[];
  };
};
