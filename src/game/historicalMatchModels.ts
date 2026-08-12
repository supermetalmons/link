import * as MonsRules from "mons-rules";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";

import type {
  HistoricalMatchPair,
  Match,
} from "../connection/connectionModels";
import {
  createGameModelForStoredVariant,
  normalizeStoredGameVariant,
  type StoredGameVariant,
} from "./gameVariants";

type GameModelFromFen = (fen: unknown) => MonsRules.Game | null;

export type TrustedMatchPairGame = {
  gameModel: MonsRules.Game;
  whiteMovesCount: number;
  blackMovesCount: number;
};

export const normalizePersistedMoveHistory = (
  value: unknown,
): string | null => {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : null;
};

export const persistedMoveCount = (flatMovesString: string): number => {
  return flatMovesString === "" ? 0 : flatMovesString.split("-").length;
};

export const movesArrayForHistoryVerification = (
  flatMovesString: string,
): string[] => {
  return flatMovesString === "" ? [] : flatMovesString.split("-");
};

export const movesArrayFromFlatString = (
  flatMovesString: unknown,
): string[] => {
  if (typeof flatMovesString !== "string" || flatMovesString === "") {
    return [];
  }
  return flatMovesString.split("-").filter((move) => move !== "");
};

const getVerifiedFenCandidate = (
  match: Match,
  whiteMovesString: string,
  blackMovesString: string,
  gameModelFromFen: GameModelFromFen,
): MonsRules.Game | null => {
  const candidate = gameModelFromFen(match.fen);
  if (!candidate) {
    return null;
  }
  try {
    if (
      candidate.verifyHistory({
        white: movesArrayForHistoryVerification(whiteMovesString),
        black: movesArrayForHistoryVerification(blackMovesString),
      })
    ) {
      return candidate;
    }
  } catch {}
  return null;
};

export const getTrustedGameFromMatchPair = (
  pair: HistoricalMatchPair,
  gameModelFromFen: GameModelFromFen,
): TrustedMatchPairGame | null => {
  const hostMatch = pair.hostMatch;
  const guestMatch = pair.guestMatch;
  if (!hostMatch || !guestMatch) {
    return null;
  }
  const haveOppositeStoredColors =
    (hostMatch.color === "white" && guestMatch.color === "black") ||
    (hostMatch.color === "black" && guestMatch.color === "white");
  if (!haveOppositeStoredColors) {
    return null;
  }

  const whiteMatch = hostMatch.color === "white" ? hostMatch : guestMatch;
  const blackMatch = hostMatch.color === "black" ? hostMatch : guestMatch;
  const whiteMovesString = normalizePersistedMoveHistory(
    whiteMatch.flatMovesString,
  );
  const blackMovesString = normalizePersistedMoveHistory(
    blackMatch.flatMovesString,
  );
  if (whiteMovesString === null || blackMovesString === null) {
    return null;
  }

  const hostCandidate = getVerifiedFenCandidate(
    hostMatch,
    whiteMovesString,
    blackMovesString,
    gameModelFromFen,
  );
  const guestCandidate = getVerifiedFenCandidate(
    guestMatch,
    whiteMovesString,
    blackMovesString,
    gameModelFromFen,
  );
  let verifiedGame: MonsRules.Game | null = null;
  if (hostCandidate && guestCandidate) {
    let candidatesAgree = false;
    try {
      candidatesAgree = hostCandidate.toFen() === guestCandidate.toFen();
    } catch {
      candidatesAgree = false;
    }
    if (!candidatesAgree) {
      return null;
    }
    verifiedGame = hostCandidate;
  } else {
    verifiedGame = hostCandidate ?? guestCandidate;
  }
  if (!verifiedGame) {
    return null;
  }
  return {
    gameModel: verifiedGame,
    whiteMovesCount: persistedMoveCount(whiteMovesString),
    blackMovesCount: persistedMoveCount(blackMovesString),
  };
};

export const buildGameFromMoveStreams = (
  gameVariant: unknown,
  whiteMovesString: string,
  blackMovesString: string,
): MonsRules.Game | null => {
  const gameFromMoves = createGameModelForStoredVariant(gameVariant);
  const whiteMoves = movesArrayFromFlatString(whiteMovesString);
  const blackMoves = movesArrayFromFlatString(blackMovesString);
  let whiteIndex = 0;
  let blackIndex = 0;
  while (whiteIndex < whiteMoves.length || blackIndex < blackMoves.length) {
    const activeColor = gameFromMoves.activeColor;
    if (activeColor === MonsRules.Color.White) {
      if (whiteIndex >= whiteMoves.length) {
        return null;
      }
      const output = gameFromMoves.playFen(whiteMoves[whiteIndex]);
      if (output.kind === "invalid") {
        return null;
      }
      whiteIndex += 1;
    } else if (activeColor === MonsRules.Color.Black) {
      if (blackIndex >= blackMoves.length) {
        return null;
      }
      const output = gameFromMoves.playFen(blackMoves[blackIndex]);
      if (output.kind === "invalid") {
        return null;
      }
      blackIndex += 1;
    } else {
      return null;
    }
  }
  return gameFromMoves;
};

