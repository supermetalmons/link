#!/usr/bin/env node

"use strict";

const { createHmac, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { COMPRESSED_PRIZES_EVENT_ID } = require("@mons/shared/event-prizes");
const {
  buildEventPrizeAnnouncement,
} = require("../functions/telegram/eventPrizeAnnouncement");

const ANNOUNCEMENT_URL =
  "https://api.mons.link/internal/telegram/event-prize-announcement";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BRIDGE_SECRET_BYTES = 8 * 1024;
const USAGE =
  'Usage: npm run announceEventPrizes -- --bridge-secret-file <path> [--smoke | <event-id> "<announcement>"]';

const parseAnnouncementArguments = (argv) => {
  if (argv.length === 0) {
    return null;
  }
  if (argv.length !== 2) {
    throw new TypeError(USAGE);
  }
  return {
    eventId: argv[0],
    announcement: argv[1],
  };
};

const parseArgs = (argv) => {
  let bridgeSecretFile = "";
  let smoke = false;
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bridge-secret-file") {
      const value = argv[++index];
      if (bridgeSecretFile || !value || value.startsWith("--")) {
        throw new TypeError(USAGE);
      }
      bridgeSecretFile = value;
      continue;
    }
    if (arg === "--smoke") {
      if (smoke) {
        throw new TypeError(USAGE);
      }
      smoke = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new TypeError(USAGE);
    }
    positionals.push(arg);
  }
  if (!bridgeSecretFile || (smoke && positionals.length > 0)) {
    throw new TypeError(USAGE);
  }
  return {
    bridgeSecretFile,
    input: smoke ? null : parseAnnouncementArguments(positionals),
    smoke,
  };
};

const readBridgeSecretStream = async (stream = stdin) => {
  let value = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > MAX_BRIDGE_SECRET_BYTES) {
      throw new Error("Telegram bridge secret input is too large.");
    }
  }
  return value;
};

const readBridgeSecret = async (
  filePath,
  { readFile = fs.readFileSync, readStream = readBridgeSecretStream } = {},
) => {
  let secret;
  try {
    secret = String(
      filePath === "-"
        ? await readStream()
        : readFile(path.resolve(filePath), "utf8"),
    ).trim();
  } catch (error) {
    throw new Error("Could not read the Telegram bridge secret file.", {
      cause: error,
    });
  }
  if (!secret) {
    throw new Error("Telegram bridge secret file is empty.");
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

const sendEventPrizeAnnouncement = async (
  input,
  {
    bridgeSecretFile,
    fetchImpl,
    now,
    readSecret = readBridgeSecret,
    requestId = randomUUID(),
  },
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

const smokeEventPrizeAnnouncement = async (
  bridgeSecretFile,
  { fetchImpl, now, readSecret = readBridgeSecret } = {},
) => {
  const result = await postEventPrizeAnnouncement(
    {
      eventId: "__cloudflare_smoke__",
      announcement: "smoke",
      requestId: "00000000-0000-4000-8000-000000000000",
    },
    {
      secret: await readSecret(bridgeSecretFile),
      fetchImpl,
      now,
    },
  );
  if (result.status !== 400 || result.body.error !== "invalid-request") {
    throw new Error(
      `Cloudflare announcement bridge smoke returned ${result.status}.`,
    );
  }
  return { ok: true };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.smoke) {
    await smokeEventPrizeAnnouncement(options.bridgeSecretFile);
    stdout.write("Cloudflare announcement bridge smoke passed.\n");
    return;
  }
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const input = options.input || {
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
    const result = await sendEventPrizeAnnouncement(input, {
      bridgeSecretFile: options.bridgeSecretFile,
    });
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
  REQUEST_TIMEOUT_MS,
  createBridgeHeaders,
  main,
  parseAnnouncementArguments,
  parseArgs,
  postEventPrizeAnnouncement,
  readBridgeSecret,
  readBridgeSecretStream,
  sendEventPrizeAnnouncement,
  smokeEventPrizeAnnouncement,
};
