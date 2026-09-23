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
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/src/lifecycle/lifecycleDiagnostics.ts")) {
      return {
        ...result,
        source: String(result.source).replace("import.meta.env.DEV", "false"),
      };
    }
    return result;
  },
});

const {
  bindBoardUiHandlers,
  createEmptyPlayerInfoOverlayState,
  getBoardPlayerInfoOverlayState,
  playerInfoOverlayStatesEqual,
  resetBoardUiHandlers,
  setBoardPlayerInfoOverlayState,
  setTopBoardOverlayVisible,
  showRaibowAura,
  unbindBoardUiHandlers,
  updateAuraForAvatarElement,
  updateBoardComponentForBoardStyleChange,
  updateWagerPlayerUids,
} = await import("../src/game/boardUiPort.ts");
const {
  bindBoardVideoReactionHandler,
  resetBoardVideoReactionHandler,
  showVideoReaction,
  unbindBoardVideoReactionHandler,
} = await import("../src/ui/controls/boardReactionPort.ts");
const { bindBoardEffectsRuntime, getBoardEffectsRuntime } =
  await import("../src/game/boardEffectsPort.ts");
const {
  MAX_WAGER_PILE_ITEMS,
  buildWagerRenderState,
  computeWagerStackCenterUs,
  computeWagerStackHeights,
  createWagerPile,
  generateWagerPositions,
  getWagerIconLayout,
  getWagerStackColumnCount,
  syncWagerPileIcons,
  updateWagerPileLayout,
  wagerSlotLayoutsEqual,
} = await import("../src/game/boardWagerModels.ts");
const {
  cancelManagedBoardRaf,
  cancelManagedBoardTimeout,
  clearTrackedBoardRafs,
  clearTrackedBoardTimeouts,
  setManagedBoardRaf,
  setManagedBoardTimeout,
} = await import("../src/game/boardRuntimeScheduler.ts");
const { getLifecycleCounters } =
  await import("../src/lifecycle/lifecycleDiagnostics.ts");

const recordingBoardUiHandlers = (events) =>
  Object.fromEntries(
    [
      "updateBoardComponentForBoardStyleChange",
      "setTopBoardOverlayVisible",
      "showRaibowAura",
      "updateAuraForAvatarElement",
      "updateWagerPlayerUids",
      "setBoardPlayerInfoOverlayState",
    ].map((name) => [name, (...args) => events.push([name, ...args])]),
  );

test.afterEach(() => {
  resetBoardUiHandlers();
  setBoardPlayerInfoOverlayState(createEmptyPlayerInfoOverlayState());
  resetBoardVideoReactionHandler();
});

test("board UI port forwards exact arguments only while bound", () => {
  resetBoardUiHandlers();
  const empty = createEmptyPlayerInfoOverlayState();
  setBoardPlayerInfoOverlayState(empty);
  const events = [];
  const handlers = recordingBoardUiHandlers(events);
  const svgElement = { id: "overlay" };
  const ok = () => {};
  const cancel = () => {};
  const sendCommands = () => {
    updateBoardComponentForBoardStyleChange();
    setTopBoardOverlayVisible(true, svgElement, true, ok, cancel);
    showRaibowAura(true, "aura.webp", false);
    updateAuraForAvatarElement(true, svgElement);
    updateWagerPlayerUids("player-1", "player-2");
    setBoardPlayerInfoOverlayState(empty);
  };

  assert.doesNotThrow(sendCommands);
  assert.deepEqual(events, []);
  assert.equal(bindBoardUiHandlers(handlers), handlers);
  assert.deepEqual(events, []);

  sendCommands();
  assert.deepEqual(events, [
    ["updateBoardComponentForBoardStyleChange"],
    ["setTopBoardOverlayVisible", true, svgElement, true, ok, cancel],
    ["showRaibowAura", true, "aura.webp", false],
    ["updateAuraForAvatarElement", true, svgElement],
    ["updateWagerPlayerUids", "player-1", "player-2"],
    ["setBoardPlayerInfoOverlayState", empty],
  ]);

  unbindBoardUiHandlers(handlers);
  events.length = 0;
  assert.doesNotThrow(sendCommands);
  assert.deepEqual(events, []);
});

