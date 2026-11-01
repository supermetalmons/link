import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      specifier.startsWith("./") &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  createGameControlsState,
  gameControlsReducer,
  createAutomatchControlsState,
  automatchControlsReducer,
} = await import("../src/ui/controls/bottomControlsState.ts");
const { PrimaryActionType } =
  await import("../src/ui/controls/primaryAction.ts");

const config = Object.freeze({ duration: 60, progress: 10, requestDate: 1000 });
/** @param {...Parameters<typeof gameControlsReducer>[1]} actions */
const gameState = (...actions) =>
  actions.reduce(gameControlsReducer, createGameControlsState(config));
/** @param {...Parameters<typeof automatchControlsReducer>[1]} actions */
const automatchState = (...actions) =>
  actions.reduce(automatchControlsReducer, createAutomatchControlsState());
/**
 * @template {object} T
 * @param {T} value
 * @returns {Readonly<T>}
 */
const freeze = (value) => {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
};

test("initial controls preserve independent button defaults and caller-supplied timer configuration", () => {
  assert.deepEqual(createGameControlsState(config), {
    undo: { visible: false, enabled: false },
    automove: { visible: false, enabled: true },
    resignVisible: false,
    primaryAction: PrimaryActionType.None,
    timer: {
      mode: "hidden",
      config,
      startEnabled: false,
      claimEnabled: true,
    },
    confirmation: "none",
  });
  assert.deepEqual(createAutomatchControlsState(), {
    visible: false,
    enabled: true,
    waiting: false,
    cancelVisible: false,
    cancelDisabled: false,
    revealRevision: 0,
  });
});

test("button visibility and enablement remain independent", () => {
  const state = gameState(
    { type: "setUndoEnabled", enabled: true },
    { type: "setAutomoveEnabled", enabled: false },
    { type: "setUndoVisible", visible: true },
    { type: "setAutomoveVisible", visible: true },
    { type: "setUndoVisible", visible: false },
    { type: "showResign" },
    { type: "setPrimaryAction", action: PrimaryActionType.JoinGame },
  );
  assert.deepEqual(state.undo, { visible: false, enabled: true });
  assert.deepEqual(state.automove, { visible: true, enabled: false });
  assert.equal(state.resignVisible, true);
  assert.equal(state.primaryAction, PrimaryActionType.JoinGame);
  assert.equal(state.timer.mode, "hidden");
  assert.equal(state.confirmation, "none");
});

test("timer transitions hide turn actions, preserve enablement and resign confirmation, and dismiss timer confirmations", () => {
  const nextConfig = { duration: 120, progress: 20, requestDate: 2000 };
  for (const confirmation of /** @type {const} */ ([
    "none",
    "resign",
    "timer",
    "claim",
  ])) {
    const initial = freeze(
      gameState(
        { type: "setUndoVisible", visible: true },
        { type: "setUndoEnabled", enabled: true },
        { type: "setAutomoveVisible", visible: true },
        { type: "setAutomoveEnabled", enabled: false },
        { type: "showResign" },
        { type: "setPrimaryAction", action: PrimaryActionType.Rematch },
        { type: "showTimerProgress", config },
        { type: "enableTimer" },
        { type: "disableVictoryClaim" },
        { type: "setUndoVisible", visible: true },
        { type: "setAutomoveVisible", visible: true },
        { type: "setConfirmation", confirmation },
      ),
    );
    const progressing = gameControlsReducer(initial, {
      type: "showTimerProgress",
      config: nextConfig,
    });
    const claim = gameControlsReducer(initial, { type: "showVictoryClaim" });
    for (const state of [progressing, claim]) {
      assert.deepEqual(state.undo, { visible: false, enabled: true });
      assert.deepEqual(state.automove, { visible: false, enabled: false });
      assert.equal(state.resignVisible, true);
      assert.equal(state.primaryAction, PrimaryActionType.Rematch);
      assert.equal(
        state.confirmation,
        confirmation === "resign" ? "resign" : "none",
      );
    }
    assert.deepEqual(progressing.timer, {
      mode: "progressing",
      config: nextConfig,
      startEnabled: false,
      claimEnabled: false,
    });
    assert.deepEqual(claim.timer, {
      mode: "claim",
      config,
      startEnabled: true,
      claimEnabled: true,
    });
  }
});

test("only progressing timers can be enabled, including after a stale deadline action", () => {
  assert.equal(gameState({ type: "enableTimer" }).timer.startEnabled, false);
  const state = gameState(
    { type: "showTimerProgress", config },
    { type: "enableTimer" },
    { type: "hideTimers" },
    { type: "showVictoryClaim" },
    { type: "enableTimer" },
  );
  assert.equal(state.timer.mode, "claim");
  assert.equal(state.timer.startEnabled, false);
  assert.equal(state.timer.claimEnabled, true);
});

