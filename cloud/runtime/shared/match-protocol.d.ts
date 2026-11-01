// Generated from src/shared/match-protocol.ts. Run npm run generate:runtime.
import type { IdleMatchTimer, MatchTimer } from "./timers.js";
import type { Aura, EmojiId } from "./appearance.js";
export type MatchSeedRecord<TGameVariant extends string = string> = {
  gameVariant: TGameVariant;
  fen: string;
};
export type FreshMatchRecord<
  TEmojiId = EmojiId,
  TAura = Aura,
  TGameVariant extends string = string,
  TColor extends string = "white" | "black",
> = {
  schemaVersion: 1;
  version: typeof CONTROLLER_VERSION;
  color: TColor;
  emojiId: TEmojiId;
  aura: TAura;
  gameVariant: TGameVariant;
  fen: string;
  status: "active";
  flatMovesString: "";
  timer: IdleMatchTimer;
};
export type MatchCreationRecord = {
  schemaVersion: 1;
  version: number;
  color: "white" | "black";
  emojiId: EmojiId;
  aura: Aura;
  gameVariant: string;
  fen: string;
  status: "active" | "surrendered";
  flatMovesString: string;
  timer: MatchTimer;
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
