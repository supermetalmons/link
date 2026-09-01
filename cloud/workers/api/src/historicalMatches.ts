import {
  isHistoricalMatchPair,
  normalizeHistoricalMatchRecord,
  type HistoricalMatchPair,
} from "@mons/shared/game-sessions";
import {
  buildOrderedMoveHistory,
  movesFromFlatString,
  parseGameFromMatchData,
} from "@mons/shared/match-protocol";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { Color, Game } from "mons-rules";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";

export type HistoricalMatchSource = "backfill" | "rating" | "transition";
export const HISTORICAL_MATCH_ARCHIVE_VERSION = 1;

export type HistoricalMatchDescriptor = {
  finalizedAtMs: number;
  guestPlayerId: string;
  hostPlayerId: string;
  matchId: string;
  source: HistoricalMatchSource;
};

const normalizeHistoricalMatch = normalizeHistoricalMatchRecord;

export function buildHistoricalMatchPair(input: {
  guestMatch: unknown;
  guestPlayerId: unknown;
  hostMatch: unknown;
  hostPlayerId: unknown;
  matchId: unknown;
}): HistoricalMatchPair | null {
  const matchId =
    typeof input.matchId === "string" && isSafeFirebaseKey(input.matchId)
      ? input.matchId
      : "";
  const hostPlayerId =
    typeof input.hostPlayerId === "string" &&
    isSafeFirebaseKey(input.hostPlayerId)
      ? input.hostPlayerId
      : "";
  const guestPlayerId =
    typeof input.guestPlayerId === "string" &&
    isSafeFirebaseKey(input.guestPlayerId) &&
    input.guestPlayerId !== hostPlayerId
      ? input.guestPlayerId
      : null;
  if (!matchId || !hostPlayerId) return null;
  const hostMatch = normalizeHistoricalMatch(input.hostMatch);
  const guestMatch = guestPlayerId
    ? normalizeHistoricalMatch(input.guestMatch)
    : null;
  const pair = {
    matchId,
    hostPlayerId,
    guestPlayerId,
    hostMatch,
    guestMatch,
  };
  return isHistoricalMatchPair(pair) ? pair : null;
}

export function buildTransitionHistoricalMatchPair(input: {
  guestMatch: unknown;
  guestPlayerId: unknown;
  hostMatch: unknown;
  hostPlayerId: unknown;
  matchId: unknown;
}): HistoricalMatchPair | null {
  const pair = buildHistoricalMatchPair(input);
  const hostMatch = pair?.hostMatch;
  const guestMatch = pair?.guestMatch;
  if (
    !pair ||
    !hostMatch ||
    !guestMatch ||
    hostMatch.color === guestMatch.color
  ) {
    return null;
  }
  let hostGame: Game | undefined;
  let guestGame: Game | undefined;
  try {
    hostGame = parseGameFromMatchData({ Game }, hostMatch);
    guestGame = parseGameFromMatchData({ Game }, guestMatch);
  } catch {
    return null;
  }
  if (!hostGame || !guestGame || hostGame.variant !== guestGame.variant) {
    return null;
  }
  const history = buildOrderedMoveHistory(
    hostMatch,
    guestMatch,
    movesFromFlatString,
  );
  const replay = new Game({ variant: hostGame.variant });
  const initialFen = replay.toFen();
  let hostFenSeen = hostMatch.fen === initialFen;
  let guestFenSeen = guestMatch.fen === initialFen;
  let whiteIndex = 0;
  let blackIndex = 0;
  while (
    whiteIndex < history.white.length ||
    blackIndex < history.black.length
  ) {
    let move: string;
    if (replay.activeColor === Color.White) {
      if (whiteIndex >= history.white.length) return null;
      move = history.white[whiteIndex++];
    } else if (replay.activeColor === Color.Black) {
      if (blackIndex >= history.black.length) return null;
      move = history.black[blackIndex++];
    } else {
      return null;
    }
    if (replay.playFen(move).kind === "invalid") return null;
    const replayFen = replay.toFen();
    hostFenSeen ||= hostMatch.fen === replayFen;
    guestFenSeen ||= guestMatch.fen === replayFen;
  }
  if (!hostFenSeen || !guestFenSeen) return null;
  const finalFen = replay.toFen();
  if (hostMatch.fen !== finalFen && guestMatch.fen !== finalFen) return null;
  const stablePair = {
    ...pair,
    hostMatch: { ...hostMatch, gameVariant: hostGame.variant },
    guestMatch: { ...guestMatch, gameVariant: hostGame.variant },
  };
  const externallyFinal =
    hostMatch.status === "surrendered" ||
    guestMatch.status === "surrendered" ||
    hostMatch.timer === MATCH_TIMER_TERMINAL ||
    guestMatch.timer === MATCH_TIMER_TERMINAL;
  return externallyFinal || replay.winner !== undefined ? stablePair : null;
}