test("hiding timers leaves independent controls and resign confirmation intact", () => {
  const state = gameState(
    { type: "showTimerProgress", config },
    { type: "enableTimer" },
    { type: "disableVictoryClaim" },
    { type: "setUndoVisible", visible: true },
    { type: "setAutomoveVisible", visible: true },
    { type: "setConfirmation", confirmation: "resign" },
    { type: "hideTimers" },
  );
  assert.equal(state.timer.mode, "hidden");
  assert.equal(state.timer.startEnabled, false);
  assert.equal(state.timer.claimEnabled, false);
  assert.equal(state.undo.visible, true);
  assert.equal(state.automove.visible, true);
  assert.equal(state.confirmation, "resign");
  for (const confirmation of /** @type {const} */ (["timer", "claim"])) {
    assert.equal(
      gameControlsReducer({ ...state, confirmation }, { type: "hideTimers" })
        .confirmation,
      "none",
    );
  }
});

test("hiding game controls clears every confirmation and undo enablement while preserving primary action and other enablement", () => {
  for (const confirmation of /** @type {const} */ ([
    "resign",
    "timer",
    "claim",
  ])) {
    const state = gameState(
      { type: "showTimerProgress", config },
      { type: "enableTimer" },
      { type: "disableVictoryClaim" },
      { type: "setUndoEnabled", enabled: true },
      { type: "setUndoVisible", visible: true },
      { type: "setAutomoveVisible", visible: true },
      { type: "showResign" },
      { type: "setPrimaryAction", action: PrimaryActionType.Rematch },
      { type: "setConfirmation", confirmation },
      { type: "hideGameControls" },
    );
    assert.deepEqual(state.undo, { visible: false, enabled: false });
    assert.deepEqual(state.automove, { visible: false, enabled: true });
    assert.equal(state.resignVisible, false);
    assert.equal(state.confirmation, "none");
    assert.equal(state.primaryAction, PrimaryActionType.Rematch);
    assert.deepEqual(state.timer, {
      mode: "hidden",
      config,
      startEnabled: true,
      claimEnabled: false,
    });
  }
});

test("opening and dismissing confirmations cannot retain a second game confirmation", () => {
  let state = createGameControlsState(config);
  for (const confirmation of /** @type {const} */ ([
    "resign",
    "timer",
    "claim",
    "resign",
    "none",
  ])) {
    state = gameControlsReducer(state, {
      type: "setConfirmation",
      confirmation,
    });
    assert.equal(state.confirmation, confirmation);
  }
});

test("repeated hide and claim actions preserve state identity once their changes are applied", () => {
  for (const type of /** @type {const} */ ([
    "hideTimers",
    "hideGameControls",
    "showVictoryClaim",
  ])) {
    for (const confirmation of /** @type {const} */ ([
      "none",
      "resign",
      "timer",
      "claim",
    ])) {
      const action = { type };
      const state = freeze(
        gameState(
          { type: "showTimerProgress", config },
          { type: "enableTimer" },
          { type: "setUndoVisible", visible: true },
          { type: "setUndoEnabled", enabled: true },
          { type: "setAutomoveVisible", visible: true },
          { type: "showResign" },
          { type: "setConfirmation", confirmation },
          action,
        ),
      );
      assert.strictEqual(gameControlsReducer(state, action), state);
    }
  }
});

test("confirmation completion wins after synchronous controller updates in the same dispatch batch", () => {
  const timer = gameState(
    { type: "showTimerProgress", config },
    { type: "enableTimer" },
    { type: "setConfirmation", confirmation: "timer" },
    { type: "setConfirmation", confirmation: "none" },
    { type: "showTimerProgress", config },
    { type: "enableTimer" },
    { type: "showVictoryClaim" },
    { type: "disableTimer" },
  );
  assert.equal(timer.timer.startEnabled, false);
  assert.equal(timer.timer.mode, "claim");
  const claim = gameState(
    { type: "showVictoryClaim" },
    { type: "setConfirmation", confirmation: "claim" },
    { type: "setConfirmation", confirmation: "none" },
    { type: "showVictoryClaim" },
    { type: "showTimerProgress", config },
    { type: "disableVictoryClaim" },
  );
  assert.equal(claim.timer.claimEnabled, false);
  assert.equal(claim.timer.mode, "progressing");
  const primary = gameState(
    { type: "setPrimaryAction", action: PrimaryActionType.JoinGame },
    { type: "setPrimaryAction", action: PrimaryActionType.Rematch },
    { type: "setPrimaryAction", action: PrimaryActionType.None },
  );
  assert.equal(primary.primaryAction, PrimaryActionType.None);
});

