const { onCall, HttpsError } = require("firebase-functions/v2/https");
const glicko2 = require("glicko2");
const { createRatingUpdater } = require("@mons/shared/ratings");
const admin = require("./firebaseAdmin");
const { isAutoInviteId } = require("@mons/shared/ids");
const { MATCH_TIMER_TERMINAL } = require("@mons/shared/timers");
const {
  batchReadWithRetry,
  getProfileByLoginId,
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} = require("./utils");
const { resolveMatchWinner } = require("./matchOutcome");
const { loadMonsRules } = require("./monsRules");

const laterGameFromMatchData = (mons, matchData, opponentMatchData) => {
  const playerGame =
    typeof matchData.fen === "string"
      ? mons.Game.fromFen(matchData.fen)
      : undefined;
  const opponentGame =
    typeof opponentMatchData.fen === "string"
      ? mons.Game.fromFen(opponentMatchData.fen)
      : undefined;
  if (!playerGame && !opponentGame) {
    throw new HttpsError("internal", "Could not validate the game score.");
  }
  if (!playerGame) {
    return opponentGame;
  }
  if (!opponentGame) {
    return playerGame;
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
};

const updateRating = createRatingUpdater(glicko2.Glicko2);

const materialTelegramEmojiIds = {
  dust: "5235835141238063097",
  slime: "5235497595463303384",
  gum: "5233425978117621609",
  metal: "5235794850149863190",
  ice: "5233743994676086020",
};

const matchStatusTelegramEmojiIds = {
  timer: "5229098317530568280",
  whiteFlag: "5228702136862282659",
};

const FEB_CHALLENGE_START_UTC = Date.UTC(2026, 1, 1);
const FEB_CHALLENGE_END_UTC = Date.UTC(2026, 2, 1);
const RATING_UPDATE_LEASE_MS = 30 * 1000;
const RATING_UPDATE_HEARTBEAT_INTERVAL_MS = 10 * 1000;
const RATING_UPDATE_ACQUIRE_RETRY_DELAY_MS = 500;
const RATING_UPDATE_ACQUIRE_MAX_ATTEMPTS = 70;

const isFebruaryChallengeActive = () => {
  const now = Date.now();
  return now >= FEB_CHALLENGE_START_UTC && now < FEB_CHALLENGE_END_UTC;
};

const updateFebruaryUniqueOpponents = async (profileId, opponentProfileId) => {
  if (!profileId || !opponentProfileId || profileId === opponentProfileId) {
    return;
  }

  try {
    const firestore = admin.firestore();
    const userRef = firestore.collection("users").doc(profileId);
    await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(userRef);
      if (!snap.exists) {
        return;
      }
      const data = snap.data() || {};
      const existingOpponents = Array.isArray(data.feb2026UniqueOpponents)
        ? data.feb2026UniqueOpponents
        : [];
      if (existingOpponents.includes(opponentProfileId)) {
        return;
      }
      const updatedOpponents = [...existingOpponents, opponentProfileId];
      transaction.update(userRef, {
        feb2026UniqueOpponents: updatedOpponents,
        feb2026UniqueOpponentsCount: updatedOpponents.length,
      });
    });
  } catch (error) {
    console.error("Error updating February unique opponents:", error);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createLeaseToken = (ownerUid) => {
  return `${ownerUid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const getRatingUpdateRef = (inviteId, matchId) => {
  return admin
    .firestore()
    .collection("ratingUpdates")
    .doc(`${inviteId}__${matchId}`);
};

const ensureRatingUpdateCompletionMarker = async (completionRef) => {
  const snapshot = await completionRef.once("value");
  if (snapshot.val() === true) {
    return false;
  }
  await completionRef.set(true);
  return true;
};

const readRatingUpdateData = async (ratingUpdateRef) => {
  const snapshot = await ratingUpdateRef.get();
  if (!snapshot.exists) {
    return null;
  }
  return snapshot.data() || null;
};

const tryAcquireRatingUpdateLease = async ({
  ratingUpdateRef,
  ownerUid,
  ownerToken,
  inviteId,
  matchId,
  playerId,
  opponentId,
}) => {
  const nowMs = Date.now();
  let claim = { status: "busy", data: null };

  await admin.firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ratingUpdateRef);
    const data = snapshot.exists ? snapshot.data() || {} : {};

    if (data.status === "done") {
      claim = { status: "done", data };
      return;
    }

    const leaseExpiresAtMs =
      typeof data.leaseExpiresAtMs === "number" ? data.leaseExpiresAtMs : 0;
    if (
      data.status === "processing" &&
      leaseExpiresAtMs > nowMs &&
      data.ownerToken &&
      data.ownerToken !== ownerToken
    ) {
      claim = { status: "busy", data };
      return;
    }

    transaction.set(
      ratingUpdateRef,
      {
        inviteId,
        matchId,
        playerId,
        opponentId,
        ownerUid,
        ownerToken,
        status: "processing",
        startedAtMs:
          typeof data.startedAtMs === "number" ? data.startedAtMs : nowMs,
        updatedAtMs: nowMs,
        leaseExpiresAtMs: nowMs + RATING_UPDATE_LEASE_MS,
      },
      { merge: true },
    );
    claim = { status: "acquired", data };
  });

  return claim;
};

const acquireRatingUpdateLease = async ({
  completionRef,
  ratingUpdateRef,
  ownerUid,
  inviteId,
  matchId,
  playerId,
  opponentId,
}) => {
  const ownerToken = createLeaseToken(ownerUid);

  for (
    let attempt = 0;
    attempt < RATING_UPDATE_ACQUIRE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const completionSnapshot = await completionRef.once("value");
    if (completionSnapshot.val() === true) {
      return {
        status: "done",
        ownerToken,
        data: await readRatingUpdateData(ratingUpdateRef),
      };
    }

    const claim = await tryAcquireRatingUpdateLease({
      ratingUpdateRef,
      ownerUid,
      ownerToken,
      inviteId,
      matchId,
      playerId,
      opponentId,
    });
    if (claim.status === "acquired" || claim.status === "done") {
      return {
        status: claim.status,
        ownerToken,
        data: claim.data,
      };
    }

    if (attempt < RATING_UPDATE_ACQUIRE_MAX_ATTEMPTS - 1) {
      await sleep(RATING_UPDATE_ACQUIRE_RETRY_DELAY_MS);
    }
  }

  return {
    status: "busy",
    ownerToken,
    data: await readRatingUpdateData(ratingUpdateRef),
  };
};

const startRatingUpdateLeaseHeartbeat = ({ ratingUpdateRef, ownerToken }) => {
  let isDisposed = false;
  const heartbeatInterval = setInterval(() => {
    if (isDisposed) {
      return;
    }
    const nowMs = Date.now();
    void admin
      .firestore()
      .runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ratingUpdateRef);
        if (!snapshot.exists) {
          return;
        }
        const data = snapshot.data() || {};
        if (data.status !== "processing" || data.ownerToken !== ownerToken) {
          return;
        }
        transaction.set(
          ratingUpdateRef,
          {
            updatedAtMs: nowMs,
            leaseExpiresAtMs: nowMs + RATING_UPDATE_LEASE_MS,
          },
          { merge: true },
        );
      })
      .catch((error) => {
        console.error(
          "ratingUpdate:leaseHeartbeat:error",
          error && error.message ? error.message : error,
        );
      });
  }, RATING_UPDATE_HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeatInterval.unref === "function") {
    heartbeatInterval.unref();
  }

  return () => {
    isDisposed = true;
    clearInterval(heartbeatInterval);
  };
};

const maybeApplyStoredFebruaryChallengeUpdate = async (ratingUpdateData) => {
  if (
    !ratingUpdateData ||
    ratingUpdateData.shouldUpdateFebruaryChallenge !== true
  ) {
    return false;
  }

  const playerProfileId =
    typeof ratingUpdateData.playerProfileId === "string"
      ? ratingUpdateData.playerProfileId
      : "";
  const opponentProfileId =
    typeof ratingUpdateData.opponentProfileId === "string"
      ? ratingUpdateData.opponentProfileId
      : "";
  if (!playerProfileId || !opponentProfileId) {
    return false;
  }

  await Promise.all([
    updateFebruaryUniqueOpponents(playerProfileId, opponentProfileId),
    updateFebruaryUniqueOpponents(opponentProfileId, playerProfileId),
  ]);
  return true;
};

const getWagerSuffix = (inviteData, matchId) => {
  const wagerData =
    inviteData && inviteData.wagers && inviteData.wagers[matchId]
      ? inviteData.wagers[matchId]
      : null;
  const agreed = wagerData && wagerData.agreed ? wagerData.agreed : null;
  if (
    !agreed ||
    !agreed.material ||
    agreed.count === undefined ||
    agreed.count === null
  ) {
    return "";
  }
  const material = typeof agreed.material === "string" ? agreed.material : "";
  const emojiId = materialTelegramEmojiIds[material] || "";
  const icon = getTelegramEmojiTag(emojiId);
  if (!icon) {
    return "";
  }
  const normalizedCount = Math.round(Number(agreed.count));
  if (!Number.isFinite(normalizedCount) || normalizedCount <= 0) {
    return "";
  }
  return `${icon} ${normalizedCount}`;
};

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isEventOwnedInvite = (inviteData) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  return (
    inviteData.eventOwned === true || normalizeString(inviteData.eventId) !== ""
  );
};

const getRatingEventMetadata = (inviteData) => ({
  isEventMatch: isEventOwnedInvite(inviteData),
  eventOwned: inviteData?.eventOwned === true,
  eventId: normalizeString(inviteData?.eventId) || null,
});

exports.getRatingEventMetadata = getRatingEventMetadata;

exports.updateRatings = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const uid = request.auth.uid;
  const playerId = request.data.playerId;
  const inviteId = request.data.inviteId;
  const matchId = request.data.matchId;
  const opponentId = request.data.opponentId;

  if (!isAutoInviteId(inviteId)) {
    return { ok: false };
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
  const authPlayerProfile = await getProfileByLoginId(playerId);

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
      authPlayerProfile.profileId &&
      (!customClaims.profileId ||
        customClaims.profileId !== authPlayerProfile.profileId)
    ) {
      throw new HttpsError(
        "permission-denied",
        "You don't have permission to perform this action for this player.",
      );
    }
  }

  const resolvedWinner = await resolveMatchWinner(matchData, opponentMatchData);
  let result = "none";
  if (resolvedWinner.winner === "player") {
    result = "win";
  } else if (resolvedWinner.winner === "opponent") {
    result = "gg";
  }

  if (result !== "win" && result !== "gg") {
    throw new HttpsError("internal", "Could not confirm victory.");
  }

  const ratingUpdateFlagRef = admin
    .database()
    .ref(`invites/${inviteId}/matchesRatingUpdates/${matchId}`);
  const ratingUpdateRef = getRatingUpdateRef(inviteId, matchId);
  const lease = await acquireRatingUpdateLease({
    completionRef: ratingUpdateFlagRef,
    ratingUpdateRef,
    ownerUid: uid,
    inviteId,
    matchId,
    playerId,
    opponentId,
  });

  if (lease.status === "done") {
    await ensureRatingUpdateCompletionMarker(ratingUpdateFlagRef);
    await maybeApplyStoredFebruaryChallengeUpdate(lease.data);
    return {
      ok: true,
    };
  }
  if (lease.status !== "acquired") {
    return {
      ok: true,
      skipped: true,
    };
  }

  const stopRatingUpdateLeaseHeartbeat = startRatingUpdateLeaseHeartbeat({
    ratingUpdateRef,
    ownerToken: lease.ownerToken,
  });

  try {
    const playerProfile = await getProfileByLoginId(playerId);
    const opponentProfile = await getProfileByLoginId(opponentId);

    const mons = await loadMonsRules();
    const gameForScore = laterGameFromMatchData(
      mons,
      matchData,
      opponentMatchData,
    );
    const playerManaPoints =
      matchData.color === "white"
        ? gameForScore.scores[mons.Color.White]
        : gameForScore.scores[mons.Color.Black];
    const opponentManaPoints =
      opponentMatchData.color === "white"
        ? gameForScore.scores[mons.Color.White]
        : gameForScore.scores[mons.Color.Black];
    const playerHasProfile = playerProfile.profileId !== "";
    const opponentHasProfile = opponentProfile.profileId !== "";
    const canUpdateRatings = playerHasProfile && opponentHasProfile;
    const ratingEventMetadata = getRatingEventMetadata(inviteData);
    const isEventMatch = ratingEventMetadata.isEventMatch;
    const shouldApplyRatingDelta = canUpdateRatings && !isEventMatch;

    const playerEmoji =
      playerProfile.emoji === "" ? matchData.emojiId : playerProfile.emoji;
    const opponentEmoji =
      opponentProfile.emoji === ""
        ? opponentMatchData.emojiId
        : opponentProfile.emoji;
    const playerProfileDisplayName = getDisplayNameFromAddress(
      playerProfile.username,
      playerProfile.eth,
      playerProfile.sol,
      0,
      playerEmoji,
      false,
    );
    const opponentProfileDisplayName = getDisplayNameFromAddress(
      opponentProfile.username,
      opponentProfile.eth,
      opponentProfile.sol,
      0,
      opponentEmoji,
      false,
    );

    let winnerDisplayName =
      result === "win" ? playerProfileDisplayName : opponentProfileDisplayName;
    let loserDisplayName =
      result === "win" ? opponentProfileDisplayName : playerProfileDisplayName;

    let winnerNewRating = 0;
    let loserNewRating = 0;
    let playerRatingUpdate = null;
    let opponentRatingUpdate = null;
    let shouldUpdateFebruaryChallenge = false;
    let didApplyRatingDelta = false;

    if (canUpdateRatings) {
      const hasMoves = (data) =>
        typeof data.flatMovesString === "string" &&
        data.flatMovesString.length > 0;
      const bothPlayersMoved =
        hasMoves(matchData) && hasMoves(opponentMatchData);
      const newPlayerManaTotal =
        (playerProfile.totalManaPoints ?? 0) + playerManaPoints;
      const newOpponentManaTotal =
        (opponentProfile.totalManaPoints ?? 0) + opponentManaPoints;
      const newNonce1 = playerProfile.nonce + 1;
      const newNonce2 = opponentProfile.nonce + 1;
      const updatedPlayerNonce = bothPlayersMoved
        ? newNonce1
        : playerProfile.nonce;
      const updatedOpponentNonce = bothPlayersMoved
        ? newNonce2
        : opponentProfile.nonce;
      shouldUpdateFebruaryChallenge =
        bothPlayersMoved && !isEventMatch && isFebruaryChallengeActive();

      if (shouldApplyRatingDelta) {
        didApplyRatingDelta = true;
        if (result === "win") {
          const [newWinnerRating, newLoserRating] = updateRating(
            playerProfile.rating,
            newNonce1,
            opponentProfile.rating,
            newNonce2,
          );
          winnerNewRating = newWinnerRating;
          loserNewRating = newLoserRating;
          playerRatingUpdate = {
            rating: newWinnerRating,
            nonce: updatedPlayerNonce,
            win: true,
            totalManaPoints: newPlayerManaTotal,
          };
          opponentRatingUpdate = {
            rating: newLoserRating,
            nonce: updatedOpponentNonce,
            win: false,
            totalManaPoints: newOpponentManaTotal,
          };
        } else {
          const [newWinnerRating, newLoserRating] = updateRating(
            opponentProfile.rating,
            newNonce2,
            playerProfile.rating,
            newNonce1,
          );
          winnerNewRating = newWinnerRating;
          loserNewRating = newLoserRating;
          playerRatingUpdate = {
            rating: newLoserRating,
            nonce: updatedPlayerNonce,
            win: false,
            totalManaPoints: newPlayerManaTotal,
          };
          opponentRatingUpdate = {
            rating: newWinnerRating,
            nonce: updatedOpponentNonce,
            win: true,
            totalManaPoints: newOpponentManaTotal,
          };
        }
      } else if (result === "win") {
        winnerNewRating = playerProfile.rating;
        loserNewRating = opponentProfile.rating;
        playerRatingUpdate = {
          nonce: updatedPlayerNonce,
          win: true,
          totalManaPoints: newPlayerManaTotal,
        };
        opponentRatingUpdate = {
          nonce: updatedOpponentNonce,
          win: false,
          totalManaPoints: newOpponentManaTotal,
        };
      } else {
        winnerNewRating = opponentProfile.rating;
        loserNewRating = playerProfile.rating;
        playerRatingUpdate = {
          nonce: updatedPlayerNonce,
          win: false,
          totalManaPoints: newPlayerManaTotal,
        };
        opponentRatingUpdate = {
          nonce: updatedOpponentNonce,
          win: true,
          totalManaPoints: newOpponentManaTotal,
        };
      }
    }

    const winnerScore =
      result === "win" ? playerManaPoints : opponentManaPoints;
    const loserScore = result === "win" ? opponentManaPoints : playerManaPoints;
    let suffix = ` (${winnerScore} - ${loserScore})`;
    if (
      matchData.status === "surrendered" ||
      opponentMatchData.status === "surrendered"
    ) {
      const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.whiteFlag);
      if (icon) suffix += ` ${icon}`;
    } else if (
      matchData.timer === MATCH_TIMER_TERMINAL ||
      opponentMatchData.timer === MATCH_TIMER_TERMINAL
    ) {
      const icon = getTelegramEmojiTag(matchStatusTelegramEmojiIds.timer);
      if (icon) suffix += ` ${icon}`;
    }
    const wagerSuffix = getWagerSuffix(inviteData, matchId);
    if (wagerSuffix) {
      suffix += ` ${wagerSuffix}`;
    }
    const updateRatingMessage = didApplyRatingDelta
      ? `${winnerDisplayName} ${winnerNewRating}↑ ${loserDisplayName} ${loserNewRating}↓${suffix}`
      : `${winnerDisplayName} ↑ ${loserDisplayName}${suffix}`;

    const firestore = admin.firestore();
    const batch = firestore.batch();
    const completedAtMs = Date.now();
    if (playerRatingUpdate && opponentRatingUpdate) {
      batch.update(
        firestore.collection("users").doc(playerProfile.profileId),
        playerRatingUpdate,
      );
      batch.update(
        firestore.collection("users").doc(opponentProfile.profileId),
        opponentRatingUpdate,
      );
    }
    batch.set(
      ratingUpdateRef,
      {
        inviteId,
        matchId,
        playerId,
        opponentId,
        status: "done",
        result,
        canUpdateRatings,
        didApplyRatingDelta,
        winnerDisplayName,
        loserDisplayName,
        winnerNewRating: didApplyRatingDelta ? winnerNewRating : null,
        loserNewRating: didApplyRatingDelta ? loserNewRating : null,
        playerManaPoints,
        opponentManaPoints,
        shouldUpdateFebruaryChallenge,
        playerProfileId: playerProfile.profileId,
        opponentProfileId: opponentProfile.profileId,
        updateRatingMessage,
        telegramDeliveryVersion:
          !isEventMatch && inviteData.telegramDeliveryVersion === 2 ? 2 : null,
        ...ratingEventMetadata,
        updatedAtMs: completedAtMs,
        completedAtMs,
        leaseExpiresAtMs: completedAtMs,
      },
      { merge: true },
    );
    await batch.commit();

    await ensureRatingUpdateCompletionMarker(ratingUpdateFlagRef);
    await maybeApplyStoredFebruaryChallengeUpdate({
      shouldUpdateFebruaryChallenge,
      playerProfileId: playerProfile.profileId,
      opponentProfileId: opponentProfile.profileId,
    });
  } finally {
    stopRatingUpdateLeaseHeartbeat();
  }

  return {
    ok: true,
  };
});
