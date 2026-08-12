const admin = require("../firebaseAdmin");
const { getProfileByLoginId } = require("../profileSummaryLookup");
const { TELEGRAM_AUTOMATCH_VERSION } = require("../automatchTelegramMessages");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const toFiniteTimestamp = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (
    typeof value === "string" &&
    value !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Math.floor(Number(value));
  }
  return 0;
};

const getQueuedInviteCandidatesFromSnapshot = (snapshot) => {
  if (!snapshot || !snapshot.exists()) {
    return [];
  }
  const value = snapshot.val();
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value)
    .reduce((acc, [inviteId, data]) => {
      if (!inviteId || typeof inviteId !== "string") {
        return acc;
      }
      const payload = data && typeof data === "object" ? data : {};
      acc.push({
        inviteId,
        uid: normalizeString(payload.uid),
        profileId: normalizeString(payload.profileId),
        timestamp: toFiniteTimestamp(payload.timestamp),
        telegramDeliveryVersion:
          payload.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION
            ? TELEGRAM_AUTOMATCH_VERSION
            : null,
      });
      return acc;
    }, [])
    .sort((a, b) => b.timestamp - a.timestamp);
};

const resolveProfileIdForRequester = async (uid, tokenProfileId) => {
  try {
    const snapshot = await admin
      .database()
      .ref(`players/${uid}/profile`)
      .once("value");
    const linkedProfileId = normalizeString(snapshot.val());
    if (linkedProfileId) {
      return linkedProfileId;
    }
  } catch (error) {
    console.error("auto:cancel:profile-resolve:error", {
      uid,
      error: error && error.message ? error.message : error,
    });
  }
  try {
    const profile = await getProfileByLoginId(uid);
    const profileId = normalizeString(profile && profile.profileId);
    if (profileId) {
      return profileId;
    }
  } catch (error) {
    console.error("auto:cancel:profile-resolve:firestore:error", {
      uid,
      error: error && error.message ? error.message : error,
    });
  }
  const tokenValue = normalizeString(tokenProfileId);
  if (tokenValue) {
    return tokenValue;
  }
  return "";
};

const inviteHostMatchesProfile = async (inviteId, profileId) => {
  const normalizedInviteId = normalizeString(inviteId);
  const normalizedProfileId = normalizeString(profileId);
  if (!normalizedInviteId || !normalizedProfileId) {
    return false;
  }
  try {
    const inviteSnapshot = await admin
      .database()
      .ref(`invites/${normalizedInviteId}`)
      .once("value");
    if (!inviteSnapshot.exists()) {
      return false;
    }
    const inviteData = inviteSnapshot.val();
    const hostUid = normalizeString(inviteData && inviteData.hostId);
    if (!hostUid) {
      return false;
    }
    const hostProfileSnapshot = await admin
      .database()
      .ref(`players/${hostUid}/profile`)
      .once("value");
    const hostProfileId = normalizeString(hostProfileSnapshot.val());
    return hostProfileId !== "" && hostProfileId === normalizedProfileId;
  } catch (error) {
    console.error("auto:cancel:invite-host-profile-check:error", {
      inviteId: normalizedInviteId,
      error: error && error.message ? error.message : error,
    });
    return false;
  }
};

const resolveQueuedAutomatchInviteId = async (uid, profileId) => {
  const normalizedUid = normalizeString(uid);
  const normalizedProfileId = normalizeString(profileId);

  const userAutomatchQuery = admin
    .database()
    .ref("automatch")
    .orderByChild("uid")
    .equalTo(normalizedUid);
  const byUidSnapshot = await userAutomatchQuery.once("value");
  const byUidCandidates = getQueuedInviteCandidatesFromSnapshot(byUidSnapshot);
  if (byUidCandidates.length > 0) {
    return {
      inviteId: byUidCandidates[0].inviteId,
      lookup: "uid",
      telegramDeliveryVersion: byUidCandidates[0].telegramDeliveryVersion,
    };
  }

  if (!normalizedProfileId) {
    return { inviteId: null, lookup: "uid" };
  }

  const profileAutomatchQuery = admin
    .database()
    .ref("automatch")
    .orderByChild("profileId")
    .equalTo(normalizedProfileId);
  const byProfileSnapshot = await profileAutomatchQuery.once("value");
  const byProfileCandidates =
    getQueuedInviteCandidatesFromSnapshot(byProfileSnapshot);
  for (const candidate of byProfileCandidates) {
    if (
      await inviteHostMatchesProfile(candidate.inviteId, normalizedProfileId)
    ) {
      return {
        inviteId: candidate.inviteId,
        lookup: "profileId",
        telegramDeliveryVersion: candidate.telegramDeliveryVersion,
      };
    }
  }
  return {
    inviteId: null,
    lookup:
      byProfileCandidates.length > 0 ? "profileId-unverified" : "profileId",
  };
};

module.exports = {
  getQueuedInviteCandidatesFromSnapshot,
  inviteHostMatchesProfile,
  normalizeString,
  resolveProfileIdForRequester,
  resolveQueuedAutomatchInviteId,
  toFiniteTimestamp,
};
