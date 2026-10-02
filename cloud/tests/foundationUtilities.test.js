"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { resolveMatchWinner } = require("../runtime/matchOutcome");
const {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
  resolveTelegramEmojiId,
} = require("../runtime/telegramDisplay");
const { customTelegramEmojis } = require("../runtime/telegramEmojiData");

test("Telegram emoji data preserves the complete configured catalog", () => {
  assert.equal(Object.keys(customTelegramEmojis).length, 622);
  assert.equal(customTelegramEmojis[1], "5273900723417929741");
  assert.equal(customTelegramEmojis[155], "5274191711747201553");
  assert.equal(customTelegramEmojis[1000], "5280755224934382724");
  assert.equal(customTelegramEmojis[1466], "5278711026659915839");
});

test("Telegram display formatting preserves name, rating, and emoji rules", () => {
  const emojiTag =
    '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji>';

  assert.equal(resolveTelegramEmojiId(1), "5273900723417929741");
  assert.equal(resolveTelegramEmojiId("1"), "5273900723417929741");
  assert.equal(resolveTelegramEmojiId(0), "");
  assert.equal(resolveTelegramEmojiId("unknown"), "");
  assert.equal(getTelegramEmojiTag(""), "");
  assert.equal(
    getTelegramEmojiTag("123"),
    '<tg-emoji emoji-id="123">&#11088;</tg-emoji>',
  );
  assert.equal(
    getDisplayNameFromAddress(
      "ivan",
      "0x1234567890",
      "solana12345678",
      "1500",
      "1",
    ),
    `${emojiTag} ivan (1500)`,
  );
  assert.equal(
    getDisplayNameFromAddress("", "0x1234567890", "", 0, 1, false),
    "0x12...7890",
  );
  assert.equal(
    getDisplayNameFromAddress("", "", "solana12345678", null, null),
    "sola...5678",
  );
  assert.equal(
    getDisplayNameFromAddress("", "", "", "not-a-rating", 999),
    "anon",
  );
});

test("match outcome preserves winner and incomplete-state resolution", async () => {
  assert.deepEqual(await resolveMatchWinner(null, {}), {
    winner: null,
    reason: "missing-match",
  });
  assert.deepEqual(
    await resolveMatchWinner({ color: "white" }, { color: "white" }),
    { winner: null, reason: "invalid-colors" },
  );
  assert.deepEqual(
    await resolveMatchWinner(
      { color: "white", fen: "fen" },
      { color: "black" },
    ),
    { winner: null, reason: "missing-fen" },
  );

  assert.deepEqual(await resolveMatchWinner({ status: "surrendered" }, {}), {
    winner: "opponent",
    reason: "surrender-or-timer",
  });
  assert.deepEqual(await resolveMatchWinner({}, { status: "surrendered" }), {
    winner: "player",
    reason: "surrender-or-timer",
  });
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "../runtime/matchResult.js")),
    false,
  );
});
