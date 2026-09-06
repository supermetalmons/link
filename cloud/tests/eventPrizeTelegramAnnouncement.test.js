"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const prizeCatalog = require("@mons/shared/event-prizes");
const {
  AUTOMATCH_WAITING_EMOJI_ID,
  getTelegramEmojiTag,
} = require("../functions/telegramDisplay");
const {
  EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS,
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
  isEventPrizeAnnouncementEvent,
} = require("../functions/telegram/eventPrizeAnnouncement");

const EVENT_ID = "z3oj52Iiime";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const DATA = Object.freeze({ eventId: EVENT_ID });
const SCHEDULED_EVENT = Object.freeze({
  status: "scheduled",
  isSundayMons: true,
  startAtMs: 1_800_000_000_000,
  telegramAnnouncements: { invite: false, matches: false, results: false },
});
const CONFIG = prizeCatalog.getEventPrizeConfig(EVENT_ID);

const withPrizeConfig = (context, config) => {
  const modulePath =
    require.resolve("../functions/telegram/eventPrizeAnnouncement");
  context.mock.method(prizeCatalog, "getEventPrizeConfig", () => config);
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    delete require.cache[modulePath];
    context.mock.restoreAll();
  }
};

test("builds the exact Planet Peppa caption and ordered prize images", () => {
  const result = buildEventPrizeAnnouncement(DATA);
  assert.deepEqual(result, {
    collectionName: "planet peppa",
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    imageUrls: [
      "https://cdn.lil.org/player/planet_peppa/3727.webp",
      "https://cdn.lil.org/player/planet_peppa/3728.webp",
      "https://cdn.lil.org/player/planet_peppa/3729.webp",
    ],
    parseMode: EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
    text: 'sunday mons treats — <tg-spoiler>planet peppa</tg-spoiler>\n\nstarting in 1 hour\n\nhttps://mons.link/event/z3oj52Iiime <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>',
  });
  assert.equal(result.parseMode, "HTML");
  assert.ok(
    result.text.endsWith(getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)),
  );
  assert.equal(EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS, 3_600_000);
  assert.equal(EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS, 60_000);
});

test("uses approved catalog names in lowercase and trims event IDs", () => {
  for (const [eventId, collectionName] of [
    ["NN3eRzoZo80", "scarecrow"],
    ["FRkdorMWaYW", "card nft"],
    ["VOxalSrexcA", "artifact magazine 3"],
    ["oXAceF6anag", "artifact magazine 3"],
    ["RpPjMNyrJJa", "rare weitsmans"],
    [EVENT_ID, "planet peppa"],
  ]) {
    const result = buildEventPrizeAnnouncement({ eventId: ` ${eventId} ` });
    assert.equal(result.collectionName, collectionName);
    assert.equal(result.eventId, eventId);
    assert.deepEqual(
      result.imageUrls,
      prizeCatalog
        .getEventPrizeConfig(eventId)
        .prizes.map((prize) => prize.imageUrl),
    );
    assert.ok(
      result.text.includes(`<tg-spoiler>${collectionName}</tg-spoiler>`),
    );
  }
});

test("lowercases and escapes catalog names before embedding Telegram HTML", (t) => {
  const renderer = withPrizeConfig(t, {
    ...CONFIG,
    collectionName: `  Rare <Weitsmans> & "Friends"'  `,
  });
  const result = renderer.buildEventPrizeAnnouncement(DATA);
  assert.equal(result.collectionName, `rare <weitsmans> & "friends"'`);
  assert.equal(
    result.text,
    `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}<tg-spoiler>rare &lt;weitsmans&gt; &amp; &quot;friends&quot;&apos;</tg-spoiler>\n\nstarting in 1 hour\n\n${EVENT_URL} ${getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)}`,
  );
});

test("accepts only an event ID and rejects invalid or unconfigured events", () => {
  for (const input of [
    null,
    [],
    {},
    { eventId: "" },
    { eventId: 123 },
    { eventId: "invalid/event" },
    { eventId: "unknown" },
    { ...DATA, collectionName: "arbitrary" },
    { ...DATA, extra: true },
  ]) {
    assert.throws(() => buildEventPrizeAnnouncement(input), TypeError);
  }
});

