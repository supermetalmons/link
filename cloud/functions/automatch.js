const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("./firebaseAdmin");
const { getProfileByLoginId } = require("./profileSummaryLookup");
const {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
} = require("./telegramDisplay");
const {
  TELEGRAM_AUTOMATCH_VERSION,
  buildPendingAutomatchTelegramSource,
  buildMatchedAutomatchTelegramUpdates,
} = require("./automatchTelegramMessages");
const {
  buildGameSeedForStoredVariant,
  buildRandomGameSeed,
} = require("./gameVariants");
const {
  buildAutoInviteId,
  pickHostColor,
  randomAlphanumeric,
} = require("@mons/shared/ids");
const {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} = require("@mons/shared/match-protocol");

exports.automatch = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const uid = request.auth.uid;
  console.log("auto:fn:start", { uid });
  const profile = await getProfileByLoginId(uid);
  const ethAddress = profile.eth ?? "";
  const solAddress = profile.sol ?? "";
  const profileId = profile.profileId;
  const username = profile.username ?? "";
  const rating = profile.rating ?? 0;
  const hasProfile = profileId !== "";
  const emojiId = hasProfile ? (profile.emoji ?? "") : request.data.emojiId;
  const name = getDisplayNameFromAddress(
    username,
    ethAddress,
    solAddress,
    rating,
    emojiId,
  );
  const aura = hasProfile ? profile.aura || null : request.data.aura || null;

  console.log("auto:fn:params", {
    rating,
    profileId,
    name,
    emojiId,
    aura: aura ? true : false,
  });
  const automatchAttemptResult = await attemptAutomatch(
    uid,
    rating,
    username,
    ethAddress,
    solAddress,
    profileId,
    name,
    emojiId,
    aura,
    0,
  );
  console.log("auto:fn:result", automatchAttemptResult);
  return automatchAttemptResult;
});

