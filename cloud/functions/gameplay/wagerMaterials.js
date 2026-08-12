const admin = require("../firebaseAdmin");
const {
  applyMaterialDeltas,
  applyMaterialDeltasWithCap,
  computeAcceptedReservation,
  computeAvailableCount,
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

const updateFrozenMaterialsWithCap = async (uid, deltas, totalMaterials) => {
  const frozenRef = admin.database().ref(`players/${uid}/mining/frozen`);
  await frozenRef.transaction((current) => {
    return applyMaterialDeltasWithCap(current, deltas, totalMaterials);
  });
};

const reserveFrozenMaterials = async (uid, material, count, totalMaterials) => {
  let reservedCount = 0;
  const frozenRef = admin.database().ref(`players/${uid}/mining/frozen`);
  const result = await frozenRef.transaction((current) => {
    const normalized = normalizeMaterials(current);
    const available = computeAvailableCount(
      totalMaterials,
      normalized,
      material,
    );
    const nextCount = Math.min(count, available);
    if (nextCount <= 0) {
      reservedCount = 0;
      return;
    }
    reservedCount = nextCount;
    normalized[material] = (normalized[material] ?? 0) + nextCount;
    return normalized;
  });
  if (!result.committed) {
    reservedCount = 0;
  }
  return reservedCount;
};

const reserveAcceptedMaterials = async (
  uid,
  material,
  proposedCount,
  ownProposal,
  totalMaterials,
) => {
  let acceptedCount = 0;
  let appliedDelta = null;
  const frozenRef = admin.database().ref(`players/${uid}/mining/frozen`);
  const result = await frozenRef.transaction((current) => {
    const reservation = computeAcceptedReservation(
      current,
      material,
      proposedCount,
      ownProposal,
      totalMaterials,
    );
    acceptedCount = reservation.acceptedCount;
    appliedDelta = reservation.appliedDelta;
    if (!reservation.materials) {
      return;
    }
    return reservation.materials;
  });
  if (!result.committed) {
    acceptedCount = 0;
    appliedDelta = null;
  }
  return { acceptedCount, appliedDelta };
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
  updateFrozenMaterialsWithCap,
  reserveFrozenMaterials,
  reserveAcceptedMaterials,
  readUserMiningMaterials,
  updateUserMiningMaterials,
};
