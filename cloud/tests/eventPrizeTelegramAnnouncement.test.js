"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
} = require("../functions/telegram/eventPrizeAnnouncement");

const EVENT_ID = "FRkdorMWaYW";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const ANNOUNCEMENT = "Win compressed NFTs";
const DATA = Object.freeze({
  eventId: EVENT_ID,
  announcement: ANNOUNCEMENT,
});

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
