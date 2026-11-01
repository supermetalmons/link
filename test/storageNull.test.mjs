import assert from "node:assert/strict";
import test from "node:test";

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
/** @type {Map<string, string>} */
const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: /** @satisfies {Storage} */ ({
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  }),
});

const { storage } = await import("../src/utils/storage.ts");

test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("nullable profile setters remove previous identity values", () => {
  storage.setPlayerRating(1600);
  storage.setPlayerNonce(4);
  storage.setPlayerTotalManaPoints(20);
  storage.setCardBackgroundId(2);
  storage.setCardSubtitleId(3);
  storage.setCardStickers({ mana: "blue-mana" });
  storage.setProfileCounter("gp");
  storage.setProfileMons({
    demon: 0,
    angel: 0,
    drainer: 0,
    spirit: 0,
    mystic: 0,
  });

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
  assert.equal(storage.getProfileCounter("gp"), "gp");
  assert.equal(storage.getProfileMons(null), null);
});
