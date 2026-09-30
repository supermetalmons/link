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

export type MatchHistoryRecord = {
  color?: unknown;
  fen?: unknown;
  flatMovesString?: unknown;
};

const CONTROLLER_VERSION = 2;
const MAX_MATCH_FEN_BYTES: 16384 = (16 * 1024) as 16384;
const MAX_MATCH_HISTORY_BYTES: 65536 = (64 * 1024) as 65536;
const MAX_MATCH_HISTORY_ENTRIES = 2_048;

function isMatchFenWithinLimit(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_MATCH_FEN_BYTES
  );
}

function isMatchHistoryWithinLimits(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_MATCH_HISTORY_BYTES
  ) {
    return false;
  }
  let entries = value === "" ? 0 : 1;
  for (const character of value) {
    if (character === "-" && ++entries > MAX_MATCH_HISTORY_ENTRIES) {
      return false;
    }
  }
  return true;
}

function buildFreshMatchRecord<TEmojiId, TAura, TGameVariant extends string>({
  color,
  emojiId,
  aura,
  seed,
}: {
  color: string;
  emojiId: TEmojiId;
  aura: TAura;
  seed: MatchSeedRecord<TGameVariant>;
}): FreshMatchRecord<TEmojiId, TAura, TGameVariant> {
  return {
    version: CONTROLLER_VERSION,
    color,
    emojiId,
    aura,
    gameVariant: seed.gameVariant,
    fen: seed.fen,
    status: "",
    flatMovesString: "",
    timer: "",
  };
}

function movesFromFlatString(value: unknown): string[] {
  return typeof value !== "string" || value === "" ? [] : value.split("-");
}

function buildOrderedMoveHistory(
  player: MatchHistoryRecord,
  opponent: MatchHistoryRecord,
  parseMoves: (value: unknown) => string[] = movesFromFlatString,
): { white: string[]; black: string[] } {
  if (player.color === "white") {
    return {
      white: parseMoves(player.flatMovesString),
      black: parseMoves(opponent.flatMovesString),
    };
  }
  return {
    white: parseMoves(opponent.flatMovesString),
    black: parseMoves(player.flatMovesString),
  };
}

function parseGameFromMatchData<TGame>(
  mons: { Game: { fromFen(fen: string): TGame | undefined } },
  matchData: MatchHistoryRecord | null | undefined,
): TGame | undefined {
  return typeof matchData?.fen === "string"
    ? mons.Game.fromFen(matchData.fen)
    : undefined;
}

function selectLaterGame<TGame extends { isLaterThan(other: TGame): boolean }>(
  playerGame: TGame | undefined,
  opponentGame: TGame | undefined,
): TGame | undefined {
  if (!playerGame) {
    return opponentGame;
  }
  if (!opponentGame) {
    return playerGame;
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
}

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
