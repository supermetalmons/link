"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cloudRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(cloudRoot, "..");
const functionsRoot = path.join(cloudRoot, "functions");
const adminRoot = path.join(cloudRoot, "admin");
const telegramClientPaths = new Set([
  path.join(functionsRoot, "telegram", "client.js"),
  path.join(
    repositoryRoot,
    "cloud",
    "workers",
    "api",
    "src",
    "eventPrizeAnnouncement.ts",
  ),
  path.join(
    repositoryRoot,
    "cloud",
    "workers",
    "api",
    "src",
    "telegramQueue.ts",
  ),
  path.join(repositoryRoot, "cloud", "workers", "api", "test", "testEnv.ts"),
  path.join(
    repositoryRoot,
    "cloud",
    "workers",
    "api",
    "worker-configuration.d.ts",
  ),
  path.join(repositoryRoot, "cloud", "workers", "api", "wrangler.jsonc"),
]);
const sourceExtensions = new Set([
  ".bash",
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".zsh",
]);
const ignoredDirectories = new Set([
  ".git",
  ".firebase",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const listJavaScriptFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules"
        ? []
        : listJavaScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });

const listRepositorySourceFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : listRepositorySourceFiles(entryPath);
    }
    return entry.isFile() &&
      !entry.name.includes(".test.") &&
      sourceExtensions.has(path.extname(entry.name))
      ? [entryPath]
      : [];
  });

test("only the private Telegram client references the Bot API or token", () => {
  const botApiHost = ["api.telegram", ".org"].join("");
  const botTokenName = ["TELEGRAM", "BOT", "TOKEN"].join("_");
  const violations = [];
  for (const filePath of listRepositorySourceFiles(repositoryRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    if (
      !telegramClientPaths.has(filePath) &&
      (source.includes(botApiHost) || source.includes(botTokenName))
    ) {
      violations.push(path.relative(repositoryRoot, filePath));
    }
  }
  assert.deepEqual(violations, []);
});

test("legacy Telegram transport helpers stay removed", () => {
  const legacySymbols = [
    "sendBotMessage",
    "sendAutomatchBotMessage",
    "sendTelegramMessageAndReturnId",
    "appendAutomatchBotMessageText",
    "replaceAutomatchBotMessageText",
    "replaceAutomatchBotMessageByDeletingOriginal",
    "markCanceledAutomatchBotMessage",
  ];
  const violations = [];
  for (const filePath of [
    ...listJavaScriptFiles(functionsRoot),
    ...listJavaScriptFiles(adminRoot),
  ]) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const symbol of legacySymbols) {
      if (source.includes(symbol)) {
        violations.push(`${path.relative(cloudRoot, filePath)}:${symbol}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("a blocked Telegram client cannot delay latency-critical domain handlers", () => {
  const domainFiles = [
    path.join(repositoryRoot, "cloud/workers/api/src/automatch.ts"),
    path.join(repositoryRoot, "cloud/workers/api/src/ratingUpdate.ts"),
    path.join(functionsRoot, "events.js"),
  ];
  for (const filePath of domainFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.equal(source.includes("telegramClient"), false, filePath);
    assert.equal(
      source.includes('require("./telegramDelivery")'),
      false,
      filePath,
    );
    assert.equal(source.includes("telegramDeliveryFunctions"), false, filePath);
    assert.equal(source.includes("queueTelegram"), false, filePath);
    assert.equal(source.includes("sendTelegramMessage"), false, filePath);
    assert.equal(source.includes("editTelegramMessage"), false, filePath);
    assert.equal(source.includes("deleteTelegramMessage"), false, filePath);
  }
});

test("rating responses do not enqueue event progress tasks", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "cloud/workers/api/src/ratingUpdate.ts"),
    "utf8",
  );
  assert.equal(source.includes("requestEventProgress"), false);
  assert.equal(source.includes("eventProgressTasks"), false);
  assert.equal(source.includes(".taskQueue("), false);
});

test("event Telegram projection uses a dedicated lock without changing domain locks", () => {
  const eventsSource = fs.readFileSync(
    path.join(functionsRoot, "events.js"),
    "utf8",
  );
  assert.equal(eventsSource.includes("eventTelegramProjectionLocks"), false);
  assert.equal(eventsSource.includes("EVENT_TELEGRAM_PROJECTION_LOCK"), false);

  const projectorSource = fs.readFileSync(
    path.join(functionsRoot, "telegram", "eventAnnouncements.js"),
    "utf8",
  );
  assert.equal(projectorSource.includes('require("../eventLocks")'), true);
  assert.equal(projectorSource.includes("createEventLockManager"), true);
  assert.equal(projectorSource.includes("eventTelegramProjectionLocks"), true);
  assert.equal(
    projectorSource.includes("EVENT_TELEGRAM_PROJECTION_LOCK_ROOT"),
    true,
  );
});

test("admin Telegram scripts use durable aliases and document ADC setup", () => {
  const scripts = [
    ["shootingStarAlert.js", "admin:shooting-star:", "silent: true"],
    ["topGpWithEmojis.js", "admin:top-gp:", 'parseMode: "HTML"'],
    ["topMpWithEmojis.js", "admin:top-mp:", 'parseMode: "HTML"'],
  ];
  for (const [fileName, keyPrefix, option] of scripts) {
    const source = fs.readFileSync(path.join(adminRoot, fileName), "utf8");
    assert.match(source, /queueTelegramSend/);
    assert.match(source, /destination: "community"/);
    assert.equal(source.includes(keyPrefix), true);
    assert.equal(source.includes(option), true);
    assert.match(source, /ADC_FAILURE_MESSAGE/);
    assert.equal(source.includes("../functions/.env"), false);
  }
  const adminSource = fs.readFileSync(
    path.join(adminRoot, "_admin.js"),
    "utf8",
  );
  assert.match(adminSource, /getDatabase/);
  assert.match(adminSource, /Application Default Credentials/);
});

test("admin credential failures include actionable ADC setup help", () => {
  const {
    ADC_FAILURE_MESSAGE,
    addApplicationDefaultCredentialHelp,
  } = require("../admin/_admin");
  const credentialError = new Error("Could not load the default credentials");
  const normalized = addApplicationDefaultCredentialHelp(credentialError);
  assert.equal(normalized.message, ADC_FAILURE_MESSAGE);
  assert.equal(normalized.cause, credentialError);

  const unrelated = new Error("permission denied");
  assert.equal(addApplicationDefaultCredentialHelp(unrelated), unrelated);
});

test("all Telegram functions are exported", () => {
  const functionIndex = require("../functions/index");
  const exportNames = [
    "dispatchTelegramDelivery",
    "dispatchTelegramManualRecovery",
    "projectAutomatchTelegramMessages",
    "projectRatingTelegramUpdates",
    "projectEventTelegramOnCreated",
    "projectEventTelegramOnUpdated",
  ];
  for (const exportName of exportNames) {
    assert.equal(typeof functionIndex[exportName], "function", exportName);
  }
});
