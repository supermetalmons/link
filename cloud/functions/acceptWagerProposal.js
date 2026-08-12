const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const {
  normalizeCount,
  readUserMiningMaterials,
  reserveAcceptedMaterials,
  updateFrozenMaterials,
  updateFrozenMaterialsWithCap,
} = require("./wagerHelpers");
const { readWagerRequestContext } = require("./gameplay/wagerRequestContext");

exports.acceptWagerProposal = onCall(async (request) => {
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
  const { playerUid, opponentUid, playerProfile } = context.participants;
  const resolvedDebug = { ...inviteDebug, playerUid, opponentUid };

  const wagerRef = admin
    .database()
    .ref(`invites/${inviteId}/wagers/${matchId}`);
  const wagerSnap = await wagerRef.once("value");
  const wagerData = wagerSnap.val();
  if (!wagerData || wagerData.resolved || wagerData.agreed) {
    return {
      ok: false,
      reason: "proposal-missing",
      debug: {
        ...resolvedDebug,
        hasWager: !!wagerData,
        resolved: !!(wagerData && wagerData.resolved),
        agreed: !!(wagerData && wagerData.agreed),
      },
    };
  }

  const proposals = wagerData.proposals || {};
  const opponentProposal = proposals[opponentUid];
  if (!opponentProposal) {
    return {
      ok: false,
      reason: "proposal-missing",
      debug: { ...resolvedDebug, proposalKeys: Object.keys(proposals) },
    };
  }
  const ownProposal = proposals[playerUid] || null;
  const material = opponentProposal.material;
  const proposedCount = Number(opponentProposal.count) || 0;

  const totalMaterials = await readUserMiningMaterials(playerProfile.profileId);
  const acceptReserve = await reserveAcceptedMaterials(
    playerUid,
    material,
    proposedCount,
    ownProposal,
    totalMaterials,
  );
  const acceptedCount = acceptReserve.acceptedCount;
  const appliedDelta = acceptReserve.appliedDelta;
  if (acceptedCount <= 0 || !appliedDelta) {
    return {
      ok: false,
      reason: "insufficient-materials",
      debug: { ...resolvedDebug, acceptedCount },
    };
  }

  const now = Date.now();
  const agreedRef = wagerRef.child("agreed");
  const agreedTxn = await agreedRef.transaction((current) => {
    if (current) {
      return;
    }
    return {
      material,
      count: acceptedCount,
      total: acceptedCount * 2,
      proposerId: opponentUid,
      accepterId: playerUid,
      acceptedAt: now,
    };
  });

  if (!agreedTxn.committed) {
    const rollback = Object.keys(appliedDelta).reduce((acc, key) => {
      acc[key] = -appliedDelta[key];
      return acc;
    }, {});
    if (Object.keys(rollback).length > 0) {
      await updateFrozenMaterialsWithCap(playerUid, rollback, totalMaterials);
    }
    const latestSnap = await wagerRef.once("value");
    const latestData = latestSnap.val() || {};
    const latestProposals = latestData.proposals || {};
    return {
      ok: false,
      reason: "proposal-unavailable",
      debug: {
        ...resolvedDebug,
        proposalKeys: Object.keys(proposals),
        latestProposalKeys: Object.keys(latestProposals),
        latestAgreed: !!latestData.agreed,
        latestResolved: !!latestData.resolved,
        latestOpponentProposal: latestProposals[opponentUid] || null,
        agreedSnapshot: agreedTxn.snapshot ? agreedTxn.snapshot.val() : null,
      },
    };
  }

  await wagerRef.child("proposals").set(null);
  const proposerDelta = {};
  proposerDelta[material] = acceptedCount - normalizeCount(proposedCount);
  await updateFrozenMaterials(opponentUid, proposerDelta);

  return {
    ok: true,
    count: acceptedCount,
    debug: { ...resolvedDebug, acceptedCount },
  };
});
