const admin = require("../firebaseAdmin");

const RATING_UPDATE_LEASE_MS = 30 * 1000;
const RATING_UPDATE_HEARTBEAT_INTERVAL_MS = 10 * 1000;
const RATING_UPDATE_ACQUIRE_RETRY_DELAY_MS = 500;
const RATING_UPDATE_ACQUIRE_MAX_ATTEMPTS = 70;

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

module.exports = {
  acquireRatingUpdateLease,
  createLeaseToken,
  ensureRatingUpdateCompletionMarker,
  getRatingUpdateRef,
  readRatingUpdateData,
  startRatingUpdateLeaseHeartbeat,
  tryAcquireRatingUpdateLease,
};
