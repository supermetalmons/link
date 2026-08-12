import type { BotAutomoveMode } from "./botAutomoveMode";

export type BoardEndOfGameMarker = "none" | "victory" | "resign";
export type BoardTimerColor = "green" | "orange" | "red";

export type BoardInviteBotButtonLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePx: number;
  horizontalPaddingPx: number;
};

export type BoardPlayerInfoSlotState = {
  visible: boolean;
  nameVisible: boolean;
  scoreText: string;
  nameText: string;
  nameReactionText: string;
  timerText: string;
  timerVisible: boolean;
  timerColor: BoardTimerColor;
  endOfGameMarker: BoardEndOfGameMarker;
  profileMetadataIsOpponent: boolean | null;
};

export type BoardPlayerInfoOverlayState = {
  player: BoardPlayerInfoSlotState;
  opponent: BoardPlayerInfoSlotState;
  topControlSlot: "player" | "opponent";
  botStrengthControlVisible: boolean;
  botStrengthControlMode: BotAutomoveMode;
  wagerLayoutRevision: number;
};

export const createEmptyPlayerInfoSlotState = (): BoardPlayerInfoSlotState => ({
  visible: false,
  nameVisible: false,
  scoreText: "",
  nameText: "",
  nameReactionText: "",
  timerText: "",
  timerVisible: false,
  timerColor: "green",
  endOfGameMarker: "none",
  profileMetadataIsOpponent: null,
});

export const createEmptyPlayerInfoOverlayState =
  (): BoardPlayerInfoOverlayState => ({
    player: createEmptyPlayerInfoSlotState(),
    opponent: createEmptyPlayerInfoSlotState(),
    topControlSlot: "opponent",
    botStrengthControlVisible: false,
    botStrengthControlMode: "normal",
    wagerLayoutRevision: 0,
  });

export const playerInfoSlotStatesEqual = (
  a: BoardPlayerInfoSlotState,
  b: BoardPlayerInfoSlotState,
): boolean =>
  a.visible === b.visible &&
  a.nameVisible === b.nameVisible &&
  a.scoreText === b.scoreText &&
  a.nameText === b.nameText &&
  a.nameReactionText === b.nameReactionText &&
  a.timerText === b.timerText &&
  a.timerVisible === b.timerVisible &&
  a.timerColor === b.timerColor &&
  a.endOfGameMarker === b.endOfGameMarker &&
  a.profileMetadataIsOpponent === b.profileMetadataIsOpponent;

export const playerInfoOverlayStatesEqual = (
  a: BoardPlayerInfoOverlayState,
  b: BoardPlayerInfoOverlayState,
): boolean =>
  playerInfoSlotStatesEqual(a.player, b.player) &&
  playerInfoSlotStatesEqual(a.opponent, b.opponent) &&
  a.topControlSlot === b.topControlSlot &&
  a.botStrengthControlVisible === b.botStrengthControlVisible &&
  a.botStrengthControlMode === b.botStrengthControlMode &&
  a.wagerLayoutRevision === b.wagerLayoutRevision;

export type BoardUiHandlers = {
  updateBoardComponentForBoardStyleChange(): void;
  setTopBoardOverlayVisible(
    blurry: boolean,
    svgElement: SVGElement | null,
    withConfirmAndCancelButtons: boolean,
    ok?: () => void,
    cancel?: () => void,
  ): void;
  showRaibowAura(visible: boolean, url: string, opponent: boolean): void;
  updateAuraForAvatarElement(
    opponent: boolean,
    avatarElement: SVGElement,
  ): void;
  updateWagerPlayerUids(playerUid: string, opponentUid: string): void;
  setBoardPlayerInfoOverlayState(state: BoardPlayerInfoOverlayState): void;
};

let handlers: BoardUiHandlers | null = null;

export const bindBoardUiHandlers = (nextHandlers: BoardUiHandlers): void => {
  handlers = nextHandlers;
};

export const resetBoardUiHandlers = (): void => {
  handlers = null;
};

export const updateBoardComponentForBoardStyleChange = (): void => {
  handlers?.updateBoardComponentForBoardStyleChange();
};

export const setTopBoardOverlayVisible = (
  blurry: boolean,
  svgElement: SVGElement | null,
  withConfirmAndCancelButtons: boolean,
  ok?: () => void,
  cancel?: () => void,
): void => {
  handlers?.setTopBoardOverlayVisible(
    blurry,
    svgElement,
    withConfirmAndCancelButtons,
    ok,
    cancel,
  );
};

export const showRaibowAura = (
  visible: boolean,
  url: string,
  opponent: boolean,
): void => {
  handlers?.showRaibowAura(visible, url, opponent);
};

export const updateAuraForAvatarElement = (
  opponent: boolean,
  avatarElement: SVGElement,
): void => {
  handlers?.updateAuraForAvatarElement(opponent, avatarElement);
};

export const updateWagerPlayerUids = (
  playerUid: string,
  opponentUid: string,
): void => {
  handlers?.updateWagerPlayerUids(playerUid, opponentUid);
};

export const setBoardPlayerInfoOverlayState = (
  state: BoardPlayerInfoOverlayState,
): void => {
  handlers?.setBoardPlayerInfoOverlayState(state);
};
