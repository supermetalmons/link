const admin = require("./firebaseAdmin");

class ProfileLookupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const readProfileByLoginUid = async (uid, selectedFields = []) => {
  let query = admin
    .firestore()
    .collection("users")
    .where("logins", "array-contains", uid)
    .limit(2);
  if (selectedFields.length > 0) {
    query = query.select(...selectedFields);
  }
  const snapshot = await query.get();
  if (snapshot.empty) {
    return null;
  }
  if (snapshot.size > 1) {
    throw new ProfileLookupError(
      "failed-precondition",
      "login-profile-conflict",
    );
  }
  return snapshot.docs[0];
};

module.exports = { readProfileByLoginUid };
