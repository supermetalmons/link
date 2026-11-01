import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { FIXED_STICKER_IDS } from "@mons/shared/reactions";

registerTypeScriptTestHooks();

const {
  canSendSticker,
  EMPTY_STICKER_ENTITLEMENT,
  getStickerPickerState,
  getStickerRefreshResult,
  preferNewerStickerEntitlement,
  retainStickerEntitlementForOwner,
  toUsableStickerEntitlement,
} = await import("../src/ui/controls/reactionPickerModel.ts");
const { getNftIdentityKey, NFT_CACHE_TTL_MS } =
  await import("../src/services/nftService.ts");

const NOW = 10_000;
const IDENTITY = {
  profileId: "profile-a",
  ethAddress: "0x0000000000000000000000000000000000000001",
  solAddress: "11111111111111111111111111111111",
};
/** @type {import("../src/connection/authModels.ts").AuthState} */
const AUTH_STATE = { ...IDENTITY, authStatus: "authenticated" };
const OWNER_KEY = required(getNftIdentityKey(IDENTITY));
const OTHER_OWNER_KEY = required(
  getNftIdentityKey({
    ...IDENTITY,
    profileId: "profile-b",
  }),
);

/** @param {Partial<import("../src/utils/storage.ts").ReactionExtraStickerCache>} [overrides] @returns {import("../src/utils/storage.ts").ReactionExtraStickerCache} */
const cache = (overrides = {}) => ({
  ...IDENTITY,
  extraIds: [9, 17],
  expiresAtMs: NOW + NFT_CACHE_TTL_MS,
  ...overrides,
});

/** @param {number[]} [extraIds] @returns {{data: import("@mons/shared/nfts").NftApiResponse; expiresAtMs: number}} */
const snapshot = (
  extraIds = [9, 17],
  expiresAtMs = NOW + NFT_CACHE_TTL_MS,
) => ({
  data: {
    ok: true,
    specials: [],
    swagpack_avatars: [],
    swagpack_reactions: extraIds.map((id) => ({ id, count: 1 })),
  },
  expiresAtMs,
});

/** @param {Partial<Parameters<typeof getStickerRefreshResult>[0]>} [overrides] */
const refresh = (overrides = {}) =>
  getStickerRefreshResult({
    snapshot: snapshot(),
    authState: AUTH_STATE,
    storedOwnerKey: OWNER_KEY,
    cache: null,
    now: NOW,
    ...overrides,
  });

test("hydrates only supported extras after fixed stickers, preserving order without duplicates", () => {
  /** @type {unknown} */
  const entitlement = Reflect.apply(toUsableStickerEntitlement, undefined, [
    {
      ...cache(),
      extraIds: [17, 9, 17, 0, 1.5, "9", NaN, FIXED_STICKER_IDS[0]],
    },
    OWNER_KEY,
    NOW,
  ]);
  assert.deepEqual(entitlement, {
    stickerIds: [...FIXED_STICKER_IDS, 17, 9],
    ownerKey: OWNER_KEY,
    expiresAtMs: NOW + NFT_CACHE_TTL_MS,
  });
});

test("requires matching profile and both wallet addresses for persisted entitlement", () => {
  for (const overrides of [
    { profileId: "profile-b" },
    { ethAddress: "other-eth" },
    { solAddress: "other-sol" },
  ]) {
    assert.equal(
      toUsableStickerEntitlement(cache(overrides), OWNER_KEY, NOW),
      null,
    );
  }
  assert.equal(toUsableStickerEntitlement(null, OWNER_KEY, NOW), null);
});

test("rejects expired and excessively future cache timestamps at exact TTL boundaries", () => {
  for (const expiresAtMs of [
    0,
    NOW - 1,
    NOW,
    NOW + NFT_CACHE_TTL_MS + 1,
    NaN,
    Infinity,
  ]) {
    assert.equal(
      toUsableStickerEntitlement(cache({ expiresAtMs }), OWNER_KEY, NOW),
      null,
    );
  }
  for (const expiresAtMs of [NOW + 1, NOW + NFT_CACHE_TTL_MS]) {
    assert.equal(
      toUsableStickerEntitlement(cache({ expiresAtMs }), OWNER_KEY, NOW)
        ?.expiresAtMs,
      expiresAtMs,
    );
  }
});

