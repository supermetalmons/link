"use strict";

const admin = require("./firebaseAdmin");
const { PROFILE_MERGE_TARGETS_COLLECTION } = require("./profileMergeTargets");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  createProfileGamesProjectionCore,
  readExistingProjectionDocuments,
} = require("./profileGamesProjectionCore");

const projectionRef = (firestore, profileId, inviteId) =>
  firestore
    .collection("users")
    .doc(profileId)
    .collection("games")
    .doc(inviteId);

const repository = {
  async commitProjectionWrites(writes) {
    const firestore = admin.firestore();
    const batch = firestore.batch();
    for (const write of writes) {
      const ref = projectionRef(firestore, write.profileId, write.inviteId);
      if (write.type === "delete") {
        batch.delete(ref);
      } else if (write.type === "create") {
        batch.create(ref, write.data);
      } else if (write.type === "update") {
        batch.update(ref, write.data, { lastUpdateTime: write.updateTime });
      } else {
        batch.set(ref, write.data, { merge: true });
      }
    }
    await batch.commit();
  },

  async findProfileByLogin(loginUid) {
    const snapshot = await admin
      .firestore()
      .collection("users")
      .where("logins", "array-contains", loginUid)
      .limit(1)
      .get();
    return snapshot.empty
      ? null
      : { id: snapshot.docs[0].id, data: snapshot.docs[0].data() || {} };
  },

  async getMergeTarget(profileId) {
    const snapshot = await admin
      .firestore()
      .collection(PROFILE_MERGE_TARGETS_COLLECTION)
      .doc(profileId)
      .get();
    return snapshot.exists ? snapshot.data() || {} : null;
  },

  async getProfile(profileId) {
    const snapshot = await admin
      .firestore()
      .collection("users")
      .doc(profileId)
      .get();
    return snapshot.exists
      ? { data: snapshot.data() || {}, updateTime: snapshot.updateTime }
      : null;
  },

  async getProjection(profileId, inviteId) {
    const snapshot = await projectionRef(
      admin.firestore(),
      profileId,
      inviteId,
    ).get();
    return snapshot.exists
      ? { data: snapshot.data() || {}, updateTime: snapshot.updateTime }
      : null;
  },

  async getRtdbPath(path) {
    const snapshot = await admin.database().ref(path).once("value");
    return snapshot.exists() ? snapshot.val() : null;
  },
};

const { recomputeInviteProjection } = createProfileGamesProjectionCore({
  repository,
  timestampFromMillis: (millis) =>
    admin.firestore.Timestamp.fromMillis(Math.max(1, Math.floor(millis))),
});

module.exports = {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
};
