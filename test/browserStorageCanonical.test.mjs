import assert from "node:assert/strict";
import test from "node:test";
import { storage } from "../src/utils/storage.ts";
import { applicationStorageKey } from "../src/session/applicationDataStorage.ts";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
/** @type {Map<string, string>} */
const values = new Map();
/** @type {[string, string | null][]} */
const writes = [];
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value:
    /** @satisfies {Pick<Storage, "getItem" | "setItem" | "removeItem">} */ ({
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        writes.push([key, null]);
        values.delete(key);
      },
      setItem: (key, value) => {
        writes.push([key, String(value)]);
        values.set(key, String(value));
      },
    }),
});
const put = (/** @type {string} */ key, /** @type {string} */ value) =>
  values.set(applicationStorageKey(key), value);
const raw = (/** @type {string} */ key) =>
  values.get(applicationStorageKey(key));
test.beforeEach(() => {
  values.clear();
  writes.length = 0;
});
test.after(() => {
  if (previousLocalStorage)
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("canonical storage uses only versioned keys and JSON strings", () => {
  values.set("profileId", "old-profile");
  assert.equal(storage.getProfileId("missing"), "missing");
  storage.setProfileId("profile-one");
  assert.equal(raw("profileId"), '"profile-one"');
  assert.equal(storage.getProfileId("missing"), "profile-one");
  assert.equal(values.get("profileId"), "old-profile");
  for (const name of ["123", "true", "001", "Player", ""]) {
    storage.setUsername(name);
    assert.equal(raw("username"), JSON.stringify(name));
    assert.equal(storage.getUsername("fallback"), name);
  }
});

test("canonical text rejects old raw text and primitive coercions without rewriting", () => {
  for (const serialized of [
    "profile-one",
    "123",
    "true",
    "001",
    "null",
    "[]",
    '{"value":"text"}',
  ]) {
    put("profileId", serialized);
    assert.equal(storage.getProfileId("fallback"), "fallback");
    assert.equal(raw("profileId"), serialized);
  }
  assert.deepEqual(writes, []);
});

test("finite numbers, booleans and nullable values round-trip without string coercion", () => {
  for (const value of [0, -2, 1.5]) {
    storage.setPlayerRating(value);
    assert.equal(storage.getPlayerRating(1500), value);
  }
  for (const serialized of ['"2"', "1e400", "false", "[]", "{}", "null"]) {
    put("playerRating", serialized);
    assert.equal(storage.getPlayerRating(7), 7);
  }
  storage.setTutorialCompleted(false);
  assert.equal(raw("tutorialCompleted"), "false");
  assert.equal(storage.getTutorialCompleted(true), false);
  put("tutorialCompleted", '"false"');
  assert.equal(storage.getTutorialCompleted(true), true);
  storage.setPlayerRating(null);
  assert.equal(raw("playerRating"), undefined);
  storage.setBoardColorSetsByTheme({ light: null, dark: "dark-board" });
  assert.deepEqual(
    storage.getBoardColorSetsByTheme({ light: "default", dark: null }),
    { light: null, dark: "dark-board" },
  );
});

test("collections require their canonical field types and themes reject extension fields", () => {
  storage.setCompletedProblemIds(["one", "two"]);
  assert.deepEqual(storage.getCompletedProblemIds([]), ["one", "two"]);
  const fallback = ["fallback"];
  for (const serialized of ['["one",1]', "{}", '"one"']) {
    put("completedProblems", serialized);
    assert.equal(storage.getCompletedProblemIds(fallback), fallback);
  }
  const theme = { light: "default", dark: null };
  for (const serialized of [
    '{"light":null}',
    '{"light":1,"dark":null}',
    '{"light":null,"dark":null,"extra":true}',
    "[]",
  ]) {
    put("boardColorSetsByTheme", serialized);
    assert.equal(storage.getBoardColorSetsByTheme(theme), theme);
  }
  put("preferredAssetsSet", '"Pixel"');
  assert.equal(
    storage.getPreferredAssetsSet(
      /** @type {import("../src/content/boardStyleModels.ts").AssetsSet.Original} */ (
        "Original"
      ),
    ),
    "Pixel",
  );
  put("preferredAssetsSet", "Pixel");
  assert.equal(
    storage.getPreferredAssetsSet(
      /** @type {import("../src/content/boardStyleModels.ts").AssetsSet.Original} */ (
        "Original"
      ),
    ),
    "Original",
  );
});

test("sticker storage persists a structured catalog map and rejects string encodings", () => {
  const fallback = {};
  assert.deepEqual(storage.getCardStickers(fallback), {});
  /** @type {import("@mons/shared/appearance").StickerMap} */
  const stickers = { mana: "blue-mana" };
  storage.setCardStickers(stickers);
  assert.equal(raw("cardStickers"), JSON.stringify(stickers));
  assert.deepEqual(storage.getCardStickers(fallback), stickers);
  for (const malformed of [
    JSON.stringify(stickers),
    false,
    0,
    [1, null],
    null,
    { mana: "gate" },
  ]) {
    put("cardStickers", JSON.stringify(malformed));
    assert.equal(storage.getCardStickers(fallback), fallback);
  }
});

test("reaction cache rejects malformed members instead of dropping or preserving unknown data", () => {
  const cache = {
    profileId: "profile",
    ethAddress: "",
    solAddress: "",
    extraIds: [1, 2],
    expiresAtMs: 10,
  };
  storage.setReactionExtraStickerCache(cache);
  assert.deepEqual(storage.getReactionExtraStickerCache(null), cache);
  for (const malformed of [
    { ...cache, extraIds: [1, "2"] },
    { ...cache, extra: true },
    { ...cache, expiresAtMs: "10" },
  ]) {
    put("reactionExtraStickerCache", JSON.stringify(malformed));
    assert.equal(storage.getReactionExtraStickerCache(null), null);
  }
});

test("storage failures propagate except the muted preference fallback", () => {
  const read = localStorage.getItem;
  const failure = new Error("storage denied");
  localStorage.getItem = () => {
    throw failure;
  };
  try {
    assert.throws(
      () => storage.getUsername(""),
      (error) => error === failure,
    );
    assert.throws(
      () => storage.getPlayerRating(0),
      (error) => error === failure,
    );
    assert.throws(
      () => storage.getPendingAutomatchOperation("login"),
      (error) => error === failure,
    );
    assert.equal(storage.getIsMuted(false), false);
  } finally {
    localStorage.getItem = read;
  }
});

test("mining material cache requires a complete numeric map and retains the existing fallback", () => {
  const fallback = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };
  const valid = { ...fallback, dust: 5 };
  storage.setMiningMaterials(valid);
  assert.equal(raw("playerMiningMaterials"), JSON.stringify(valid));
  assert.deepEqual(storage.getMiningMaterials(fallback), valid);
  writes.length = 0;
  for (const malformed of [
    {},
    { dust: 5 },
    { ...valid, dust: "5" },
    { ...valid, dust: -1 },
    { ...valid, dust: 1.5 },
    { ...valid, extra: 1 },
    null,
    [],
  ]) {
    const serialized = JSON.stringify(malformed);
    put("playerMiningMaterials", serialized);
    assert.strictEqual(storage.getMiningMaterials(fallback), fallback);
    assert.equal(raw("playerMiningMaterials"), serialized);
  }
  assert.deepEqual(writes, []);
  for (const malformed of [
    { dust: 5 },
    { ...valid, dust: "5" },
    { ...valid, dust: -1 },
  ])
    assert.throws(
      () => Reflect.apply(storage.setMiningMaterials, storage, [malformed]),
      /invalid-application-storage-value/,
    );
});
