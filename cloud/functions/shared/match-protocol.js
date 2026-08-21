"use strict";

const CONTROLLER_VERSION = 2;
const MAX_MATCH_FEN_BYTES = 16 * 1024;
const MAX_MATCH_HISTORY_BYTES = 64 * 1024;
const MAX_MATCH_HISTORY_ENTRIES = 2_048;

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

module.exports = {
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
