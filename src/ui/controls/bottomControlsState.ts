import { PrimaryActionType, type PrimaryAction } from "./primaryAction";

export type TimerConfig = {
  duration: number;
  progress: number;
  requestDate: number;
};

type GameControlsConfirmation = "none" | "resign" | "timer" | "claim";

export type GameControlsState = {
  undo: { visible: boolean; enabled: boolean };
  automove: { visible: boolean; enabled: boolean };
  resignVisible: boolean;
  primaryAction: PrimaryAction;
  timer: {
    mode: "hidden" | "progressing" | "claim";
    config: TimerConfig;
    startEnabled: boolean;
    claimEnabled: boolean;
  };
  confirmation: GameControlsConfirmation;
};

export type GameControlsAction =
  | { type: "setUndoVisible"; visible: boolean }
  | { type: "setUndoEnabled"; enabled: boolean }
  | { type: "setAutomoveVisible"; visible: boolean }
  | { type: "setAutomoveEnabled"; enabled: boolean }
  | { type: "showResign" }
  | { type: "setPrimaryAction"; action: PrimaryAction }
  | { type: "showTimerProgress"; config: TimerConfig }
  | { type: "enableTimer" }
  | { type: "disableTimer" }
  | { type: "showVictoryClaim" }
  | { type: "disableVictoryClaim" }
  | { type: "hideTimers" }
  | { type: "hideGameControls" }
  | { type: "setConfirmation"; confirmation: GameControlsConfirmation };

export const createGameControlsState = (
  timerConfig: TimerConfig,
): GameControlsState => ({
  undo: { visible: false, enabled: false },
  automove: { visible: false, enabled: true },
  resignVisible: false,
  primaryAction: PrimaryActionType.None,
  timer: {
    mode: "hidden",
    config: { ...timerConfig },
    startEnabled: false,
    claimEnabled: true,
  },
  confirmation: "none",
});

const dismissTimerConfirmation = (
  confirmation: GameControlsConfirmation,
): GameControlsConfirmation => (confirmation === "resign" ? "resign" : "none");

export const gameControlsReducer = (
  state: GameControlsState,
  action: GameControlsAction,
): GameControlsState => {
  switch (action.type) {
    case "setUndoVisible":
      return state.undo.visible === action.visible
        ? state
        : { ...state, undo: { ...state.undo, visible: action.visible } };
    case "setUndoEnabled":
      return state.undo.enabled === action.enabled
        ? state
        : { ...state, undo: { ...state.undo, enabled: action.enabled } };
    case "setAutomoveVisible":
      if (state.automove.visible === action.visible) return state;
      return {
        ...state,
        automove: { ...state.automove, visible: action.visible },
      };
    case "setAutomoveEnabled":
      if (state.automove.enabled === action.enabled) return state;
      return {
        ...state,
        automove: { ...state.automove, enabled: action.enabled },
      };
    case "showResign":
      return state.resignVisible ? state : { ...state, resignVisible: true };
    case "setPrimaryAction":
      return state.primaryAction === action.action
        ? state
        : { ...state, primaryAction: action.action };
    case "showTimerProgress":
      return {
        ...state,
        undo: { ...state.undo, visible: false },
        automove: { ...state.automove, visible: false },
        timer: {
          ...state.timer,
          mode: "progressing",
          config: { ...action.config },
          startEnabled: false,
        },
        confirmation: dismissTimerConfirmation(state.confirmation),
      };
    case "enableTimer":
      return state.timer.mode === "progressing" && !state.timer.startEnabled
        ? { ...state, timer: { ...state.timer, startEnabled: true } }
        : state;
    case "disableTimer":
      return state.timer.startEnabled
        ? { ...state, timer: { ...state.timer, startEnabled: false } }
        : state;
    case "showVictoryClaim":
      if (
        !state.undo.visible &&
        !state.automove.visible &&
        state.timer.mode === "claim" &&
        state.timer.claimEnabled &&
        state.confirmation === dismissTimerConfirmation(state.confirmation)
      )
        return state;
      return {
        ...state,
        undo: { ...state.undo, visible: false },
        automove: { ...state.automove, visible: false },
        timer: { ...state.timer, mode: "claim", claimEnabled: true },
        confirmation: dismissTimerConfirmation(state.confirmation),
      };
    case "disableVictoryClaim":
      return state.timer.claimEnabled
        ? { ...state, timer: { ...state.timer, claimEnabled: false } }
        : state;
    case "hideTimers":
      if (
        state.timer.mode === "hidden" &&
        !state.timer.startEnabled &&
        state.confirmation === dismissTimerConfirmation(state.confirmation)
      )
        return state;
      return {
        ...state,
        timer: { ...state.timer, mode: "hidden", startEnabled: false },
        confirmation: dismissTimerConfirmation(state.confirmation),
      };
    case "hideGameControls":
      if (
        !state.undo.visible &&
        !state.undo.enabled &&
        !state.automove.visible &&
        !state.resignVisible &&
        state.timer.mode === "hidden" &&
        state.confirmation === "none"
      )
        return state;
      return {
        ...state,
        undo: { visible: false, enabled: false },
        automove: { ...state.automove, visible: false },
        resignVisible: false,
        timer: { ...state.timer, mode: "hidden" },
        confirmation: "none",
      };
    case "setConfirmation":
      return state.confirmation === action.confirmation
        ? state
        : { ...state, confirmation: action.confirmation };
  }
};

