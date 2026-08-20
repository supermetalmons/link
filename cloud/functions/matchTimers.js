const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const { requestEventProgress } = require("./eventProgressTasks");
const {
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
} = require("@mons/shared/timers");
const { parseInviteMatchIndex } = require("@mons/shared/rematches");
const { loadMonsRules } = require("./monsRules");
const {
  buildOrderedMoveHistory,
  requireLaterGameFromMatchData,
} = require("./gameplay/matchReconstruction");
const {
  assertInviteMatchesPlayers,
  readMatchInviteRecords,
} = require("./gameplay/matchRecords");
const { assertPlayerClaim } = require("./gameplay/playerAuthorization");
const { finishMatchTimer } = require("./gameplay/matchTimerMarkers");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const maybeEnqueueEventProgressFromInvite = async ({
  inviteData,
  inviteId,
  matchId,
}) => {
  const eventId = normalizeString(inviteData && inviteData.eventId);
  if (!eventId || inviteData?.eventOwned !== true) {
    return;
  }
  try {
    const result = await requestEventProgress({
      eventId,
      sourceKey: `timer:${inviteId}:${matchId}`,
      reason: "timer-claimed",
    });
    if (result && result.fallbackPersisted) {
      console.warn("event:progress:fallback:queued", {
        eventId,
        inviteId,
        matchId,
        reason: "timer-claimed",
        fallbackSignalId: result.fallbackSignalId || null,
      });
    }
  } catch (error) {
    console.error("event:progress:enqueue:error", {
      eventId,
      inviteId,
      matchId,
      reason: "timer-claimed",
      error: error && error.message ? error.message : error,
    });
  }
};

exports.claimMatchVictoryByTimer = onCall(async (request) => {
  const uid = request.auth.uid;
  const inviteId = request.data.inviteId;
  const matchId = request.data.matchId;
  const opponentId = request.data.opponentId;
  const playerId = request.data.playerId;

  if (uid !== playerId) {
    const profileRef = admin.database().ref(`players/${playerId}/profile`);
    const profileSnapshot = await profileRef.once("value");
    const profileId = profileSnapshot.val();
    assertPlayerClaim({
      uid,
      playerId,
      token: request.auth.token,
      profileId,
    });
  }

  const { matchData, inviteData, opponentMatchData } =
    await readMatchInviteRecords({
      playerId,
      opponentId,
      matchId,
      inviteId,
    });
  assertInviteMatchesPlayers(inviteData, playerId, opponentId);
  if (parseInviteMatchIndex(inviteId, matchId) === null) {
    throw new HttpsError(
      "permission-denied",
      "Match does not belong to invite",
    );
  }

  const opponentColor = opponentMatchData.color;

  const mons = await loadMonsRules();
  const game = requireLaterGameFromMatchData(
    mons,
    matchData,
    opponentMatchData,
  );

  if (
    matchData.status === "surrendered" ||
    opponentMatchData.status === "surrendered" ||
    matchData.timer === MATCH_TIMER_TERMINAL ||
    opponentMatchData.timer === MATCH_TIMER_TERMINAL ||
    game.winner !== undefined
  ) {
    throw new HttpsError("failed-precondition", "game is already over.");
  }

  const result = game.verifyHistory(
    buildOrderedMoveHistory(matchData, opponentMatchData),
  );
  if (!result) {
    throw new HttpsError(
      "failed-precondition",
      "something is wrong with the moves.",
    );
  }

  const activeColor = game.activeColor;
  const opponentColorModel =
    opponentColor === "white" ? mons.Color.White : mons.Color.Black;

  if (activeColor !== opponentColorModel) {
    throw new HttpsError(
      "failed-precondition",
      "can't claim timer victory on your own turn.",
    );
  }

  const timer = matchData.timer;
  if (timer && typeof timer === "string") {
    const parsedTimer = parseStrictMatchTimer(timer);
    if (parsedTimer) {
      const { turnNumber, targetTimestamp } = parsedTimer;
      const timeDelta = targetTimestamp - Date.now();
      const sameTurn = game.turnNumber === turnNumber;
      if (sameTurn && timeDelta <= 0) {
        await finishMatchTimer({ playerId, opponentId, matchId });
        await maybeEnqueueEventProgressFromInvite({
          inviteData,
          inviteId,
          matchId,
        });
        return { ok: true };
      } else if (!sameTurn) {
        throw new HttpsError(
          "failed-precondition",
          "can't claim this timer anymore, it's turn is over.",
        );
      } else {
        throw new HttpsError(
          "failed-precondition",
          `can't claim yet, ${timeDelta} ms remaining`,
        );
      }
    } else {
      throw new HttpsError("failed-precondition", "wrong timer format.");
    }
  } else {
    throw new HttpsError(
      "failed-precondition",
      "could not find an existing timer.",
    );
  }
});
