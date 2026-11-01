import { required, canonicalAppearance } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { bindProfileCosmeticStorage } from "./fixtures/profileCosmeticStorageHarness.mjs";
import { isPlayerProfile } from "@mons/shared/profiles";
import { decodeEnsProfile } from "../src/utils/ensResolver.ts";

const path = new URL("../src/utils/playerMetadata.ts", import.meta.url);
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "updatePlayerMetadataWithProfile",
);
assert.ok(declaration && ts.isFunctionDeclaration(declaration));
assert.ok(declaration);
const { outputText } = ts.transpileModule(
  declaration.getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
/**
 * @typedef {import("@mons/shared/profiles").PlayerProfile} Profile
 * @typedef {typeof import("../src/utils/storage.ts").storage} StorageContract
 * @typedef {typeof import("../src/utils/playerMetadataRuntimePort.ts")} RuntimePort
 * @typedef {object} FixtureData
 * @property {Exclude<Parameters<StorageContract["setCardBackgroundId"]>[0], null>} [cardBackgroundId]
 * @property {Exclude<Parameters<StorageContract["setCardStickers"]>[0], null>} [cardStickers]
 * @property {Exclude<Parameters<StorageContract["setCardSubtitleId"]>[0], null>} [cardSubtitleId]
 * @property {Exclude<Parameters<StorageContract["setProfileCounter"]>[0], null>} [profileCounter]
 * @property {Exclude<Parameters<StorageContract["setProfileMons"]>[0], null>} [profileMons]
 * @property {Exclude<Parameters<StorageContract["setPlayerEmojiId"]>[0], null>} [playerEmojiId]
 * @property {Exclude<Parameters<StorageContract["setPlayerEmojiAura"]>[0], null>} [playerEmojiAura]
 * @property {Exclude<Parameters<StorageContract["setUsername"]>[0], null>} [username]
 * @property {Exclude<Parameters<StorageContract["setPlayerRating"]>[0], null>} [playerRating]
 * @property {Exclude<Parameters<StorageContract["setPlayerNonce"]>[0], null>} [playerNonce]
 * @property {Exclude<Parameters<StorageContract["setPlayerTotalManaPoints"]>[0], null>} [playerTotalManaPoints]
 * @property {Exclude<Parameters<StorageContract["setEthAddress"]>[0], null>} [ethAddress]
 * @property {Exclude<Parameters<StorageContract["setSolAddress"]>[0], null>} [solAddress]
 */
const cosmeticKeys = /** @type {const} */ ([
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
]);
/** @type {(keyof FixtureData)[]} */
const storageFields = [
  "cardBackgroundId",
  "cardStickers",
  "cardSubtitleId",
  "profileCounter",
  "profileMons",
  "playerEmojiId",
  "playerEmojiAura",
  "username",
  "playerRating",
  "playerNonce",
  "playerTotalManaPoints",
  "ethAddress",
  "solAddress",
];
/** @param {string} key @returns {key is keyof FixtureData} */
const isStorageField = (key) => storageFields.some((field) => field === key);
/** @param {unknown} value @returns {Response} */
function providerResponse(value) {
  const response = new Response();
  response.json = async () => value;
  return response;
}

/** @type {import("@mons/shared/profiles").CompletePlayerProfile} */
const fetchedProfile = {
  ...canonicalAppearance(),
  id: "profile",
  username: "Player",
  eth: null,
  sol: null,
  emoji: 1,
  aura: "none",
  rating: 1500,
  nonce: 1,
  totalManaPoints: 0,
  win: false,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};
/** @satisfies {Pick<import("@mons/shared/appearance").ProfileAppearance, typeof cosmeticKeys[number]>} */
const storedCosmetics = {
  cardBackgroundId: 8,
  cardStickers: { mana: "blue-mana" },
  cardSubtitleId: 4,
  profileCounter: "mp",
  profileMons: { demon: 1, angel: 1, drainer: 1, spirit: 1, mystic: 1 },
};
const flush = () => new Promise(setImmediate);

/** @param {{ watchOnly?: boolean, unreadableCosmetic?: string | null }} [options] */
function harness({ watchOnly = false, unreadableCosmetic = null } = {}) {
  /** @type {PromiseWithResolvers<Profile>} */
  const { promise: profileRead, resolve: finishProfile } =
    Promise.withResolvers();
  let currentSession = true;
  /** @type {FixtureData} */
  const data = { ...storedCosmetics };
  /** @type {{ displays: Parameters<RuntimePort["updatePlayerEmojiAndAura"]>[], writes: [keyof FixtureData, FixtureData[keyof FixtureData] | null][], completions: number, lookups: number, mining: Profile[], tutorials: Parameters<RuntimePort["syncPlayerTutorialProgress"]>[] }} */
  const events = {
    displays: [],
    writes: [],
    completions: 0,
    lookups: 0,
    mining: [],
    tutorials: [],
  };
  /** @type {Record<string, Partial<Profile>>} */
  const profiles = {};
  /** @satisfies {Pick<StorageContract, "setCardBackgroundId" | "setCardStickers" | "setCardSubtitleId" | "setProfileCounter" | "setProfileMons" | "setPlayerEmojiId" | "setPlayerEmojiAura" | "setUsername" | "setPlayerRating" | "setPlayerNonce" | "setPlayerTotalManaPoints" | "getEthAddress" | "getSolAddress">} */
  const storage = {
    setCardBackgroundId: (value) => {
      events.writes.push(["cardBackgroundId", value]);
      if (value === null) delete data.cardBackgroundId;
      else data.cardBackgroundId = value;
    },
    setCardStickers: (value) => {
      events.writes.push(["cardStickers", value]);
      if (value === null) delete data.cardStickers;
      else data.cardStickers = value;
    },
    setCardSubtitleId: (value) => {
      events.writes.push(["cardSubtitleId", value]);
      if (value === null) delete data.cardSubtitleId;
      else data.cardSubtitleId = value;
    },
    setProfileCounter: (value) => {
      events.writes.push(["profileCounter", value]);
      if (value === null) delete data.profileCounter;
      else data.profileCounter = value;
    },
    setProfileMons: (value) => {
      events.writes.push(["profileMons", value]);
      if (value === null) delete data.profileMons;
      else data.profileMons = value;
    },
    setPlayerEmojiId: (value) => {
      events.writes.push(["playerEmojiId", value]);
      if (value === null) delete data.playerEmojiId;
      else data.playerEmojiId = value;
    },
    setPlayerEmojiAura: (value) => {
      events.writes.push(["playerEmojiAura", value]);
      if (value === null) delete data.playerEmojiAura;
      else data.playerEmojiAura = value;
    },
    setUsername: (value) => {
      events.writes.push(["username", value]);
      if (value === null) delete data.username;
      else data.username = value;
    },
    setPlayerRating: (value) => {
      events.writes.push(["playerRating", value]);
      if (value === null) delete data.playerRating;
      else data.playerRating = value;
    },
    setPlayerNonce: (value) => {
      events.writes.push(["playerNonce", value]);
      if (value === null) delete data.playerNonce;
      else data.playerNonce = value;
    },
    setPlayerTotalManaPoints: (value) => {
      events.writes.push(["playerTotalManaPoints", value]);
      if (value === null) delete data.playerTotalManaPoints;
      else data.playerTotalManaPoints = value;
    },
    getEthAddress: (fallback) => data.ethAddress ?? fallback,
    getSolAddress: (fallback) => data.solAddress ?? fallback,
  };
  const dependencies = {
    decodeEnsProfile,
    createPlayerMetadataSessionGuard: () => () => currentSession,
    usernamesForUids: /** @type {Record<string, string>} */ ({}),
    ethAddressesForUids: /** @type {Record<string, string>} */ ({}),
    solAddressesForUids: /** @type {Record<string, string>} */ ({}),
    ensForUids:
      /** @type {Record<string, NonNullable<ReturnType<typeof decodeEnsProfile>>>} */ ({}),
    profilesForUids: profiles,
    getPlayerProfileByLoginId: () => {
      events.lookups++;
      return profileRead;
    },
    /** @type {RuntimePort["syncPlayerMiningState"]} */
    syncPlayerMiningState: (profile) => {
      events.mining.push(profile);
    },
    /** @type {RuntimePort["syncPlayerTutorialProgress"]} */
    syncPlayerTutorialProgress: (...args) => {
      events.tutorials.push(args);
    },
    isPlayerMetadataWatchOnly: () => watchOnly,
    updatePlayerProfileDisplayName: () => {},
    /** @type {RuntimePort["updatePlayerEmojiAndAura"]} */
    updatePlayerEmojiAndAura: (...args) => {
      events.displays.push(args);
    },
    storage,
    createProfileCosmeticWrites: bindProfileCosmeticStorage(storage, {
      getItem: (key) => {
        if (key === unreadableCosmetic) throw new Error("storage unavailable");
        return isStorageField(key) && key in data
          ? JSON.stringify(data[key])
          : null;
      },
    }),
  };
  const hydrate =
    /** @type {typeof import("../src/utils/playerMetadata.ts").updatePlayerMetadataWithProfile} */ (
      new Function(
        ...Object.keys(dependencies),
        `${outputText}\nreturn updatePlayerMetadataWithProfile;`,
      )(...Object.values(dependencies))
    );
  return {
    data,
    events,
    profiles,
    ens: dependencies.ensForUids,
    /** @param {Partial<Profile>} [profile] */
    hydrate: (profile = { username: "Player" }, own = true) => {
      const completed = () => {
        events.completions++;
      };
      if (isPlayerProfile(profile))
        return hydrate(profile, "actor", own, completed);
      return Reflect.apply(hydrate, undefined, [
        profile,
        "actor",
        own,
        completed,
      ]);
    },
    finishProfile,
    invalidate: () => {
      currentSession = false;
    },
  };
}

test("delayed profile hydration updates metadata without publishing stale match cosmetics", async () => {
  const h = harness();
  h.hydrate();
  assert.equal(h.events.completions, 0);
  assert.deepEqual(h.events.writes, []);
  h.finishProfile(fetchedProfile);
  await flush();
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.profiles.actor, fetchedProfile);
  assert.deepEqual(h.events.displays, [[1, "none", false]]);
  assert.deepEqual(h.events.mining, [fetchedProfile]);
  assert.deepEqual(h.events.tutorials, [[[], false]]);
  assert.equal(h.data.playerRating, 1500);
  assert.equal(h.data.playerNonce, 1);
  assert.equal(h.data.playerTotalManaPoints, 0);
});