test("fresh automatch waits for an explicit reveal and repeated waiting preserves cancellation state", () => {
  let state = automatchState(
    { type: "setVisible", visible: true },
    { type: "beginRequest" },
  );
  assert.deepEqual(state, {
    visible: true,
    enabled: false,
    waiting: true,
    cancelVisible: false,
    cancelDisabled: false,
    revealRevision: 1,
  });
  state = automatchControlsReducer(state, { type: "enterWaiting" });
  assert.equal(state.cancelVisible, false);
  state = automatchControlsReducer(state, { type: "revealCancel" });
  state = automatchControlsReducer(state, { type: "requestCancellation" });
  state = automatchControlsReducer(freeze(state), { type: "enterWaiting" });
  assert.equal(state.cancelVisible, true);
  assert.equal(state.cancelDisabled, true);
  assert.equal(state.revealRevision, 3);
});

test("cancel reveal requires both a visible automatch button and waiting state", () => {
  for (const actions of /** @type {Parameters<typeof automatchControlsReducer>[1][][]} */ ([
    [],
    [{ type: "setVisible", visible: true }],
    [{ type: "beginRequest" }],
  ])) {
    const state = automatchState(...actions);
    assert.equal(
      automatchControlsReducer(state, { type: "revealCancel" }),
      state,
    );
  }
});

test("selecting an existing pending match reveals cancellation immediately and clears an old cancellation request", () => {
  const state = automatchState(
    { type: "beginRequest" },
    { type: "requestCancellation" },
    { type: "selectPending" },
  );
  assert.deepEqual(state, {
    visible: true,
    enabled: false,
    waiting: true,
    cancelVisible: true,
    cancelDisabled: false,
    revealRevision: 2,
  });
});

test("leaving waiting clears cancellation without enabling or hiding automatch", () => {
  const state = automatchState(
    { type: "selectPending" },
    { type: "requestCancellation" },
    { type: "leaveWaiting" },
  );
  assert.deepEqual(state, {
    visible: true,
    enabled: false,
    waiting: false,
    cancelVisible: false,
    cancelDisabled: false,
    revealRevision: 1,
  });
  assert.equal(
    automatchControlsReducer(state, { type: "revealCancel" }),
    state,
  );
});

test("visibility and enabled setters leave cancellation cleanup to its existing owner", () => {
  const initial = freeze(
    automatchState({ type: "selectPending" }, { type: "requestCancellation" }),
  );
  const hidden = automatchControlsReducer(initial, {
    type: "setVisible",
    visible: false,
  });
  assert.deepEqual(hidden, { ...initial, visible: false });
  for (const enabled of [false, true]) {
    assert.deepEqual(
      automatchControlsReducer(initial, { type: "setEnabled", enabled }),
      { ...initial, enabled, waiting: false },
    );
  }
  assert.deepEqual(automatchControlsReducer(initial, { type: "hideCancel" }), {
    ...initial,
    cancelVisible: false,
  });
  assert.deepEqual(automatchControlsReducer(initial, { type: "resetCancel" }), {
    ...initial,
    cancelVisible: false,
    cancelDisabled: false,
  });
});

test("failed cancellation and profile reset restore retry without losing the waiting match", () => {
  const pending = automatchState({ type: "selectPending" });
  const canceling = automatchControlsReducer(pending, {
    type: "requestCancellation",
  });
  assert.equal(canceling.cancelDisabled, true);
  const retryable = automatchControlsReducer(canceling, {
    type: "finishCancellation",
  });
  assert.deepEqual(retryable, pending);
  const retrying = automatchControlsReducer(retryable, {
    type: "requestCancellation",
  });
  assert.deepEqual(retrying, canceling);
  const finished = automatchControlsReducer(retrying, { type: "leaveWaiting" });
  assert.equal(finished.waiting, false);
  assert.equal(finished.cancelVisible, false);
  assert.equal(finished.cancelDisabled, false);
});

test("beginning another request preserves explicit visibility and cancel reveal while clearing cancellation disablement", () => {
  const initial = automatchState(
    { type: "selectPending" },
    { type: "requestCancellation" },
    { type: "setVisible", visible: false },
  );
  assert.deepEqual(
    automatchControlsReducer(initial, { type: "beginRequest" }),
    {
      ...initial,
      cancelDisabled: false,
      revealRevision: 2,
    },
  );
});
