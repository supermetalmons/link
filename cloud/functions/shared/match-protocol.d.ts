export const CONTROLLER_VERSION: 2;

export type MatchSeedRecord<TGameVariant extends string = string> = {
  gameVariant: TGameVariant;
  fen: string;
};

export type FreshMatchRecord<
  TEmojiId = unknown,
  TAura = unknown,
  TGameVariant extends string = string,
> = {
  version: typeof CONTROLLER_VERSION;
  color: string;
  emojiId: TEmojiId;
  aura: TAura;
  gameVariant: TGameVariant;
  fen: string;
  status: "";
  flatMovesString: "";
  timer: "";
};

export function buildFreshMatchRecord<
  TEmojiId,
  TAura,
  TGameVariant extends string,
>(options: {
  color: string;
  emojiId: TEmojiId;
  aura: TAura;
  seed: MatchSeedRecord<TGameVariant>;
}): FreshMatchRecord<TEmojiId, TAura, TGameVariant>;

export type MatchHistoryRecord = {
  color?: unknown;
  fen?: unknown;
  flatMovesString?: unknown;
};

export function movesFromFlatString(value: unknown): string[];
export function buildOrderedMoveHistory(
  player: MatchHistoryRecord,
  opponent: MatchHistoryRecord,
  parseMoves?: (value: unknown) => string[],
): { white: string[]; black: string[] };
export function parseGameFromMatchData<TGame>(
  mons: { Game: { fromFen(fen: string): TGame | undefined } },
  matchData: MatchHistoryRecord | null | undefined,
): TGame | undefined;
export function selectLaterGame<
  TGame extends { isLaterThan(other: TGame): boolean },
>(
  playerGame: TGame | undefined,
  opponentGame: TGame | undefined,
): TGame | undefined;
