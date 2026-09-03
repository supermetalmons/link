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
    for (const helper of ["queueTelegramSend"]) {
      assert.equal(source.includes(helper), false, filePath);
    }
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
    path.join(
      repositoryRoot,
      "cloud/workers/api/src/eventTelegramProjection.ts",
    ),
    "utf8",
  );
  assert.equal(projectorSource.includes("createEventLockManagerCore"), true);
  assert.equal(
    projectorSource.includes("EVENT_TELEGRAM_PROJECTION_LOCK_ROOT"),
    true,
  );
  const coreSource = fs.readFileSync(
    path.join(functionsRoot, "telegram", "eventProjectionCore.js"),
    "utf8",
  );
  assert.equal(coreSource.includes("eventTelegramProjectionLocks"), true);
});

test("event HTTP and Workflow runtimes install every outbox producer", () => {
  for (const relativePath of [
    "cloud/workers/api/src/eventRoute.ts",
    "cloud/workers/api/src/eventProgress.ts",
  ]) {
    const source = fs.readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.equal(
      source.includes("createEventMutationRepository"),
      true,
      relativePath,
    );
  }
  const composition = fs.readFileSync(
    path.join(
      repositoryRoot,
      "cloud/workers/api/src/eventMutationRepository.ts",
    ),
    "utf8",
  );
  const telegramProducer = composition.indexOf(
    "createEventTelegramProjectionRepository(",
  );
  const profileProducer = composition.indexOf(
    "createEventProfileGameProjectionRepository(",
  );
  assert.ok(telegramProducer >= 0);
  assert.ok(profileProducer > telegramProducer);
});

test("Worker tests exercise the production event projector", () => {
  const source = fs.readFileSync(
    path.join(
      repositoryRoot,
      "cloud/workers/api/test/eventTelegramProjection.test.ts",
    ),
    "utf8",
  );
  assert.equal(source.includes("processEventProjectionTask"), true);
  assert.equal(source.includes("newer generation fences stale"), true);
  assert.equal(source.includes("successor marker survives"), true);
});

test("admin Telegram scripts use signed commands and durable aliases", () => {
  const scripts = [
    ["shootingStarAlert.js", "admin:shooting-star:", "silent: true"],
    ["topGpWithEmojis.js", "admin:top-gp:", 'parseMode: "HTML"'],
    ["topMpWithEmojis.js", "admin:top-mp:", 'parseMode: "HTML"'],
  ];
  for (const [fileName, keyPrefix, option] of scripts) {
    const source = fs.readFileSync(path.join(adminRoot, fileName), "utf8");
    assert.match(source, /sendCommand/);
    assert.match(source, /destination: "community"/);
    assert.equal(source.includes(keyPrefix), true);
    assert.equal(source.includes(option), true);
    assert.match(source, /parseBridgeSecretFile/);
    assert.match(source, /randomUUID/);
    assert.equal(source.includes('ref("telegramMessages")'), false);
    assert.equal(source.includes("../functions/.env"), false);
  }
  const shootingSource = fs.readFileSync(
    path.join(adminRoot, "shootingStarAlert.js"),
    "utf8",
  );
  assert.equal(shootingSource.includes("ADC_FAILURE_MESSAGE"), false);
  for (const fileName of ["topGpWithEmojis.js", "topMpWithEmojis.js"]) {
    const source = fs.readFileSync(path.join(adminRoot, fileName), "utf8");
    assert.match(source, /createProfileD1Reader/);
    assert.equal(source.includes("ADC_FAILURE_MESSAGE"), false);
  }
  const d1Source = fs.readFileSync(path.join(adminRoot, "_d1.js"), "utf8");
  assert.match(d1Source, /CLOUDFLARE_API_TOKEN/);
  assert.match(d1Source, /D1 Read/);
  assert.match(d1Source, /\["active", "frozen"\]/);
  assert.equal(d1Source.includes('"verifying"'), false);
  assert.equal(d1Source.includes("activated_at_ms"), false);
});

test("admin tools no longer require Firebase Admin credentials", () => {
  assert.equal(fs.existsSync(path.join(adminRoot, "_admin.js")), false);
  const manifest = require("../admin/package.json");
  assert.equal(manifest.dependencies?.["firebase-admin"], undefined);
});

test("event Telegram projection is no longer exported by Firebase", () => {
  const functionIndex = require("../functions/index");
  const exportNames = [
    "projectEventTelegramOnCreated",
    "projectEventTelegramOnUpdated",
  ];
  for (const exportName of exportNames) {
    assert.equal(functionIndex[exportName], undefined, exportName);
  }
  assert.equal(
    functionIndex.projectProfileGamesOnEventWritten,
    undefined,
    "projectProfileGamesOnEventWritten",
  );
  assert.equal(functionIndex.dispatchTelegramDelivery, undefined);
  assert.equal(functionIndex.dispatchTelegramManualRecovery, undefined);
});
