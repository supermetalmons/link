export const primaryActionTypes = {
  None: "none",
  JoinGame: "joinGame",
  Rematch: "rematch",
} as const;

export const PrimaryActionType = primaryActionTypes;
export type PrimaryAction =
  (typeof primaryActionTypes)[keyof typeof primaryActionTypes];

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
  showMoveHistoryButton(show: boolean): void;
  showResignButton(): void;
  setInviteLinkActionVisible(visible: boolean): void;
  setAutomatchEnabled(enabled: boolean): void;
  setAutomatchVisible(visible: boolean): void;
  setBotGameOptionVisible(visible: boolean): void;
  setPlaySamePuzzleAgainButtonVisible(visible: boolean): void;
  setAutomatchWaitingState(waiting: boolean): void;
  setBrushAndNavigationButtonDimmed(dimmed: boolean): void;
  showWaitingStateText(text: string): void;
  setHomeVisible(visible: boolean): void;
  setEndMatchVisible(visible: boolean): void;
  setEndMatchConfirmed(confirmed: boolean): void;
  setUndoVisible(visible: boolean): void;
  setAutomoveActionEnabled(enabled: boolean): void;
  setAutomoveActionVisible(visible: boolean): void;
  setWatchOnlyVisible(visible: boolean): void;
  setUndoEnabled(enabled: boolean): void;
  disableAndHideUndoResignAndTimerControls(): void;
  setIsReadyToCopyExistingInviteLink(): void;
  hideTimerButtons(): void;
  showTimerButtonProgressing(
    currentProgress: number,
    target: number,
    enableWhenTargetReached: boolean,
  ): void;
  toggleReactionPicker(): void;
  enableTimerVictoryClaim(): void;
  showPrimaryAction(action: PrimaryAction): void;
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

export const showMoveHistoryButton = (show: boolean): void =>
  api?.showMoveHistoryButton(show);

export const showResignButton = (): void => api?.showResignButton();

export const setInviteLinkActionVisible = (visible: boolean): void =>
  api?.setInviteLinkActionVisible(visible);

export const setAutomatchEnabled = (enabled: boolean): void =>
  api?.setAutomatchEnabled(enabled);

export const setAutomatchVisible = (visible: boolean): void =>
  api?.setAutomatchVisible(visible);

export const setBotGameOptionVisible = (visible: boolean): void =>
  api?.setBotGameOptionVisible(visible);

export const setPlaySamePuzzleAgainButtonVisible = (visible: boolean): void =>
  api?.setPlaySamePuzzleAgainButtonVisible(visible);

export const setAutomatchWaitingState = (waiting: boolean): void =>
  api?.setAutomatchWaitingState(waiting);

export const setBrushAndNavigationButtonDimmed = (dimmed: boolean): void =>
  api?.setBrushAndNavigationButtonDimmed(dimmed);

export const showWaitingStateText = (text: string): void =>
  api?.showWaitingStateText(text);

export const setHomeVisible = (visible: boolean): void =>
  api?.setHomeVisible(visible);

export const setEndMatchVisible = (visible: boolean): void =>
  api?.setEndMatchVisible(visible);

export const setEndMatchConfirmed = (confirmed: boolean): void =>
  api?.setEndMatchConfirmed(confirmed);

export const setUndoVisible = (visible: boolean): void =>
  api?.setUndoVisible(visible);

export const setAutomoveActionEnabled = (enabled: boolean): void =>
  api?.setAutomoveActionEnabled(enabled);

export const setAutomoveActionVisible = (visible: boolean): void =>
  api?.setAutomoveActionVisible(visible);

export const setWatchOnlyVisible = (visible: boolean): void =>
  api?.setWatchOnlyVisible(visible);

export const setUndoEnabled = (enabled: boolean): void =>
  api?.setUndoEnabled(enabled);

export const disableAndHideUndoResignAndTimerControls = (): void =>
  api?.disableAndHideUndoResignAndTimerControls();

export const setIsReadyToCopyExistingInviteLink = (): void =>
  api?.setIsReadyToCopyExistingInviteLink();

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

export const toggleReactionPicker = (): void => api?.toggleReactionPicker();

export const enableTimerVictoryClaim = (): void =>
  api?.enableTimerVictoryClaim();

export const showPrimaryAction = (action: PrimaryAction): void =>
  api?.showPrimaryAction(action);

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
