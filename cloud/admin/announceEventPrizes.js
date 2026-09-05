#!/usr/bin/env node

"use strict";

const { createHmac, randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const {
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  buildEventPrizeAnnouncement,
} = require("../functions/telegram/eventPrizeAnnouncement");
const {
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("./telegramQueueCli");

const ANNOUNCEMENT_URL =
  "https://api.mons.link/internal/telegram/event-prize-announcement";
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE =
  'Usage: npm run announceEventPrizes -- <event-id> "<collection-name>" --bridge-secret-file <path>';

const parseAnnouncementArguments = (argv) => {
  const { bridgeSecretFile, remainingArgs } = parseBridgeSecretFile(argv);
  if (
    remainingArgs.length !== 2 ||
    remainingArgs.some((arg) => arg.startsWith("--"))
  ) {
    throw new TypeError(USAGE);
  }
  return {
    eventId: remainingArgs[0],
    collectionName: remainingArgs[1],
    bridgeSecretFile,
  };
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
    bridgeSecretFile,
    readSecret = readBridgeSecret,
    requestId = randomUUID(),
  } = {},
) => {
  const announcement = buildEventPrizeAnnouncement(input);
  const result = await postEventPrizeAnnouncement(
    { ...input, requestId },
    {
      secret: await readSecret(bridgeSecretFile),
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

const main = async (
  argv = process.argv.slice(2),
  {
    createPrompts = () => createInterface({ input: stdin, output: stdout }),
    output = stdout,
    readSecret = readBridgeSecret,
    fetchImpl,
  } = {},
) => {
  const { bridgeSecretFile, ...input } = parseAnnouncementArguments(argv);
  const prompts = createPrompts();
  try {
    const preview = buildEventPrizeAnnouncement(input);
    output.write(
      `\n${preview.imageUrls.length} prize images\n\n${formatEventPrizeAnnouncementPreview(preview)}\n\n`,
    );
    const confirmation = await prompts.question("Send to Telegram? [y/N] ");
    if (!/^(y|yes)$/i.test(confirmation.trim())) {
      output.write("Canceled.\n");
      return;
    }
    output.write("Sending...\n");
    const result = await sendEventPrizeAnnouncement(input, {
      bridgeSecretFile,
      readSecret,
      fetchImpl,
    });
    output.write(
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
  REQUEST_TIMEOUT_MS,
  createBridgeHeaders,
  formatEventPrizeAnnouncementPreview,
  main,
  parseAnnouncementArguments,
  postEventPrizeAnnouncement,
  sendEventPrizeAnnouncement,
};