test("rejects invalid catalog metadata and album sizes", (t) => {
  for (const config of [
    null,
    { ...CONFIG, collectionName: "" },
    { ...CONFIG, collectionName: "   " },
    { ...CONFIG, collectionName: 123 },
    { ...CONFIG, collectionName: "one\ntwo" },
    { ...CONFIG, collectionName: "one\rtwo" },
    { ...CONFIG, collectionName: "one\u2028two" },
    { ...CONFIG, prizes: null },
    { ...CONFIG, prizes: [] },
    { ...CONFIG, prizes: [CONFIG.prizes[0]] },
    { ...CONFIG, prizes: Array(11).fill(CONFIG.prizes[0]) },
  ]) {
    const renderer = withPrizeConfig(t, config);
    assert.throws(() => renderer.buildEventPrizeAnnouncement(DATA), TypeError);
    assert.equal(
      renderer.isEventPrizeAnnouncementEvent(EVENT_ID, SCHEDULED_EVENT),
      false,
    );
  }
  for (const length of [2, 10]) {
    const renderer = withPrizeConfig(t, {
      ...CONFIG,
      prizes: Array(length).fill(CONFIG.prizes[0]),
    });
    assert.equal(
      renderer.buildEventPrizeAnnouncement(DATA).imageUrls.length,
      length,
    );
    assert.equal(
      renderer.isEventPrizeAnnouncementEvent(EVENT_ID, SCHEDULED_EVENT),
      true,
    );
  }
});

test("enforces caption bounds after parsing HTML entities", (t) => {
  const fixedLength =
    `${EVENT_PRIZE_ANNOUNCEMENT_PREFIX}\n\nstarting in 1 hour\n\n${EVENT_URL} ⭐`
      .length;
  const maximumCollectionName = "&".repeat(
    TELEGRAM_MEDIA_CAPTION_MAX_LENGTH - fixedLength,
  );
  const validRenderer = withPrizeConfig(t, {
    ...CONFIG,
    collectionName: maximumCollectionName,
  });
  assert.equal(
    validRenderer.buildEventPrizeAnnouncement(DATA).collectionName,
    maximumCollectionName,
  );
  const oversizedRenderer = withPrizeConfig(t, {
    ...CONFIG,
    collectionName: `${maximumCollectionName}a`,
  });
  assert.throws(
    () => oversizedRenderer.buildEventPrizeAnnouncement(DATA),
    TypeError,
  );
});

test("requires a scheduled Sunday Mons event with prizes independently of toggles", () => {
  assert.equal(isEventPrizeAnnouncementEvent(EVENT_ID, SCHEDULED_EVENT), true);
  assert.equal(
    isEventPrizeAnnouncementEvent(EVENT_ID, {
      ...SCHEDULED_EVENT,
      telegramAnnouncements: undefined,
    }),
    true,
  );
  for (const eventData of [
    null,
    [],
    {},
    { ...SCHEDULED_EVENT, status: "active" },
    { ...SCHEDULED_EVENT, status: "ended" },
    { ...SCHEDULED_EVENT, status: "cancelled" },
    { ...SCHEDULED_EVENT, isSundayMons: false },
    { ...SCHEDULED_EVENT, isSundayMons: "true" },
    { ...SCHEDULED_EVENT, isSundayMons: 1 },
    { ...SCHEDULED_EVENT, isSundayMons: undefined },
  ]) {
    assert.equal(isEventPrizeAnnouncementEvent(EVENT_ID, eventData), false);
  }
  for (const startAtMs of [
    undefined,
    null,
    "1800000000000",
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      isEventPrizeAnnouncementEvent(EVENT_ID, {
        ...SCHEDULED_EVENT,
        startAtMs,
      }),
      false,
    );
  }
  assert.equal(
    isEventPrizeAnnouncementEvent("unknown", SCHEDULED_EVENT),
    false,
  );
  assert.equal(isEventPrizeAnnouncementEvent(null, SCHEDULED_EVENT), false);
});
