#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");
const { createHmac, randomUUID } = require("node:crypto");
const path = require("node:path");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const {
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  buildEventPrizeAnnouncement,
} = require("../functions/telegram/eventPrizeAnnouncement");

const FIREBASE_PROJECT_ID = "mons-link";
const TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET =
  "TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET";
const ANNOUNCEMENT_URL =
  "https://api.mons.link/internal/telegram/event-prize-announcement";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BRIDGE_SECRET_BYTES = 8 * 1024;
const cloudRoot = path.resolve(__dirname, "..");
const USAGE =
  'Usage: npm run announceEventPrizes -- <event-id> "<collection-name>"';

const parseAnnouncementArguments = (argv) => {
  if (argv.length !== 2 || argv.some((arg) => arg.startsWith("--"))) {
    throw new TypeError(USAGE);
  }
  return {
    eventId: argv[0],
    collectionName: argv[1],
  };
};

const readAnnouncementBridgeSecret = ({
  projectId = FIREBASE_PROJECT_ID,
  runCommand = spawnSync,
  workingDirectory = cloudRoot,
} = {}) => {
  const result = runCommand(
    "firebase",
    [
      "functions:secrets:access",
      TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET,
      "--project",
      projectId,
    ],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: MAX_BRIDGE_SECRET_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!result || result.error || result.status !== 0) {
    throw new Error(
      "Could not access the Telegram announcement bridge secret.",
    );
  }
  const output = String(result.stdout || "");
  if (Buffer.byteLength(output, "utf8") > MAX_BRIDGE_SECRET_BYTES) {
    throw new Error("Telegram announcement bridge secret is too large.");
  }
  const secret = output.trim();
  if (!secret) {
    throw new Error("Telegram announcement bridge secret is empty.");
  }
  return secret;
};

const createBridgeHeaders = (body, secret, nowMs) => {
  const timestamp = String(Math.floor(nowMs / 1_000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");
  return {
    "Content-Type": "application/json",
    "X-Mons-Telegram-Signature": signature,
    "X-Mons-Telegram-Timestamp": timestamp,
  };
};

const postEventPrizeAnnouncement = async (
  input,
  {
    fetchImpl = globalThis.fetch,
    now = Date.now,
    secret,
    url = ANNOUNCEMENT_URL,
  },
) => {
  const body = JSON.stringify(input);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: createBridgeHeaders(body, secret, now()),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      "Could not reach the Cloudflare announcement bridge. Delivery may be uncertain; check the group before retrying.",
    );
  }
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error(
      "Telegram may have accepted the announcement. Check the group before retrying.",
    );
  }
  if (!responseBody || typeof responseBody !== "object") {
    throw new Error(
      "Telegram may have accepted the announcement. Check the group before retrying.",
    );
  }
  return { body: responseBody, status: response.status };
};

const failureDetails = (body) =>
  [body.code, body.description].filter(Boolean).join(": ");

const formatEventPrizeAnnouncementPreview = (announcement) =>
  `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}[spoiler: ${announcement.collectionName}]\n\n${announcement.eventUrl}`;

const sendEventPrizeAnnouncement = async (
  input,
  {
    fetchImpl,
    now,
    readSecret = readAnnouncementBridgeSecret,
    requestId = randomUUID(),
  } = {},
) => {
  const announcement = buildEventPrizeAnnouncement(input);
  const result = await postEventPrizeAnnouncement(
    { ...input, requestId },
    {
      secret: await readSecret(),
      fetchImpl,
      now,
    },
  );
  if (result.status === 200 && result.body.ok === true) {
    if (
      !Array.isArray(result.body.messageIds) ||
      result.body.messageIds.length !== announcement.imageUrls.length ||
      result.body.messageIds.some(
        (messageId) => !Number.isInteger(messageId) || messageId <= 0,
      )
    ) {
      throw new Error(
        "Telegram may have accepted the announcement. Check the group before retrying.",
      );
    }
    return {
      ...announcement,
      messageIds: result.body.messageIds,
    };
  }
  if (
    result.status === 409 &&
    result.body.error === "telegram-delivery-uncertain"
  ) {
    throw new Error(
      "Telegram may have accepted the announcement. Check the group before retrying.",
    );
  }
  if (result.status === 401) {
    throw new Error("Cloudflare announcement bridge rejected the credentials.");
  }
  if (result.status === 400) {
    throw new Error(
      "Cloudflare announcement bridge rejected the announcement.",
    );
  }
  if (result.status === 503) {
    throw new Error("Telegram is temporarily unavailable. Please try again.");
  }
  if (result.status === 502) {
    const details = failureDetails(result.body);
    throw new Error(
      `Telegram rejected the announcement.${details ? ` ${details}` : ""}`,
    );
  }
  throw new Error(
    "Telegram may have accepted the announcement. Check the group before retrying.",
  );
};

const main = async (argv = process.argv.slice(2)) => {
  const input = parseAnnouncementArguments(argv);
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const preview = buildEventPrizeAnnouncement(input);
    stdout.write(
      `\n${preview.imageUrls.length} prize images\n\n${formatEventPrizeAnnouncementPreview(preview)}\n\n`,
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
  ANNOUNCEMENT_URL,
  FIREBASE_PROJECT_ID,
  MAX_BRIDGE_SECRET_BYTES,
  REQUEST_TIMEOUT_MS,
  TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET,
  createBridgeHeaders,
  formatEventPrizeAnnouncementPreview,
  main,
  parseAnnouncementArguments,
  postEventPrizeAnnouncement,
  readAnnouncementBridgeSecret,
  sendEventPrizeAnnouncement,
};
