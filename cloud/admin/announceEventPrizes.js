#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { createInterface } = require("node:readline/promises");
const { spawnSync } = require("node:child_process");
const { stdin, stdout } = require("node:process");
const { COMPRESSED_PRIZES_EVENT_ID } = require("@mons/shared/event-prizes");
const {
  buildEventPrizeAnnouncement,
  telegramCommunityChatId,
} = require("../functions/eventPrizeTelegramAnnouncement");
const {
  sendTelegramMediaGroup,
  telegramBotToken,
} = require("../functions/telegramClient");

const FIREBASE_PROJECT_ID = "mons-link";
const cloudRoot = path.resolve(__dirname, "..");

const parseAnnouncementArguments = (argv) => {
  if (argv.length === 0) {
    return null;
  }
  if (argv.length !== 2) {
    throw new TypeError(
      'Usage: npm run announceEventPrizes -- <event-id> "<announcement>"',
    );
  }
  return {
    eventId: argv[0],
    announcement: argv[1],
  };
};

const readFirebaseSecret = (
  secretName,
  {
    projectId = FIREBASE_PROJECT_ID,
    runCommand = spawnSync,
    workingDirectory = cloudRoot,
  } = {},
) => {
  const result = runCommand(
    "firebase",
    ["functions:secrets:access", secretName, "--project", projectId],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    const details = String(result.stderr || result.error?.message || "").trim();
    throw new Error(
      `Could not access Firebase secret ${secretName}.${
        details ? ` ${details}` : ""
      }`,
    );
  }
  const value = String(result.stdout || "").trim();
  if (!value) {
    throw new Error(`Firebase secret ${secretName} is empty.`);
  }
  return value;
};

const sendEventPrizeAnnouncement = async (
  input,
  { readSecret = readFirebaseSecret, send = sendTelegramMediaGroup } = {},
) => {
  const announcement = buildEventPrizeAnnouncement(input);
  const token = await readSecret(telegramBotToken.name);
  const chatId = await readSecret(telegramCommunityChatId.name);
  const result = await send({
    chatId,
    imageUrls: announcement.imageUrls,
    text: announcement.text,
    silent: false,
    token,
  });
  if (result?.ok) {
    return {
      ...announcement,
      messageIds: result.messageIds,
    };
  }
  if (result?.classification === "uncertain") {
    throw new Error(
      "Telegram may have accepted the announcement. Check the group before retrying.",
    );
  }
  const details = [result?.code, result?.description]
    .filter(Boolean)
    .join(": ");
  throw new Error(
    `Telegram rejected the announcement.${details ? ` ${details}` : ""}`,
  );
};

const main = async (argv = process.argv.slice(2)) => {
  const cliInput = parseAnnouncementArguments(argv);
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const input = cliInput || {
      eventId:
        (await prompts.question(
          `Event ID [${COMPRESSED_PRIZES_EVENT_ID}]: `,
        )) || COMPRESSED_PRIZES_EVENT_ID,
      announcement: await prompts.question("Announcement: "),
    };
    const preview = buildEventPrizeAnnouncement(input);
    stdout.write(
      `\n${preview.imageUrls.length} prize images\n\n${preview.text}\n\n`,
    );
    const confirmation = await prompts.question("Send to Telegram? [y/N] ");
    if (!/^(y|yes)$/i.test(confirmation.trim())) {
      stdout.write("Canceled.\n");
      return;
    }
    stdout.write("Sending...\n");
    const result = await sendEventPrizeAnnouncement(input);
    stdout.write(
      `Sent ${result.messageIds.length} Telegram messages: ${result.messageIds.join(
        ", ",
      )}\n`,
    );
  } finally {
    prompts.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  FIREBASE_PROJECT_ID,
  main,
  parseAnnouncementArguments,
  readFirebaseSecret,
  sendEventPrizeAnnouncement,
};
