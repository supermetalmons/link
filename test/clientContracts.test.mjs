import assert from "node:assert/strict";
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

const { getCurrentRouteState, getRoutePathForTarget } =
  await import("../src/navigation/routeState.ts");
const {
  buildDeterministicGameSeed,
  buildGameSeedForStoredVariant,
  buildRandomGameSeed,
  getAllGameVariantNames,
  getStoredGameVariantForPersistence,
  legacyDefaultGameVariant,
  normalizeStoredGameVariant,
} = await import("../src/game/gameVariants.ts");
const { compareNavigationItems } =
  await import("../src/services/navigationItemOrdering.ts");
const { shouldPreserveStorageKeyOnLogout } =
  await import("../src/utils/storage.ts");

const GAME_VARIANTS = [
  "Classic",
  "SwappedManaRows",
  "OffsetArcManaRows",
  "CenterSpokeManaRows",
  "AlternatingManaRows",
  "InnerWedgeManaRows",
  "OuterWedgeManaRows",
  "BentCenterManaRows",
  "OuterEdgeManaRows",
  "SplitFlankManaRows",
  "ForwardBridgeManaRows",
  "CornerChainManaRows",
];

const CLASSIC_FEN =
  "0 0 w 0 0 0 0 0 1 n03y0xs0xd0xa0xe0xn03/n11/n11/n04xxmn01xxmn04/n03xxmn01xxmn01xxmn03/xxQn04xxUn04xxQ/n03xxMn01xxMn01xxMn03/n04xxMn01xxMn04/n11/n11/n03E0xA0xD0xS0xY0xn03";

const routeTarget = (mode, values = {}) => ({
  mode,
  path: "",
  inviteId: null,
  snapshotId: null,
  eventId: null,
  autojoin: false,
  ...values,
});

const readRoute = (pathname) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname } },
  });
  try {
    return getCurrentRouteState();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
};

test("parses canonical client routes and auto-invite intent", () => {
  assert.deepEqual(readRoute("/"), routeTarget("home"));
  assert.deepEqual(
    readRoute("/watch/"),
    routeTarget("watch", { path: "watch" }),
  );
  assert.deepEqual(
    readRoute("/event/summer-2026/"),
    routeTarget("event", {
      path: "event/summer-2026",
      eventId: "summer-2026",
    }),
  );
  assert.deepEqual(
    readRoute("/snapshot/round%2F1%20A/"),
    routeTarget("snapshot", {
      path: "snapshot/round%2F1%20A",
      snapshotId: "round/1 A",
    }),
  );
  assert.deepEqual(
    readRoute("/auto_ranked-1/"),
    routeTarget("invite", {
      path: "auto_ranked-1",
      inviteId: "auto_ranked-1",
      autojoin: true,
    }),
  );
  assert.deepEqual(
    readRoute("/friendly-match/"),
    routeTarget("invite", {
      path: "friendly-match",
      inviteId: "friendly-match",
    }),
  );
});

test("builds canonical route paths and safely rejects malformed snapshots", () => {
  const targets = [
    [routeTarget("home"), "/"],
    [routeTarget("watch"), "/watch"],
    [routeTarget("event", { eventId: "summer-2026" }), "/event/summer-2026"],
    [
      routeTarget("snapshot", { snapshotId: "round/1 ☃" }),
      "/snapshot/round%2F1%20%E2%98%83",
    ],
    [routeTarget("invite", { inviteId: "match-1" }), "/match-1"],
  ];

  for (const [target, expectedPath] of targets) {
    assert.equal(getRoutePathForTarget(target), expectedPath);
  }

  assert.deepEqual(
    readRoute("/snapshot/%E0%A4%A/"),
    routeTarget("snapshot", {
      path: "snapshot/%E0%A4%A",
      snapshotId: null,
    }),
  );
});

test("keeps stored game-variant normalization and persistence compatible", () => {
  assert.equal(legacyDefaultGameVariant, "Classic");
  assert.deepEqual(getAllGameVariantNames(), GAME_VARIANTS);
  assert.equal(
    normalizeStoredGameVariant("  OuterWedgeManaRows  "),
    "OuterWedgeManaRows",
  );
  assert.equal(normalizeStoredGameVariant("future-variant"), "Classic");
  assert.equal(normalizeStoredGameVariant(null), "Classic");
  assert.equal(
    getStoredGameVariantForPersistence("  future-variant  "),
    "future-variant",
  );
  assert.equal(getStoredGameVariantForPersistence("  "), "Classic");
  assert.equal(getStoredGameVariantForPersistence(null), "Classic");
});

test("builds stable deterministic and random game seeds", () => {
  assert.deepEqual(buildGameSeedForStoredVariant("Classic"), {
    gameVariant: "Classic",
    fen: CLASSIC_FEN,
  });

  const first = buildDeterministicGameSeed("alpha");
  assert.deepEqual(buildDeterministicGameSeed("alpha"), first);
  assert.equal(first.gameVariant, "CornerChainManaRows");
  assert.notDeepEqual(buildDeterministicGameSeed("beta"), first);

  let randomCalls = 0;
  const randomSeed = buildRandomGameSeed(() => {
    randomCalls += 1;
    return 0.5;
  });
  assert.equal(randomCalls, 1);
  assert.equal(randomSeed.gameVariant, "OuterWedgeManaRows");
});

test("orders navigation items by status, bucket, recency, then id", () => {
  const items = [
    { id: "ended", status: "ended", sortBucket: 0, listSortAtMs: 999 },
    { id: "active", status: "active", sortBucket: 0, listSortAtMs: 999 },
    { id: "b", status: "waiting", sortBucket: 30, listSortAtMs: 100 },
    { id: "new", status: "waiting", sortBucket: 30, listSortAtMs: 200 },
    { id: "a", status: "waiting", sortBucket: 30, listSortAtMs: 100 },
    { id: "lower-bucket", status: "waiting", sortBucket: 20, listSortAtMs: 0 },
    { id: "pending", status: "pending", sortBucket: 999, listSortAtMs: 0 },
  ];
  const originalIds = items.map(({ id }) => id);

  const sortedIds = [...items].sort(compareNavigationItems).map(({ id }) => id);

  assert.deepEqual(sortedIds, [
    "pending",
    "lower-bucket",
    "new",
    "a",
    "b",
    "active",
    "ended",
  ]);
  assert.deepEqual(
    items.map(({ id }) => id),
    originalIds,
  );
});

test("preserves only the mute preference during logout", () => {
  assert.equal(shouldPreserveStorageKeyOnLogout("isMuted"), true);
  for (const key of [
    "profileId",
    "preferredAssetsSet",
    "tutorialCompleted",
    "walletconnect",
    "IsMuted",
    "",
  ]) {
    assert.equal(shouldPreserveStorageKeyOnLogout(key), false);
  }
});
