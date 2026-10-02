import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { loadMonsRules } from "./monsRules.js";
import { buildOrderedMatchSubmissions } from "./gameplay/matchReconstruction.js";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
const normalizeColor = (value: unknown) =>
  value === "white" || value === "black" ? value : null;

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

export async function resolveMatchWinner(
  matchData: MatchOutcomeRecord | null | undefined,
  opponentMatchData: MatchOutcomeRecord | null | undefined,
): Promise<MatchWinnerResolution> {
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
  const resolution = mons.resolveMatch(
    buildOrderedMatchSubmissions(
      playerColor,
      matchData,
      opponentMatchData,
    ) as Parameters<typeof mons.resolveMatch>[0],
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
