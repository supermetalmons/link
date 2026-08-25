const { getApp, initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");

const getDefaultApp = () => {
  try {
    return getApp();
  } catch (error) {
    if (error && error.code !== "app/no-app") {
      throw error;
    }
    return initializeApp();
  }
};

const database = () => getDatabase(getDefaultApp());
database.ServerValue = ServerValue;

const firestore = () => getFirestore(getDefaultApp());
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

module.exports = {
  database,
  firestore,
  initializeApp: getDefaultApp,
};
