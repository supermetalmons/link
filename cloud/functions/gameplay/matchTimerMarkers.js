const admin = require("../firebaseAdmin");
const { MATCH_TIMER_START_ROOT } = require("@mons/shared/timers");

const markerUpdates = ({ playerId, opponentId, matchId }) => ({
  [`${MATCH_TIMER_START_ROOT}/${playerId}/${matchId}`]: null,
  [`${MATCH_TIMER_START_ROOT}/${opponentId}/${matchId}`]: null,
});

const clearMatchTimerMarkers = ({ playerId, opponentId, matchId }) =>
  admin.database().ref().update(
    markerUpdates({
      playerId,
      opponentId,
      matchId,
    }),
  );

module.exports = {
  clearMatchTimerMarkers,
};
