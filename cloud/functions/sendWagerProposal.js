const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const {
  isMaterialName,
  normalizeCount,
  reserveFrozenMaterials,
  updateFrozenMaterials,
  readUserMiningMaterials,
} = require("./wagerHelpers");
const {
  transitionWagerProposal,
} = require("./gameplay/wagerProposalTransition");
const { readWagerRequestContext } = require("./gameplay/wagerRequestContext");

exports.sendWagerProposal = onCall(async (request) => {
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
  const material = request.data && request.data.material;
  const requestedCount = normalizeCount(request.data && request.data.count);
  const baseDebug = {
    authUid,
    authProfileId,
    inviteId,
    matchId,
    material,
    requestedCount,
  };

  if (
    typeof inviteId !== "string" ||
    typeof matchId !== "string" ||
    !isMaterialName(material) ||
    requestedCount <= 0
  ) {
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
  const { playerUid, opponentUid, playerProfile } = context.participants;
  const playerDebug = { ...inviteDebug, playerUid, opponentUid };

  const totalMaterials = await readUserMiningMaterials(playerProfile.profileId);
  const reservedCount = await reserveFrozenMaterials(
    playerUid,
    material,
    requestedCount,
    totalMaterials,
  );
  if (reservedCount <= 0) {
    return {
      ok: false,
      reason: "insufficient-materials",
      debug: { ...playerDebug, reservedCount },
    };
  }

  const wagerRef = admin
    .database()
    .ref(`invites/${inviteId}/wagers/${matchId}`);
  const now = Date.now();
  let autoAgreement = null;
  let autoOpponentCount = 0;
  const txn = await wagerRef.transaction((current) => {
    const transition = transitionWagerProposal(current, {
      playerUid,
      opponentUid,
      material,
      reservedCount,
      now,
    });
    autoAgreement = transition.autoAgreement;
    autoOpponentCount = transition.autoOpponentCount;
    return transition.value;
  });

  if (!txn.committed) {
    await updateFrozenMaterials(playerUid, { [material]: -reservedCount });
    const latestSnap = await wagerRef.once("value");
    const latestData = latestSnap.val() || {};
    const latestProposals = latestData.proposals || {};
    return {
      ok: false,
      reason: "proposal-unavailable",
      debug: {
        ...playerDebug,
        reservedCount,
        latestAgreed: !!latestData.agreed,
        latestResolved: !!latestData.resolved,
        latestProposalKeys: Object.keys(latestProposals),
      },
    };
  }

  if (autoAgreement) {
    const agreedCount = normalizeCount(autoAgreement.count);
    const selfDelta = agreedCount - reservedCount;
    if (selfDelta !== 0) {
      await updateFrozenMaterials(playerUid, { [material]: selfDelta });
    }
    if (opponentUid && autoOpponentCount) {
      const opponentDelta = agreedCount - autoOpponentCount;
      if (opponentDelta !== 0) {
        await updateFrozenMaterials(opponentUid, { [material]: opponentDelta });
      }
    }
    return {
      ok: true,
      count: agreedCount,
      agreed: autoAgreement,
      debug: { ...playerDebug, reservedCount, agreedCount, auto: true },
    };
  }

  return {
    ok: true,
    count: reservedCount,
    debug: { ...playerDebug, reservedCount },
  };
});
