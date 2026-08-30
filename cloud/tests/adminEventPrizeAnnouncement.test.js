"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ANNOUNCEMENT_URL,
  FIREBASE_PROJECT_ID,
  MAX_BRIDGE_SECRET_BYTES,
  TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET,
  formatEventPrizeAnnouncementPreview,
  parseAnnouncementArguments,
  postEventPrizeAnnouncement,
  readAnnouncementBridgeSecret,
  sendEventPrizeAnnouncement,
} = require("../admin/announceEventPrizes");

const EVENT_ID = "FRkdorMWaYW";
const COLLECTION_NAME = "Rare Weitsmans";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const TEXT = `sunday mons treats — <tg-spoiler>${COLLECTION_NAME}</tg-spoiler>\n\n${EVENT_URL}`;
const NOW_MS = Date.UTC(2026, 7, 20, 12);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const DATA = Object.freeze({
  eventId: EVENT_ID,
  collectionName: COLLECTION_NAME,
});

test("root package exposes the requested announcement command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.announceEventPrizes,
    "node cloud/admin/announceEventPrizes.js",
  );
});

test("requires exactly an event ID and collection name", () => {
  assert.deepEqual(parseAnnouncementArguments([EVENT_ID, COLLECTION_NAME]), {
    eventId: EVENT_ID,
    collectionName: COLLECTION_NAME,
  });
  for (const args of [
    [],
    [EVENT_ID],
    [EVENT_ID, COLLECTION_NAME, "extra"],
    ["--smoke", COLLECTION_NAME],
    [EVENT_ID, "--bridge-secret-file"],
  ]) {
    assert.throws(() => parseAnnouncementArguments(args), TypeError);
  }
});

test("formats the operator preview without exposing Telegram markup", () => {
  assert.equal(
    formatEventPrizeAnnouncementPreview({
      collectionName: COLLECTION_NAME,
      eventUrl: EVENT_URL,
    }),
    `sunday mons treats — [spoiler: ${COLLECTION_NAME}]\n\n${EVENT_URL}`,
  );
});

test("reads only the bounded announcement bridge secret through Firebase", () => {
  let invocation;
  const secret = readAnnouncementBridgeSecret({
    projectId: "test-project",
    workingDirectory: "/workspace/cloud",
    runCommand: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: " bridge-secret\n" };
    },
  });
  assert.equal(secret, "bridge-secret");
  assert.deepEqual(invocation, {
    command: "firebase",
    args: [
      "functions:secrets:access",
      TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET,
      "--project",
      "test-project",
    ],
    options: {
      cwd: "/workspace/cloud",
      encoding: "utf8",
      maxBuffer: MAX_BRIDGE_SECRET_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  assert.equal(FIREBASE_PROJECT_ID, "mons-link");

  for (const result of [
    { status: 1, stdout: "", stderr: "private diagnostic" },
    { status: null, stdout: "", error: new Error("private diagnostic") },
    { status: 0, stdout: "" },
    { status: 0, stdout: "x".repeat(MAX_BRIDGE_SECRET_BYTES + 1) },
  ]) {
    assert.throws(
      () =>
        readAnnouncementBridgeSecret({
          runCommand: () => result,
        }),
      (error) =>
        !String(error.message).includes("private diagnostic") &&
        !String(error.message).includes("x".repeat(100)),
    );
  }
});

test("posts the exact collection payload with a timestamped HMAC signature", async () => {
  let request;
  const input = { ...DATA, requestId: REQUEST_ID };
  const result = await postEventPrizeAnnouncement(input, {
    secret: "bridge-secret",
    now: () => NOW_MS,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true, messageIds: [1, 2, 3] });
    },
  });
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(NOW_MS / 1_000));
  const expectedSignature = createHmac("sha256", "bridge-secret")
    .update(`${timestamp}.${body}`)
    .digest("base64url");

  assert.equal(request.url, ANNOUNCEMENT_URL);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, body);
  assert.deepEqual(request.init.headers, {
    "Content-Type": "application/json",
    "X-Mons-Telegram-Signature": expectedSignature,
    "X-Mons-Telegram-Timestamp": timestamp,
  });
  assert.equal(request.init.signal instanceof AbortSignal, true);
  assert.equal(result.status, 200);
});

test("returns the formatted album result through the Worker", async () => {
  let secretArguments;
  const result = await sendEventPrizeAnnouncement(DATA, {
    requestId: REQUEST_ID,
    readSecret: async (...args) => {
      secretArguments = args;
      return "bridge-secret";
    },
    fetchImpl: async () =>
      Response.json({
        ok: true,
        eventId: EVENT_ID,
        eventUrl: EVENT_URL,
        messageIds: [41, 42, 43],
      }),
  });

  assert.deepEqual(secretArguments, []);
  assert.deepEqual(result, {
    collectionName: COLLECTION_NAME,
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    parseMode: "HTML",
    text: TEXT,
    messageIds: [41, 42, 43],
  });
});

test("warns against retrying uncertain Worker and network outcomes", async () => {
  const call = (fetchImpl) =>
    sendEventPrizeAnnouncement(DATA, {
      requestId: REQUEST_ID,
      readSecret: async () => "bridge-secret",
      fetchImpl,
    });
  await assert.rejects(
    () =>
      call(async () =>
        Response.json(
          { ok: false, error: "telegram-delivery-uncertain" },
          { status: 409 },
        ),
      ),
    /Check the group before retrying/,
  );
  await assert.rejects(
    () =>
      call(async () => {
        throw new Error("network failure");
      }),
    /check the group before retrying/i,
  );
  await assert.rejects(
    () => call(async () => new Response("not-json", { status: 200 })),
    /Check the group before retrying/,
  );
});

test("requires one message ID for every configured prize image", async () => {
  await assert.rejects(
    () =>
      sendEventPrizeAnnouncement(DATA, {
        requestId: REQUEST_ID,
        readSecret: async () => "bridge-secret",
        fetchImpl: async () => Response.json({ ok: true, messageIds: [41] }),
      }),
    /Check the group before retrying/,
  );
});

test("keeps Firebase access scoped away from Telegram delivery credentials", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../admin/announceEventPrizes.js"),
    "utf8",
  );
  assert.equal(source.includes("functions:secrets:access"), true);
  assert.equal(source.includes(TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET), true);
  assert.equal(source.includes("TELEGRAM_BOT_TOKEN"), false);
  assert.equal(source.includes("TELEGRAM_EXTRA_CHAT_ID"), false);
});
