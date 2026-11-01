import {
  dispatchGameControls,
  updateGameControlsPresentation,
} from "../../game/gameControlsStore";
import type { PrimaryAction } from "./primaryAction";

export { PrimaryActionType, type PrimaryAction } from "./primaryAction";

export type CloseNavigationAndAppearancePopupOptions = {
  preserveNavigationSelection?: boolean;
};

export type BottomControlsApi = {
  closeNavigationAndAppearancePopupIfAny(
    options?: CloseNavigationAndAppearancePopupOptions,
  ): void;
  setNavigationListButtonVisible(visible: boolean): void;
  hasNavigationPopupVisible(): boolean;
  hasBottomPopupsVisible(): boolean;
  showVoiceReactionButton(show: boolean): void;
  setInviteLinkActionVisible(visible: boolean): void;
  setAutomatchEnabled(enabled: boolean): void;
  setAutomatchVisible(visible: boolean): void;
  setAutomatchWaitingState(waiting: boolean): void;
  hideTimerButtons(): void;
  showTimerButtonProgressing(
    currentProgress: number,
    target: number,
    enableWhenTargetReached: boolean,
  ): void;
  toggleReactionPicker(): void;
};

let api: BottomControlsApi | null = null;

export const bindBottomControlsApi = (
  nextApi: BottomControlsApi,
): BottomControlsApi => {
  api = nextApi;
  return nextApi;
};

export const unbindBottomControlsApi = (boundApi: BottomControlsApi): void => {
  if (api === boundApi) {
    api = null;
  }
};

export const closeNavigationAndAppearancePopupIfAny = (
  options?: CloseNavigationAndAppearancePopupOptions,
): void => api?.closeNavigationAndAppearancePopupIfAny(options);

export const setNavigationListButtonVisible = (visible: boolean): void =>
  api?.setNavigationListButtonVisible(visible);

export const hasNavigationPopupVisible = (): boolean =>
  api?.hasNavigationPopupVisible() ?? false;

export const hasBottomPopupsVisible = (): boolean =>
  api?.hasBottomPopupsVisible() ?? false;

export const showVoiceReactionButton = (show: boolean): void =>
  api?.showVoiceReactionButton(show);

export const showMoveHistoryButton = (show: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ moveHistoryVisible: show });
};

export const showResignButton = (): void => {
  if (!api) return;
  dispatchGameControls({ type: "showResign" });
};

export const setInviteLinkActionVisible = (visible: boolean): void =>
  api?.setInviteLinkActionVisible(visible);

export const setAutomatchEnabled = (enabled: boolean): void =>
  api?.setAutomatchEnabled(enabled);

export const setAutomatchVisible = (visible: boolean): void =>
  api?.setAutomatchVisible(visible);

export const setBotGameOptionVisible = (visible: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ botGameVisible: visible });
};

export const setPlaySamePuzzleAgainButtonVisible = (visible: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ replayPuzzleVisible: visible });
};

export const setAutomatchWaitingState = (waiting: boolean): void =>
  api?.setAutomatchWaitingState(waiting);

export const setBrushAndNavigationButtonDimmed = (dimmed: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({
    navigationDimmed: dimmed,
    appearanceDimmed: dimmed,
  });
};

export const showWaitingStateText = (text: string): void => {
  if (!api) return;
  updateGameControlsPresentation({ waitingText: text });
};

export const setHomeVisible = (visible: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ homeVisible: visible });
};

export const setEndMatchVisible = (visible: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ endMatchVisible: visible });
};

export const setEndMatchConfirmed = (confirmed: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ endMatchConfirmed: confirmed });
};

export const setUndoVisible = (visible: boolean): void => {
  if (!api) return;
  dispatchGameControls({ type: "setUndoVisible", visible });
};

export const setAutomoveActionEnabled = (enabled: boolean): void => {
  if (!api) return;
  dispatchGameControls({ type: "setAutomoveEnabled", enabled });
};

export const setAutomoveActionVisible = (visible: boolean): void => {
  if (!api) return;
  dispatchGameControls({ type: "setAutomoveVisible", visible });
};

export const setWatchOnlyVisible = (visible: boolean): void => {
  if (!api) return;
  updateGameControlsPresentation({ watchOnlyVisible: visible });
};

export const setUndoEnabled = (enabled: boolean): void => {
  if (!api) return;
  dispatchGameControls({ type: "setUndoEnabled", enabled });
};

export const disableAndHideUndoResignAndTimerControls = (): void => {
  if (!api) return;
  dispatchGameControls({ type: "hideGameControls" });
};

export const setIsReadyToCopyExistingInviteLink = (): void => {
  if (!api) return;
  updateGameControlsPresentation({ inviteReadyToCopy: true });
};

export const hideTimerButtons = (): void => api?.hideTimerButtons();

export const showTimerButtonProgressing = (
  currentProgress: number,
  target: number,
  enableWhenTargetReached: boolean,
): void =>
  api?.showTimerButtonProgressing(
    currentProgress,
    target,
    enableWhenTargetReached,
  );

/** @knipExternal Called through the injected port in bottomControls.browser.mjs. */
export const toggleReactionPicker = (): void => api?.toggleReactionPicker();

export const enableTimerVictoryClaim = (): void => {
  if (!api) return;
  dispatchGameControls({ type: "showVictoryClaim" });
};

export const showPrimaryAction = (action: PrimaryAction): void => {
  if (!api) return;
  dispatchGameControls({ type: "setPrimaryAction", action });
};

type WagerPanelApi = {
  isVisible(): boolean;
  handleOutsideTap(event: TouchEvent | MouseEvent): boolean;
};

let wagerPanelApi: WagerPanelApi | null = null;

export const setWagerPanelVisibilityChecker = (
  checker: () => boolean,
): void => {
  wagerPanelApi = {
    isVisible: checker,
    handleOutsideTap: wagerPanelApi?.handleOutsideTap ?? (() => false),
  };
};

export const setWagerPanelOutsideTapHandler = (
  handler: ((event: TouchEvent | MouseEvent) => boolean) | null,
): void => {
  wagerPanelApi = {
    isVisible: wagerPanelApi?.isVisible ?? (() => false),
    handleOutsideTap: handler ?? (() => false),
  };
};

export const isWagerPanelVisible = (): boolean =>
  wagerPanelApi?.isVisible() ?? false;

export const handleWagerPanelOutsideTap = (
  event: TouchEvent | MouseEvent,
): boolean => wagerPanelApi?.handleOutsideTap(event) ?? false;

export const resetWagerPanelApi = (): void => {
  wagerPanelApi = null;
};
