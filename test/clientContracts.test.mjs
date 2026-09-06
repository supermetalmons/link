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

const {
  getCurrentRouteState,
  getCurrentViewUrl,
  getRoutePathForTarget,
  getRouteWithEventOverlay,
  isSameBackgroundRoute,
} = await import("../src/navigation/routeState.ts");
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

const withLocation = (path, read) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(path, "https://mons.link") },
  });
  try {
    return read();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
};

const readRoute = (path) => withLocation(path, getCurrentRouteState);

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

test("round-trips event overlays independently of the background route", () => {
  const eventId = "summer/round 1 + ☃&prize=gold";
  const targets = [
    routeTarget("home", { eventId }),
    routeTarget("watch", { eventId }),
    routeTarget("invite", { inviteId: "match-exact-1", eventId }),
    routeTarget("invite", {
      inviteId: "auto_ranked-exact-2",
      autojoin: true,
      eventId,
    }),
    routeTarget("snapshot", { snapshotId: "round/1 A", eventId }),
    routeTarget("event", { eventId }),
  ];

  for (const target of targets) {
    const route = readRoute(getRoutePathForTarget(target));
    assert.equal(route.mode, target.mode);
    assert.equal(route.eventId, eventId);
    assert.equal(route.inviteId, target.inviteId);
    assert.equal(route.snapshotId, target.snapshotId);
    assert.equal(route.autojoin, target.autojoin);
    assert.equal(isSameBackgroundRoute(route, target), true);
  }

  assert.equal(
    getRoutePathForTarget(
      routeTarget("invite", {
        inviteId: "match-exact-1",
        eventId: "summer-2026",
      }),
    ),
    "/match-exact-1?event=summer-2026",
  );
  assert.equal(
    getRoutePathForTarget(routeTarget("event", { eventId })),
    `/event/${encodeURIComponent(eventId)}`,
  );
});

test("treats blank overlay queries as closed and prioritizes legacy event paths", () => {
  for (const suffix of ["", "?event", "?event=", "?event=%20%20%09"]) {
    assert.equal(readRoute(`/match-1${suffix}`).eventId, null);
  }
  assert.equal(
    readRoute("/match-1?event=%20summer-2026%20").eventId,
    "summer-2026",
  );
  assert.equal(readRoute("/match-1?event=a%2Fb%2Bc%25").eventId, "a/b+c%");
  assert.equal(
    readRoute("/event/path-event?event=query-event").eventId,
    "path-event",
  );
  assert.equal(readRoute("/event/round%2F1%20A").eventId, "round/1 A");
  assert.equal(readRoute("/event/%E0%A4%A?event=query-event").eventId, null);
});

test("opening and closing overlays preserve match, watch, and snapshot backgrounds", () => {
  for (const path of [
    "/match-1",
    "/auto_ranked-2",
    "/watch",
    "/snapshot/round%2F1",
  ]) {
    const background = readRoute(path);
    const opened = getRouteWithEventOverlay(background, "event-a");
    const switched = getRouteWithEventOverlay(opened, "event-b");
    const closed = getRouteWithEventOverlay(switched, null);
    assert.deepEqual(opened, { ...background, eventId: "event-a" });
    assert.deepEqual(switched, { ...background, eventId: "event-b" });
    assert.deepEqual(closed, background);
    assert.equal(isSameBackgroundRoute(background, opened), true);
    assert.equal(isSameBackgroundRoute(opened, switched), true);
    assert.equal(isSameBackgroundRoute(switched, closed), true);
  }

  const lobby = readRoute("/");
  const lobbyEvent = getRouteWithEventOverlay(lobby, "round/1");
  assert.deepEqual(
    lobbyEvent,
    routeTarget("event", {
      path: "event/round%2F1",
      eventId: "round/1",
    }),
  );
  assert.equal(isSameBackgroundRoute(lobby, lobbyEvent), true);
  assert.deepEqual(getRouteWithEventOverlay(lobbyEvent, null), lobby);
  assert.equal(getRouteWithEventOverlay(lobbyEvent, "   ").mode, "home");
});

test("background comparison detects game, snapshot, watch, and autojoin changes", () => {
  const invite = readRoute("/match-1?event=a");
  assert.equal(
    isSameBackgroundRoute(invite, readRoute("/match-2?event=a")),
    false,
  );
  assert.equal(
    isSameBackgroundRoute(invite, { ...invite, autojoin: true }),
    false,
  );
  assert.equal(
    isSameBackgroundRoute(invite, readRoute("/watch?event=a")),
    false,
  );
  assert.equal(isSameBackgroundRoute(invite, readRoute("/event/a")), false);
  assert.equal(
    isSameBackgroundRoute(readRoute("/event/a"), readRoute("/watch")),
    false,
  );
  assert.equal(
    isSameBackgroundRoute(
      readRoute("/snapshot/one"),
      readRoute("/snapshot/two"),
    ),
    false,
  );
  assert.equal(
    isSameBackgroundRoute(readRoute("/snapshot/one"), readRoute("/one")),
    false,
  );
  assert.equal(
    isSameBackgroundRoute({ ...invite, path: "stale" }, invite),
    true,
  );
});

test("overlay URL changes preserve explicit query parameters and fragments", () => {
  const suffix = {
    search:
      "?callback=abc%2B123&event=old&filter=one&filter=two&event=duplicate",
    hash: "#round-3",
  };
  const background = readRoute("/match-1");
  const opened = getRouteWithEventOverlay(background, "new event");
  assert.equal(
    getRoutePathForTarget(opened, suffix),
    "/match-1?callback=abc%2B123&filter=one&filter=two&event=new+event#round-3",
  );
  assert.equal(
    getRoutePathForTarget(background, suffix),
    "/match-1?callback=abc%2B123&filter=one&filter=two#round-3",
  );
  assert.equal(
    getRoutePathForTarget(
      getRouteWithEventOverlay(readRoute("/"), "event-a"),
      suffix,
    ),
    "/event/event-a?callback=abc%2B123&filter=one&filter=two#round-3",
  );
  assert.equal(getRoutePathForTarget(opened), "/match-1?event=new+event");
});

test("share URLs restore the current overlay and exact background without callback parameters", () => {
  const paths = [
    "/match-exact-1?event=summer-2026",
    "/auto_ranked-exact-2?event=summer-2026",
    "/watch?event=summer-2026",
    "/snapshot/round%2F1?event=summer-2026",
    "/event/round%2F1",
    "/match-exact-1",
  ];

  for (const path of paths) {
    const incidental = `${path}${path.includes("?") ? "&" : "?"}callback=private#callback-fragment`;
    const shareUrl = withLocation(incidental, getCurrentViewUrl);
    assert.equal(shareUrl, `https://mons.link${path}`);
    assert.deepEqual(readRoute(shareUrl), readRoute(path));
  }
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
