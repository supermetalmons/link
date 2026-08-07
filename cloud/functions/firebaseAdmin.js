const { getApp, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { getFunctions } = require("firebase-admin/functions");
const { isDeepStrictEqual } = require("node:util");
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

const databaseWithAuthOverride = (appName, authOverride) => {
  if (typeof appName !== "string" || appName.trim() === "") {
    throw new TypeError("appName must be a non-empty string");
  }
  if (!authOverride || typeof authOverride !== "object") {
    throw new TypeError("authOverride must be an object");
  }
  const normalizedAppName = appName.trim();
  try {
    const existingApp = getApp(normalizedAppName);
    if (
      !isDeepStrictEqual(
        existingApp.options.databaseAuthVariableOverride,
        authOverride,
      )
    ) {
      throw new Error(
        `Firebase app ${normalizedAppName} has a different database auth override`,
      );
    }
    return getDatabase(existingApp);
  } catch (error) {
    if (error && error.code !== "app/no-app") {
      throw error;
    }
  }
  const defaultApp = getDefaultApp();
  const guardedApp = initializeApp(
    {
      ...defaultApp.options,
      databaseAuthVariableOverride: authOverride,
    },
    normalizedAppName,
  );
  return getDatabase(guardedApp);
};

const database = () => getDatabase(getDefaultApp());
database.ServerValue = ServerValue;

const firestore = () => getFirestore(getDefaultApp());
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

const auth = () => getAuth(getDefaultApp());
const functions = () => getFunctions(getDefaultApp());

module.exports = {
  auth,
  database,
  databaseWithAuthOverride,
  firestore,
  functions,
  initializeApp: getDefaultApp,
};
