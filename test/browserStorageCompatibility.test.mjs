import assert from "node:assert/strict";
import test from "node:test";
import { storage } from "../src/utils/storage.ts";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const values = new Map();
const writes = [];
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      writes.push([key, null]);
      values.delete(key);
    },
    setItem: (key, value) => {
      writes.push([key, String(value)]);
      values.set(key, String(value));
    },
  },
});

test.beforeEach(() => {
  values.clear();
  writes.length = 0;
});
test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

test("browser storage compatibility: identity text accepts raw and JSON-quoted strings without rewriting", () => {
  for (const serialized of ["profile-one", '"profile-one"']) {
    values.set("profileId", serialized);
    assert.equal(storage.getProfileId("missing"), "profile-one");
    assert.equal(values.get("profileId"), serialized);
  }
  for (const serialized of ["null", null]) {
    if (serialized === null) values.delete("profileId");
    else values.set("profileId", serialized);
    assert.equal(storage.getProfileId("missing"), "missing");
  }
  assert.deepEqual(writes, []);
  storage.setProfileId("profile-two");
  assert.equal(values.get("profileId"), "profile-two");
});

test("browser storage compatibility: zero, false, arrays, and nullable theme fields round-trip", () => {
  storage.setPlayerRating(0);
  storage.setPlayerNonce(0);
  storage.setTutorialCompleted(false);
  storage.setCompletedProblemIds(["problem-one", "problem-two"]);
  storage.setBoardColorSetsByTheme({ light: null, dark: "dark-board" });
  assert.equal(storage.getPlayerRating(1500), 0);
  assert.equal(storage.getPlayerNonce(1), 0);
  assert.equal(storage.getTutorialCompleted(true), false);
  assert.deepEqual(storage.getCompletedProblemIds([]), [
    "problem-one",
    "problem-two",
  ]);
  assert.deepEqual(
    storage.getBoardColorSetsByTheme({ light: "default", dark: null }),
    { light: null, dark: "dark-board" },
  );
  assert.equal(values.get("playerRating"), "0");
  assert.equal(values.get("tutorialCompleted"), "false");
  assert.equal(
    values.get("completedProblems"),
    '["problem-one","problem-two"]',
  );
});

test("browser storage compatibility: sticker reads retain serialized-object and legacy-string conventions", () => {
  assert.equal(storage.getCardStickers(""), '""');
  for (const [serialized, expected] of [
    ['{ "mana": "blue-mana" }', '{"mana":"blue-mana"}'],
    ['"legacy-stickers"', '"legacy-stickers"'],
    ["legacy-stickers", '"legacy-stickers"'],
    ["null", '"fallback"'],
  ]) {
    values.set("cardStickers", serialized);
    assert.equal(storage.getCardStickers("fallback"), expected);
    assert.equal(values.get("cardStickers"), serialized);
  }
  assert.deepEqual(writes, []);
});

test("browser storage text codecs preserve raw primitives and quoted strings without rewriting", () => {
  for (const [key, read] of [
    ["profileId", storage.getProfileId],
    ["username", storage.getUsername],
    ["profileMons", storage.getProfileMons],
    ["boardColorSet", storage.getBoardColorSet],
  ]) {
    for (const [serialized, expected] of [
      ["123", "123"],
      [" 123 ", " 123 "],
      ["true", "true"],
      [" false ", " false "],
      ["001", "001"],
      ["legacy text", "legacy text"],
      ['"123"', "123"],
      ['"true"', "true"],
      ['""', ""],
    ]) {
      values.set(key, serialized);
      assert.equal(read("fallback"), expected);
      assert.equal(values.get(key), serialized);
    }
    for (const serialized of ["null", " null ", "[]", '{"value":"text"}']) {
      values.set(key, serialized);
      assert.equal(read("fallback"), "fallback");
      assert.equal(values.get(key), serialized);
    }
  }
  assert.deepEqual(writes, []);
  for (const name of ["123", "true", "001", "Player"]) {
    storage.setUsername(name);
    assert.equal(values.get("username"), name);
    assert.equal(storage.getUsername("fallback"), name);
  }
  storage.setProfileMons("1,2,3,4,5");
  assert.equal(storage.getProfileMons(""), "1,2,3,4,5");
  values.set("profileId", "123");
  values.set("ethAddress", "true");
  values.set("solAddress", '"001"');
  assert.deepEqual(storage.getAuthIdentity(), {
    profileId: "123",
    ethAddress: "true",
    solAddress: "001",
  });
});

