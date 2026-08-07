"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const originalFirebaseConfig = process.env.FIREBASE_CONFIG;
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: "firebase-admin-test",
  databaseURL: "https://firebase-admin-test-default-rtdb.firebaseio.com",
});

const requireFromFunctions = createRequire(
  path.resolve(__dirname, "..", "functions", "package.json"),
);
const { deleteApp, getApps, initializeApp } =
  requireFromFunctions("firebase-admin/app");
const firebaseAdmin = require("../functions/firebaseAdmin");

test.after(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  if (originalFirebaseConfig === undefined) {
    delete process.env.FIREBASE_CONFIG;
  } else {
    process.env.FIREBASE_CONFIG = originalFirebaseConfig;
  }
});

test("database auth override apps reuse an exactly matching configuration", () => {
  const appName = "firebase-admin-test-stable-override";
  const authOverride = {
    uid: "event-telegram-projector",
    token: { eventTelegramProjectionWriter: true },
  };

  const first = firebaseAdmin.databaseWithAuthOverride(appName, authOverride);
  const second = firebaseAdmin.databaseWithAuthOverride(appName, {
    token: { eventTelegramProjectionWriter: true },
    uid: "event-telegram-projector",
  });

  assert.strictEqual(second, first);
  assert.deepEqual(
    second.app.options.databaseAuthVariableOverride,
    authOverride,
  );
});

test("database auth override apps reject a mismatched reused configuration", () => {
  const appName = "firebase-admin-test-mismatched-override";
  firebaseAdmin.databaseWithAuthOverride(appName, {
    uid: "first-writer",
    token: { eventTelegramProjectionWriter: true },
  });

  assert.throws(
    () =>
      firebaseAdmin.databaseWithAuthOverride(appName, {
        uid: "second-writer",
        token: { eventTelegramProjectionWriter: true },
      }),
    /has a different database auth override/,
  );
});

test("database auth override apps reject an unrestricted name collision", () => {
  const appName = "firebase-admin-test-unrestricted-collision";
  initializeApp(
    {
      projectId: "firebase-admin-test",
      databaseURL: "https://firebase-admin-test-default-rtdb.firebaseio.com",
    },
    appName,
  );

  assert.throws(
    () =>
      firebaseAdmin.databaseWithAuthOverride(appName, {
        uid: "event-telegram-projector",
        token: { eventTelegramProjectionWriter: true },
      }),
    /has a different database auth override/,
  );
});