test("fetched own profiles apply canonical defaults, zero and structured cosmetics", async () => {
  for (const cosmetics of [
    canonicalAppearance({
      cardBackgroundId: 0,
      cardStickers: {},
      cardSubtitleId: 0,
      profileCounter: "gp",
      profileMons: null,
    }),
    {},
  ]) {
    const h = harness();
    h.hydrate();
    h.finishProfile({ ...fetchedProfile, ...cosmetics });
    await flush();
    for (const key of cosmeticKeys) {
      const expected = { ...fetchedProfile, ...cosmetics }[key];
      assert.deepEqual(h.data[key], expected === null ? undefined : expected);
    }
    assert.equal(h.events.completions, 1);
  }
});

test("delayed cosmetics preserve newer edits while applying untouched fields", async () => {
  for (const cosmetics of [
    {},
    canonicalAppearance({
      cardBackgroundId: 0,
      cardStickers: {},
      cardSubtitleId: 0,
      profileCounter: "gp",
      profileMons: null,
    }),
    storedCosmetics,
  ]) {
    const h = harness();
    h.hydrate();
    h.data.cardBackgroundId = 9;
    h.data.cardStickers = { mana: "metal-mana" };
    h.finishProfile({ ...fetchedProfile, ...cosmetics });
    await flush();
    assert.equal(h.data.cardBackgroundId, 9);
    assert.deepEqual(h.data.cardStickers, { mana: "metal-mana" });
    for (const key of /** @type {const} */ ([
      "cardSubtitleId",
      "profileCounter",
      "profileMons",
    ])) {
      const expected = { ...fetchedProfile, ...cosmetics }[key];
      assert.deepEqual(h.data[key], expected === null ? undefined : expected);
    }
    assert.equal(h.events.completions, 1);
    assert.deepEqual(h.events.displays, [[1, "none", false]]);
  }
});

