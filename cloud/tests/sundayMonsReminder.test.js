"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  buildSundayMonsReminder,
  isSundayMonsReminderEvent,
} = require("../functions/telegram/sundayMonsReminder");
const {
  buildEventPrizeAnnouncement,
  isEventPrizeAnnouncementEvent,
} = require("../functions/telegram/eventPrizeAnnouncement");
const {
  AUTOMATCH_WAITING_EMOJI_ID,
  getTelegramEmojiTag,
} = require("../functions/telegramDisplay");

const PRIZE_EVENT_ID = "z3oj52Iiime";
const NO_PRIZES_EVENT_ID = "sunday-no-prizes";
const EVENT = Object.freeze({
  status: "scheduled",
  isSundayMons: true,
  startAtMs: 1_800_000_000_000,
});

test("renders the exact three-hour reminder with the shared custom emoji", () => {
  const result = buildSundayMonsReminder({ eventId: PRIZE_EVENT_ID });
  assert.deepEqual(result, {
    eventId: PRIZE_EVENT_ID,
    eventUrl: "https://mons.link/event/z3oj52Iiime",
    text: 'sunday mons in 3 hours!\n\nhttps://mons.link/event/z3oj52Iiime <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>',
    parseMode: "HTML",
  });
  assert.ok(
    result.text.endsWith(getTelegramEmojiTag(AUTOMATCH_WAITING_EMOJI_ID)),
  );
  assert.equal(result.text.includes("tg-spoiler"), false);
  assert.equal(Object.hasOwn(result, "imageUrls"), false);
  assert.equal(SUNDAY_MONS_REMINDER_LEAD_MS, 10_800_000);
});

test("renders events without catalog prizes and normalizes outer whitespace", () => {
  const result = buildSundayMonsReminder({
    eventId: ` ${NO_PRIZES_EVENT_ID} `,
  });
  assert.equal(result.eventId, NO_PRIZES_EVENT_ID);
  assert.equal(
    result.eventUrl,
    `https://mons.link/event/${NO_PRIZES_EVENT_ID}`,
  );
  assert.equal(isSundayMonsReminderEvent(NO_PRIZES_EVENT_ID, EVENT), true);
  assert.equal(isEventPrizeAnnouncementEvent(NO_PRIZES_EVENT_ID, EVENT), false);
});

test("encodes event-key characters that would otherwise break the link or Telegram HTML", () => {
  const eventId = 'sunday<&"? x';
  const result = buildSundayMonsReminder({ eventId });
  assert.equal(result.eventId, eventId);
  assert.equal(
    result.eventUrl,
    "https://mons.link/event/sunday%3C%26%22%3F%20x",
  );
  assert.equal(result.text.includes(eventId), false);
  assert.equal(isSundayMonsReminderEvent(eventId, EVENT), true);
});

test("rejects malformed IDs and unsupported renderer arguments", () => {
  for (const eventId of [
    null,
    undefined,
    123,
    {},
    "",
    "   ",
    "event/child",
    "event.name",
    "event#name",
    "event$name",
    "event[name]",
    "event\nname",
    "event\u0000name",
    "event\u007fname",
    "a".repeat(769),
    "\ud800",
  ]) {
    assert.throws(() => buildSundayMonsReminder({ eventId }), TypeError);
    assert.equal(isSundayMonsReminderEvent(eventId, EVENT), false);
    assert.equal(isEventPrizeAnnouncementEvent(eventId, EVENT), false);
  }
  for (const input of [
    null,
    [],
    {},
    { eventId: PRIZE_EVENT_ID, collectionName: "unused" },
    { eventId: PRIZE_EVENT_ID, extra: true },
  ]) {
    assert.throws(() => buildSundayMonsReminder(input), TypeError);
  }
});

test("requires a strict Sunday flag, scheduled status, and a positive safe start time", () => {
  for (const eventData of [
    null,
    [],
    {},
    { ...EVENT, isSundayMons: false },
    { ...EVENT, isSundayMons: "true" },
    { ...EVENT, isSundayMons: 1 },
    { ...EVENT, isSundayMons: undefined },
    { ...EVENT, status: "active" },
    { ...EVENT, status: "ended" },
    { ...EVENT, status: "dismissed" },
    { ...EVENT, status: "cancelled" },
    ...[
      null,
      undefined,
      "1800000000000",
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((startAtMs) => ({ ...EVENT, startAtMs })),
  ]) {
    assert.equal(isSundayMonsReminderEvent(PRIZE_EVENT_ID, eventData), false);
    assert.equal(
      isSundayMonsReminderEvent(NO_PRIZES_EVENT_ID, eventData),
      false,
    );
    assert.equal(
      isEventPrizeAnnouncementEvent(PRIZE_EVENT_ID, eventData),
      false,
    );
  }
});

test("reminder eligibility ignores prize configuration and Telegram toggles", () => {
  for (const eventId of [PRIZE_EVENT_ID, NO_PRIZES_EVENT_ID]) {
    for (const telegramAnnouncements of [
      undefined,
      { invite: false, matches: false, results: false },
      { invite: true, matches: true, results: true },
    ]) {
      const eventData = {
        ...EVENT,
        announceOnTelegram: false,
        telegramAnnouncements,
      };
      assert.equal(isSundayMonsReminderEvent(eventId, eventData), true);
      assert.equal(
        isEventPrizeAnnouncementEvent(eventId, eventData),
        eventId === PRIZE_EVENT_ID,
      );
    }
  }
});

test("shared eligibility extraction preserves the existing prize caption bytes", () => {
  assert.equal(
    buildEventPrizeAnnouncement({ eventId: PRIZE_EVENT_ID }).text,
    'sunday mons treats — <tg-spoiler>planet peppa</tg-spoiler>\n\nstarting in 1 hour\n\nhttps://mons.link/event/z3oj52Iiime <tg-emoji emoji-id="5355002036817525409">&#11088;</tg-emoji>',
  );
});
