"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const bs58 = require("bs58");
const {
  COMPRESSED_PRIZES_EVENT_ID,
  EVENT_PRIZE_IDS,
  LEGACY_CORE_PRIZES_EVENT_ID,
  getEventPrizeConfig,
  getEventPrizeDefinition,
  isEventPrizeEvent,
  isEventPrizeId,
} = require("@mons/shared/event-prizes");
const databaseRules = require("../database.rules.json");

test("preserves the legacy Core prize catalog", () => {
  const config = getEventPrizeConfig(LEGACY_CORE_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      { id: "1092", standard: "core", claimAvailable: true },
      { id: "1111", standard: "core", claimAvailable: true },
      { id: "1514", standard: "core", claimAvailable: true },
    ],
  );
});

test("maps the compressed event to the supplied prizes in fallback order", () => {
  const config = getEventPrizeConfig(COMPRESSED_PRIZES_EVENT_ID);
  assert.deepEqual(
    config.prizes.map((prize) => ({
      id: prize.id,
      imageUrl: prize.imageUrl,
      assetAddress: prize.assetAddress,
      standard: prize.standard,
      claimAvailable: prize.claimAvailable,
    })),
    [
      {
        id: "1866",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1866.webp",
        assetAddress: "2KNT8rbXC7G8w5AChbEHHi6i4FN7EAZCtdWX65ZSuQp6",
        standard: "compressed",
        claimAvailable: false,
      },
      {
        id: "1682",
        imageUrl: "https://cdn.lil.org/nft/card_nft/1682.webp",
        assetAddress: "AzQvo7HgBQYiP4bK314QQTsdRKCY98gK9bxrXNMZAeMA",
        standard: "compressed",
        claimAvailable: false,
      },
      {
        id: "6793",
        imageUrl: "https://cdn.lil.org/nft/card_nft/6793.webp",
        assetAddress: "CHDbyCecsFmLa9sQrMRz7xBbCs2JALbM4LXB35bv1CU",
        standard: "compressed",
        claimAvailable: false,
      },
    ],
  );
  assert.equal(
    getEventPrizeDefinition(COMPRESSED_PRIZES_EVENT_ID, "1092"),
    null,
  );
  assert.deepEqual(EVENT_PRIZE_IDS, [
    "1092",
    "1111",
    "1514",
    "1866",
    "1682",
    "6793",
  ]);
  for (const prize of config.prizes) {
    assert.equal(bs58.default.decode(prize.assetAddress).length, 32);
  }
});

test("database rules scope selections to each event's prize IDs", () => {
  const selectionRules =
    databaseRules.rules.eventPrizeSelections.$eventId.$profileId;
  assert.match(selectionRules[".write"], /FRkdorMWaYW/);
  assert.match(selectionRules[".validate"], /FRkdorMWaYW/);
  assert.match(selectionRules[".validate"], /1866/);
  assert.match(selectionRules[".validate"], /1682/);
  assert.match(selectionRules[".validate"], /6793/);
});

test("catalog membership rejects inherited keys and padded IDs", () => {
  for (const eventId of ["constructor", "toString", "__proto__"]) {
    assert.equal(getEventPrizeConfig(eventId), null);
    assert.equal(isEventPrizeEvent(eventId), false);
  }
  assert.equal(isEventPrizeEvent(` ${COMPRESSED_PRIZES_EVENT_ID} `), false);
  assert.equal(isEventPrizeId(COMPRESSED_PRIZES_EVENT_ID, " 1866 "), false);
  assert.equal(
    getEventPrizeDefinition(COMPRESSED_PRIZES_EVENT_ID, " 1866 ")?.id,
    "1866",
  );
});
