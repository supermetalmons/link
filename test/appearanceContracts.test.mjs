import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_BACKGROUND_IDS,
  CARD_SUBTITLE_IDS,
  PROFILE_STICKER_CATALOG,
  createDefaultProfileAppearance,
  getProfileFallbackEmojiId,
  isAura,
  isCardBackgroundId,
  isCardSubtitleId,
  isEmojiId,
  isSelectedMons,
  isStickerMap,
  withMonSelection,
  withStickerSelection,
} from "@mons/shared/appearance";
import {
  isProfileCustomizationUpdateRequest,
  isProfileLookupResponse,
} from "@mons/shared/profiles";

test("canonical appearance uses numeric catalog emoji IDs including zero and rejects coercions", () => {
  for (const id of [0, 1, 155, 1000, 1466]) assert.equal(isEmojiId(id), true);
  for (const value of ["0", "1", -1, 1.5, 156, 999, 1467, Infinity, null])
    assert.equal(isEmojiId(value), false);
  assert.equal(typeof getProfileFallbackEmojiId("profile"), "number");
  for (const aura of ["none", "rainbow"]) assert.equal(isAura(aura), true);
  for (const aura of ["", null, "other"]) assert.equal(isAura(aura), false);
  assert.deepEqual(createDefaultProfileAppearance(0), {
    emoji: 0,
    aura: "none",
    cardBackgroundId: 30,
    cardSubtitleId: 0,
    profileCounter: "gp",
    profileMons: null,
    cardStickers: {},
  });
});

test("card catalogs and named mon selections have one exact representation", () => {
  assert.ok(CARD_BACKGROUND_IDS.every(isCardBackgroundId));
  assert.ok(CARD_SUBTITLE_IDS.every(isCardSubtitleId));
  for (const value of ["30", -1, 37, 99, 101, 1.2])
    assert.equal(isCardBackgroundId(value), false);
  /** @type {import("@mons/shared/appearance").SelectedMons} */
  const mons = { demon: 1, angel: 4, drainer: 5, spirit: 2, mystic: 2 };
  assert.equal(isSelectedMons(mons), true);
  for (const value of [
    "1,4,5,2,2",
    [1, 4, 5, 2, 2],
    { ...mons, demon: 2 },
    { ...mons, extra: 1 },
  ])
    assert.equal(isSelectedMons(value), false);
  assert.deepEqual(withMonSelection(mons, "drainer", 0), {
    ...mons,
    drainer: 0,
  });
  assert.throws(
    () => Reflect.apply(withMonSelection, undefined, [mons, "demon", 5]),
    /invalid-mon-selection/,
  );
});

test("sticker maps correlate slots with catalog names and preserve only explicit selections", () => {
  for (const [slot, names] of Object.entries(PROFILE_STICKER_CATALOG)) {
    for (const name of names)
      assert.equal(isStickerMap({ [slot]: name }), true);
  }
  for (const value of [
    '{"mana":"blue-mana"}',
    { mana: "gate" },
    { unknown: "blue-mana" },
    { mana: undefined },
    [],
  ])
    assert.equal(isStickerMap(value), false);
  /** @type {import("@mons/shared/appearance").StickerMap} */
  const before = { mana: "blue-mana" };
  const selected = withStickerSelection(before, "big-mon-top-right", "gate");
  assert.deepEqual(selected, {
    mana: "blue-mana",
    "big-mon-top-right": "gate",
  });
  assert.deepEqual(withStickerSelection(selected, "mana", undefined), {
    "big-mon-top-right": "gate",
  });
  assert.deepEqual(before, { mana: "blue-mana" });
  assert.throws(
    () =>
      Reflect.apply(withStickerSelection, undefined, [before, "mana", "gate"]),
    /invalid-sticker-selection/,
  );
});

test("profile endpoints accept structured appearance and reject legacy or partial representations", () => {
  for (const request of [
    { field: "emojiAndAura", value: { emoji: 0, aura: "none" } },
    { field: "emojiAndAura", value: { emoji: 1009, aura: "rainbow" } },
    {
      field: "profileMons",
      value: { demon: 0, angel: 1, drainer: 5, spirit: 0, mystic: 2 },
    },
    { field: "profileMons", value: null },
    { field: "cardStickers", value: { "big-mon-top-right": "gate" } },
  ])
    assert.equal(isProfileCustomizationUpdateRequest(request), true);
  for (const request of [
    { field: "emojiAndAura", value: { emoji: "0", aura: "none" } },
    { field: "emojiAndAura", value: { emoji: 1, aura: "" } },
    { field: "emojiAndAura", value: { emoji: 1, aura: "rainbow" } },
    { field: "profileMons", value: "0,1,5,0,2" },
    { field: "cardStickers", value: '{"big-mon-top-right":"gate"}' },
  ])
    assert.equal(isProfileCustomizationUpdateRequest(request), false);
  const profile = {
    id: "profile",
    nonce: 0,
    rating: 1500,
    totalManaPoints: 0,
    win: false,
    username: null,
    eth: null,
    sol: null,
    mining: {
      lastRockDate: null,
      materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    },
    ...createDefaultProfileAppearance(0),
  };
  assert.equal(isProfileLookupResponse({ ok: true, profile }), true);
  const { aura, ...partial } = profile;
  assert.equal(aura, "none");
  assert.equal(isProfileLookupResponse({ ok: true, profile: partial }), false);
});
