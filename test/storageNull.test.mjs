import assert from "node:assert/strict";
import test from "node:test";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  },
});

const { storage } = await import("../src/utils/storage.ts");

test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    delete globalThis.localStorage;
  }
});

test("nullable profile setters remove previous identity values", () => {
  storage.setPlayerRating(1600);
  storage.setPlayerNonce(4);
  storage.setPlayerTotalManaPoints(20);
  storage.setCardBackgroundId(2);
  storage.setCardSubtitleId(3);
  storage.setCardStickers("stickers");
  storage.setProfileCounter("wins");
  storage.setProfileMons("mons");

  storage.setPlayerRating(null);
  storage.setPlayerNonce(null);
  storage.setPlayerTotalManaPoints(null);
  storage.setCardBackgroundId(null);
  storage.setCardSubtitleId(null);
  storage.setCardStickers(null);
  storage.setProfileCounter(null);
  storage.setProfileMons(null);

  assert.equal(values.size, 0);
  assert.equal(storage.getPlayerRating(1500), 1500);
  assert.equal(storage.getPlayerNonce(-1), -1);
  assert.equal(storage.getPlayerTotalManaPoints(0), 0);
  assert.equal(storage.getCardBackgroundId(0), 0);
  assert.equal(storage.getCardSubtitleId(0), 0);
  assert.equal(storage.getProfileCounter(""), "");
  assert.equal(storage.getProfileMons(""), "");
});