test("retains same-owner extras through expiry and replaces them immediately for another owner", () => {
  const entitlement = required(
    toUsableStickerEntitlement(cache(), OWNER_KEY, NOW),
  );
  assert.equal(
    retainStickerEntitlementForOwner(entitlement, OWNER_KEY),
    entitlement,
  );
  assert.deepEqual(
    getStickerPickerState(
      entitlement,
      OWNER_KEY,
      required(entitlement).expiresAtMs,
    ),
    {
      visibleStickerIds: required(entitlement).stickerIds,
      hasFreshStickerEntitlement: false,
    },
  );
  for (const ownerKey of [OTHER_OWNER_KEY, null]) {
    assert.deepEqual(getStickerPickerState(entitlement, ownerKey, NOW), {
      visibleStickerIds: FIXED_STICKER_IDS,
      hasFreshStickerEntitlement: false,
    });
    assert.equal(
      retainStickerEntitlementForOwner(entitlement, ownerKey),
      EMPTY_STICKER_ENTITLEMENT,
    );
  }
  assert.equal(
    retainStickerEntitlementForOwner(EMPTY_STICKER_ENTITLEMENT, OWNER_KEY),
    EMPTY_STICKER_ENTITLEMENT,
  );
});

test("never downgrades newer in-memory entitlement for the same owner", () => {
  const current = required(toUsableStickerEntitlement(cache(), OWNER_KEY, NOW));
  const older = {
    ...current,
    stickerIds: FIXED_STICKER_IDS,
    expiresAtMs: NOW + 1,
  };
  assert.equal(preferNewerStickerEntitlement(current, older), current);
  const equalExpiry = { ...current, stickerIds: [...FIXED_STICKER_IDS, 20] };
  assert.equal(
    preferNewerStickerEntitlement(current, equalExpiry),
    equalExpiry,
  );
  const otherOwner = { ...older, ownerKey: OTHER_OWNER_KEY };
  assert.equal(preferNewerStickerEntitlement(current, otherOwner), otherOwner);
});

test("rejects failed, expired, reset, and stale-owner refresh results", () => {
  /** @type {Array<Partial<Parameters<typeof getStickerRefreshResult>[0]>>} */
  const cases = [
    { snapshot: { data: { ok: false }, expiresAtMs: NOW + 1 } },
    { snapshot: snapshot([9], NOW) },
    { snapshot: snapshot([9], 0) },
    { storedOwnerKey: OTHER_OWNER_KEY },
    { storedOwnerKey: null },
    { authState: { ...AUTH_STATE, authStatus: "loading" } },
    { authState: { ...AUTH_STATE, authStatus: "unauthenticated" } },
    { authState: { ...AUTH_STATE, profileId: "" } },
  ];
  for (const overrides of cases) {
    assert.equal(refresh(overrides), null);
  }
});

test("prefers a newer persisted cache to an arriving response without rewriting it", () => {
  const currentCache = cache({ extraIds: [20] });
  const result = refresh({
    cache: currentCache,
    snapshot: snapshot([9], NOW + 1),
  });
  assert.deepEqual(result, {
    entitlement: toUsableStickerEntitlement(currentCache, OWNER_KEY, NOW),
    cacheToWrite: null,
  });
});

test("persists refreshed inventory with its original expiry and full owner identity", () => {
  const expiresAtMs = NOW + 500;
  const result = refresh({ snapshot: snapshot([17, 9, 17, -1], expiresAtMs) });
  assert.deepEqual(result, {
    entitlement: {
      stickerIds: [...FIXED_STICKER_IDS, 17, 9],
      ownerKey: OWNER_KEY,
      expiresAtMs,
    },
    cacheToWrite: { ...IDENTITY, extraIds: [17, 9, 17], expiresAtMs },
  });
});

