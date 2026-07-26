const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const { batchReadWithRetry } = require("./utils");
const { requestEventProgress } = require("./eventProgressTasks");
const {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_TERMINAL,
  formatMatchTimer,
  parseMatchTimer,
} = require("@mons/shared/timers");
const { loadMonsRules, movesFromFlatString } = require("./monsRules");

const laterGameFromMatchData = (mons, matchData, opponentMatchData) => {
  const playerGame =
    typeof matchData.fen === "string"
      ? mons.Game.fromFen(matchData.fen)
      : undefined;
  const opponentGame =
    typeof opponentMatchData.fen === "string"
      ? mons.Game.fromFen(opponentMatchData.fen)
      : undefined;
  if (!playerGame || !opponentGame) {
    throw new HttpsError(
      "failed-precondition",
      "something is wrong with the game state.",
    );
  }
  return playerGame.isLaterThan(opponentGame) ? playerGame : opponentGame;
};

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

exports.startMatchTimer = onCall(async (request) => {
  const uid = request.auth.uid;
  const playerId = request.data.playerId;
  const matchId = request.data.matchId;
  const opponentId = request.data.opponentId;

  if (uid !== playerId) {
    const profileRef = admin.database().ref(`players/${playerId}/profile`);
    const profileSnapshot = await profileRef.once("value");
    const profileId = profileSnapshot.val();
    const customClaims = request.auth.token || {};
    if (!customClaims.profileId || customClaims.profileId !== profileId) {
      throw new HttpsError(
        "permission-denied",
        "You don't have permission to perform this action for this player.",
      );
    }
  }

  const matchRef = admin
    .database()
    .ref(`players/${playerId}/matches/${matchId}`);
  const opponentMatchRef = admin
    .database()
    .ref(`players/${opponentId}/matches/${matchId}`);

  const [matchSnapshot, opponentMatchSnapshot] = await batchReadWithRetry([
    matchRef,
    opponentMatchRef,
  ]);

  const matchData = matchSnapshot.val();
  const opponentMatchData = opponentMatchSnapshot.val();

  const color = matchData.color;
  const opponentColor = opponentMatchData.color;

  const mons = await loadMonsRules();
  const game = laterGameFromMatchData(mons, matchData, opponentMatchData);

  if (
    matchData.status === "surrendered" ||
    opponentMatchData.status === "surrendered" ||
    game.winner !== undefined ||
    matchData.timer === MATCH_TIMER_TERMINAL ||
    opponentMatchData.timer === MATCH_TIMER_TERMINAL
  ) {
    throw new HttpsError("failed-precondition", "game is already over.");
  }

  let whiteMoves = [];
  let blackMoves = [];
  if (color === "white") {
    whiteMoves = movesFromFlatString(matchData.flatMovesString);
    blackMoves = movesFromFlatString(opponentMatchData.flatMovesString);
  } else {
    whiteMoves = movesFromFlatString(opponentMatchData.flatMovesString);
    blackMoves = movesFromFlatString(matchData.flatMovesString);
  }

  const result = game.verifyHistory({ white: whiteMoves, black: blackMoves });
  if (!result) {
    throw new HttpsError(
      "failed-precondition",
      "something is wrong with the moves.",
    );
  }

  const turnNumber = game.turnNumber;
  const activeColor = game.activeColor;
  const opponentColorModel =
    opponentColor === "white" ? mons.Color.White : mons.Color.Black;

  if (activeColor !== opponentColorModel) {
    throw new HttpsError(
      "failed-precondition",
      "can't start a timer on your own turn.",
    );
  }

  const duration = MATCH_TIMER_DURATION_MS;
  const targetTimestamp = Date.now() + duration + 500;
  const timerString = formatMatchTimer(turnNumber, targetTimestamp);
  await matchRef.child("timer").set(timerString);

  return {
    duration: duration,
    timer: timerString,
    ok: true,
  };
});

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
    const customClaims = request.auth.token || {};
    if (!customClaims.profileId || customClaims.profileId !== profileId) {
      throw new HttpsError(
        "permission-denied",
        "You don't have permission to perform this action for this player.",
      );
    }
  }

  const matchRef = admin
    .database()
    .ref(`players/${playerId}/matches/${matchId}`);
  const opponentMatchRef = admin
    .database()
    .ref(`players/${opponentId}/matches/${matchId}`);
  const inviteRef = admin.database().ref(`invites/${inviteId}`);

  const [matchSnapshot, opponentMatchSnapshot, inviteSnapshot] =
    await batchReadWithRetry([matchRef, opponentMatchRef, inviteRef]);

  const inviteData = inviteSnapshot.val();
  if (!(
    (inviteData.hostId === playerId && inviteData.guestId === opponentId) ||
    (inviteData.hostId === opponentId && inviteData.guestId === playerId)
  )) {
    throw new HttpsError(
      "permission-denied",
      "Players don't match invite data",
    );
  }

  const matchData = matchSnapshot.val();
  const opponentMatchData = opponentMatchSnapshot.val();

  const color = matchData.color;
  const opponentColor = opponentMatchData.color;

  const mons = await loadMonsRules();
  const game = laterGameFromMatchData(mons, matchData, opponentMatchData);

  if (
    matchData.status === "surrendered" ||
    opponentMatchData.status === "surrendered" ||
    matchData.timer === MATCH_TIMER_TERMINAL ||
    opponentMatchData.timer === MATCH_TIMER_TERMINAL ||
    game.winner !== undefined
  ) {
    throw new HttpsError("failed-precondition", "game is already over.");
  }

  let whiteMoves = [];
  let blackMoves = [];
  if (color === "white") {
    whiteMoves = movesFromFlatString(matchData.flatMovesString);
    blackMoves = movesFromFlatString(opponentMatchData.flatMovesString);
  } else {
    whiteMoves = movesFromFlatString(opponentMatchData.flatMovesString);
    blackMoves = movesFromFlatString(matchData.flatMovesString);
  }

  const result = game.verifyHistory({ white: whiteMoves, black: blackMoves });
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
    const parsedTimer = parseMatchTimer(timer);
    if (parsedTimer) {
      const { turnNumber, targetTimestamp } = parsedTimer;
      const timeDelta = targetTimestamp - Date.now();
      const sameTurn = game.turnNumber === turnNumber;
      if (sameTurn && timeDelta <= 0) {
        await matchRef.child("timer").set(MATCH_TIMER_TERMINAL);
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
