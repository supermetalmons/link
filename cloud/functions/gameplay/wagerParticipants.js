const { HttpsError } = require("firebase-functions/v2/https");
const { getProfileByLoginId } = require("../profileSummaryLookup");

const resolveWagerParticipants = async (inviteData, auth) => {
  const hostId = inviteData.hostId;
  const guestId = inviteData.guestId;
  if (!hostId || !guestId) {
    return { error: "missing-opponent" };
  }
  const hostProfile = await getProfileByLoginId(hostId);
  const guestProfile = await getProfileByLoginId(guestId);
  if (!hostProfile.profileId || !guestProfile.profileId) {
    return { error: "profile-not-found" };
  }
  const authUid = auth.uid;
  const authProfileId = auth.token && auth.token.profileId;
  const hasProfileClaim =
    typeof authProfileId === "string" && authProfileId !== "";
  const isHost =
    authUid === hostId ||
    (hasProfileClaim && authProfileId === hostProfile.profileId);
  const isGuest =
    authUid === guestId ||
    (hasProfileClaim && authProfileId === guestProfile.profileId);
  if (!isHost && !isGuest) {
    throw new HttpsError(
      "permission-denied",
      "You don't have permission to manage this wager.",
    );
  }
  return {
    playerUid: isHost ? hostId : guestId,
    opponentUid: isHost ? guestId : hostId,
    playerProfile: isHost ? hostProfile : guestProfile,
    opponentProfile: isHost ? guestProfile : hostProfile,
  };
};

module.exports = { resolveWagerParticipants };
