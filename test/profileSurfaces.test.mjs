import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";

registerTypeScriptTestHooks();

const {
  ProfileScopedUndoHistory,
  getNextRegularId,
  getShinyCardUndoEntry,
  getShinyCardUndoUpdateSource,
  isInventoryEmojiId,
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
const {
  createLeaderboardEntry,
  getLeaderboardDisplayName,
  populateMaterialLeaderboardCaches,
} = await import("../src/ui/leaderboardModels.ts");

const readSource = (/** @type {string | URL} */ relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("shiny card UI port exposes state and forwards every public command", async () => {
  /** @type {((string | boolean | import("@mons/shared/profiles").PlayerProfile | null)[] | string[] | (string | number)[])[]} */
  const calls = [];
  const selection = { avatarId: 9, specialIds: new Set([1, 2]) };
  const dispose = bindShinyCardUi({
    show: async (...args) => {
      calls.push(["show", ...args]);
    },
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
  history.enqueue("one", "one", { contentType: "bg", value: 7 });
  history.enqueue("two", "one", { contentType: "bg", value: 8 });
  assert.equal(history.size, 1);
  assert.deepEqual(history.pop("one"), { contentType: "bg", value: 7 });

  history.enqueue("one", "one", { contentType: "subtitle", value: 4 });
  history.synchronize("two");
  assert.equal(history.size, 0);
  assert.equal(history.pop("two"), undefined);
});

test("card history retains absent sticker values and rejects anonymous or stale owners", () => {
  const history = new ProfileScopedUndoHistory();
  history.enqueue(null, null, { contentType: "bg", value: 7 });
  assert.equal(history.size, 0);

  history.enqueue("one", "one", { contentType: "mana", value: undefined });
  Reflect.apply(history.enqueue, history, [
    "one",
    "one",
    {
      contentType: "profileCounter",
      value: "legacy-counter",
    },
  ]);
  assert.deepEqual(history.pop("one"), {
    contentType: "profileCounter",
    value: "legacy-counter",
  });
  assert.deepEqual(history.pop("one"), {
    contentType: "mana",
    value: undefined,
  });
  assert.equal(history.pop("one"), undefined);

  history.enqueue("one", "one", { contentType: "bg", value: 7 });
  history.enqueue("one", "two", { contentType: "subtitle", value: 4 });
  assert.equal(history.size, 0);
  history.enqueue("two", "two", { contentType: "bg", value: 9 });
  history.synchronize(null);
  assert.equal(history.pop("two"), undefined);
  assert.equal(history.pop("one"), undefined);
});

test("explicit undo intent distinguishes recorded absence from skipped history", () => {
  /** @type {import("@mons/shared/game-sessions").GameSessionPresentation} */
  const oldEmoji = { emojiId: 1009, aura: "rainbow" };
  const restoredEmoji = getShinyCardUndoEntry({
    contentType: "emojiAndAura",
    value: { emojiId: 1, aura: "none" },
    undo: { kind: "record", value: oldEmoji },
  });
  assert.deepEqual(restoredEmoji, {
    contentType: "emojiAndAura",
    value: oldEmoji,
  });
  assert.strictEqual(restoredEmoji.value, oldEmoji);
  assert.deepEqual(
    getShinyCardUndoEntry({
      contentType: "mana",
      value: "blue-mana",
      undo: { kind: "record", value: undefined },
    }),
    { contentType: "mana", value: undefined },
  );
  assert.equal(
    getShinyCardUndoEntry({
      contentType: "mana",
      value: undefined,
      undo: { kind: "skip" },
    }),
    null,
  );
});

test("shiny card selectors preserve inventory and cyclic rules", () => {
  assert.equal(isInventoryEmojiId(1000, 1000), true);
  assert.equal(isInventoryEmojiId(999, 1000), false);
  assert.equal(
    Reflect.apply(isInventoryEmojiId, undefined, ["1000", 1000]),
    false,
  );
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
      { contentType: "emojiAndAura", value: { emojiId: 1001, aura: "none" } },
      options,
    ),
    "inventory",
  );
  assert.equal(
    getShinyCardUndoUpdateSource({ contentType: "bg", value: 100 }, options),
    "inventory",
  );
  assert.equal(
    getShinyCardUndoUpdateSource({ contentType: "bg", value: 4 }, options),
    "default",
  );
});

test("card undo permission preserves canonical inventory and restoration values", () => {
  const options = {
    inventoryEmojiStartId: 1000,
    inventoryBackgroundId: 100,
    inventoryDrainerId: 5,
    inventoryStickerType: "big-mon-top-right",
    inventoryStickerName: "gate",
  };
  for (const [
    change,
    expected,
  ] of /** @type {[Parameters<typeof getShinyCardUndoUpdateSource>[0], string][]} */ ([
    [
      { contentType: "emojiAndAura", value: { emojiId: 1009, aura: "none" } },
      "inventory",
    ],
    [
      { contentType: "emojiAndAura", value: { emojiId: 1, aura: "rainbow" } },
      "inventory",
    ],
    [
      { contentType: "emojiAndAura", value: { emojiId: 1, aura: "none" } },
      "default",
    ],
    [{ contentType: "bg", value: 100 }, "inventory"],
    [{ contentType: "drainer", value: 5 }, "inventory"],
    [{ contentType: "drainer", value: 0 }, "default"],
    [{ contentType: "big-mon-top-right", value: "gate" }, "inventory"],
    [{ contentType: "big-mon-top-right", value: undefined }, "default"],
    [{ contentType: "mana", value: "blue-mana" }, "default"],
    [{ contentType: "profileCounter", value: "gp" }, "default"],
  ])) {
    assert.equal(getShinyCardUndoUpdateSource(change, options), expected);
  }
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
  /** @type {ReturnType<typeof createLeaderboardEntry>} */
  const entry = Reflect.apply(createLeaderboardEntry, undefined, [profile]);
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

test("material leaderboard warming deduplicates and caps missing rankings while preserving existing caches", () => {
  /** @type {ReturnType<typeof createLeaderboardEntry>[]} */
  const entries = Array.from({ length: 105 }, (_, index) =>
    Reflect.apply(createLeaderboardEntry, undefined, [
      {
        id: `profile-${index}`,
        emoji: 7,
        mining: { materials: { slime: index } },
      },
    ]),
  );
  entries.push(
    Reflect.apply(createLeaderboardEntry, undefined, [
      {
        id: "profile-0",
        emoji: 7,
        mining: { materials: { slime: 200 } },
      },
    ]),
  );
  /** @type {ReturnType<typeof createLeaderboardEntry>[]} */
  const existing = [
    Reflect.apply(createLeaderboardEntry, undefined, [
      { id: "existing", emoji: 7 },
    ]),
  ];
  /** @type {Parameters<typeof populateMaterialLeaderboardCaches>[0]} */
  const cache = new Map([
    ["dust", existing],
    ["rating", existing],
  ]);
  const originalOrder = entries.map((entry) => entry.id);

  populateMaterialLeaderboardCaches(cache, entries);

  const expected = [
    "profile-0",
    ...Array.from({ length: 98 }, (_, index) => `profile-${104 - index}`),
  ];
  assert.deepEqual(
    required(cache.get("slime")).map((entry) => entry.id),
    expected,
  );
  assert.deepEqual(
    required(cache.get("total")).map((entry) => entry.id),
    expected,
  );
  assert.equal(required(required(cache.get("slime"))[0]).materials.slime, 200);
  assert.strictEqual(cache.get("dust"), existing);
  assert.strictEqual(cache.get("rating"), existing);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    originalOrder,
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

test("top-right controls own their surfaces independently of the main menu", () => {
  const mainMenu = readSource("../src/ui/MainMenu.tsx");
  const topRightControls = readSource("../src/ui/TopRightControls.tsx");
  const popoverHook = readSource("../src/ui/controls/useTopRightPopover.ts");
  const topRightPort = readSource("../src/ui/controls/topRightControlsPort.ts");

  assert.match(
    topRightControls,
    /from ["']\.\/controls\/useTopRightPopover["']/,
  );
  assert.match(topRightControls, /useTopRightPopover\(/);
  assert.doesNotMatch(
    mainMenu,
    /activeTopRightPopover|TOP_RIGHT_CONTROL_IDS|TOP_RIGHT_POPOVER_IDS|FOCUS_CLAIMING_TARGET_SELECTOR/,
  );
  assert.doesNotMatch(
    mainMenu,
    /const (?:TopRightPopover|MorePopover|MoreHelpContent|MoreActions|MoreActionButton|MusicPopover|MusicControlsContainer|MusicControlsSeparator|MusicControlButton)\b/,
  );
  assert.doesNotMatch(
    mainMenu,
    /from ["']\.\/(?:TopRightControls|InventoryModal|InfoPopover|TopRightPopoverBase)["']/,
  );
  for (const source of [topRightControls, popoverHook]) {
    assert.doesNotMatch(source, /from ["'][^"']*MainMenu["']/);
    assert.doesNotMatch(source, /from ["'][^"']*connection\/connection["']/);
    assert.doesNotMatch(
      source,
      /from ["'][^"']*game\/(?:board|gameController)["']/,
    );
  }
  assert.doesNotMatch(topRightPort, /\bimport\s*(?:[\s{*"']|\()/);
  assert.doesNotMatch(topRightPort, /\bexport\s+[^;]*\bfrom\s*["']/);
});
