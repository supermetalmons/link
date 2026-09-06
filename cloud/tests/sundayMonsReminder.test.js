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
const {
  renderUpcomingMessage,
} = require("../functions/telegram/eventProjectionCore");

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

test("uses the invitation participant threshold and exact shared formatting", () => {
  const base = buildSundayMonsReminder({ eventId: PRIZE_EVENT_ID });
  const alice = { username: "<Alice>", emojiId: 1, joinedAtMs: 100 };
  for (const participants of [{}, { alice }]) {
    assert.deepEqual(
      buildSundayMonsReminder({
        eventId: PRIZE_EVENT_ID,
        eventData: { ...EVENT, participants },
      }),
      base,
    );
  }
  const eventData = {
    ...EVENT,
    participants: {
      bob: { displayName: "Bob & Co", emojiId: 2, joinedAtMs: 200 },
      alice,
    },
  };
  const reminder = buildSundayMonsReminder({
    eventId: PRIZE_EVENT_ID,
    eventData,
  });
  const participantLine =
    '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji> &lt;Alice&gt; <tg-emoji emoji-id="5273897076990696847">&#11088;</tg-emoji> Bob &amp; Co';
  assert.equal(reminder.text, `${base.text}\n\n${participantLine}`);
  assert.equal(
    renderUpcomingMessage(PRIZE_EVENT_ID, eventData, EVENT.startAtMs)
      .split("\n")
      .at(-1),
    participantLine,
  );
});

test("shares deterministic joined order, display-name fallbacks, and anonymous names", () => {
  const result = buildSundayMonsReminder({
    eventId: PRIZE_EVENT_ID,
    eventData: {
      participants: {
        z: { username: "Z", joinedAtMs: 100 },
        b: { displayName: 'B "quoted"', emojiId: 999999, joinedAtMs: 50 },
        a: { joinedAtMs: 50 },
        invalid: null,
      },
    },
  });
  assert.ok(result.text.endsWith("\n\nanon B &quot;quoted&quot; Z"));
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
