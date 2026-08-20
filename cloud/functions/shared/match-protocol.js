"use strict";

const CONTROLLER_VERSION = 2;

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
  buildOrderedMoveHistory,
  buildFreshMatchRecord,
  movesFromFlatString,
  parseGameFromMatchData,
  selectLaterGame,
};
