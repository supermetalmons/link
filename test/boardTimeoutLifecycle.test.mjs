import { createTimerHandle } from "./fixtures/timerHandle.mjs";
import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

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

const scheduler = await import("../src/game/boardRuntimeScheduler.ts");
const { createBoardWagerRuntime } =
  await import("../src/game/boardWagerRuntime.ts");
const diagnostics = await import("../src/lifecycle/lifecycleDiagnostics.ts");
const source = ts.createSourceFile(
  "board.ts",
  readFileSync(
    process.env.MONS_BOARD_SOURCE ??
      new URL("../src/game/board.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = [
  "currentTextAnimation",
  "startTextAnimation",
  "fastForwardInstructionsIfNeeded",
  "toggleFromTalkingToIdle",
  "markWagerInitialStateReceived",
  "setWagerPiles",
  "showResolvedWager",
  "disposeBoardRuntime",
].map((name) => {
  const declaration = source.statements.find(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(source) === name,
        )),
  );
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});

/**
 * @param {test.TestContext} t
 */
function harness(t) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  /** @type {Map<number | ReturnType<typeof createTimerHandle>, {callback: () => void; due: number}>} */
  const timers = new Map();
  /** @type {Map<number, FrameRequestCallback>} */
  const rafs = new Map();
  let now = 0;
  let nextId = 1;
  const setTimeout = (/** @type {() => void} */ callback, delay = 0) => {
    const id = nextId++;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const clearTimeout = (
    /** @type {Parameters<typeof originalClearTimeout>[0]} */ id,
  ) => id != null && typeof id !== "string" && timers.delete(id);
  const requestAnimationFrame = (
    /** @type {FrameRequestCallback} */ callback,
  ) => {
    const id = nextId++;
    rafs.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (/** @type {number} */ id) => rafs.delete(id);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      requestAnimationFrame,
      cancelAnimationFrame,
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: cancelAnimationFrame,
  });
  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(_target, _receiver, /** @type {unknown[]} */ args) {
      const [callback, delay = 0] = args;
      assert.ok(typeof callback === "function");
      assert.ok(typeof delay === "number");
      const id = createTimerHandle();
      timers.set(id, {
        callback: () => Reflect.apply(callback, undefined, args.slice(2)),
        due: now + delay,
      });
      return id;
    },
  });
  globalThis.clearTimeout = clearTimeout;
  const initialCounters = diagnostics.getLifecycleCounters();
  /** @type {import("../src/game/boardWagerModels.ts").WagerRenderState[]} */
  const renders = [];
  const noop = () => {};
  const dependencies = {
    ...scheduler,
    ...diagnostics,
    createBoardWagerRuntime,
    currentTime: () => now,
    handleWagerRenderState: (
      /** @type {import("../src/game/boardWagerModels.ts").WagerRenderState} */ state,
    ) => renders.push(structuredClone(state)),
    stopMonsBoardAsDisplayAnimations: noop,
    hideTimerCountdownDigits: noop,
    stopConfetti: noop,
    removeItemAndCleanUpAnimation: noop,
    clearWavesIntervals: noop,
    clearSparkleIntervals: noop,
    removeHighlights: noop,
    cleanAllPixels: noop,
    hideItemSelectionOrConfirmationOverlay: noop,
    setEndOfGameMarkers: noop,
    emitBoardPlayerInfoOverlayState: noop,
  };
  const initial = {
    talkingDudeTextDiv: { textContent: "" },
    talkingDude: null,
    talkingDudeIsTalking: true,
    instructionsContainerElement: undefined,
    instructionsCloudBg: null,
    boardRuntimeToken: 1,
    preserveDisplayAnimation: false,
    cleanupInviteBotButtonThemeListener: null,
    didRegisterResizeHandler: false,
    boardInputHandler: null,
    hasSetupBoardRuntime: true,
    dimmingOverlay: undefined,
    board: null,
    controlsLayer: { innerHTML: "" },
    boardBackgroundLayer: {},
    itemsLayer: null,
    avatarLayer: null,
    effectsLayer: null,
    highlightsLayer: null,
    opponentMoveStatusItems: [],
    playerMoveStatusItems: [],
    doNotShowPlayerAvatarPlaceholderAgain: false,
    doNotShowOpponentAvatarPlaceholderAgain: false,
    opponentAvatar: undefined,
    playerAvatar: undefined,
    opponentAvatarPlaceholder: undefined,
    playerAvatarPlaceholder: undefined,
    inviteBotButtonContainer: undefined,
    inviteBotButtonElement: undefined,
    botStrengthControlVisible: false,
    playerScoreDisplayText: "",
    opponentScoreDisplayText: "",
    playerTimerDisplayText: "",
    opponentTimerDisplayText: "",
    playerTimerColor: "green",
    opponentTimerColor: "green",
    playerInfoPlayerVisible: false,
    playerInfoOpponentVisible: false,
    playerInfoPlayerNameVisible: false,
    playerInfoOpponentNameVisible: false,
  };
  const body = ts.transpileModule(
    `
      const { ${Object.keys(dependencies).join(", ")} } = dependencies;
      let { ${Object.keys(initial).join(", ")} } = initial;
      const wagerRuntime = createBoardWagerRuntime({
        canLayout: () => Boolean(controlsLayer && boardBackgroundLayer),
        getAvatarSize: () => 1,
        getDisplaySlot: opponent => opponent ? "opponent" : "player",
        getFallbackRect: () => ({ x: 0, y: 0, w: 2, h: 1 }),
        setTimeout: setManagedBoardTimeout,
        cancelTimeout: cancelManagedBoardTimeout,
        requestAnimationFrame: setManagedBoardRaf,
        cancelAnimationFrame: cancelManagedBoardRaf,
        now: currentTime,
        random: () => 0.5,
        log: () => {},
      });
      wagerRuntime.setWagerRenderHandler(handleWagerRenderState);
      wagerRuntime.setWagerSlotLayouts({}, 0);
      ${declarations.join("\n")}
      return {
        startTextAnimation,
        fastForwardInstructionsIfNeeded,
        setWagerPiles,
        markWagerInitialStateReceived,
        showResolvedWager,
        disposeBoardRuntime,
        state: () => ({
          textElement: talkingDudeTextDiv,
          isAnimating: currentTextAnimation.isAnimating,
          textTimer: currentTextAnimation.timer,
          talkingDudeIsTalking,
        }),
        attachPresentation: () => {
          talkingDudeTextDiv = { textContent: "" };
          controlsLayer = { innerHTML: "" };
          boardBackgroundLayer = {};
        },
      };
    `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api =
    /** @type {Pick<typeof import("../src/game/board.ts"), "fastForwardInstructionsIfNeeded" | "setWagerPiles" | "markWagerInitialStateReceived" | "showResolvedWager" | "disposeBoardRuntime"> & {startTextAnimation(text: string): void; state(): {textElement: {textContent: string} | null; isAnimating: boolean; textTimer: number | null; talkingDudeIsTalking: boolean}; attachPresentation(): void}} */ (
      new Function("dependencies", "initial", body)(dependencies, initial)
    );
  t.after(() => {
    try {
      api.disposeBoardRuntime();
      scheduler.clearTrackedBoardTimeouts();
      scheduler.clearTrackedBoardRafs();
      assert.equal(timers.size, 0);
      assert.equal(rafs.size, 0);
      assert.deepEqual(diagnostics.getLifecycleCounters(), initialCounters);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      if (originalCancelAnimationFrame) {
        Object.defineProperty(
          globalThis,
          "cancelAnimationFrame",
          originalCancelAnimationFrame,
        );
      } else {
        Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      }
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
  const advance = (/** @type {number} */ milliseconds) => {
    const until = now + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= until)
        .sort((a, b) => a[1].due - b[1].due || Number(a[0]) - Number(b[0]))[0];
      if (!next) break;
      assert.ok(callbacks++ < 1000, "timer loop did not settle");
      const [id, timer] = next;
      timers.delete(id);
      now = timer.due;
      timer.callback();
    }
    now = until;
  };
  return {
    ...api,
    renders,
    latestRender: () => renders.at(-1),
    pending: () => timers.size,
    pendingFrames: () => rafs.size,
    counter: () =>
      diagnostics.getLifecycleCounters().boardTimeouts -
      initialCounters.boardTimeouts,
    frameCounter: () =>
      diagnostics.getLifecycleCounters().boardRaf - initialCounters.boardRaf,
    advance,
    frame(/** @type {number} */ milliseconds) {
      advance(milliseconds);
      for (const [id, callback] of [...rafs]) {
        if (!rafs.has(id)) continue;
        rafs.delete(id);
        callback(now);
      }
    },
  };
}

/** @type {{material: import("../src/services/rocksMiningService.ts").MaterialName; count: number}} */
const player = { material: "dust", count: 2 };
/** @type {{material: import("../src/services/rocksMiningService.ts").MaterialName; count: number}} */
const opponent = { material: "dust", count: 3 };

/** @param {ReturnType<typeof harness>} h */
function startDisappearingPiles(h) {
  h.setWagerPiles({ player, opponent });
  h.markWagerInitialStateReceived();
  h.setWagerPiles({});
}

test("tutorial typing preserves Unicode characters and character delays", (t) => {
  const h = harness(t);
  h.startTextAnimation("A🪨 B");
  const text = h.state().textElement;
  assert.equal(required(text).textContent, "");
  assert.equal(h.counter(), 1);
  h.advance(22);
  assert.equal(required(text).textContent, "");
  h.advance(1);
  assert.equal(required(text).textContent, "A");
  h.advance(23);
  assert.equal(required(text).textContent, "A🪨");
  h.advance(54);
  assert.equal(required(text).textContent, "A🪨");
  h.advance(1);
  assert.equal(required(text).textContent, "A🪨 ");
  h.advance(23);
  assert.equal(required(text).textContent, "A🪨 B");
  assert.equal(h.state().isAnimating, false);
  assert.equal(h.state().talkingDudeIsTalking, false);
  assert.equal(h.state().textTimer, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
});

test("replacing and fast-forwarding tutorial text cancel the pending step", (t) => {
  const h = harness(t);
  h.startTextAnimation("OLD");
  h.advance(23);
  h.startTextAnimation("NEW 🪨");
  assert.equal(h.pending(), 1);
  assert.equal(h.counter(), 1);
  h.advance(23);
  assert.equal(required(h.state().textElement).textContent, "N");
  assert.equal(h.fastForwardInstructionsIfNeeded(), true);
  assert.equal(h.fastForwardInstructionsIfNeeded(), false);
  assert.equal(required(h.state().textElement).textContent, "NEW 🪨");
  assert.equal(h.state().textTimer, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
  h.advance(1000);
  assert.equal(required(h.state().textElement).textContent, "NEW 🪨");
});

test("both wager disappearance timers retain their snapshots for 280 ms", (t) => {
  const h = harness(t);
  startDisappearingPiles(h);
  assert.equal(h.pending(), 2);
  assert.equal(h.counter(), 2);
  assert.equal(
    required(required(h.latestRender()).playerDisappearing).count,
    player.count,
  );
  assert.equal(
    required(required(h.latestRender()).opponentDisappearing).count,
    opponent.count,
  );
  h.advance(279);
  assert.equal(
    required(required(h.latestRender()).playerDisappearing).animation,
    "disappear",
  );
  assert.equal(
    required(required(h.latestRender()).opponentDisappearing).animation,
    "disappear",
  );
  h.advance(1);
  assert.equal(required(h.latestRender()).playerDisappearing, null);
  assert.equal(required(h.latestRender()).opponentDisappearing, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
});

test("wager reappearance cancels only its own disappearance and can restart", (t) => {
  const h = harness(t);
  startDisappearingPiles(h);
  h.advance(100);
  h.setWagerPiles({ player });
  assert.equal(required(h.latestRender()).playerDisappearing, null);
  assert.equal(
    required(required(h.latestRender()).opponentDisappearing).count,
    opponent.count,
  );
  assert.equal(h.pending(), 1);
  assert.equal(h.counter(), 1);
  h.advance(180);
  assert.equal(required(required(h.latestRender()).player).count, player.count);
  assert.equal(required(h.latestRender()).opponentDisappearing, null);
  assert.equal(h.counter(), 0);

  h.setWagerPiles({});
  h.advance(120);
  h.setWagerPiles({ player: { ...player, count: 5 } });
  h.setWagerPiles({});
  h.advance(160);
  assert.equal(
    required(required(h.latestRender()).playerDisappearing).count,
    5,
  );
  assert.equal(h.pending(), 1);
  assert.equal(h.counter(), 1);
  h.advance(120);
  assert.equal(required(h.latestRender()).playerDisappearing, null);
  assert.equal(h.counter(), 0);
});

test("board disposal cancels all three owners once and allows new timers", (t) => {
  const h = harness(t);
  h.startTextAnimation("unfinished instructions");
  const detachedText = h.state().textElement;
  startDisappearingPiles(h);
  assert.equal(h.pending(), 3);
  assert.equal(h.counter(), 3);
  h.disposeBoardRuntime();
  h.disposeBoardRuntime();
  const renderCount = h.renders.length;
  assert.equal(h.state().textElement, null);
  assert.equal(h.state().textTimer, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
  h.advance(1000);
  assert.equal(required(detachedText).textContent, "");
  assert.equal(h.renders.length, renderCount);

  h.attachPresentation();
  h.startTextAnimation("Z");
  startDisappearingPiles(h);
  assert.equal(h.pending(), 3);
  assert.equal(h.counter(), 3);
  h.advance(280);
  assert.equal(required(h.state().textElement).textContent, "Z");
  assert.equal(required(h.latestRender()).playerDisappearing, null);
  assert.equal(required(h.latestRender()).opponentDisappearing, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
});

test("board disposal cancels tutorial and win animation owners without leaking managed frames on reuse", (t) => {
  const h = harness(t);
  h.startTextAnimation("unfinished instructions");
  h.showResolvedWager(false, "dust", 2, true);
  assert.equal(h.pending(), 1);
  assert.equal(h.counter(), 1);
  assert.equal(h.pendingFrames(), 1);
  assert.equal(h.frameCounter(), 1);
  h.disposeBoardRuntime();
  h.disposeBoardRuntime();
  assert.equal(h.pending(), 0);
  assert.equal(h.counter(), 0);
  assert.equal(h.pendingFrames(), 0);
  assert.equal(h.frameCounter(), 0);
  const renderCount = h.renders.length;
  h.frame(1000);
  assert.equal(h.renders.length, renderCount);

  h.attachPresentation();
  h.showResolvedWager(true, "dust", 2, true);
  assert.equal(h.frameCounter(), 1);
  h.frame(400);
  assert.equal(required(h.latestRender()).winAnimationActive, true);
  assert.equal(h.frameCounter(), 1);
  h.frame(400);
  assert.equal(required(h.latestRender()).winAnimationActive, false);
  assert.equal(h.pendingFrames(), 0);
  assert.equal(h.frameCounter(), 0);
});
