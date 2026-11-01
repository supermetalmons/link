import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";

registerTypeScriptTestHooks();

const { createGameControlsStore } =
  await import("../src/game/gameControlsStore.ts");
const { deriveGameControlsView } =
  await import("../src/game/gameControlsModel.ts");
const { deriveBoardViewControls } =
  await import("../src/game/boardViewPolicy.ts");

const config = { duration: 60, progress: 0, requestDate: 1000 };

test("snapshots retain identity until state changes and unsubscribe does not reset state", () => {
  const store = createGameControlsStore(config);
  const initial = store.getSnapshot();
  assert.equal(store.getSnapshot(), initial);
  const snapshots = [];
  const stop = store.subscribe(() => snapshots.push(store.getSnapshot()));
  store.updateContext({ isOnlineGame: false });
  store.updatePresentation({ endMatchVisible: false });
  assert.equal(store.getSnapshot(), initial);
  assert.equal(snapshots.length, 0);
  store.updateContext({ isOnlineGame: true, sessionId: 2 });
  store.updatePresentation({ endMatchVisible: true, endMatchConfirmed: true });
  assert.equal(snapshots.length, 2);
  assert.equal(initial.context.isOnlineGame, false);
  assert.equal(initial.presentation.endMatchVisible, false);
  const retained = store.getSnapshot();
  stop();
  const stopAgain = store.subscribe(() => {});
  assert.equal(store.getSnapshot(), retained);
  store.updateContext({ isOnlineGame: false });
  assert.equal(snapshots.length, 2);
  stopAgain();
});

test("synchronous presentation updates expose current context and preserve unrelated retained controls", () => {
  const store = createGameControlsStore(config);
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.updatePresentation({ endMatchConfirmed: true, homeVisible: true });
  store.subscribe(() => observed.push(store.getSnapshot()));
  store.updateContext({ isWatchOnly: true, isOnlineGame: true });
  store.updatePresentation({ watchOnlyVisible: true });
  store.updateContext({ isWatchOnly: false, isGameWithBot: true });
  store.updatePresentation({ voiceReactionVisible: true });
  const context = required(observed.at(-1)).context;
  assert.equal(context.isWatchOnly, false);
  assert.equal(context.isGameWithBot, true);
  assert.equal(required(observed.at(-1)).presentation.endMatchConfirmed, true);
  assert.equal(required(observed.at(-1)).presentation.homeVisible, true);
});

test("sequential control dispatches read the latest state and preserve unrelated presentation", () => {
  const store = createGameControlsStore(config);
  store.updateContext({ sessionId: 4, isOnlineGame: true });
  store.updatePresentation({ endMatchConfirmed: true, waitingText: "waiting" });
  const before = store.getSnapshot();
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  store.dispatchGameControls({ type: "setUndoVisible", visible: true });
  store.dispatchGameControls({ type: "setUndoEnabled", enabled: true });
  store.dispatchGameControls({ type: "setAutomoveEnabled", enabled: false });
  store.dispatchGameControls({ type: "setPrimaryAction", action: "rematch" });

  const snapshot = store.getSnapshot();
  assert.equal(observed.length, 4);
  assert.equal(observed.at(-1), snapshot);
  assert.equal(snapshot.context, before.context);
  assert.equal(snapshot.presentation.endMatchConfirmed, true);
  assert.equal(snapshot.presentation.waitingText, "waiting");
  assert.deepEqual(snapshot.presentation.gameControls.undo, {
    visible: true,
    enabled: true,
  });
  assert.equal(snapshot.presentation.gameControls.automove.enabled, false);
  assert.equal(snapshot.presentation.gameControls.primaryAction, "rematch");
  assert.equal(
    snapshot.presentation.gameControls.timer,
    before.presentation.gameControls.timer,
  );
  assert.deepEqual(before.presentation.gameControls.undo, {
    visible: false,
    enabled: false,
  });
  assert.equal(
    required(observed[0]).presentation.gameControls.undo.enabled,
    false,
  );
});

test("no-op control dispatches retain the snapshot and do not notify subscribers", () => {
  const store = createGameControlsStore(config);
  let notifications = 0;
  store.subscribe(() => notifications++);
  const initial = store.getSnapshot();
  store.dispatchGameControls({ type: "setUndoVisible", visible: false });
  store.dispatchGameControls({ type: "enableTimer" });
  store.dispatchGameControls({ type: "hideGameControls" });
  assert.equal(store.getSnapshot(), initial);
  assert.equal(notifications, 0);

  store.dispatchGameControls({ type: "showResign" });
  const changed = store.getSnapshot();
  store.dispatchGameControls({ type: "showResign" });
  assert.notEqual(changed, initial);
  assert.equal(store.getSnapshot(), changed);
  assert.equal(notifications, 1);
});

