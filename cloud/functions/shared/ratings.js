const RATING_VOLATILITY = 0.06;

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

const getRatingDeviation = (gamesCount) => Math.max(60, 350 - gamesCount);

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

module.exports = {
  GLICKO_SETTINGS,
  RATING_VOLATILITY,
  createRatingUpdater,
  getRatingEventMetadata,
  getRatingDeviation,
  isRatingUpdateRequest,
  isRatingUpdateResponse,
};