test("treats a missing or non-array reaction list as empty inventory", () => {
  for (const reactions of [undefined, null, {}]) {
    const current = snapshot();
    const incoming = {
      ...current,
      data: { ...current.data, swagpack_reactions: reactions },
    };
    /** @type {unknown} */
    const result = Reflect.apply(refresh, undefined, [{ snapshot: incoming }]);
    assert.deepEqual(
      fixtureField(fixtureField(result, "entitlement"), "stickerIds"),
      FIXED_STICKER_IDS,
    );
    assert.deepEqual(
      fixtureField(fixtureField(result, "cacheToWrite"), "extraIds"),
      [],
    );
  }
});

test("avoids redundant writes but persists changed IDs, order, expiry, or owner", () => {
  assert.equal(required(refresh({ cache: cache() })).cacheToWrite, null);
  assert.equal(
    required(refresh({ cache: cache({ extraIds: [9, -1, 17] }) })).cacheToWrite,
    null,
  );
  for (const currentCache of [
    cache({ extraIds: [17, 9] }),
    cache({ extraIds: [9, 20] }),
    cache({ expiresAtMs: NOW + 1 }),
    cache({ profileId: "profile-b" }),
  ]) {
    assert.deepEqual(
      required(refresh({ cache: currentCache })).cacheToWrite,
      cache(),
    );
  }
});

test("fixed stickers remain eligible without owner, inventory, or fresh entitlement", () => {
  for (const stickerId of FIXED_STICKER_IDS) {
    assert.equal(
      canSendSticker(
        stickerId,
        EMPTY_STICKER_ENTITLEMENT,
        null,
        () => null,
        NOW,
      ),
      true,
    );
  }
});

test("checks extra ownership, current storage identity, and expiry at send time", () => {
  const entitlement = required(
    toUsableStickerEntitlement(cache(), OWNER_KEY, NOW),
  );
  assert.equal(
    canSendSticker(9, entitlement, OWNER_KEY, () => OWNER_KEY, NOW),
    true,
  );
  assert.equal(
    canSendSticker(
      9,
      entitlement,
      OWNER_KEY,
      () => OWNER_KEY,
      required(entitlement).expiresAtMs,
    ),
    false,
  );
  /** @type {Array<[number, string | null, string | null]>} */
  const cases = [
    [20, OWNER_KEY, OWNER_KEY],
    [-1, OWNER_KEY, OWNER_KEY],
    [9, OTHER_OWNER_KEY, OTHER_OWNER_KEY],
    [9, OWNER_KEY, OTHER_OWNER_KEY],
    [9, OWNER_KEY, null],
    [9, null, OWNER_KEY],
  ];
  for (const [id, currentOwner, storedOwner] of cases) {
    assert.equal(
      canSendSticker(id, entitlement, currentOwner, () => storedOwner, NOW),
      false,
    );
  }
});

test("rejects invalid local entitlement before reading stored identity", () => {
  const entitlement = required(
    toUsableStickerEntitlement(cache(), OWNER_KEY, NOW),
  );
  const unreadableIdentity = () => {
    throw new Error("storage unavailable");
  };
  /** @type {Array<[import("../src/ui/controls/reactionPickerModel.ts").StickerEntitlementState, string | null, number]>} */
  const cases = [
    [entitlement, null, NOW],
    [entitlement, OTHER_OWNER_KEY, NOW],
    [EMPTY_STICKER_ENTITLEMENT, OWNER_KEY, NOW],
    [{ ...entitlement, stickerIds: FIXED_STICKER_IDS }, OWNER_KEY, NOW],
    [entitlement, OWNER_KEY, required(entitlement).expiresAtMs],
  ];
  for (const [current, owner, now] of cases) {
    assert.equal(
      canSendSticker(9, current, owner, unreadableIdentity, now),
      false,
    );
  }
  assert.equal(
    canSendSticker(
      required(FIXED_STICKER_IDS[0]),
      entitlement,
      OWNER_KEY,
      unreadableIdentity,
      NOW,
    ),
    true,
  );
});

/** @param {unknown} value @param {string} key @returns {unknown} */
function fixtureField(value, key) {
  assert.ok(value !== null && typeof value === "object" && key in value);
  return Reflect.get(value, key);
}