export const getHistoricalPairGameVariant = (
  pair: HistoricalMatchPair,
): StoredGameVariant => {
  return normalizeStoredGameVariant(
    pair.hostMatch?.gameVariant ?? pair.guestMatch?.gameVariant,
  );
};

export const getMatchMovesByColor = (
  pair: HistoricalMatchPair,
  hostColorBySeries: "white" | "black" | null,
): { whiteMoves: string | null; blackMoves: string | null } => {
  let whiteMoves: string | null = null;
  let blackMoves: string | null = null;
  const movesFromMatch = (match: Match | null): string =>
    match?.flatMovesString ?? "";
  const assignMovesByStoredColor = (match: Match | null) => {
    if (!match) {
      return;
    }
    if (match.color === "white" && whiteMoves === null) {
      whiteMoves = match.flatMovesString ?? "";
    } else if (match.color === "black" && blackMoves === null) {
      blackMoves = match.flatMovesString ?? "";
    }
  };
  assignMovesByStoredColor(pair.hostMatch);
  assignMovesByStoredColor(pair.guestMatch);
  if (whiteMoves === null || blackMoves === null) {
    if (hostColorBySeries === "white") {
      if (whiteMoves === null) {
        whiteMoves = movesFromMatch(pair.hostMatch);
      }
      if (blackMoves === null) {
        blackMoves = movesFromMatch(pair.guestMatch);
      }
    } else if (hostColorBySeries === "black") {
      if (whiteMoves === null) {
        whiteMoves = movesFromMatch(pair.guestMatch);
      }
      if (blackMoves === null) {
        blackMoves = movesFromMatch(pair.hostMatch);
      }
    }
  }
  return { whiteMoves, blackMoves };
};

export const countRecordedMovesInHistoricalPair = (
  pair: HistoricalMatchPair,
  hostColorBySeries: "white" | "black" | null,
): number => {
  const { whiteMoves, blackMoves } = getMatchMovesByColor(
    pair,
    hostColorBySeries,
  );
  return (
    movesArrayFromFlatString(whiteMoves).length +
    movesArrayFromFlatString(blackMoves).length
  );
};

export const toMonsColor = (
  color: string | null | undefined,
): MonsRules.Color | undefined => {
  if (color === "white") {
    return MonsRules.Color.White;
  }
  if (color === "black") {
    return MonsRules.Color.Black;
  }
  return undefined;
};

export const oppositeMonsColor = (
  color: MonsRules.Color | undefined,
): MonsRules.Color | undefined => {
  if (color === MonsRules.Color.White) {
    return MonsRules.Color.Black;
  }
  if (color === MonsRules.Color.Black) {
    return MonsRules.Color.White;
  }
  return undefined;
};

const getHistoricalTerminalColor = (
  pair: HistoricalMatchPair,
  hostColorBySeries: "white" | "black" | null,
  isTerminalMatch: (match: Match | null) => boolean,
): MonsRules.Color | undefined => {
  const hostMatchIsTerminal = isTerminalMatch(pair.hostMatch);
  const guestMatchIsTerminal = isTerminalMatch(pair.guestMatch);
  if (!hostMatchIsTerminal && !guestMatchIsTerminal) {
    return undefined;
  }
  const hostStoredColor = hostMatchIsTerminal
    ? toMonsColor(pair.hostMatch?.color)
    : undefined;
  const guestStoredColor = guestMatchIsTerminal
    ? toMonsColor(pair.guestMatch?.color)
    : undefined;
  if (hostStoredColor !== undefined && guestStoredColor === undefined) {
    return hostStoredColor;
  }
  if (guestStoredColor !== undefined && hostStoredColor === undefined) {
    return guestStoredColor;
  }
  if (
    hostStoredColor !== undefined &&
    guestStoredColor !== undefined &&
    hostStoredColor === guestStoredColor
  ) {
    return hostStoredColor;
  }
  const hostSeriesColor = toMonsColor(hostColorBySeries);
  if (hostSeriesColor !== undefined) {
    if (hostMatchIsTerminal && !guestMatchIsTerminal) {
      return hostSeriesColor;
    }
    if (guestMatchIsTerminal && !hostMatchIsTerminal) {
      return oppositeMonsColor(hostSeriesColor);
    }
  }
  return hostStoredColor ?? guestStoredColor;
};

export const getHistoricalResignedColor = (
  pair: HistoricalMatchPair,
  hostColorBySeries: "white" | "black" | null,
): MonsRules.Color | undefined => {
  return getHistoricalTerminalColor(
    pair,
    hostColorBySeries,
    (match) => match?.status === "surrendered",
  );
};

export const getHistoricalWinnerByTimerColor = (
  pair: HistoricalMatchPair,
  hostColorBySeries: "white" | "black" | null,
): MonsRules.Color | undefined => {
  return getHistoricalTerminalColor(
    pair,
    hostColorBySeries,
    (match) => match?.timer === MATCH_TIMER_TERMINAL,
  );
};
