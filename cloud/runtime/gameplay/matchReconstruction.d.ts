// Generated from src/gameplay/matchReconstruction.ts. Run npm run generate:runtime.
import {
  buildOrderedMoveHistory,
  type MatchHistoryRecord,
} from "@mons/shared/match-protocol";
export { buildOrderedMoveHistory };
export declare const requireLaterGameFromMatchData: <
  TGame extends {
    isLaterThan(other: TGame): boolean;
  },
>(
  mons: {
    Game: {
      fromFen(fen: string): TGame | undefined;
    };
  },
  matchData: MatchHistoryRecord | null | undefined,
  opponentMatchData: MatchHistoryRecord | null | undefined,
) => TGame | undefined;
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