test("board UI port preserves cached player info without dispatching on bind", () => {
  const state = createEmptyPlayerInfoOverlayState();
  state.player.nameText = "Player";
  state.player.visible = true;
  setBoardPlayerInfoOverlayState(state);
  assert.equal(getBoardPlayerInfoOverlayState(), state);

  const firstEvents = [];
  const first = bindBoardUiHandlers(recordingBoardUiHandlers(firstEvents));
  assert.deepEqual(firstEvents, []);
  assert.equal(getBoardPlayerInfoOverlayState(), state);

  const updated = { ...state, wagerLayoutRevision: 1 };
  setBoardPlayerInfoOverlayState(updated);
  assert.equal(getBoardPlayerInfoOverlayState(), updated);
  assert.deepEqual(firstEvents.at(-1), [
    "setBoardPlayerInfoOverlayState",
    updated,
  ]);
  unbindBoardUiHandlers(first);
  assert.equal(getBoardPlayerInfoOverlayState(), updated);

  const whileUnmounted = { ...updated, topControlSlot: "player" };
  setBoardPlayerInfoOverlayState(whileUnmounted);
  assert.equal(firstEvents.length, 1);
  const secondEvents = [];
  bindBoardUiHandlers(recordingBoardUiHandlers(secondEvents));
  assert.deepEqual(secondEvents, []);
  assert.equal(getBoardPlayerInfoOverlayState(), whileUnmounted);

  resetBoardUiHandlers();
  assert.equal(getBoardPlayerInfoOverlayState(), whileUnmounted);
  updateBoardComponentForBoardStyleChange();
  assert.deepEqual(secondEvents, []);
  const thirdEvents = [];
  bindBoardUiHandlers(recordingBoardUiHandlers(thirdEvents));
  assert.deepEqual(thirdEvents, []);
  assert.equal(getBoardPlayerInfoOverlayState(), whileUnmounted);
});

test("an older board UI binding cannot unbind its replacement", () => {
  const firstEvents = [];
  const secondEvents = [];
  const first = bindBoardUiHandlers(recordingBoardUiHandlers(firstEvents));
  const second = bindBoardUiHandlers(recordingBoardUiHandlers(secondEvents));
  firstEvents.length = 0;
  secondEvents.length = 0;

  unbindBoardUiHandlers(first);
  updateWagerPlayerUids("current-player", "current-opponent");
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, [
    ["updateWagerPlayerUids", "current-player", "current-opponent"],
  ]);

  unbindBoardUiHandlers(second);
  updateWagerPlayerUids("ignored", "ignored");
  assert.equal(secondEvents.length, 1);
});

test("video reaction bindings forward exact arguments and unbind by identity", () => {
  resetBoardVideoReactionHandler();
  assert.doesNotThrow(() => showVideoReaction(true, 17));
  const firstEvents = [];
  const secondEvents = [];
  const firstHandler = (...args) => firstEvents.push(args);
  const secondHandler = (...args) => secondEvents.push(args);
  const first = bindBoardVideoReactionHandler(firstHandler);
  assert.equal(first, firstHandler);
  showVideoReaction(false, 20);
  assert.deepEqual(firstEvents, [[false, 20]]);

  const second = bindBoardVideoReactionHandler(secondHandler);
  assert.equal(second, secondHandler);
  unbindBoardVideoReactionHandler(first);
  showVideoReaction(true, 374);
  assert.deepEqual(firstEvents, [[false, 20]]);
  assert.deepEqual(secondEvents, [[true, 374]]);

  unbindBoardVideoReactionHandler(second);
  assert.doesNotThrow(() => showVideoReaction(false, 429));
  assert.deepEqual(secondEvents, [[true, 374]]);
  bindBoardVideoReactionHandler(secondHandler);
  resetBoardVideoReactionHandler();
  showVideoReaction(true, 465);
  assert.deepEqual(secondEvents, [[true, 374]]);
});

test("board player info comparison checks state values", () => {
  const empty = createEmptyPlayerInfoOverlayState();
  assert.equal(
    playerInfoOverlayStatesEqual(empty, createEmptyPlayerInfoOverlayState()),
    true,
  );
  assert.equal(
    playerInfoOverlayStatesEqual(empty, {
      ...empty,
      wagerLayoutRevision: 1,
    }),
    false,
  );
});

test("board effects runtime is read lazily", () => {
  let flipped = false;
  const effectsLayer = { id: "effects" };
  bindBoardEffectsRuntime(() => ({ isFlipped: flipped, effectsLayer }));

  assert.deepEqual(getBoardEffectsRuntime(), {
    isFlipped: false,
    effectsLayer,
  });
  flipped = true;
  assert.deepEqual(getBoardEffectsRuntime(), { isFlipped: true, effectsLayer });
});

