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
  createBottomControlsUiState,
  bottomControlsUiReducer,
  hasBottomControlsPopups,
} = await import("../src/ui/controls/bottomControlsUiState.ts");
const { createGameControlsState, gameControlsReducer } =
  await import("../src/ui/controls/bottomControlsState.ts");

const config = Object.freeze({ duration: 60, progress: 10, requestDate: 1000 });
const closedReaction = { mode: "closed", selection: { name: null, count: 0 } };
const wagerReaction = {
  mode: "wager",
  selection: { name: "dust", count: 2 },
};
const freeze = (value) => {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
};
const apply = (...actions) =>
  actions.reduce(
    (state, action) => bottomControlsUiReducer(freeze(state), freeze(action)),
    createBottomControlsUiState(config),
  );
const allOpen = () => {
  const state = createBottomControlsUiState(config);
  return freeze({
    ...state,
    gameControls: { ...state.gameControls, confirmation: "resign" },
    popups: {
      navigation: true,
      appearance: true,
      history: true,
      reaction: wagerReaction,
    },
  });
};
const confirm = (confirmation) => ({
  type: "gameControls",
  action: { type: "setConfirmation", confirmation },
});

test("initial popup state is closed and game controls retain their defaults", () => {
  const state = createBottomControlsUiState(config);
  assert.deepEqual(state, {
    gameControls: createGameControlsState(config),
    popups: {
      navigation: false,
      appearance: false,
      history: false,
      reaction: closedReaction,
    },
  });
  const another = createBottomControlsUiState(config);
  assert.notEqual(
    state.popups.reaction.selection,
    another.popups.reaction.selection,
  );
  assert.notEqual(state.gameControls.timer.config, config);
});

test("navigation can open and close without disturbing other popups or confirmation", () => {
  const initial = allOpen();
  const closed = bottomControlsUiReducer(initial, { type: "toggleNavigation" });
  assert.deepEqual(closed, {
    ...initial,
    popups: { ...initial.popups, navigation: false },
  });
  assert.deepEqual(
    bottomControlsUiReducer(freeze(closed), { type: "toggleNavigation" }),
    initial,
  );
});

test("appearance and history coexist while opening either dismisses navigation, reactions, and confirmations", () => {
  for (const [type, popup] of [
    ["toggleAppearance", "appearance"],
    ["toggleHistory", "history"],
  ]) {
    const initial = allOpen();
    const closed = bottomControlsUiReducer(initial, { type });
    assert.deepEqual(closed, {
      ...initial,
      popups: { ...initial.popups, [popup]: false },
    });
    const reopened = bottomControlsUiReducer(freeze(closed), { type });
    assert.deepEqual(reopened, {
      ...initial,
      gameControls: { ...initial.gameControls, confirmation: "none" },
      popups: {
        navigation: false,
        appearance: true,
        history: true,
        reaction: closedReaction,
      },
    });
  }
});

test("reaction opening preserves appearance and navigation while dismissing history and all confirmations", () => {
  for (const confirmation of ["none", "resign", "timer", "claim"]) {
    const state = apply(
      { type: "toggleAppearance" },
      { type: "toggleHistory" },
      { type: "toggleNavigation" },
      confirm(confirmation),
      { type: "toggleReaction", disabled: false },
    );
    assert.deepEqual(state.popups, {
      navigation: true,
      appearance: true,
      history: false,
      reaction: { mode: "reactions", selection: { name: null, count: 0 } },
    });
    assert.equal(state.gameControls.confirmation, "none");
  }
});

test("disabled reactions cannot open but an already open picker can still close", () => {
  const closed = freeze(apply({ type: "toggleHistory" }, confirm("resign")));
  assert.equal(
    bottomControlsUiReducer(closed, { type: "toggleReaction", disabled: true }),
    closed,
  );
  const initial = allOpen();
  assert.deepEqual(
    bottomControlsUiReducer(initial, {
      type: "toggleReaction",
      disabled: true,
    }),
    { ...initial, popups: { ...initial.popups, reaction: closedReaction } },
  );
});

test("targeted dismissal changes only resolved targets and becomes a no-op when repeated", () => {
  const keys = [
    "navigation",
    "appearance",
    "history",
    "reaction",
    "confirmation",
  ];
  for (let mask = 0; mask < 1 << keys.length; mask += 1) {
    const targets = Object.fromEntries(
      keys.map((key, index) => [key, Boolean(mask & (1 << index))]),
    );
    const action = { type: "dismissPopups", ...targets };
    const initial = allOpen();
    const next = bottomControlsUiReducer(initial, action);
    assert.deepEqual(next, {
      gameControls: {
        ...initial.gameControls,
        confirmation: targets.confirmation ? "none" : "resign",
      },
      popups: {
        navigation: !targets.navigation,
        appearance: !targets.appearance,
        history: !targets.history,
        reaction: targets.reaction ? closedReaction : wagerReaction,
      },
    });
    assert.equal(bottomControlsUiReducer(freeze(next), action), next);
    if (mask === 0) assert.equal(next, initial);
  }
});

test("transient cleanup preserves navigation only when requested and resets the wager selection", () => {
  for (const preserveNavigation of [false, true]) {
    const initial = allOpen();
    const action = { type: "closeTransient", preserveNavigation };
    const next = bottomControlsUiReducer(initial, action);
    assert.deepEqual(next, {
      gameControls: { ...initial.gameControls, confirmation: "none" },
      popups: {
        navigation: preserveNavigation,
        appearance: false,
        history: false,
        reaction: closedReaction,
      },
    });
    assert.equal(bottomControlsUiReducer(freeze(next), action), next);
  }
});

