"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  announceEventPrizes,
  buildEventPrizeAnnouncement,
  handleAnnounceEventPrizes,
} = require("../functions/eventPrizeTelegramAnnouncement");

const EVENT_ID = "FRkdorMWaYW";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const ANNOUNCEMENT = "Win compressed NFTs";
const DATA = Object.freeze({
  eventId: EVENT_ID,
  announcement: ANNOUNCEMENT,
});
const silentLogger = Object.freeze({ error() {} });

test("builds the exact three-line announcement from every configured prize", () => {
  const result = buildEventPrizeAnnouncement(DATA);
  assert.deepEqual(result, {
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    text: `${ANNOUNCEMENT}\n\n${EVENT_URL}`,
  });
  assert.deepEqual(result.text.split("\n"), [ANNOUNCEMENT, "", EVENT_URL]);
});

test("preserves the announcement string exactly", () => {
  const announcement = "  🏆 Prizes are ready  ";
  const result = buildEventPrizeAnnouncement({
    eventId: ` ${EVENT_ID} `,
    announcement,
  });
  assert.equal(result.text, `${announcement}\n\n${EVENT_URL}`);
});

test("rejects missing, extra, multiline, unconfigured, and oversized input", () => {
  for (const input of [
    null,
    { eventId: EVENT_ID },
    { eventId: EVENT_ID, announcement: "" },
    { eventId: EVENT_ID, announcement: "line one\nline two" },
    { eventId: EVENT_ID, announcement: "line one\rline two" },
    { eventId: EVENT_ID, announcement: "line one\u2028line two" },
    { eventId: "unknown", announcement: ANNOUNCEMENT },
    { ...DATA, extra: true },
  ]) {
    assert.throws(() => buildEventPrizeAnnouncement(input), TypeError);
  }

  const fixedLength = `\n\n${EVENT_URL}`.length;
  const maximumAnnouncement = "a".repeat(
    TELEGRAM_MEDIA_CAPTION_MAX_LENGTH - fixedLength,
  );
  assert.equal(
    buildEventPrizeAnnouncement({
      eventId: EVENT_ID,
      announcement: maximumAnnouncement,
    }).text.length,
    TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  );
  assert.throws(
    () =>
      buildEventPrizeAnnouncement({
        eventId: EVENT_ID,
        announcement: `${maximumAnnouncement}a`,
      }),
    TypeError,
  );
});

test("requires authentication and a configured admin profile", async () => {
  await assert.rejects(
    () => handleAnnounceEventPrizes({ data: DATA }),
    (error) => error.code === "unauthenticated",
  );

  await assert.rejects(
    () =>
      handleAnnounceEventPrizes(
        { auth: { uid: "uid" }, data: DATA },
        {
          getProfileByLoginId: async () => ({ username: "player" }),
        },
      ),
    (error) => error.code === "permission-denied",
  );
});

test("sends the configured album to the community chat for an admin", async () => {
  let readUid;
  let sent;
  const result = await handleAnnounceEventPrizes(
    { auth: { uid: "admin-login" }, data: DATA },
    {
      chatId: "community-chat",
      getProfileByLoginId: async (uid) => {
        readUid = uid;
        return { username: " Ivan " };
      },
      sendTelegramMediaGroup: async (input) => {
        sent = input;
        return { ok: true, messageIds: [101, 102, 103] };
      },
    },
  );

  assert.equal(readUid, "admin-login");
  assert.deepEqual(sent, {
    chatId: "community-chat",
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    text: `${ANNOUNCEMENT}\n\n${EVENT_URL}`,
    silent: false,
  });
  assert.deepEqual(result, {
    ok: true,
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    messageIds: [101, 102, 103],
  });
});

test("rejects an empty chat configuration before sending", async () => {
  let sent = false;
  await assert.rejects(
    () =>
      handleAnnounceEventPrizes(
        { auth: { uid: "uid" }, data: DATA },
        {
          chatId: "",
          getProfileByLoginId: async () => ({ username: "ivan" }),
          sendTelegramMediaGroup: async () => {
            sent = true;
          },
        },
      ),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(sent, false);
});

test("maps Telegram delivery failures without encouraging unsafe retries", async () => {
  const call = (classification) =>
    handleAnnounceEventPrizes(
      { auth: { uid: "uid" }, data: DATA },
      {
        chatId: "community-chat",
        getProfileByLoginId: async () => ({ username: "ivan" }),
        logger: silentLogger,
        sendTelegramMediaGroup: async () => ({
          ok: false,
          classification,
          code: "failure",
        }),
      },
    );

  await assert.rejects(
    () => call("uncertain"),
    (error) =>
      error.code === "aborted" && error.message.includes("Check the group"),
  );
  await assert.rejects(
    () => call("retryable"),
    (error) => error.code === "unavailable",
  );
  await assert.rejects(
    () => call("terminal"),
    (error) => error.code === "failed-precondition",
  );
});

test("binds both Telegram secrets and serializes announcements", () => {
  assert.deepEqual(
    announceEventPrizes.__endpoint.secretEnvironmentVariables
      .map((secret) => secret.key)
      .sort(),
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_EXTRA_CHAT_ID"],
  );
  assert.equal(announceEventPrizes.__endpoint.timeoutSeconds, 30);
  assert.equal(announceEventPrizes.__endpoint.maxInstances, 1);
  assert.equal(announceEventPrizes.__endpoint.concurrency, 1);
});
