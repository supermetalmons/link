const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const { batchReadWithRetry, getProfileByLoginId } = require("./utils");
const {
  applyMaterialDeltas,
  updateFrozenMaterials,
  readUserMiningMaterials,
  updateUserMiningMaterials,
} = require("./wagerHelpers");
const { resolveMatchResult } = require("./matchResult");

exports.resolveWagerOutcome = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const uid = request.auth.uid;
  const authProfileId =
    request.auth.token && request.auth.token.profileId
      ? request.auth.token.profileId
      : null;
  const playerId = request.data.playerId;
  const inviteId = request.data.inviteId;
  const matchId = request.data.matchId;
  const opponentId = request.data.opponentId;
  const baseDebug = {
    authUid: uid,
    authProfileId,
    playerId,
    opponentId,
    inviteId,
    matchId,
  };

  if (
    typeof playerId !== "string" ||
    typeof inviteId !== "string" ||
    typeof matchId !== "string" ||
    typeof opponentId !== "string"
  ) {
    return { ok: false, reason: "invalid-argument", debug: baseDebug };
  }

  const matchRef = admin
    .database()
    .ref(`players/${playerId}/matches/${matchId}`);
  const inviteRef = admin.database().ref(`invites/${inviteId}`);
  const opponentMatchRef = admin
    .database()
    .ref(`players/${opponentId}/matches/${matchId}`);

  const [matchSnapshot, inviteSnapshot, opponentMatchSnapshot] =
    await batchReadWithRetry([matchRef, inviteRef, opponentMatchRef]);
  const matchData = matchSnapshot.val();
  const inviteData = inviteSnapshot.val();
  const opponentMatchData = opponentMatchSnapshot.val();

  if (!matchData || !inviteData || !opponentMatchData) {
    return { ok: false, reason: "match-not-found", debug: baseDebug };
  }
  const inviteDebug = {
    ...baseDebug,
    hostId: inviteData.hostId || null,
    guestId: inviteData.guestId || null,
  };

  const playerProfile = await getProfileByLoginId(playerId);
  const opponentProfile = await getProfileByLoginId(opponentId);

  if (!(
    (inviteData.hostId === playerId && inviteData.guestId === opponentId) ||
    (inviteData.hostId === opponentId && inviteData.guestId === playerId)
  )) {
    throw new HttpsError(
      "permission-denied",
      "Players don't match invite data",
    );
  }

  if (uid !== playerId) {
    const customClaims = request.auth.token || {};
    if (
      playerProfile.profileId &&
      (!customClaims.profileId ||
        customClaims.profileId !== playerProfile.profileId)
    ) {
      throw new HttpsError(
        "permission-denied",
        "You don't have permission to perform this action for this player.",
      );
    }
  }

  const matchResult = await resolveMatchResult(matchData, opponentMatchData);
  const result = matchResult.result;

  if (result !== "win" && result !== "gg") {
    throw new HttpsError("internal", "Could not confirm victory.");
  }

  const readMiningSnapshot = async () => {
    if (!playerProfile.profileId) {
      return null;
    }
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(playerProfile.profileId)
      .get();
    if (!userDoc.exists) {
      return null;
    }
    const userData = userDoc.data() || {};
    return {
      lastRockDate:
        typeof (userData.mining && userData.mining.lastRockDate) === "string"
          ? userData.mining.lastRockDate
          : null,
      materials: applyMaterialDeltas(
        userData.mining && userData.mining.materials,
        {},
      ),
    };
  };

  const wagerRef = admin
    .database()
    .ref(`invites/${inviteId}/wagers/${matchId}`);
  const wagerSnap = await wagerRef.once("value");
  const wagerData = wagerSnap.val();
  if (!wagerData) {
    const mining = await readMiningSnapshot();
    return {
      ok: true,
      reason: "no-wager",
      mining,
      debug: { ...inviteDebug, result },
    };
  }
  const wagerDebug = {
    ...inviteDebug,
    result,
    hasResolved: !!wagerData.resolved,
    hasAgreed: !!wagerData.agreed,
    proposalKeys: Object.keys(wagerData.proposals || {}),
  };

  const wagerResolutionFlagRef = admin
    .database()
    .ref(`invites/${inviteId}/matchesWagerResolutions/${matchId}`);
  const txnResult = await wagerResolutionFlagRef.transaction((current) => {
    if (current === true) {
      return;
    }
    return true;
  });
  if (!txnResult.committed) {
    const mining = await readMiningSnapshot();
    return { ok: true, reason: "already-resolved", mining, debug: wagerDebug };
  }

  let resolutionMode = "none";
  let resolvedPayload = null;
  let unfrozenProposalKeys = [];
  if (!wagerData.resolved) {
    if (
      wagerData.agreed &&
      wagerData.agreed.material &&
      wagerData.agreed.count
    ) {
      resolutionMode = "agreed";
      const material = wagerData.agreed.material;
      const count = Math.max(0, Math.round(Number(wagerData.agreed.count)));
      if (count > 0 && playerProfile.profileId && opponentProfile.profileId) {
        const winnerId = result === "win" ? playerId : opponentId;
        const loserId = result === "win" ? opponentId : playerId;
        const winnerProfileId =
          winnerId === playerId
            ? playerProfile.profileId
            : opponentProfile.profileId;
        const loserProfileId =
          loserId === playerId
            ? playerProfile.profileId
            : opponentProfile.profileId;

        const winnerMaterials = await readUserMiningMaterials(winnerProfileId);
        const loserMaterials = await readUserMiningMaterials(loserProfileId);
        const updatedWinnerMaterials = applyMaterialDeltas(winnerMaterials, {
          [material]: count,
        });
        const updatedLoserMaterials = applyMaterialDeltas(loserMaterials, {
          [material]: -count,
        });
        await updateUserMiningMaterials(
          winnerProfileId,
          updatedWinnerMaterials,
        );
        await updateUserMiningMaterials(loserProfileId, updatedLoserMaterials);
        await updateFrozenMaterials(winnerId, { [material]: -count });
        await updateFrozenMaterials(loserId, { [material]: -count });
        resolvedPayload = {
          winnerId,
          loserId,
          material,
          count,
          total: count * 2,
        };
        await wagerRef.update({
          resolved: {
            winnerId,
            loserId,
            material,
            count,
            total: count * 2,
            resolvedAt: Date.now(),
          },
          proposals: null,
        });
      }
    } else if (wagerData.proposals) {
      resolutionMode = "proposals";
      const proposals = wagerData.proposals;
      const updateTasks = [];
      Object.keys(proposals).forEach((proposalUid) => {
        const proposal = proposals[proposalUid];
        if (proposal && proposal.material && proposal.count) {
          updateTasks.push(
            updateFrozenMaterials(proposalUid, {
              [proposal.material]: -proposal.count,
            }),
          );
        }
      });
      unfrozenProposalKeys = Object.keys(proposals);
      if (updateTasks.length > 0) {
        await Promise.all(updateTasks);
      }
      await wagerRef.update({
        proposals: null,
      });
    }
  }

  const mining = await readMiningSnapshot();

  return {
    ok: true,
    mining,
    debug: {
      ...wagerDebug,
      resolutionMode,
      resolvedPayload,
      unfrozenProposalKeys,
      hadResolved: !!wagerData.resolved,
      hadAgreed: !!wagerData.agreed,
      hadProposals: !!wagerData.proposals,
    },
  };
});
