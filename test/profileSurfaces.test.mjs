import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  ProfileScopedUndoHistory,
  getNextRegularId,
  getShinyCardUndoUpdateSource,
  isInventoryEmojiId,
  parseStickerMap,
} = await import("../src/ui/shinyCardModels.ts");
const {
  bindShinyCardUi,
  getActiveInventoryItemSelection,
  hideShinyCard,
  setShinyCardVisible,
  setOwnershipVerifiedIdCardEmoji,
  setOwnershipVerifiedSpecialItem,
  showShinyCard,
  updateShinyCardDisplayName,
} = await import("../src/ui/shinyCardUiPort.ts");
const { createLeaderboardEntry, getLeaderboardDisplayName } =
  await import("../src/ui/leaderboardModels.ts");

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("shiny card UI port exposes state and forwards every public command", async () => {
  const calls = [];
  const selection = { avatarId: 9, specialIds: new Set([1, 2]) };
  const dispose = bindShinyCardUi({
    show: async (...args) => calls.push(["show", ...args]),
    hide: () => calls.push(["hide"]),
    updateDisplayName: (name) => calls.push(["name", name]),
    getActiveInventoryItemSelection: () => selection,
    setOwnershipVerifiedSpecialItem: (id) => calls.push(["special", id]),
    setOwnershipVerifiedIdCardEmoji: (id, aura) =>
      calls.push(["emoji", id, aura]),
  });

  setShinyCardVisible(true);
  const port = await import("../src/ui/shinyCardUiPort.ts");
  assert.equal(port.showsShinyCardSomewhere, true);
  await showShinyCard(null, "anon", false);
  hideShinyCard();
  updateShinyCardDisplayName("mons");
  assert.strictEqual(getActiveInventoryItemSelection(), selection);
  setOwnershipVerifiedSpecialItem(2);
  setOwnershipVerifiedIdCardEmoji(1009, "rainbow");
  assert.deepEqual(calls, [
    ["show", null, "anon", false],
    ["hide"],
    ["name", "mons"],
    ["special", 2],
    ["emoji", 1009, "rainbow"],
  ]);

  dispose();
  assert.equal(port.showsShinyCardSomewhere, false);
  assert.throws(() => hideShinyCard(), /shiny-card-ui-not-bound/);
});

test("profile scoped undo history clears entries across identities", () => {
  const history = new ProfileScopedUndoHistory();
  history.synchronize("one");
  history.enqueue("one", "one", ["bg", 7]);
  history.enqueue("two", "one", ["bg", 8]);
  assert.equal(history.size, 1);
  assert.deepEqual(history.pop("one"), ["bg", 7]);

  history.enqueue("one", "one", ["subtitle", 4]);
  history.synchronize("two");
  assert.equal(history.size, 0);
  assert.equal(history.pop("two"), undefined);
});

test("shiny card selectors preserve inventory and cyclic rules", () => {
  assert.deepEqual(parseStickerMap('{"left":"mon","count":2}'), {
    left: "mon",
  });
  assert.deepEqual(parseStickerMap("[]"), {});
  assert.deepEqual(parseStickerMap("{"), {});
  assert.equal(isInventoryEmojiId("1000", 1000), true);
  assert.equal(isInventoryEmojiId("999", 1000), false);
  assert.equal(getNextRegularId(36, 37), 0);
  assert.equal(getNextRegularId(Number.NaN, 37), 0);
  assert.equal(getNextRegularId(1, 0), 0);

  const options = {
    inventoryEmojiStartId: 1000,
    inventoryBackgroundId: 100,
    inventoryDrainerId: 12,
    inventoryStickerType: "big-mon-top-right",
    inventoryStickerName: "gate",
  };
  assert.equal(
    getShinyCardUndoUpdateSource(
      "emojiAndAura",
      { emojiId: 1001, aura: "" },
      options,
    ),
    "inventory",
  );
  assert.equal(getShinyCardUndoUpdateSource("bg", 100, options), "inventory");
  assert.equal(getShinyCardUndoUpdateSource("bg", 4, options), "default");
});

test("leaderboard models preserve defaults and display-name priority", () => {
  const profile = {
    id: "profile-1",
    emoji: 7,
    username: "mons",
    eth: "0x0000000000000000000000000000000000000001",
    sol: "11111111111111111111111111111111",
    rating: 1499.6,
    totalManaPoints: 12,
    mining: { materials: { dust: 3 } },
  };
  const entry = createLeaderboardEntry(profile);
  assert.equal(entry.rating, 1500);
  assert.equal(entry.mp, 12);
  assert.equal(entry.materials.dust, 3);
  assert.equal(entry.materials.ice, 0);
  assert.equal(getLeaderboardDisplayName(entry), "mons");
  assert.equal(
    getLeaderboardDisplayName({
      ...entry,
      username: null,
      ensName: "mons.eth",
    }),
    "mons.eth",
  );
});

test("C9 surfaces depend on neutral ports and contain no production stub path", () => {
  const playerMetadata = readSource("../src/utils/playerMetadata.ts");
  const mainMenu = readSource("../src/ui/MainMenu.tsx");
  const inventory = readSource("../src/ui/InventoryModal.tsx");
  const leaderboard = readSource("../src/ui/Leaderboard.tsx");
  const shinyCard = readSource("../src/ui/ShinyCard.tsx");
  const islandView = readSource("../src/ui/island/IslandView.tsx");
  const nftService = readSource("../src/services/nftService.ts");

  assert.doesNotMatch(
    playerMetadata,
    /from ["']\.\.\/connection\/connection["']/,
  );
  assert.doesNotMatch(
    playerMetadata,
    /from ["']\.\.\/game\/(board|gameController)["']/,
  );
  assert.doesNotMatch(mainMenu, /from ["']\.\.\/connection\/connection["']/);
  assert.doesNotMatch(mainMenu, /from ["']\.\/ShinyCard["']/);
  assert.doesNotMatch(inventory, /from ["']\.\/ShinyCard["']/);
  assert.doesNotMatch(leaderboard, /from ["']\.\/ShinyCard["']/);
  assert.doesNotMatch(shinyCard, /from ["']\.\.\/connection\/connection["']/);
  assert.doesNotMatch(shinyCard, /from ["']\.\.\/game\/board["']/);
  assert.doesNotMatch(islandView, /from ["']\.\.\/ProfileSignIn["']/);
  assert.doesNotMatch(nftService, /USE_STUB_RESPONSE|generateStubResponse/);
});
