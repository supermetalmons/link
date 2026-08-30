"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
} = require("../functions/telegram/eventPrizeAnnouncement");

const EVENT_ID = "FRkdorMWaYW";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const COLLECTION_NAME = "Rare Weitsmans";
const DATA = Object.freeze({
  collectionName: COLLECTION_NAME,
  eventId: EVENT_ID,
});

test("builds the fixed HTML announcement from every configured prize", () => {
  const result = buildEventPrizeAnnouncement(DATA);
  assert.deepEqual(result, {
    collectionName: COLLECTION_NAME,
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    parseMode: EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
    text: `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>${COLLECTION_NAME}</tg-spoiler>\n\n${EVENT_URL}`,
  });
  assert.equal(result.parseMode, "HTML");
});

test("preserves collection-name casing and trims outer whitespace", () => {
  const result = buildEventPrizeAnnouncement({
    collectionName: `  ${COLLECTION_NAME}  `,
    eventId: ` ${EVENT_ID} `,
  });
  assert.equal(result.collectionName, COLLECTION_NAME);
  assert.equal(
    result.text,
    `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>${COLLECTION_NAME}</tg-spoiler>\n\n${EVENT_URL}`,
  );
});

test("escapes the collection name before embedding it in Telegram HTML", () => {
  const result = buildEventPrizeAnnouncement({
    eventId: EVENT_ID,
    collectionName: `Rare <Weitsmans> & "Friends"'`,
  });
  assert.equal(
    result.text,
    `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>Rare &lt;Weitsmans&gt; &amp; &quot;Friends&quot;&apos;</tg-spoiler>\n\n${EVENT_URL}`,
  );
});

test("rejects missing, extra, multiline, unconfigured, and oversized collection names", () => {
  for (const input of [
    null,
    { eventId: EVENT_ID },
    { eventId: EVENT_ID, collectionName: "" },
    { eventId: EVENT_ID, collectionName: "line one\nline two" },
    { eventId: EVENT_ID, collectionName: "line one\rline two" },
    { eventId: EVENT_ID, collectionName: "line one\u2028line two" },
    { eventId: "unknown", collectionName: COLLECTION_NAME },
    { ...DATA, extra: true },
  ]) {
    assert.throws(() => buildEventPrizeAnnouncement(input), TypeError);
  }

  const fixedLength = `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}\n\n${EVENT_URL}`
    .length;
  const maximumCollectionName = "a".repeat(
    TELEGRAM_MEDIA_CAPTION_MAX_LENGTH - fixedLength,
  );
  assert.equal(
    buildEventPrizeAnnouncement({
      collectionName: maximumCollectionName,
      eventId: EVENT_ID,
    }).collectionName,
    maximumCollectionName,
  );
  assert.throws(
    () =>
      buildEventPrizeAnnouncement({
        collectionName: `${maximumCollectionName}a`,
        eventId: EVENT_ID,
      }),
    TypeError,
  );
});
