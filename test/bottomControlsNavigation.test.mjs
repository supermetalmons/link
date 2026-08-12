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
  PrimaryActionType,
  bindBottomControlsApi,
  hasBottomPopupsVisible,
  hasNavigationPopupVisible,
  setAutomatchEnabled,
  setWagerPanelOutsideTapHandler,
  setWagerPanelVisibilityChecker,
  showPrimaryAction,
  unbindBottomControlsApi,
  isWagerPanelVisible,
  handleWagerPanelOutsideTap,
  resetWagerPanelApi,
} = await import("../src/ui/controls/bottomControlsPort.ts");
const {
  CANCEL_AUTOMATCH_REVEAL_DELAY_MS,
  NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS,
  didOutsideTapDismissWindowPass,
  getCancelAutomatchRevealDeadlineMs,
  getOutsideTapDismissThresholdMs,
  getTimerEnableDelayMs,
  hasControlDeadlineElapsed,
  rewindOutsideTapDismissedAtForReset,
} = await import("../src/ui/controls/controlTiming.ts");
const {
  isMoveHistoryPopupFollowingLatest,
  setMoveHistoryPopupFollowingLatest,
  setMoveHistoryPopupState,
  subscribeMoveHistoryPopupReload,
  subscribeMoveHistoryPopupSelectionReset,
  triggerMoveHistoryPopupReload,
  triggerMoveHistoryPopupSelectionReset,
} = await import("../src/ui/controls/moveHistoryPopupStore.ts");
const {
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
  writeNavigationGamesPersistedTopCache,
  writeNavigationGamesRuntimeCache,
} = await import("../src/services/navigationGamesCache.ts");

test("bottom controls port forwards the current binding and preserves rematch actions", () => {
  const events = [];
  const first = {
    setAutomatchEnabled: (enabled) => events.push(["first", enabled]),
  };
  const second = {
    setAutomatchEnabled: (enabled) => events.push(["second", enabled]),
    hasBottomPopupsVisible: () => true,
    hasNavigationPopupVisible: () => true,
    showPrimaryAction: (action) => events.push(["action", action]),
  };

  bindBottomControlsApi(first);
  bindBottomControlsApi(second);
  unbindBottomControlsApi(first);
  setAutomatchEnabled(false);
  showPrimaryAction(PrimaryActionType.Rematch);

  assert.deepEqual(events, [
    ["second", false],
    ["action", "rematch"],
  ]);
  assert.equal(hasBottomPopupsVisible(), true);
  assert.equal(hasNavigationPopupVisible(), true);

  unbindBottomControlsApi(second);
  assert.equal(hasBottomPopupsVisible(), false);
  assert.equal(hasNavigationPopupVisible(), false);
  assert.doesNotThrow(() => setAutomatchEnabled(true));
});

test("wager outside-tap registration remains independently replaceable", () => {
  resetWagerPanelApi();
  assert.equal(isWagerPanelVisible(), false);
  assert.equal(handleWagerPanelOutsideTap({}), false);

  let handled = 0;
  setWagerPanelVisibilityChecker(() => true);
  setWagerPanelOutsideTapHandler(() => {
    handled += 1;
    return true;
  });
  assert.equal(isWagerPanelVisible(), true);
  assert.equal(handleWagerPanelOutsideTap({}), true);
  assert.equal(handled, 1);

  setWagerPanelOutsideTapHandler(null);
  assert.equal(isWagerPanelVisible(), true);
  assert.equal(handleWagerPanelOutsideTap({}), false);
  resetWagerPanelApi();
});

test("control deadlines retain exact timer, cancellation, and outside-tap timing", () => {
  assert.equal(getTimerEnableDelayMs(3.25, 7), 3750);
  assert.equal(getTimerEnableDelayMs(8, 7), 0);
  assert.equal(hasControlDeadlineElapsed(null, 100), false);
  assert.equal(hasControlDeadlineElapsed(101, 100), false);
  assert.equal(hasControlDeadlineElapsed(100, 100), true);
  assert.equal(
    getCancelAutomatchRevealDeadlineMs(null, 500),
    500 + CANCEL_AUTOMATCH_REVEAL_DELAY_MS,
  );
  assert.equal(getCancelAutomatchRevealDeadlineMs(777, 500), 777);
  assert.equal(NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS, 60000);

  assert.equal(getOutsideTapDismissThresholdMs(true), 42);
  assert.equal(getOutsideTapDismissThresholdMs(false), 420);
  assert.equal(didOutsideTapDismissWindowPass(1000, 1041, true), false);
  assert.equal(didOutsideTapDismissWindowPass(1000, 1042, true), true);
  assert.equal(didOutsideTapDismissWindowPass(1000, 1419, false), false);
  assert.equal(didOutsideTapDismissWindowPass(1000, 1420, false), true);
  assert.equal(rewindOutsideTapDismissedAtForReset(1000, true), 1000);
  assert.equal(rewindOutsideTapDismissedAtForReset(1000, false), 0);
});