export type AutomatchControlsState = {
  visible: boolean;
  enabled: boolean;
  waiting: boolean;
  cancelVisible: boolean;
  cancelDisabled: boolean;
  revealRevision: number;
};

export type AutomatchControlsAction =
  | { type: "beginRequest" }
  | { type: "enterWaiting" }
  | { type: "leaveWaiting" }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "setVisible"; visible: boolean }
  | { type: "revealCancel" }
  | { type: "hideCancel" }
  | { type: "resetCancel" }
  | { type: "requestCancellation" }
  | { type: "finishCancellation" }
  | { type: "selectPending" };

export const createAutomatchControlsState = (): AutomatchControlsState => ({
  visible: false,
  enabled: true,
  waiting: false,
  cancelVisible: false,
  cancelDisabled: false,
  revealRevision: 0,
});

export const automatchControlsReducer = (
  state: AutomatchControlsState,
  action: AutomatchControlsAction,
): AutomatchControlsState => {
  switch (action.type) {
    case "beginRequest":
      return {
        ...state,
        enabled: false,
        waiting: true,
        cancelDisabled: false,
        revealRevision: state.revealRevision + 1,
      };
    case "enterWaiting":
      return {
        ...state,
        visible: true,
        enabled: false,
        waiting: true,
        revealRevision: state.revealRevision + 1,
      };
    case "leaveWaiting":
      if (!state.waiting && !state.cancelVisible && !state.cancelDisabled) {
        return state;
      }
      return {
        ...state,
        waiting: false,
        cancelVisible: false,
        cancelDisabled: false,
      };
    case "setEnabled":
      return state.enabled === action.enabled && !state.waiting
        ? state
        : { ...state, enabled: action.enabled, waiting: false };
    case "setVisible":
      return state.visible === action.visible
        ? state
        : { ...state, visible: action.visible };
    case "revealCancel":
      return state.waiting && state.visible && !state.cancelVisible
        ? { ...state, cancelVisible: true }
        : state;
    case "hideCancel":
      return state.cancelVisible ? { ...state, cancelVisible: false } : state;
    case "resetCancel":
      return state.cancelVisible || state.cancelDisabled
        ? { ...state, cancelVisible: false, cancelDisabled: false }
        : state;
    case "requestCancellation":
      return state.cancelDisabled ? state : { ...state, cancelDisabled: true };
    case "finishCancellation":
      return state.cancelDisabled ? { ...state, cancelDisabled: false } : state;
    case "selectPending":
      return {
        ...state,
        visible: true,
        enabled: false,
        waiting: true,
        cancelVisible: true,
        cancelDisabled: false,
        revealRevision: state.revealRevision + 1,
      };
  }
};