async function attemptAutomatch(
  uid,
  rating,
  username,
  ethAddress,
  solAddress,
  profileId,
  name,
  emojiId,
  aura,
  retryCount,
) {
  const maxRetryCount = 3;
  if (retryCount > maxRetryCount) {
    return { ok: false };
  }

  const automatchRef = admin.database().ref("automatch").limitToFirst(1);
  const snapshot = await automatchRef.once("value");
  console.log("auto:attempt:snapshot", { exists: snapshot.exists() });

  if (snapshot.exists()) {
    const firstAutomatchId = Object.keys(snapshot.val())[0];
    const existingAutomatchData = snapshot.val()[firstAutomatchId];
    const retryAutomatch = () =>
      attemptAutomatch(
        uid,
        rating,
        username,
        ethAddress,
        solAddress,
        profileId,
        name,
        emojiId,
        aura,
        retryCount + 1,
      );
    if (
      existingAutomatchData.uid !== uid &&
      (profileId === "" || profileId !== existingAutomatchData.profileId)
    ) {
      const matchSeed = await buildGameSeedForStoredVariant(
        existingAutomatchData.gameVariant,
      );
      console.log("auto:attempt:foundExisting", {
        inviteId: firstAutomatchId,
        existingUid: existingAutomatchData.uid,
        hostColor: existingAutomatchData.hostColor,
        gameVariant: matchSeed.gameVariant,
      });
      const existingPlayerName = getDisplayNameFromAddress(
        existingAutomatchData.username,
        existingAutomatchData.ethAddress,
        existingAutomatchData.solAddress,
        existingAutomatchData.rating,
        existingAutomatchData.emojiId,
      );
      const usesTelegramDeliveryV2 =
        existingAutomatchData.telegramDeliveryVersion ===
        TELEGRAM_AUTOMATCH_VERSION;

      const invite = {
        version: CONTROLLER_VERSION,
        hostId: existingAutomatchData.uid,
        hostColor: existingAutomatchData.hostColor,
        guestId: uid,
        password: existingAutomatchData.password,
        ...(usesTelegramDeliveryV2
          ? { telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION }
          : {}),
      };

      const match = buildFreshMatchRecord({
        color: existingAutomatchData.hostColor === "white" ? "black" : "white",
        emojiId,
        aura,
        seed: matchSeed,
      });
      const matchLink = `https://mons.link/${firstAutomatchId}`;
      const matchMessage = `${existingPlayerName} vs. ${name} ${matchLink}`;
      const telegramUpdates = usesTelegramDeliveryV2
        ? buildMatchedAutomatchTelegramUpdates({
            inviteId: firstAutomatchId,
            matchedText: matchMessage,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            generation: admin.database.ServerValue.increment(1),
          })
        : {};

      try {
        const success = await acceptInvite(
          firstAutomatchId,
          invite,
          match,
          uid,
          telegramUpdates,
        );
        console.log("auto:accept:done", {
          inviteId: firstAutomatchId,
          success,
        });
        if (success) {
          return {
            ok: true,
            inviteId: firstAutomatchId,
            mode: "matched",
            matchedImmediately: true,
          };
        }
        return await retryAutomatch();
      } catch (error) {
        console.error("auto:accept:error", {
          inviteId: firstAutomatchId,
          error: error && error.message ? error.message : error,
        });
        return await retryAutomatch();
      }
    }
    return {
      ok: true,
      inviteId: firstAutomatchId,
      mode: "pending",
      matchedImmediately: false,
    };
  } else {
    console.log("auto:attempt:createInvite");
    const inviteId = buildAutoInviteId();
    const password = randomAlphanumeric(15);
    const hostColor = pickHostColor();
    const matchSeed = await buildRandomGameSeed();

    const invite = {
      version: CONTROLLER_VERSION,
      hostId: uid,
      hostColor,
      guestId: null,
      password,
      automatchStateHint: "pending",
      automatchCanceledAt: null,
      telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
    };

    const match = buildFreshMatchRecord({
      color: hostColor,
      emojiId,
      aura,
      seed: matchSeed,
    });
    const emojiSuffix = getTelegramEmojiTag("5355002036817525409");
    const message = `${name} is looking for a match https://mons.link ${emojiSuffix}`;
    const canceledMessage = `<i>${name} canceled an automatch</i>`;
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    const updates = {};
    updates[`players/${uid}/matches/${inviteId}`] = match;
    updates[`automatch/${inviteId}`] = {
      uid,
      rating,
      timestamp: admin.database.ServerValue.TIMESTAMP,
      username,
      ethAddress,
      solAddress,
      profileId,
      hostColor,
      password,
      emojiId,
      gameVariant: matchSeed.gameVariant,
      telegramDeliveryVersion: TELEGRAM_AUTOMATCH_VERSION,
    };
    updates[`invites/${inviteId}`] = invite;
    updates[`telegramAutomatches/${inviteId}`] =
      buildPendingAutomatchTelegramSource({
        inviteId,
        waitingText: message,
        canceledText: canceledMessage,
        timestamp,
      });
    await admin.database().ref().update(updates);
    console.log("auto:create:db:ok", { inviteId });

    return {
      ok: true,
      inviteId,
      mode: "pending",
      matchedImmediately: false,
    };
  }
}

async function acceptInvite(
  firstAutomatchId,
  invite,
  match,
  uid,
  telegramUpdates,
) {
  const updates = {};
  updates[`automatch/${firstAutomatchId}`] = null;
  updates[`invites/${firstAutomatchId}`] = {
    ...invite,
    automatchStateHint: "matched",
    automatchCanceledAt: null,
  };
  updates[`players/${uid}/matches/${firstAutomatchId}`] = match;
  Object.assign(updates, telegramUpdates);
  await admin.database().ref().update(updates);
  const guestIdRef = admin
    .database()
    .ref(`invites/${firstAutomatchId}/guestId`);
  const guestIdSnapshot = await guestIdRef.once("value");
  const finalGuestId = guestIdSnapshot.val();
  return finalGuestId === uid;
}