test("local zero, empty, and removed cosmetics survive an older populated response", async () => {
  const h = harness();
  h.hydrate();
  h.data.cardBackgroundId = 0;
  h.data.cardStickers = {};
  delete h.data.profileMons;
  h.finishProfile({ ...fetchedProfile, ...storedCosmetics });
  await flush();
  assert.equal(h.data.cardBackgroundId, 0);
  assert.deepEqual(h.data.cardStickers, {});
  assert.equal(h.data.profileMons, undefined);
  assert.equal(h.events.completions, 1);
});

test("an unreadable cosmetic baseline does not block profile hydration", async () => {
  const h = harness({ unreadableCosmetic: "cardBackgroundId" });
  assert.doesNotThrow(() => h.hydrate());
  h.finishProfile({
    ...fetchedProfile,
    cardBackgroundId: 0,
    cardSubtitleId: 0,
  });
  await flush();
  assert.equal(h.data.cardBackgroundId, storedCosmetics.cardBackgroundId);
  assert.equal(h.data.cardSubtitleId, 0);
  assert.deepEqual(h.data.cardStickers, {});
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.events.displays, [[1, "none", false]]);
});

test("the partial profile fast path leaves stored cosmetics untouched", () => {
  const h = harness();
  const profile = { username: "Player", rating: 1500, nonce: 1 };
  h.hydrate(profile);
  assert.equal(h.events.lookups, 0);
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.profiles.actor, profile);
  assert.deepEqual(h.data, storedCosmetics);
  assert.deepEqual(h.events.writes, []);
});

