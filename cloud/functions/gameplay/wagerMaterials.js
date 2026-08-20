const admin = require("../firebaseAdmin");
const {
  applyMaterialDeltas,
  isMaterialName,
  normalizeCount,
  normalizeMaterials,
} = require("@mons/shared/mining");

const updateFrozenMaterials = async (uid, deltas) => {
  const frozenRef = admin.database().ref(`players/${uid}/mining/frozen`);
  await frozenRef.transaction((current) => {
    return applyMaterialDeltas(current, deltas);
  });
};

const readUserMiningMaterials = async (profileId) => {
  const doc = await admin.firestore().collection("users").doc(profileId).get();
  if (!doc.exists) {
    return normalizeMaterials();
  }
  const data = doc.data() || {};
  return normalizeMaterials(data.mining && data.mining.materials);
};

const updateUserMiningMaterials = async (profileId, materials) => {
  const userRef = admin.firestore().collection("users").doc(profileId);
  await userRef.update({
    "mining.materials": normalizeMaterials(materials),
  });
};

module.exports = {
  isMaterialName,
  normalizeCount,
  applyMaterialDeltas,
  updateFrozenMaterials,
  readUserMiningMaterials,
  updateUserMiningMaterials,
};