test("wager stacks retain their exact column and center layout", () => {
  assert.deepEqual(
    [1, 3, 4, 8, 9, 18, 19].map(getWagerStackColumnCount),
    [1, 1, 2, 2, 3, 3, 4],
  );
  assert.deepEqual(computeWagerStackHeights(11, 3), [4, 4, 3]);
  assert.deepEqual(computeWagerStackCenterUs(4), [0.12, 0.38, 0.62, 0.88]);

  const positions = generateWagerPositions(13);
  assert.equal(positions.length, 13);
  positions.forEach(({ u, v }) => {
    assert.ok(u >= 0.14 && u <= 0.86);
    assert.ok(v >= 0.14 && v <= 0.86);
  });
});

test("wager pile models cap visible icons while retaining totals and geometry", () => {
  const pile = createWagerPile();
  syncWagerPileIcons(pile, "obsidian", 40);
  assert.equal(pile.count, MAX_WAGER_PILE_ITEMS);
  assert.equal(pile.actualCount, 40);
  assert.equal(
    pile.materialUrl,
    "https://cdn.lil.org/mons/rocks/materials/obsidian.webp",
  );

  const rect = { x: 2, y: 3, w: 4, h: 2 };
  const layout = getWagerIconLayout(rect, 0.777);
  updateWagerPileLayout(pile, rect, 0.777);
  assert.equal(pile.frames.length, MAX_WAGER_PILE_ITEMS);
  assert.equal(pile.iconSize, layout.iconSize);
  assert.deepEqual(buildWagerRenderState(pile, "player", "appear", true), {
    side: "player",
    rect,
    iconSize: pile.iconSize,
    materialUrl: pile.materialUrl,
    frames: pile.frames,
    count: MAX_WAGER_PILE_ITEMS,
    actualCount: 40,
    animation: "appear",
    isPending: true,
  });
});

test("wager slot comparison uses value geometry rather than object identity", () => {
  const first = {
    player: {
      pile: { x: 1, y: 2, w: 3, h: 4 },
      winner: { x: 5, y: 6, w: 7, h: 8 },
    },
  };
  assert.equal(wagerSlotLayoutsEqual(first, structuredClone(first)), true);
  assert.equal(
    wagerSlotLayoutsEqual(first, {
      player: { ...first.player, pile: { ...first.player.pile, x: 2 } },
    }),
    false,
  );
});

test("board scheduler clears timeout and animation counters exactly once", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousClearTimeout = globalThis.clearTimeout;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const timeoutCallbacks = new Map();
  const rafCallbacks = new Map();
  const clearedTimeouts = [];
  const canceledRafs = [];
  let nextTimeoutId = 10;
  let nextRafId = 20;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback) {
        const id = nextTimeoutId++;
        timeoutCallbacks.set(id, callback);
        return id;
      },
      requestAnimationFrame(callback) {
        const id = nextRafId++;
        rafCallbacks.set(id, callback);
        return id;
      },
    },
  });
  globalThis.clearTimeout = (id) => clearedTimeouts.push(id);
  globalThis.cancelAnimationFrame = (id) => canceledRafs.push(id);
  const initial = getLifecycleCounters();

  try {
    const timeoutId = setManagedBoardTimeout(() => {}, 1);
    const rafId = setManagedBoardRaf(() => {});
    assert.equal(
      getLifecycleCounters().boardTimeouts,
      initial.boardTimeouts + 1,
    );
    assert.equal(getLifecycleCounters().boardRaf, initial.boardRaf + 1);
    cancelManagedBoardTimeout(timeoutId);
    cancelManagedBoardRaf(rafId);
    cancelManagedBoardTimeout(timeoutId);
    cancelManagedBoardRaf(rafId);
    assert.equal(getLifecycleCounters().boardTimeouts, initial.boardTimeouts);
    assert.equal(getLifecycleCounters().boardRaf, initial.boardRaf);

    const firedTimeout = setManagedBoardTimeout(() => {}, 1);
    const firedRaf = setManagedBoardRaf(() => {});
    timeoutCallbacks.get(firedTimeout)();
    rafCallbacks.get(firedRaf)(123);
    assert.equal(getLifecycleCounters().boardTimeouts, initial.boardTimeouts);
    assert.equal(getLifecycleCounters().boardRaf, initial.boardRaf);

    setManagedBoardTimeout(() => {}, 1);
    setManagedBoardRaf(() => {});
    clearTrackedBoardTimeouts();
    clearTrackedBoardRafs();
    assert.equal(getLifecycleCounters().boardTimeouts, initial.boardTimeouts);
    assert.equal(getLifecycleCounters().boardRaf, initial.boardRaf);
    assert.ok(clearedTimeouts.length >= 2);
    assert.ok(canceledRafs.length >= 2);
  } finally {
    clearTrackedBoardTimeouts();
    clearTrackedBoardRafs();
    globalThis.clearTimeout = previousClearTimeout;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});
