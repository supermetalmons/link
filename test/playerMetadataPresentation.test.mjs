import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { bindProfileCosmeticStorage } from "./fixtures/profileCosmeticStorageHarness.mjs";
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
assert.ok(declaration);
const { outputText } = ts.transpileModule(
  declaration.getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const fetchedProfile = {
  id: "profile",
  username: "Player",
  eth: null,
  sol: null,
  emoji: "1",
  aura: "",
  rating: 1500,
  nonce: 1,
  totalManaPoints: 0,
  win: false,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};
const storedCosmetics = {
  cardBackgroundId: 8,
  cardStickers: '{"mana":"blue-mana"}',
  cardSubtitleId: 4,
  profileCounter: "mp",
  profileMons: "1,1,1,1,1",
};
const flush = () => new Promise(setImmediate);

function harness({ watchOnly = false, unreadableCosmetic = null } = {}) {
  let finishProfile;
  let currentSession = true;
  const profileRead = new Promise((resolve) => (finishProfile = resolve));
  const data = { ...storedCosmetics };
  const events = {
    displays: [],
    writes: [],
    completions: 0,
    lookups: 0,
    mining: [],
    tutorials: [],
  };
  const profiles = {};
  const storage = new Proxy(
    {},
    {
      get: (_target, key) => {
        const field = key[3].toLowerCase() + key.slice(4);
        if (key.startsWith("get")) {
          return (fallback) => data[field] ?? fallback;
        }
        return (value) => {
          events.writes.push([field, value]);
          if (value === null) delete data[field];
          else data[field] = value;
        };
      },
    },
  );
  const dependencies = {
    decodeEnsProfile,
    createPlayerMetadataSessionGuard: () => () => currentSession,
    usernamesForUids: {},
    ethAddressesForUids: {},
    solAddressesForUids: {},
    ensForUids: {},
    profilesForUids: profiles,
    getPlayerProfileByLoginId: () => {
      events.lookups++;
      return profileRead;
    },
    syncPlayerMiningState: (profile) => events.mining.push(profile),
    syncPlayerTutorialProgress: (...args) => events.tutorials.push(args),
    isPlayerMetadataWatchOnly: () => watchOnly,
    updatePlayerProfileDisplayName: () => {},
    updatePlayerEmojiAndAura: (...args) => events.displays.push(args),
    storage,
    createProfileCosmeticWrites: bindProfileCosmeticStorage(storage, {
      getItem: (key) => {
        if (key === unreadableCosmetic) throw new Error("storage unavailable");
        return key in data ? String(data[key]) : null;
      },
    }),
  };
  const hydrate = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn updatePlayerMetadataWithProfile;`,
  )(...Object.values(dependencies));
  return {
    data,
    events,
    profiles,
    ens: dependencies.ensForUids,
    hydrate: (profile = { username: "Player" }, own = true) =>
      hydrate(profile, "actor", own, () => events.completions++),
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
  assert.deepEqual(h.events.displays, [["1", "", false]]);
  assert.deepEqual(h.events.mining, [fetchedProfile]);
  assert.deepEqual(h.events.tutorials, [[[], false]]);
  assert.equal(h.data.playerRating, 1500);
  assert.equal(h.data.playerNonce, 1);
  assert.equal(h.data.playerTotalManaPoints, 0);
});

test("fetched own profiles apply zero and empty cosmetics and clear omitted cosmetics", async () => {
  for (const cosmetics of [
    {
      cardBackgroundId: 0,
      cardStickers: "",
      cardSubtitleId: 0,
      profileCounter: "gp",
      profileMons: "",
    },
    {},
  ]) {
    const h = harness();
    h.hydrate();
    h.finishProfile({ ...fetchedProfile, ...cosmetics });
    await flush();
    for (const key of Object.keys(storedCosmetics)) {
      assert.equal(h.data[key], cosmetics[key]);
    }
    assert.equal(h.events.completions, 1);
  }
});

test("delayed cosmetics preserve newer edits while applying untouched fields", async () => {
  for (const cosmetics of [
    {},
    {
      cardBackgroundId: 0,
      cardStickers: "",
      cardSubtitleId: 0,
      profileCounter: "gp",
      profileMons: "",
    },
    storedCosmetics,
  ]) {
    const h = harness();
    h.hydrate();
    h.data.cardBackgroundId = 9;
    h.data.cardStickers = '{"mana":"new-sticker"}';
    h.finishProfile({ ...fetchedProfile, ...cosmetics });
    await flush();
    assert.equal(h.data.cardBackgroundId, 9);
    assert.equal(h.data.cardStickers, '{"mana":"new-sticker"}');
    for (const key of ["cardSubtitleId", "profileCounter", "profileMons"]) {
      assert.equal(h.data[key], cosmetics[key]);
    }
    assert.equal(h.events.completions, 1);
    assert.deepEqual(h.events.displays, [["1", "", false]]);
  }
});

test("local zero, empty, and removed cosmetics survive an older populated response", async () => {
  const h = harness();
  h.hydrate();
  h.data.cardBackgroundId = 0;
  h.data.cardStickers = "";
  delete h.data.profileMons;
  h.finishProfile({ ...fetchedProfile, ...storedCosmetics });
  await flush();
  assert.equal(h.data.cardBackgroundId, 0);
  assert.equal(h.data.cardStickers, "");
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
  assert.equal(h.data.cardStickers, undefined);
  assert.equal(h.events.completions, 1);
  assert.deepEqual(h.events.displays, [["1", "", false]]);
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
  for (const key of Object.keys(storedCosmetics)) {
    assert.equal(h.data[key], undefined);
  }
});

test("ENS metadata decodes valid provider names and optional avatars without publishing malformed or stale replies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [value, expected] of [
      [
        { name: "  player.eth  ", avatar: null },
        { name: "  player.eth  ", avatar: null },
      ],
      [{ name: "player.eth" }, { name: "player.eth", avatar: undefined }],
      [
        { name: "player.eth", avatar: 7 },
        { name: "player.eth", avatar: undefined },
      ],
      [{ name: "   ", avatar: "ignored" }, undefined],
      [{ name: 7 }, undefined],
      [null, undefined],
    ]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => value });
      const h = harness();
      h.hydrate({ eth: "0xaddress", rating: 1500, nonce: 1 }, false);
      await flush();
      assert.deepEqual(h.ens.actor, expected);
      assert.equal(h.events.completions, expected ? 2 : 1);
    }
    let finish;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const h = harness();
    h.hydrate({ eth: "0xaddress", rating: 1500, nonce: 1 }, false);
    h.invalidate();
    finish({ ok: true, json: async () => ({ name: "late.eth" }) });
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
    for (const [names, expected, expectedReads] of [
      [["first", " ", "third"], undefined, ["name", "name"]],
      [
        ["first", "second", " third "],
        { name: " third ", avatar: "avatar" },
        ["name", "name", "name", "avatar"],
      ],
    ]) {
      const reads = [];
      let index = 0;
      const value = {
        get name() {
          reads.push("name");
          return names[index++];
        },
        get avatar() {
          reads.push("avatar");
          return "avatar";
        },
      };
      globalThis.fetch = async () => ({ ok: true, json: async () => value });
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
