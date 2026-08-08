"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  FIREBASE_PROJECT_ID,
  parseAnnouncementArguments,
  readFirebaseSecret,
  sendEventPrizeAnnouncement,
} = require("../admin/announceEventPrizes");

const EVENT_ID = "FRkdorMWaYW";
const ANNOUNCEMENT = "Win compressed NFTs";

test("root package exposes the requested announcement command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.announceEventPrizes,
    "node cloud/admin/announceEventPrizes.js",
  );
});

test("accepts either interactive input or exactly two positional arguments", () => {
  assert.equal(parseAnnouncementArguments([]), null);
  assert.deepEqual(parseAnnouncementArguments([EVENT_ID, ANNOUNCEMENT]), {
    eventId: EVENT_ID,
    announcement: ANNOUNCEMENT,
  });
  assert.throws(() => parseAnnouncementArguments([EVENT_ID]), TypeError);
  assert.throws(
    () => parseAnnouncementArguments([EVENT_ID, ANNOUNCEMENT, "extra"]),
    TypeError,
  );
});

test("reads a secret from the selected Firebase project without printing it", () => {
  let command;
  const value = readFirebaseSecret("SECRET_NAME", {
    runCommand: (...args) => {
      command = args;
      return { status: 0, stdout: " secret-value\n", stderr: "warning" };
    },
    workingDirectory: "/cloud",
  });
  assert.equal(value, "secret-value");
  assert.deepEqual(command, [
    "firebase",
    [
      "functions:secrets:access",
      "SECRET_NAME",
      "--project",
      FIREBASE_PROJECT_ID,
    ],
    {
      cwd: "/cloud",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ]);
});

test("sends the exact configured prize album with Firebase secrets", async () => {
  const secretNames = [];
  let sent;
  const result = await sendEventPrizeAnnouncement(
    { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
    {
      readSecret: async (secretName) => {
        secretNames.push(secretName);
        return secretName.includes("BOT") ? "bot-token" : "community-chat";
      },
      send: async (input) => {
        sent = input;
        return { ok: true, messageIds: [41, 42, 43] };
      },
    },
  );

  assert.deepEqual(secretNames, [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_EXTRA_CHAT_ID",
  ]);
  assert.deepEqual(sent, {
    chatId: "community-chat",
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    text: `${ANNOUNCEMENT}\n\nhttps://mons.link/event/${EVENT_ID}`,
    silent: false,
    token: "bot-token",
  });
  assert.deepEqual(result.messageIds, [41, 42, 43]);
});

test("warns against retrying an uncertain Telegram send", async () => {
  await assert.rejects(
    () =>
      sendEventPrizeAnnouncement(
        { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
        {
          readSecret: async () => "secret",
          send: async () => ({
            ok: false,
            classification: "uncertain",
          }),
        },
      ),
    /Check the group before retrying/,
  );
});
