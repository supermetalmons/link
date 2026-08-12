const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  updateFrozenMaterials,
  removeWagerProposalWithRetry,
} = require("./wagerHelpers");
const { readWagerRequestContext } = require("./gameplay/wagerRequestContext");

exports.cancelWagerProposal = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const authUid = request.auth.uid;
  const authProfileId =
    request.auth.token && request.auth.token.profileId
      ? request.auth.token.profileId
      : null;
  const inviteId = request.data && request.data.inviteId;
  const matchId = request.data && request.data.matchId;
  const baseDebug = { authUid, authProfileId, inviteId, matchId };

  if (typeof inviteId !== "string" || typeof matchId !== "string") {
    return { ok: false, reason: "invalid-argument", debug: baseDebug };
  }

  const context = await readWagerRequestContext({
    request,
    inviteId,
    baseDebug,
  });
  if (context.failure) {
    return context.failure;
  }
  const { inviteDebug } = context;
  const { playerUid } = context.participants;
  const resolvedDebug = { ...inviteDebug, playerUid };

  const removal = await removeWagerProposalWithRetry(
    inviteId,
    matchId,
    playerUid,
  );
  if (!removal.ok || !removal.removedProposal) {
    return {
      ok: false,
      reason: "proposal-missing",
      debug: { ...resolvedDebug, removalDebug: removal.debug },
    };
  }

  if (removal.canUnfreeze) {
    await updateFrozenMaterials(playerUid, {
      [removal.removedProposal.material]: -removal.removedProposal.count,
    });
  }
  return {
    ok: true,
    debug: {
      ...resolvedDebug,
      removedProposal: removal.removedProposal,
      removalDebug: removal.debug,
      canUnfreeze: removal.canUnfreeze,
    },
  };
});
