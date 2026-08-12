const admin = require("../firebaseAdmin");
const { resolveWagerParticipants } = require("./wagerParticipants");

const readWagerRequestContext = async ({ request, inviteId, baseDebug }) => {
  const inviteSnap = await admin
    .database()
    .ref(`invites/${inviteId}`)
    .once("value");
  const inviteData = inviteSnap.val();
  if (!inviteData) {
    return {
      failure: { ok: false, reason: "invite-not-found", debug: baseDebug },
    };
  }
  const inviteDebug = {
    ...baseDebug,
    hostId: inviteData.hostId || null,
    guestId: inviteData.guestId || null,
  };
  if (!inviteData.guestId) {
    return {
      failure: {
        ok: false,
        reason: "missing-opponent",
        debug: inviteDebug,
      },
    };
  }
  const participants = await resolveWagerParticipants(inviteData, request.auth);
  if (participants.error) {
    return {
      failure: {
        ok: false,
        reason: participants.error,
        debug: inviteDebug,
      },
    };
  }
  return { inviteData, inviteDebug, participants };
};

module.exports = { readWagerRequestContext };
