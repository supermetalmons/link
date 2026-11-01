import { canonicalAppearance } from "./fixtures/canonicalData.mjs";
import { applicationStorageKey } from "../src/session/applicationDataStorage.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { storage } from "../src/utils/storage.ts";
import { bindProfileCosmeticStorage } from "./fixtures/profileCosmeticStorageHarness.mjs";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
/** @type {Map<string, string>} */
const values = new Map();
/** @type {string[]} */
const reads = [];
/** @type {string[]} */
const writes = [];
/** @type {Pick<Storage, "getItem" | "setItem" | "removeItem">} */
const localStorage = {
  getItem: (key) => {
    reads.push(key);
    return values.get(key) ?? null;
  },
  removeItem: (key) => {
    writes.push(key);
    values.delete(key);
  },
  setItem: (key, value) => {
    writes.push(key);
    values.set(key, String(value));
  },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorage,
});
const createProfileCosmeticWrites = bindProfileCosmeticStorage(
  storage,
  localStorage,
  applicationStorageKey,
);
const cosmeticKeys = /** @type {const} */ ([
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
]);

test.beforeEach(() => {
  values.clear();
  reads.length = 0;
  writes.length = 0;
});
test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("cosmetic descriptors are lazy and retain raw storage baselines", () => {
  const rawStickers = '{ "mana": "blue-mana" }';
  values.set(applicationStorageKey("cardStickers"), rawStickers);
  const fields = createProfileCosmeticWrites(
    canonicalAppearance({ cardBackgroundId: 0 }),
  );
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);

  values.set(applicationStorageKey("cardBackgroundId"), "7");
  assert.deepEqual(
    fields.map((field) => field.read()),
    ["7", rawStickers, null, null, null],
  );
  assert.deepEqual(reads, cosmeticKeys.map(applicationStorageKey));
  assert.deepEqual(writes, []);
});

test("authoritative cosmetics persist structured values and clear an explicit default mon selection", () => {
  for (const cosmetics of [
    canonicalAppearance({ cardBackgroundId: 0, cardSubtitleId: 0 }),
    canonicalAppearance({
      cardStickers: { mana: "blue-mana" },
      profileMons: { demon: 1, angel: 2, drainer: 3, spirit: 0, mystic: 1 },
    }),
  ]) {
    cosmeticKeys.forEach((key) =>
      values.set(applicationStorageKey(key), "stale"),
    );
    values.set(applicationStorageKey("profileId"), "owner");
    values.set(applicationStorageKey("playerRating"), "1777");
    writes.length = 0;
    createProfileCosmeticWrites(cosmetics).forEach((field) => field.write());
    assert.deepEqual(writes, cosmeticKeys.map(applicationStorageKey));
    for (const key of cosmeticKeys) {
      assert.equal(
        values.get(applicationStorageKey(key)),
        cosmetics[key] === null ? undefined : JSON.stringify(cosmetics[key]),
      );
    }
    assert.equal(values.get(applicationStorageKey("profileId")), "owner");
    assert.equal(values.get(applicationStorageKey("playerRating")), "1777");
  }
});

test("emoji storage accepts only numeric catalog IDs and preserves zero", () => {
  assert.equal(storage.getPlayerEmojiId(null), null);
  for (const id of [0, 1, 155, 1000, 1466]) {
    storage.setPlayerEmojiId(id);
    assert.equal(
      values.get(applicationStorageKey("playerEmojiId")),
      JSON.stringify(id),
    );
    assert.equal(storage.getPlayerEmojiId(1), id);
  }
  for (const value of ["1009", "001", "named-emoji", -1, 10000]) {
    assert.throws(
      () => Reflect.apply(storage.setPlayerEmojiId, storage, [value]),
      /invalid-application-storage-value/,
    );
    values.set(applicationStorageKey("playerEmojiId"), JSON.stringify(value));
    assert.equal(storage.getPlayerEmojiId(1), 1);
  }
});
