// Generated from src/matchOutcome.ts. Run npm run generate:runtime.
export type MatchOutcomeRecord = {
  status?: unknown;
  timer?: unknown;
  color?: unknown;
  fen?: unknown;
  flatMovesString?: unknown;
};
export type MatchWinnerResolution = {
  winner: "player" | "opponent" | null;
  reason:
    | "missing-match"
    | "surrender-or-timer"
    | "missing-color"
    | "invalid-colors"
    | "missing-fen"
    | "winner-color"
    | "invalid-game"
    | "pending";
};
export declare function resolveMatchWinner(
  matchData: MatchOutcomeRecord | null | undefined,
  opponentMatchData: MatchOutcomeRecord | null | undefined,
): Promise<MatchWinnerResolution>;
export declare const resolveMatchResult: (
  matchData: MatchOutcomeRecord | null | undefined,
  opponentMatchData: MatchOutcomeRecord | null | undefined,
) => Promise<{
  result: "win" | "gg" | "none";
}>;
