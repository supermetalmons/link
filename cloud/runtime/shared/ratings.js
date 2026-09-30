// Generated from src/shared/ratings.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRatingUpdateResponse =
  exports.isRatingUpdateRequest =
  exports.getRatingDeviation =
  exports.getRatingEventMetadata =
  exports.createRatingUpdater =
  exports.RATING_VOLATILITY =
  exports.GLICKO_SETTINGS =
    void 0;
const RATING_VOLATILITY = 0.06;
exports.RATING_VOLATILITY = RATING_VOLATILITY;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};
const GLICKO_SETTINGS = Object.freeze({
  tau: 0.75,
  rating: 1500,
  rd: 100,
  vol: RATING_VOLATILITY,
});
exports.GLICKO_SETTINGS = GLICKO_SETTINGS;
const getRatingDeviation = (gamesCount) => Math.max(60, 350 - gamesCount);
exports.getRatingDeviation = getRatingDeviation;
const createRatingUpdater =
  (Glicko2) =>
  (winRating, winPlayerGamesCount, lossRating, lossPlayerGamesCount) => {
    const ranking = new Glicko2({ ...GLICKO_SETTINGS });
    const winner = ranking.makePlayer(
      winRating,
      getRatingDeviation(winPlayerGamesCount),
      RATING_VOLATILITY,
    );
    const loser = ranking.makePlayer(
      lossRating,
      getRatingDeviation(lossPlayerGamesCount),
      RATING_VOLATILITY,
    );
    const matches = [[winner, loser, 1]];
    ranking.updateRatings(matches);
    const newWinRating = Math.round(winner.getRating());
    const newLossRating = Math.round(loser.getRating());
    return [newWinRating, newLossRating];
  };
exports.createRatingUpdater = createRatingUpdater;
const getRatingEventMetadata = (value) => {
  const invite = isRecord(value) ? value : {};
  const eventId =
    typeof invite.eventId === "string" && invite.eventId.trim() !== ""
      ? invite.eventId.trim()
      : null;
  return {
    isEventMatch: invite.eventOwned === true || eventId !== null,
    eventOwned: invite.eventOwned === true,
    eventId,
  };
};
exports.getRatingEventMetadata = getRatingEventMetadata;
const isRatingUpdateRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "inviteId", "matchId"]) &&
  typeof value.playerId === "string" &&
  value.playerId.trim() !== "" &&
  typeof value.opponentId === "string" &&
  value.opponentId.trim() !== "" &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";
exports.isRatingUpdateRequest = isRatingUpdateRequest;
const isRatingUpdateResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === false) {
    return hasExactKeys(value, ["ok"]);
  }
  if (value.ok !== true) {
    return false;
  }
  return (
    hasExactKeys(value, ["ok"]) ||
    (hasExactKeys(value, ["ok", "skipped"]) && value.skipped === true)
  );
};
exports.isRatingUpdateResponse = isRatingUpdateResponse;