test("fetched opponent profiles do not replace own presentation storage", async () => {
  const h = harness();
  h.hydrate({ username: "Opponent" }, false);
  h.finishProfile(fetchedProfile);
  await flush();
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.profiles.actor, fetchedProfile);
  assert.deepEqual(h.data, storedCosmetics);
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.displays, []);
});

test("an invalidated session cannot apply delayed profile cosmetics", async () => {
  const h = harness();
  h.hydrate();
  h.invalidate();
  h.finishProfile(fetchedProfile);
  await flush();
  assert.equal(h.events.completions, 0);
  assert.deepEqual(h.profiles, {});
  assert.deepEqual(h.data, storedCosmetics);
  assert.deepEqual(h.events.writes, []);
  assert.deepEqual(h.events.displays, []);
});

test("watch-only hydration persists own cosmetics without changing board appearance", async () => {
  const h = harness({ watchOnly: true });
  h.hydrate();
  h.finishProfile(fetchedProfile);
  await flush();
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.events.displays, []);
  for (const key of cosmeticKeys) {
    const expected = fetchedProfile[key];
    assert.deepEqual(h.data[key], expected === null ? undefined : expected);
  }
});

test("ENS metadata decodes valid provider names and optional avatars without publishing malformed or stale replies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [
      value,
      expected,
    ] of /** @type {[unknown, ReturnType<typeof decodeEnsProfile> | undefined][]} */ ([
      [
        { name: "  player.eth  ", avatar: null },
        { name: "  player.eth  ", avatar: null },
      ],
      [{ name: "player.eth" }, { name: "player.eth" }],
      [{ name: "player.eth", avatar: 7 }, { name: "player.eth" }],
      [{ name: "   ", avatar: "ignored" }, undefined],
      [{ name: 7 }, undefined],
      [null, undefined],
    ])) {
      globalThis.fetch = async () => providerResponse(value);
      const h = harness();
      h.hydrate({ eth: "0xaddress", rating: 1500, nonce: 1 }, false);
      await flush();
      assert.deepEqual(h.ens.actor, expected);
      assert.equal(h.events.completions, expected ? 2 : 1);
    }
    /** @type {{ value?: ((value: Response | PromiseLike<Response>) => void) }} */
    const finish = {};
    globalThis.fetch = () =>
      new Promise((resolve) => {
        finish.value = resolve;
      });
    const h = harness();
    h.hydrate({ eth: "0xaddress", rating: 1500, nonce: 1 }, false);
    h.invalidate();
    required(finish.value)(providerResponse({ name: "late.eth" }));
    await flush();
    assert.deepEqual(h.ens, {});
    assert.equal(h.events.completions, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ENS metadata observes eligibility, stored names, and avatar in their original order", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [
      names,
      expected,
      expectedReads,
    ] of /** @type {[string[], ReturnType<typeof decodeEnsProfile> | undefined, string[]][]} */ ([
      [["first", " ", "third"], undefined, ["name", "name"]],
      [
        ["first", "second", " third "],
        { name: " third ", avatar: "avatar" },
        ["name", "name", "name", "avatar"],
      ],
    ])) {
      /** @type {(string)[]} */
      const reads = [];
      let index = 0;
      const value = {
        get name() {
          reads.push("name");
          return required(names)[index++];
        },
        get avatar() {
          reads.push("avatar");
          return "avatar";
        },
      };
      globalThis.fetch = async () => providerResponse(value);
      const h = harness();
      h.hydrate({ eth: "0xaddress", rating: 1500, nonce: 1 }, false);
      await flush();
      assert.deepEqual(h.ens.actor, expected);
      assert.deepEqual(reads, expectedReads);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