test("navigation selections preserve unrelated popups and event selections retain navigation", () => {
  for (const kind of ["event", "game", "problem"]) {
    const initial = allOpen();
    assert.deepEqual(
      bottomControlsUiReducer(initial, { type: "selectNavigationItem", kind }),
      {
        ...initial,
        popups: {
          ...initial.popups,
          navigation: kind === "event",
          appearance: false,
        },
      },
    );
  }
});

test("wager selection increments to available balance and changing materials starts at one", () => {
  let state = apply(
    { type: "toggleReaction", disabled: false },
    { type: "enterWager" },
    { type: "selectWagerMaterial", name: "dust", total: 2 },
    { type: "selectWagerMaterial", name: "dust", total: 2 },
  );
  assert.deepEqual(state.popups.reaction, wagerReaction);
  for (const action of [
    { type: "enterWager" },
    { type: "selectWagerMaterial", name: "dust", total: 2 },
    { type: "selectWagerMaterial", name: "slime", total: 0 },
    { type: "selectWagerMaterial", name: "slime", total: -1 },
  ]) {
    assert.equal(bottomControlsUiReducer(freeze(state), action), state);
  }
  state = bottomControlsUiReducer(freeze(state), {
    type: "selectWagerMaterial",
    name: "slime",
    total: 4,
  });
  assert.deepEqual(state.popups.reaction.selection, {
    name: "slime",
    count: 1,
  });
});

test("wager actions require an open picker and closing through each path clears selection before reopening", () => {
  const initial = freeze(createBottomControlsUiState(config));
  for (const action of [
    { type: "enterWager" },
    { type: "selectWagerMaterial", name: "dust", total: 3 },
  ]) {
    assert.equal(bottomControlsUiReducer(initial, action), initial);
  }
  for (const close of [
    { type: "toggleReaction", disabled: false },
    { type: "toggleHistory" },
    { type: "toggleAppearance" },
    { type: "dismissPopups", reaction: true },
    { type: "closeTransient", preserveNavigation: true },
  ]) {
    const state = apply(
      { type: "toggleReaction", disabled: false },
      { type: "enterWager" },
      { type: "selectWagerMaterial", name: "dust", total: 3 },
      close,
    );
    assert.deepEqual(state.popups.reaction, closedReaction);
    const reopened = bottomControlsUiReducer(freeze(state), {
      type: "toggleReaction",
      disabled: false,
    });
    assert.deepEqual(reopened.popups.reaction, {
      mode: "reactions",
      selection: { name: null, count: 0 },
    });
  }
});

test("game actions delegate timer and confirmation behavior without changing popup state", () => {
  const actions = [
    { type: "setUndoVisible", visible: true },
    { type: "setUndoEnabled", enabled: true },
    { type: "setAutomoveVisible", visible: true },
    { type: "setAutomoveEnabled", enabled: false },
    { type: "showResign" },
    { type: "setPrimaryAction", action: "rematch" },
    { type: "showTimerProgress", config },
    { type: "enableTimer" },
    { type: "disableTimer" },
    { type: "showVictoryClaim" },
    { type: "disableVictoryClaim" },
    { type: "hideTimers" },
    { type: "hideGameControls" },
    { type: "setConfirmation", confirmation: "timer" },
  ];
  for (const confirmation of ["none", "resign", "timer", "claim"]) {
    let state = bottomControlsUiReducer(allOpen(), confirm(confirmation));
    for (const action of actions) {
      const expected = gameControlsReducer(freeze(state.gameControls), action);
      const next = bottomControlsUiReducer(freeze(state), {
        type: "gameControls",
        action,
      });
      assert.deepEqual(next.gameControls, expected);
      assert.equal(next.popups, state.popups);
      if (expected === state.gameControls) assert.equal(next, state);
      state = next;
    }
  }
});

test("confirmation completion retains synchronous controller callback ordering", () => {
  for (const [actions, expectedMode, enabled] of [
    [
      [
        { type: "showTimerProgress", config },
        { type: "enableTimer" },
        { type: "setConfirmation", confirmation: "timer" },
        { type: "setConfirmation", confirmation: "none" },
        { type: "showTimerProgress", config },
        { type: "enableTimer" },
        { type: "showVictoryClaim" },
        { type: "disableTimer" },
      ],
      "claim",
      "startEnabled",
    ],
    [
      [
        { type: "showVictoryClaim" },
        { type: "setConfirmation", confirmation: "claim" },
        { type: "setConfirmation", confirmation: "none" },
        { type: "showVictoryClaim" },
        { type: "showTimerProgress", config },
        { type: "disableVictoryClaim" },
      ],
      "progressing",
      "claimEnabled",
    ],
  ]) {
    const state = apply(
      ...actions.map((action) => ({ type: "gameControls", action })),
    );
    assert.equal(state.gameControls.timer.mode, expectedMode);
    assert.equal(state.gameControls.timer[enabled], false);
    assert.equal(state.gameControls.confirmation, "none");
  }
});

test("bottom popup visibility includes confirmations and excludes navigation", () => {
  const initial = createBottomControlsUiState(config);
  assert.equal(hasBottomControlsPopups(initial), false);
  assert.equal(
    hasBottomControlsPopups(apply({ type: "toggleNavigation" })),
    false,
  );
  for (const action of [
    { type: "toggleAppearance" },
    { type: "toggleHistory" },
    { type: "toggleReaction", disabled: false },
    confirm("resign"),
    confirm("timer"),
    confirm("claim"),
  ]) {
    assert.equal(hasBottomControlsPopups(apply(action)), true);
  }
  assert.equal(
    hasBottomControlsPopups(
      apply(
        { type: "toggleReaction", disabled: false },
        { type: "enterWager" },
      ),
    ),
    true,
  );
});