test("context changes never recreate timer configuration or reset disabled requests", () => {
  const store = createGameControlsStore(config);
  const dispatch = store.dispatchGameControls;
  const timer = { duration: 60, progress: 15, requestDate: 5000 };
  dispatch({ type: "showTimerProgress", config: timer });
  dispatch({ type: "enableTimer" });
  dispatch({ type: "disableTimer" });
  const gameControls = store.getSnapshot().presentation.gameControls;
  store.updateContext({ isOnlineGame: true, boardViewMode: "historicalView" });
  store.updateContext({ boardViewMode: "activeLive" });
  assert.equal(store.getSnapshot().presentation.gameControls, gameControls);
  assert.deepEqual(gameControls.timer.config, timer);
  assert.equal(gameControls.timer.startEnabled, false);
  dispatch({ type: "showTimerProgress", config: timer });
  assert.notEqual(store.getSnapshot().presentation.gameControls, gameControls);
});

test("waiting and historical policy retain explicit confirmation and local live reaction state", () => {
  const store = createGameControlsStore(config);
  store.updatePresentation({
    endMatchVisible: true,
    endMatchConfirmed: true,
    voiceReactionVisible: true,
  });
  const applyPolicy = (
    /** @type {Partial<Parameters<typeof deriveBoardViewControls>[0]>} */ context,
  ) => {
    const controls = deriveBoardViewControls({
      mode: "activeLive",
      isOnlineGame: false,
      isWatchOnly: false,
      isGameWithBot: false,
      isGameOver: false,
      isWaitingForRematchResponse: false,
      isSeriesEnded: false,
      ...context,
    });
    const keys = /** @type {const} */ ([
      "endMatchVisible",
      "endMatchConfirmed",
      "voiceReactionVisible",
    ]);
    /** @type {Partial<Pick<import("../src/game/gameControlsModel.ts").GameControlsPresentation, typeof keys[number]>>} */
    const changes = {};
    for (const key of keys) {
      const value = controls[key];
      if (value !== null) changes[key] = value;
    }
    store.updatePresentation(changes);
  };
  applyPolicy({});
  assert.equal(store.getSnapshot().presentation.voiceReactionVisible, true);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  applyPolicy({ mode: "waitingLive", isOnlineGame: true });
  applyPolicy({ mode: "historicalView", isOnlineGame: true });
  assert.equal(store.getSnapshot().presentation.endMatchVisible, false);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  applyPolicy({});
  assert.equal(store.getSnapshot().presentation.endMatchVisible, false);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  assert.equal(store.getSnapshot().presentation.voiceReactionVisible, true);
  for (const key of [
    "hideGameControls",
    "automoveVisible",
    "undoVisible",
    "undoEnabled",
    "hideTimers",
  ]) {
    assert.equal(Object.hasOwn(store.getSnapshot().presentation, key), false);
  }
});

test("view selectors use published role, completion, series and puzzle facts", () => {
  const store = createGameControlsStore(config);
  store.updateContext({ isOnlineGame: true });
  assert.equal(
    deriveGameControlsView(store.getSnapshot()).canWagerInCurrentGame,
    true,
  );
  store.updateContext({
    isWatchOnly: true,
    isGameOver: true,
    isSeriesEnded: true,
  });
  let view = deriveGameControlsView(store.getSnapshot());
  assert.equal(view.canWagerInCurrentGame, false);
  assert.equal(view.isWatchOnlyMatchFinished, true);
  store.dispatchGameControls({
    type: "setPrimaryAction",
    action: "rematch",
  });
  store.updateContext({ puzzleMode: true, selectedPuzzleId: "lesson" });
  view = deriveGameControlsView(store.getSnapshot());
  assert.equal(view.primaryActionText, "Next Lesson");
});

test("explicit presentation reset keeps the current context and caller's timer timestamp", () => {
  const store = createGameControlsStore(config);
  store.updateContext({ isOnlineGame: true, sessionId: 7 });
  store.updatePresentation({ endMatchConfirmed: true, waitingText: "waiting" });
  const context = store.getSnapshot().context;
  const resetConfig = { ...config, requestDate: 9000 };
  store.resetPresentation(resetConfig);
  assert.equal(store.getSnapshot().context, context);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, false);
  assert.equal(store.getSnapshot().presentation.waitingText, "");
  assert.deepEqual(
    store.getSnapshot().presentation.gameControls.timer.config,
    resetConfig,
  );
});

