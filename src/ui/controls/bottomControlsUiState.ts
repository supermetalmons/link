import type { MaterialName } from "../../services/rocksMiningService";
import {
  createGameControlsState,
  gameControlsReducer,
  type GameControlsAction,
  type GameControlsState,
  type TimerConfig,
} from "./bottomControlsState";

type ReactionPickerState = {
  mode: "closed" | "reactions" | "wager";
  selection: { name: MaterialName | null; count: number };
};

export type BottomControlsUiState = {
  gameControls: GameControlsState;
  popups: {
    navigation: boolean;
    appearance: boolean;
    history: boolean;
    reaction: ReactionPickerState;
  };
};

type DismissPopupTargets = {
  navigation?: boolean;
  appearance?: boolean;
  history?: boolean;
  reaction?: boolean;
  confirmation?: boolean;
};

export type BottomControlsUiAction =
  | { type: "gameControls"; action: GameControlsAction }
  | { type: "toggleNavigation" }
  | { type: "toggleAppearance" }
  | { type: "toggleHistory" }
  | { type: "toggleReaction"; disabled: boolean }
  | ({ type: "dismissPopups" } & DismissPopupTargets)
  | { type: "closeTransient"; preserveNavigation: boolean }
  | { type: "selectNavigationItem"; kind: "event" | "game" | "problem" }
  | { type: "enterWager" }
  | { type: "selectWagerMaterial"; name: MaterialName; total: number };

const createClosedReactionPicker = (): ReactionPickerState => ({
  mode: "closed",
  selection: { name: null, count: 0 },
});

export const createBottomControlsUiState = (
  config: TimerConfig,
): BottomControlsUiState => ({
  gameControls: createGameControlsState(config),
  popups: {
    navigation: false,
    appearance: false,
    history: false,
    reaction: createClosedReactionPicker(),
  },
});

const dismissPopups = (
  state: BottomControlsUiState,
  targets: DismissPopupTargets,
): BottomControlsUiState => {
  const gameControls = targets.confirmation
    ? gameControlsReducer(state.gameControls, {
        type: "setConfirmation",
        confirmation: "none",
      })
    : state.gameControls;
  const navigation = state.popups.navigation && !targets.navigation;
  const appearance = state.popups.appearance && !targets.appearance;
  const history = state.popups.history && !targets.history;
  const reaction =
    targets.reaction && state.popups.reaction.mode !== "closed"
      ? createClosedReactionPicker()
      : state.popups.reaction;
  const popupsUnchanged =
    navigation === state.popups.navigation &&
    appearance === state.popups.appearance &&
    history === state.popups.history &&
    reaction === state.popups.reaction;
  if (gameControls === state.gameControls && popupsUnchanged) return state;
  return {
    gameControls,
    popups: popupsUnchanged
      ? state.popups
      : { navigation, appearance, history, reaction },
  };
};

export const bottomControlsUiReducer = (
  state: BottomControlsUiState,
  action: BottomControlsUiAction,
): BottomControlsUiState => {
  switch (action.type) {
    case "gameControls": {
      const gameControls = gameControlsReducer(
        state.gameControls,
        action.action,
      );
      return gameControls === state.gameControls
        ? state
        : { ...state, gameControls };
    }
    case "toggleNavigation":
      return {
        ...state,
        popups: { ...state.popups, navigation: !state.popups.navigation },
      };
    case "toggleAppearance":
    case "toggleHistory": {
      const popup =
        action.type === "toggleAppearance" ? "appearance" : "history";
      if (state.popups[popup]) {
        return dismissPopups(state, { [popup]: true });
      }
      const dismissed = dismissPopups(state, {
        navigation: true,
        reaction: true,
        confirmation: true,
      });
      return {
        ...dismissed,
        popups: { ...dismissed.popups, [popup]: true },
      };
    }
    case "toggleReaction": {
      if (state.popups.reaction.mode !== "closed") {
        return dismissPopups(state, { reaction: true });
      }
      if (action.disabled) return state;
      const dismissed = dismissPopups(state, {
        history: true,
        confirmation: true,
      });
      return {
        ...dismissed,
        popups: {
          ...dismissed.popups,
          reaction: {
            mode: "reactions",
            selection: { name: null, count: 0 },
          },
        },
      };
    }
    case "dismissPopups":
      return dismissPopups(state, action);
    case "closeTransient":
      return dismissPopups(state, {
        navigation: !action.preserveNavigation,
        appearance: true,
        history: true,
        reaction: true,
        confirmation: true,
      });
    case "selectNavigationItem":
      return dismissPopups(state, {
        navigation: action.kind !== "event",
        appearance: true,
      });
    case "enterWager":
      return state.popups.reaction.mode !== "reactions"
        ? state
        : {
            ...state,
            popups: {
              ...state.popups,
              reaction: { ...state.popups.reaction, mode: "wager" },
            },
          };
    case "selectWagerMaterial": {
      if (state.popups.reaction.mode !== "wager" || action.total <= 0) {
        return state;
      }
      const previous = state.popups.reaction.selection;
      const count =
        previous.name === action.name
          ? Math.min(action.total, previous.count + 1)
          : 1;
      if (previous.name === action.name && previous.count === count)
        return state;
      return {
        ...state,
        popups: {
          ...state.popups,
          reaction: {
            ...state.popups.reaction,
            selection: { name: action.name, count },
          },
        },
      };
    }
  }
};

export const hasBottomControlsPopups = (
  state: BottomControlsUiState,
): boolean =>
  state.popups.appearance ||
  state.popups.history ||
  state.popups.reaction.mode !== "closed" ||
  state.gameControls.confirmation !== "none";
