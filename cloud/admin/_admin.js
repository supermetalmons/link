const fs = require("fs");
const { createRequire } = require("module");
const path = require("path");

const requireFromFunctions = createRequire(
  path.resolve(__dirname, "../functions/package.json"),
);
let hasFunctionsAdmin = false;
try {
  requireFromFunctions.resolve("firebase-admin/app");
  hasFunctionsAdmin = true;
} catch (error) {
  if (!error || error.code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}
const adminApp = hasFunctionsAdmin
  ? requireFromFunctions("firebase-admin/app")
  : require("firebase-admin/app");
const adminFirestore = hasFunctionsAdmin
  ? requireFromFunctions("firebase-admin/firestore")
  : require("firebase-admin/firestore");
const adminDatabase = hasFunctionsAdmin
  ? requireFromFunctions("firebase-admin/database")
  : require("firebase-admin/database");
const { applicationDefault, deleteApp, getApps, initializeApp } = adminApp;
const { FieldPath, FieldValue, getFirestore } = adminFirestore;
const { getDatabase } = adminDatabase;
const ADC_FAILURE_MESSAGE =
  "Failed to initialize Admin SDK with Application Default Credentials. Run gcloud auth application-default login.";

const firestore = () => getFirestore();
firestore.FieldPath = FieldPath;
firestore.FieldValue = FieldValue;
const database = () => getDatabase();

const admin = {
  database,
  firestore,
};

function getProjectIdFromArgsEnvOrRc(args = process.argv.slice(2)) {
  const pIdx = args.indexOf("--project");
  if (pIdx !== -1 && args[pIdx + 1]) return args[pIdx + 1];
  if (process.env.FIREBASE_PROJECT) return process.env.FIREBASE_PROJECT;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const rcPath = path.resolve(__dirname, "..", ".firebaserc");
    if (fs.existsSync(rcPath)) {
      const rc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      if (rc.projects && rc.projects.default) return rc.projects.default;
    }
  } catch {}
  return undefined;
}

function getDatabaseUrlFromArgsEnvOrProject(
  projectId,
  args = process.argv.slice(2),
) {
  const dbIdx = args.indexOf("--database-url");
  if (dbIdx !== -1 && args[dbIdx + 1]) return args[dbIdx + 1];
  if (process.env.FIREBASE_DATABASE_URL)
    return process.env.FIREBASE_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (projectId) return `https://${projectId}-default-rtdb.firebaseio.com`;
  return undefined;
}

function initAdmin(args = process.argv.slice(2)) {
  if (getApps().some((app) => app.name === "[DEFAULT]")) return true;
  const projectId = getProjectIdFromArgsEnvOrRc(args);
  const databaseURL = getDatabaseUrlFromArgsEnvOrProject(projectId, args);
  try {
    initializeApp({
      credential: applicationDefault(),
      projectId,
      databaseURL,
    });
    return true;
  } catch {}
  return false;
}

async function cleanupAdmin() {
  const defaultApp = getApps().find((app) => app.name === "[DEFAULT]");
  if (!defaultApp) return;
  try {
    await deleteApp(defaultApp);
  } catch {}
}

function addApplicationDefaultCredentialHelp(error) {
  const message =
    error && typeof error.message === "string" ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("default credential") ||
    normalized.includes("default credentials") ||
    normalized.includes("application_default_credentials") ||
    normalized.includes("metadata server") ||
    normalized.includes("invalid_grant")
  ) {
    return new Error(ADC_FAILURE_MESSAGE, { cause: error });
  }
  return error;
}

module.exports = {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  initAdmin,
  cleanupAdmin,
  admin,
};
