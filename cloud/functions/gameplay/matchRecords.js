const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("../firebaseAdmin");
const { batchReadWithRetry } = require("../batchRead");
const { inviteMatchesPlayers } = require("@mons/shared/rematches");

const createMatchRecordRefs = ({ playerId, opponentId, matchId, inviteId }) => {
  const matchRef = admin
    .database()
    .ref(`players/${playerId}/matches/${matchId}`);
  const opponentMatchRef = admin
    .database()
    .ref(`players/${opponentId}/matches/${matchId}`);
  const inviteRef = admin.database().ref(`invites/${inviteId}`);
  return { matchRef, inviteRef, opponentMatchRef };
};

const readMatchInviteRecords = async ({
  playerId,
  opponentId,
  matchId,
  inviteId,
}) => {
  const refs = createMatchRecordRefs({
    playerId,
    opponentId,
    matchId,
    inviteId,
  });
  const [matchSnapshot, inviteSnapshot, opponentMatchSnapshot] =
    await batchReadWithRetry([
      refs.matchRef,
      refs.inviteRef,
      refs.opponentMatchRef,
    ]);
  return {
    ...refs,
    matchData: matchSnapshot.val(),
    inviteData: inviteSnapshot.val(),
    opponentMatchData: opponentMatchSnapshot.val(),
  };
};

const assertInviteMatchesPlayers = (inviteData, playerId, opponentId) => {
  if (!inviteMatchesPlayers(inviteData, playerId, opponentId)) {
    throw new HttpsError(
      "permission-denied",
      "Players don't match invite data",
    );
  }
};

module.exports = {
  assertInviteMatchesPlayers,
  createMatchRecordRefs,
  inviteMatchesPlayers,
  readMatchInviteRecords,
};