test("browser storage primitive codecs keep zero and false and reject unrelated decoded shapes", () => {
  for (const [key, read] of [
    ["playerRating", storage.getPlayerRating],
    ["playerTotalManaPoints", storage.getPlayerTotalManaPoints],
    ["playerNonce", storage.getPlayerNonce],
    ["cardBackgroundId", storage.getCardBackgroundId],
    ["cardSubtitleId", storage.getCardSubtitleId],
  ]) {
    for (const [serialized, expected] of [
      ["0", 0],
      ["-2", -2],
      ["1.5", 1.5],
      ["1e400", Infinity],
    ]) {
      values.set(key, serialized);
      assert.equal(read(7), expected);
    }
    for (const serialized of ['"2"', "false", "[]", "{}", "null"]) {
      values.set(key, serialized);
      assert.equal(read(7), 7);
      assert.equal(values.get(key), serialized);
    }
  }
  for (const [key, read] of [
    ["isMuted", storage.getIsMuted],
    ["isExperimentingWithSprites", storage.getIsExperimentingWithSprites],
    ["tutorialCompleted", storage.getTutorialCompleted],
  ]) {
    values.set(key, "false");
    assert.equal(read(true), false);
    values.set(key, "true");
    assert.equal(read(false), true);
    for (const serialized of ['"false"', "0", "[]", "{}"]) {
      values.set(key, serialized);
      assert.equal(read(true), true);
    }
  }
  assert.deepEqual(writes, []);
});

test("browser storage collections and themes validate fields without normalizing supported values", () => {
  const problems = ["fallback"];
  values.set("completedProblems", '["", " first ", "first", "first"]');
  assert.deepEqual(storage.getCompletedProblemIds(problems), [
    "",
    " first ",
    "first",
    "first",
  ]);
  for (const serialized of ['["first", 1]', "{}", '"first"']) {
    values.set("completedProblems", serialized);
    assert.equal(storage.getCompletedProblemIds(problems), problems);
    assert.equal(values.get("completedProblems"), serialized);
  }
  const materials = { dust: 0 };
  values.set("playerMiningMaterials", '{"dust":0,"future":-2.5}');
  assert.deepEqual(storage.getMiningMaterials(materials), {
    dust: 0,
    future: -2.5,
  });
  for (const serialized of ['{"dust":"2"}', "[]", "false"]) {
    values.set("playerMiningMaterials", serialized);
    assert.equal(storage.getMiningMaterials(materials), materials);
  }
  const theme = { light: "default", dark: null };
  values.set(
    "boardColorSetsByTheme",
    '{"light":null,"dark":" dark ","extra":true}',
  );
  assert.deepEqual(storage.getBoardColorSetsByTheme(theme), {
    light: null,
    dark: " dark ",
    extra: true,
  });
  for (const serialized of [
    '{"light":null}',
    '{"light":1,"dark":null}',
    "[]",
  ]) {
    values.set("boardColorSetsByTheme", serialized);
    assert.equal(storage.getBoardColorSetsByTheme(theme), theme);
  }
  for (const value of ["Pixel", "Original", "Pangchiu"]) {
    values.set("preferredAssetsSet", value);
    assert.equal(storage.getPreferredAssetsSet("Pixel"), value);
  }
  values.set("preferredAssetsSet", "unsupported");
  assert.equal(storage.getPreferredAssetsSet("Original"), "Original");
  values.set("boardStyleSet", '"Pangchiu"');
  assert.equal(storage.getBoardStyleSet(null), "Pangchiu");
  values.set("boardStyleSet", "null");
  assert.equal(storage.getBoardStyleSet("Grid"), "Grid");
  values.set("boardStyleSet", " null ");
  assert.equal(storage.getBoardStyleSet("Grid"), null);
  assert.deepEqual(writes, []);
});

test("browser storage retains raw sticker JSON and propagates storage failures except the muted fallback", () => {
  for (const serialized of ["false", "0", "[1,null]", " null "]) {
    values.set("cardStickers", serialized);
    assert.equal(storage.getCardStickers("fallback"), serialized.trim());
    assert.equal(values.get("cardStickers"), serialized);
  }
  assert.deepEqual(writes, []);
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
  assert.deepEqual(writes, []);
});
