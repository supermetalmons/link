// Generated from src/shared/match-protocol.ts. Run npm run generate:runtime.
export type MatchSeedRecord<TGameVariant extends string = string> = {
  gameVariant: TGameVariant;
  fen: string;
};
export type FreshMatchRecord<
  TEmojiId = unknown,
  TAura = unknown,
  TGameVariant extends string = string,
  TColor extends string = string,
> = {
  version: typeof CONTROLLER_VERSION;
  color: TColor;
  emojiId: TEmojiId;
  aura: TAura;
  gameVariant: TGameVariant;
  fen: string;
  status: "";
  flatMovesString: "";
  timer: "";
};
export type MatchCreationRecord = {
  version: number;
  color: "white" | "black";
  emojiId: number | string;
  aura: string | null;
  gameVariant: string;
  fen: string;
  status: string;
  flatMovesString: string;
  timer: string;
};
export type MatchHistoryRecord = {
  color?: unknown;
  fen?: unknown;
  flatMovesString?: unknown;
};
declare const CONTROLLER_VERSION = 2;
declare const MAX_MATCH_FEN_BYTES: 16384;
declare const MAX_MATCH_HISTORY_BYTES: 65536;
declare const MAX_MATCH_HISTORY_ENTRIES = 2048;
declare function isMatchFenWithinLimit(value: unknown): value is string;
declare function isMatchHistoryWithinLimits(value: unknown): value is string;
declare function buildFreshMatchRecord<
  TEmojiId,
  TAura,
  TGameVariant extends string,
  TColor extends string,
>({
  color,
  emojiId,
  aura,
  seed,
}: {
  color: TColor;
  emojiId: TEmojiId;
  aura: TAura;
  seed: MatchSeedRecord<TGameVariant>;
}): FreshMatchRecord<TEmojiId, TAura, TGameVariant, TColor>;
declare function movesFromFlatString(value: unknown): string[];
declare function buildOrderedMoveHistory(
  player: MatchHistoryRecord,
  opponent: MatchHistoryRecord,
  parseMoves?: (value: unknown) => string[],
): {
  white: string[];
  black: string[];
};
declare function parseGameFromMatchData<TGame>(
  mons: {
    Game: {
      fromFen(fen: string): TGame | undefined;
    };
  },
  matchData: MatchHistoryRecord | null | undefined,
): TGame | undefined;
declare function selectLaterGame<
  TGame extends {
    isLaterThan(other: TGame): boolean;
  },
>(
  playerGame: TGame | undefined,
  opponentGame: TGame | undefined,
): TGame | undefined;
export {
  CONTROLLER_VERSION,
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
  buildOrderedMoveHistory,
  buildFreshMatchRecord,
  isMatchFenWithinLimit,
  isMatchHistoryWithinLimits,
  movesFromFlatString,
  parseGameFromMatchData,
  selectLaterGame,
};
