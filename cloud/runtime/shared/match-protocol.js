// Generated from src/shared/match-protocol.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MATCH_HISTORY_ENTRIES =
  exports.MAX_MATCH_HISTORY_BYTES =
  exports.MAX_MATCH_FEN_BYTES =
  exports.CONTROLLER_VERSION =
    void 0;
exports.buildOrderedMoveHistory = buildOrderedMoveHistory;
exports.buildFreshMatchRecord = buildFreshMatchRecord;
exports.isMatchFenWithinLimit = isMatchFenWithinLimit;
exports.isMatchHistoryWithinLimits = isMatchHistoryWithinLimits;
exports.movesFromFlatString = movesFromFlatString;
exports.parseGameFromMatchData = parseGameFromMatchData;
exports.selectLaterGame = selectLaterGame;
const CONTROLLER_VERSION = 2;
exports.CONTROLLER_VERSION = CONTROLLER_VERSION;
const MAX_MATCH_FEN_BYTES = 16 * 1024;
exports.MAX_MATCH_FEN_BYTES = MAX_MATCH_FEN_BYTES;
const MAX_MATCH_HISTORY_BYTES = 64 * 1024;
exports.MAX_MATCH_HISTORY_BYTES = MAX_MATCH_HISTORY_BYTES;
const MAX_MATCH_HISTORY_ENTRIES = 2_048;
exports.MAX_MATCH_HISTORY_ENTRIES = MAX_MATCH_HISTORY_ENTRIES;
function isMatchFenWithinLimit(value) {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= MAX_MATCH_FEN_BYTES
  );
}
function isMatchHistoryWithinLimits(value) {
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
function buildFreshMatchRecord({ color, emojiId, aura, seed }) {
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
function movesFromFlatString(value) {
  return typeof value !== "string" || value === "" ? [] : value.split("-");
}
function buildOrderedMoveHistory(
  player,
  opponent,
  parseMoves = movesFromFlatString,
) {
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
function parseGameFromMatchData(mons, matchData) {
  return typeof matchData?.fen === "string"
    ? mons.Game.fromFen(matchData.fen)
    : undefined;
}
function selectLaterGame(playerGame, opponentGame) {
  if (!playerGame) {
    return opponentGame;
  }
  if (!opponentGame) {
    return playerGame;
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
}
