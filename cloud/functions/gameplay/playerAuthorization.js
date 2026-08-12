const { HttpsError } = require("firebase-functions/v2/https");

const permissionError = () =>
  new HttpsError(
    "permission-denied",
    "You don't have permission to perform this action for this player.",
  );

const assertPlayerClaim = ({ uid, playerId, token, profileId }) => {
  if (uid === playerId) {
    return;
  }
  const customClaims = token || {};
  if (!customClaims.profileId || customClaims.profileId !== profileId) {
    throw permissionError();
  }
};

const assertResolvedPlayerClaim = ({ uid, playerId, token, profileId }) => {
  if (uid === playerId || !profileId) {
    return;
  }
  const customClaims = token || {};
  if (!customClaims.profileId || customClaims.profileId !== profileId) {
    throw permissionError();
  }
};

module.exports = {
  assertPlayerClaim,
  assertResolvedPlayerClaim,
};
