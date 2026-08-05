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
const { applicationDefault, deleteApp, getApps, initializeApp } = adminApp;
const { FieldPath, getFirestore } = adminFirestore;

const firestore = () => getFirestore();
firestore.FieldPath = FieldPath;

const admin = {
  firestore,
};

function getProjectIdFromArgsEnvOrRc() {
  const args = process.argv.slice(2);
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

function getDatabaseUrlFromArgsEnvOrProject(projectId) {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf("--database-url");
  if (dbIdx !== -1 && args[dbIdx + 1]) return args[dbIdx + 1];
  if (process.env.FIREBASE_DATABASE_URL)
    return process.env.FIREBASE_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (projectId) return `https://${projectId}-default-rtdb.firebaseio.com`;
  return undefined;
}

function initAdmin() {
  if (getApps().some((app) => app.name === "[DEFAULT]")) return true;
  const projectId = getProjectIdFromArgsEnvOrRc();
  const databaseURL = getDatabaseUrlFromArgsEnvOrProject(projectId);
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

module.exports = { initAdmin, cleanupAdmin, admin };
