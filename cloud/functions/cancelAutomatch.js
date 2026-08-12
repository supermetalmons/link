const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramLifecycleUpdates,
} = require("./automatchTelegramMessages");
const {
  resolveProfileIdForRequester,
  resolveQueuedAutomatchInviteId,
} = require("./gameplay/automatchQueue");

exports.cancelAutomatch = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const uid = request.auth.uid;
  const profileId = await resolveProfileIdForRequester(
    uid,
    request.auth.token && request.auth.token.profileId,
  );
  console.log("auto:cancel:start", { uid, hasProfileId: !!profileId });

  const queuedInvite = await resolveQueuedAutomatchInviteId(uid, profileId);
  if (!queuedInvite.inviteId) {
    console.log("auto:cancel:snapshot", {
      exists: false,
      lookup: queuedInvite.lookup,
    });
    return { ok: false };
  }

  const inviteId = queuedInvite.inviteId;
  const usesTelegramDeliveryV2 =
    queuedInvite.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION;
  console.log("auto:cancel:inviteId", {
    inviteId,
    lookup: queuedInvite.lookup,
  });

  const guestIdRef = admin.database().ref(`invites/${inviteId}/guestId`);
  const guestIdSnapshot = await guestIdRef.once("value");
  const guestId = guestIdSnapshot.val();
  console.log("auto:cancel:guestCheck", { inviteId, guestId: !!guestId });
  if (guestId) {
    return { ok: false };
  }

  try {
    const updates = {};
    updates[`automatch/${inviteId}`] = null;
    updates[`invites/${inviteId}/automatchStateHint`] = "canceled";
    updates[`invites/${inviteId}/automatchCanceledAt`] =
      admin.database.ServerValue.TIMESTAMP;
    if (usesTelegramDeliveryV2) {
      Object.assign(
        updates,
        buildAutomatchTelegramLifecycleUpdates({
          inviteId,
          lifecycle: "canceled",
          timestamp: admin.database.ServerValue.TIMESTAMP,
          generation: admin.database.ServerValue.increment(1),
        }),
      );
    }
    await admin.database().ref().update(updates);
    console.log("auto:cancel:db:ok", { inviteId });
  } catch (e) {
    console.error("auto:cancel:db:error", {
      inviteId,
      error: e && e.message ? e.message : e,
    });
    return { ok: false };
  }

  const guestIdSnapshotAfter = await guestIdRef.once("value");
  const guestIdAfter = guestIdSnapshotAfter.val();
  console.log("auto:cancel:guestRecheck", {
    inviteId,
    guestId: !!guestIdAfter,
  });
  if (guestIdAfter) {
    const matchedUpdates = {};
    matchedUpdates[`invites/${inviteId}/automatchStateHint`] = "matched";
    matchedUpdates[`invites/${inviteId}/automatchCanceledAt`] = null;
    if (usesTelegramDeliveryV2) {
      Object.assign(
        matchedUpdates,
        buildAutomatchTelegramLifecycleUpdates({
          inviteId,
          lifecycle: "matched",
          timestamp: admin.database.ServerValue.TIMESTAMP,
          generation: admin.database.ServerValue.increment(1),
        }),
      );
    }
    await admin.database().ref().update(matchedUpdates);
    return { ok: false };
  }

  return { ok: true };
});