test("batches expose immutable current snapshots immediately and notify once with the final state", () => {
  const store = createGameControlsStore(config);
  const initial = store.getSnapshot();
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));
  /** @type {import("../src/game/gameControlsModel.ts").GameControlsSnapshot | undefined} */
  let beforeEnablingUndo;

  store.batchUpdates(() => {
    store.updateContext({ sessionId: 3, isOnlineGame: true });
    store.updatePresentation({ waitingText: "waiting", homeVisible: true });
    store.dispatchGameControls({ type: "setUndoVisible", visible: true });
    beforeEnablingUndo = store.getSnapshot();
    assert.equal(beforeEnablingUndo.context.sessionId, 3);
    assert.equal(beforeEnablingUndo.presentation.waitingText, "waiting");
    assert.equal(
      beforeEnablingUndo.presentation.gameControls.undo.visible,
      true,
    );
    store.dispatchGameControls({ type: "setUndoEnabled", enabled: true });
    assert.deepEqual(store.getSnapshot().presentation.gameControls.undo, {
      visible: true,
      enabled: true,
    });
    assert.deepEqual(observed, []);
  });

  assert.deepEqual(observed, [store.getSnapshot()]);
  assert.equal(observed[0], store.getSnapshot());
  assert.equal(initial.context.sessionId, 0);
  assert.equal(initial.presentation.waitingText, "");
  assert.deepEqual(initial.presentation.gameControls.undo, {
    visible: false,
    enabled: false,
  });
  assert.equal(
    required(beforeEnablingUndo).presentation.gameControls.undo.enabled,
    false,
  );
});

test("empty and no-op batches retain identity while reverted changes still publish once", () => {
  const store = createGameControlsStore(config);
  const initial = store.getSnapshot();
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  store.batchUpdates(() => {});
  store.batchUpdates(() => {
    store.updateContext({ isOnlineGame: false });
    store.updatePresentation({ homeVisible: false });
    store.batchUpdates(() => {
      store.dispatchGameControls({ type: "setUndoVisible", visible: false });
    });
  });
  assert.equal(store.getSnapshot(), initial);
  assert.deepEqual(observed, []);

  store.batchUpdates(() => {
    store.updateContext({ isOnlineGame: true });
    store.updateContext({ isOnlineGame: false });
    store.updatePresentation({ homeVisible: true });
    store.updatePresentation({ homeVisible: false });
    store.dispatchGameControls({ type: "setUndoVisible", visible: true });
    store.dispatchGameControls({ type: "setUndoVisible", visible: false });
  });
  assert.deepEqual(store.getSnapshot(), initial);
  assert.notEqual(store.getSnapshot(), initial);
  assert.deepEqual(observed, [store.getSnapshot()]);
});

test("nested batches and presentation resets publish only at the outer exit", () => {
  const store = createGameControlsStore(config);
  const resetConfig = { ...config, requestDate: 9000 };
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  store.batchUpdates(() => {
    store.updateContext({ sessionId: 7, isOnlineGame: true });
    store.updatePresentation({ waitingText: "old", endMatchConfirmed: true });
    store.batchUpdates(() => {
      store.resetPresentation(resetConfig);
      assert.equal(store.getSnapshot().context.sessionId, 7);
      assert.equal(store.getSnapshot().presentation.waitingText, "");
      store.dispatchGameControls({ type: "showResign" });
    });
    assert.deepEqual(observed, []);
    store.updatePresentation({ homeVisible: true });
  });

  const final = store.getSnapshot();
  assert.deepEqual(observed, [final]);
  assert.equal(final.context.isOnlineGame, true);
  assert.equal(final.presentation.endMatchConfirmed, false);
  assert.equal(final.presentation.homeVisible, true);
  assert.equal(final.presentation.gameControls.resignVisible, true);
  assert.deepEqual(final.presentation.gameControls.timer.config, resetConfig);
});

test("batches return callback values without changing notification boundaries", () => {
  const store = createGameControlsStore(config);
  const result = { selectedMatchId: "match-2" };
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  assert.equal(
    store.batchUpdates(() => result),
    result,
  );
  assert.deepEqual(observed, []);
  assert.equal(
    store.batchUpdates(() => {
      store.updateContext({ sessionId: 2 });
      const nestedResult = store.batchUpdates(() => {
        store.updatePresentation({ homeVisible: true });
        return result;
      });
      assert.equal(nestedResult, result);
      assert.deepEqual(observed, []);
      return nestedResult;
    }),
    result,
  );
  assert.deepEqual(observed, [store.getSnapshot()]);
});