test("move-history state follows the latest entry only while its popup is open", () => {
  let reloads = 0;
  let resets = 0;
  const unsubscribeReload = subscribeMoveHistoryPopupReload(() => {
    reloads += 1;
  });
  const unsubscribeReset = subscribeMoveHistoryPopupSelectionReset(() => {
    resets += 1;
  });

  setMoveHistoryPopupState(true, true);
  assert.equal(isMoveHistoryPopupFollowingLatest(), true);
  setMoveHistoryPopupFollowingLatest(false);
  assert.equal(isMoveHistoryPopupFollowingLatest(), false);
  triggerMoveHistoryPopupReload();
  triggerMoveHistoryPopupSelectionReset();
  assert.deepEqual([reloads, resets], [1, 1]);

  unsubscribeReload();
  unsubscribeReset();
  triggerMoveHistoryPopupReload();
  triggerMoveHistoryPopupSelectionReset();
  assert.deepEqual([reloads, resets], [1, 1]);
  setMoveHistoryPopupState(false, true);
  assert.equal(isMoveHistoryPopupFollowingLatest(), false);
});

test("navigation cache stays identity-scoped, sanitized, cloned, and bounded", () => {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });

  const scope = resolveNavigationGamesCacheScope("profile-1", "login-1");
  assert.deepEqual(scope, {
    kind: "profile",
    scopeId: "profile-1",
    scopeKey: "profile:profile-1",
  });
  assert.equal(resolveNavigationGamesCacheScope("", "") ?? null, null);
  assert.equal(
    resolveNavigationGamesCacheScope("", "login-1")?.scopeKey,
    "login:login-1",
  );

  const game = {
    id: "game-1",
    entityType: "game",
    inviteId: "invite-1",
    kind: "direct",
    status: "waiting",
    sortBucket: 30,
    listSortAtMs: 9,
  };
  try {
    writeNavigationGamesRuntimeCache(
      scope,
      [game, game, { id: "invalid" }],
      [],
    );
    const runtimeSnapshot = readNavigationGamesCacheSnapshot(scope);
    assert.equal(runtimeSnapshot.topGames.length, 1);
    runtimeSnapshot.topGames.length = 0;
    assert.equal(readNavigationGamesCacheSnapshot(scope).topGames.length, 1);

    writeNavigationGamesPersistedTopCache(
      scope,
      [game, { ...game, id: "optimistic", isOptimistic: true }],
      1,
    );
    clearNavigationGamesRuntimeCacheScope(scope.scopeKey);
    const persistedSnapshot = readNavigationGamesCacheSnapshot(scope);
    assert.deepEqual(
      persistedSnapshot.topGames.map(({ id }) => id),
      ["game-1"],
    );
  } finally {
    clearNavigationGamesRuntimeCacheScope(scope.scopeKey);
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test("control domains use neutral ports and contain no disabled badge path", () => {
  const readSource = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const controller = readSource("../src/game/gameController.ts");
  const board = readSource("../src/game/board.ts");
  const bottomControls = readSource("../src/ui/BottomControls.tsx");
  const bottomControlsStyles = readSource("../src/ui/BottomControlsStyles.tsx");
  const boardComponent = readSource("../src/ui/BoardComponent.tsx");
  const mainMenu = readSource("../src/ui/MainMenu.tsx");
  const problems = readSource("../src/content/problems.ts");

  assert.doesNotMatch(
    controller,
    /ui\/(BottomControls|MoveHistoryPopup|BoardComponent)["']/,
  );
  assert.doesNotMatch(board, /ui\/(BottomControls|MainMenu)["']/);
  assert.doesNotMatch(
    bottomControls,
    /(?:game\/board|\.\/MainMenu|\.\/BoardComponent)["']/,
  );
  assert.doesNotMatch(boardComponent, /\.\/BottomControls["']/);
  assert.doesNotMatch(mainMenu, /\.\/BottomControls["']/);
  assert.doesNotMatch(problems, /game\/gameController["']/);
  assert.match(
    bottomControls,
    /useLayoutEffect\(\(\) => \{\s*const boundApi = bindBottomControlsApi\([\s\S]*?return \(\) => unbindBottomControlsApi\(boundApi\);\s*\}\);/,
  );
  assert.doesNotMatch(bottomControls, /bottomControlsApiRef/);

  for (const source of [controller, bottomControls, bottomControlsStyles]) {
    assert.doesNotMatch(
      source,
      /HOME_NAVIGATION_BADGE_ENABLED|NavigationBadge|setBadgeVisible|isBadgeVisible/,
    );
  }
});
