const admin = require("./firebaseAdmin");

const emptyProfileSummary = () => ({
  eth: "",
  sol: "",
  profileId: "",
  nonce: 0,
  rating: 0,
  username: "",
  totalManaPoints: 0,
  emoji: "",
  aura: "",
});

const profileSummaryFromDocument = (userDoc) => {
  const userData = userDoc.data();
  const emoji =
    userData.custom && userData.custom.emoji !== undefined
      ? userData.custom.emoji
      : (userData.emoji ?? "");
  return {
    nonce: userData.nonce === undefined ? -1 : userData.nonce,
    rating: userData.rating ?? 1500,
    eth: userData.eth ?? "",
    sol: userData.sol ?? "",
    username: userData.username ?? "",
    totalManaPoints: userData.totalManaPoints ?? 0,
    profileId: userDoc.id,
    emoji,
    aura: userData.custom?.aura ?? userData.aura ?? "",
  };
};

const getProfileByLoginId = async (uid) => {
  try {
    const userQuery = await admin
      .firestore()
      .collection("users")
      .where("logins", "array-contains", uid)
      .limit(1)
      .get();
    if (!userQuery.empty) {
      return profileSummaryFromDocument(userQuery.docs[0]);
    }
  } catch (error) {
    console.error("Error getting player profile:", error);
  }
  return emptyProfileSummary();
};

module.exports = {
  emptyProfileSummary,
  getProfileByLoginId,
  profileSummaryFromDocument,
};