test("early returns publish completed writes and leave later batches usable", () => {
  const store = createGameControlsStore(config);
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));
  const initialize = (/** @type {number} */ sessionId) =>
    store.batchUpdates(() => {
      if (sessionId === store.getSnapshot().context.sessionId) return false;
      store.updateContext({ sessionId });
      if (sessionId === 1) return true;
      store.updatePresentation({ homeVisible: true });
      return true;
    });

  assert.equal(initialize(0), false);
  assert.deepEqual(observed, []);
  assert.equal(initialize(1), true);
  assert.deepEqual(observed, [store.getSnapshot()]);
  assert.equal(store.getSnapshot().presentation.homeVisible, false);
  assert.equal(initialize(2), true);
  assert.equal(observed.length, 2);
  assert.equal(observed.at(-1), store.getSnapshot());
  assert.equal(store.getSnapshot().presentation.homeVisible, true);
});

test("a caught nested batch error keeps completed writes in the outer publication", () => {
  const store = createGameControlsStore(config);
  const failure = new Error("nested callback failed");
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  store.batchUpdates(() => {
    store.updateContext({ sessionId: 2 });
    assert.throws(
      () =>
        store.batchUpdates(() => {
          store.updatePresentation({ homeVisible: true });
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(store.getSnapshot().presentation.homeVisible, true);
    assert.deepEqual(observed, []);
    store.updatePresentation({ waitingText: "continued" });
  });

  assert.deepEqual(observed, [store.getSnapshot()]);
  assert.equal(required(observed[0]).context.sessionId, 2);
  assert.equal(required(observed[0]).presentation.homeVisible, true);
  assert.equal(required(observed[0]).presentation.waitingText, "continued");
});

test("an uncaught nested batch error publishes completed writes and leaves later updates usable", () => {
  const store = createGameControlsStore(config);
  const failure = new Error("callback failed");
  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  store.subscribe(() => observed.push(store.getSnapshot()));

  assert.throws(
    () =>
      store.batchUpdates(() => {
        store.updateContext({ sessionId: 2 });
        store.batchUpdates(() => {
          store.updatePresentation({ homeVisible: true });
          throw failure;
        });
        store.updatePresentation({ waitingText: "unreachable" });
      }),
    (error) => error === failure,
  );
  assert.deepEqual(observed, [store.getSnapshot()]);
  assert.equal(required(observed[0]).context.sessionId, 2);
  assert.equal(required(observed[0]).presentation.homeVisible, true);
  assert.equal(required(observed[0]).presentation.waitingText, "");

  store.updateContext({ sessionId: 3 });
  assert.equal(observed.length, 2);
  store.batchUpdates(() => {
    store.updatePresentation({ homeVisible: false, waitingText: "recovered" });
  });
  assert.equal(observed.length, 3);
  assert.equal(observed.at(-1), store.getSnapshot());
});

for (const nestedBatch of [false, true]) {
  test(`subscriber updates remain reentrant when ${nestedBatch ? "batched" : "direct"}`, () => {
    const store = createGameControlsStore(config);
    /** @type {Array<(string | number)[]>} */
    const calls = [];
    store.subscribe(() => {
      const sessionId = store.getSnapshot().context.sessionId;
      calls.push(["first", sessionId]);
      if (sessionId === 1) {
        const update = () => store.updateContext({ sessionId: 2 });
        if (nestedBatch) store.batchUpdates(update);
        else update();
      }
    });
    store.subscribe(() => {
      calls.push(["second", store.getSnapshot().context.sessionId]);
    });

    store.batchUpdates(() => store.updateContext({ sessionId: 1 }));
    assert.deepEqual(calls, [
      ["first", 1],
      ["first", 2],
      ["second", 2],
      ["second", 2],
    ]);
  });
}

test("a throwing subscriber does not leave a batch pending or suppress later notifications", () => {
  const store = createGameControlsStore(config);
  const failure = new Error("subscriber failed");
  const stopThrowing = store.subscribe(() => {
    throw failure;
  });
  assert.throws(
    () =>
      store.batchUpdates(() => {
        store.updateContext({ sessionId: 1 });
        store.updatePresentation({ homeVisible: true });
      }),
    (error) => error === failure,
  );
  assert.equal(store.getSnapshot().context.sessionId, 1);
  assert.equal(store.getSnapshot().presentation.homeVisible, true);
  stopThrowing();

  /** @type {Array<import("../src/game/gameControlsModel.ts").GameControlsSnapshot>} */
  const observed = [];
  const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
  store.batchUpdates(() => {});
  assert.deepEqual(observed, []);
  store.updateContext({ sessionId: 2 });
  assert.equal(observed.length, 1);
  store.batchUpdates(() => {
    store.updateContext({ sessionId: 3 });
    store.updatePresentation({ homeVisible: false });
  });
  assert.equal(observed.length, 2);
  assert.equal(observed.at(-1), store.getSnapshot());
  unsubscribe();
  store.batchUpdates(() => store.updateContext({ sessionId: 4 }));
  assert.equal(observed.length, 2);
});
