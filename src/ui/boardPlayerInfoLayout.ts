import type { BotAutomoveMode } from "../game/botAutomoveMode";
import type {
  BoardEndOfGameMarker,
  BoardInviteBotButtonLayout,
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
} from "../game/boardUiPort";
import { WAGER_WIN_PILE_SCALE as WAGER_WIN_STACK_SCALE } from "../game/boardWagerModels";
import type {
  WagerPileSide,
  WagerPileRect,
  WagerSlotLayout,
} from "../game/boardWagerModels";
import { BOARD_WIDTH_UNITS, BOARD_HEIGHT_UNITS } from "./boardOverlayGeometry";

type BotStrengthControlOverlayState = {
  visible: boolean;
  mode: BotAutomoveMode;
  x: number;
  y: number;
  size: number;
};

const MIN_HORIZONTAL_OFFSET = 0.21;
const END_OF_GAME_ICON_SIZE_MULTIPLIER = 0.53;
const END_OF_GAME_ICON_GAP_MULTIPLIER = 0.06;
const END_OF_GAME_NAME_OFFSET_MULTIPLIER = 0.54;
const SCORE_TEXT_FONT_SIZE_MULTIPLIER = 50;
const INVITE_BOT_BUTTON_FONT_TO_SCORE_RATIO = 0.68;
const INVITE_BOT_BUTTON_X_GAP_MULTIPLIER = 0.18;
const INVITE_BOT_BUTTON_HEIGHT_TO_FONT_RATIO = 2.1;
const INVITE_BOT_BUTTON_MIN_FONT_SIZE_PX = 12;
const INVITE_BOT_BUTTON_PADDING_TO_FONT_RATIO = 0.9;
const INVITE_BOT_BUTTON_TEXT_WIDTH_TO_FONT_RATIO = 5.5;
const BOT_STRENGTH_BUTTON_SCALE = 1.23;
const BOT_STRENGTH_BUTTON_SIZE_TO_INVITE_HEIGHT =
  0.82 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_BUTTON_NAME_GAP_MULTIPLIER =
  0.12 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_VOICE_REACTION_EXTRA_GAP_MULTIPLIER =
  0.08 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_BUTTON_LEFT_SHIFT_MULTIPLIER = 0.045;
const WAGER_STACK_NAME_GAP_MULTIPLIER = 0.13;
const WAGER_STACK_WIDTH_MULTIPLIER = 1.08;
const WAGER_STACK_HEIGHT_MULTIPLIER = 0.94;

export type EndOfGameIconHrefs = Record<
  Exclude<BoardEndOfGameMarker, "none">,
  string
>;

export type BoardTextMeasurement = {
  width: number;
  bounds: { y: number; height: number } | null;
};

export type BoardPlayerInfoMeasurements = {
  playerScore: BoardTextMeasurement;
  opponentScore: BoardTextMeasurement;
  playerTimer: BoardTextMeasurement;
  opponentTimer: BoardTextMeasurement;
  playerName: BoardTextMeasurement;
  opponentName: BoardTextMeasurement;
};

export type BoardPlayerInfoSlotLayout = {
  scoreX: number;
  scoreY: number;
  timerX: number;
  timerY: number;
  nameX: number;
  nameY: number;
  scoreFontSize: number;
  nameFontSize: number;
  endOfGameIcon: {
    visible: boolean;
    href: string;
    x: number;
    y: number;
    size: number;
  };
};

type BoardPlayerInfoLayout = {
  player: BoardPlayerInfoSlotLayout;
  opponent: BoardPlayerInfoSlotLayout;
  inviteBotButtonLayout: BoardInviteBotButtonLayout | null;
  botStrengthControlOverlay: BotStrengthControlOverlayState;
};

export const emptyTextMeasurement: BoardTextMeasurement = {
  width: 0,
  bounds: null,
};

const textMeasurementsEqual = (
  a: BoardTextMeasurement,
  b: BoardTextMeasurement,
) =>
  a.width === b.width &&
  a.bounds?.y === b.bounds?.y &&
  a.bounds?.height === b.bounds?.height;

const playerInfoMeasurementsEqual = (
  a: BoardPlayerInfoMeasurements,
  b: BoardPlayerInfoMeasurements,
) =>
  textMeasurementsEqual(a.playerScore, b.playerScore) &&
  textMeasurementsEqual(a.opponentScore, b.opponentScore) &&
  textMeasurementsEqual(a.playerTimer, b.playerTimer) &&
  textMeasurementsEqual(a.opponentTimer, b.opponentTimer) &&
  textMeasurementsEqual(a.playerName, b.playerName) &&
  textMeasurementsEqual(a.opponentName, b.opponentName);

export const mergePlayerInfoMeasurements = (
  prevMeasurements: BoardPlayerInfoMeasurements,
  measurements: Partial<BoardPlayerInfoMeasurements>,
) => {
  const nextMeasurements = { ...prevMeasurements, ...measurements };
  return playerInfoMeasurementsEqual(prevMeasurements, nextMeasurements)
    ? prevMeasurements
    : nextMeasurements;
};

export const getOuterElementsMultiplicator = (
  boardPixelSize: { width: number; height: number } | null,
) => Math.min(420 / (boardPixelSize?.width || 420), 1);

const getAvatarSize = (
  boardPixelSize: { width: number; height: number } | null,
) => 0.777 * getOuterElementsMultiplicator(boardPixelSize);

export type WagerSlotLayoutBySide = Record<WagerPileSide, WagerSlotLayout>;

const hiddenWagerRect: WagerPileRect = { x: 0, y: 0, w: 0, h: 0 };
const hiddenWagerSlotLayout: WagerSlotLayout = {
  pile: hiddenWagerRect,
  winner: hiddenWagerRect,
};

const clampBoardRect = (
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } => ({
  x: Math.max(0, Math.min(BOARD_WIDTH_UNITS - w, x)),
  y: Math.max(0, Math.min(BOARD_HEIGHT_UNITS - h, y)),
  w,
  h,
});

const getWagerStackRectForName = (
  slotLayout: BoardPlayerInfoSlotLayout,
  nameMeasurement: BoardTextMeasurement,
  boardPixelSize: { width: number; height: number } | null,
  scale: number,
) => {
  const multiplicator = getOuterElementsMultiplicator(boardPixelSize);
  const avatarSize = getAvatarSize(boardPixelSize);
  const w = avatarSize * WAGER_STACK_WIDTH_MULTIPLIER * scale;
  const h = avatarSize * WAGER_STACK_HEIGHT_MULTIPLIER * scale;
  const x =
    slotLayout.nameX +
    nameMeasurement.width +
    WAGER_STACK_NAME_GAP_MULTIPLIER * multiplicator;
  const y = slotLayout.nameY - h * 0.86;
  return clampBoardRect(x, y, w, h);
};

export const getWagerSlotLayoutForName = (
  slotLayout: BoardPlayerInfoSlotLayout,
  nameMeasurement: BoardTextMeasurement,
  boardPixelSize: { width: number; height: number } | null,
  hasVisibleName: boolean,
): WagerSlotLayout => {
  if (!hasVisibleName) {
    return hiddenWagerSlotLayout;
  }
  return {
    pile: getWagerStackRectForName(
      slotLayout,
      nameMeasurement,
      boardPixelSize,
      1,
    ),
    winner: getWagerStackRectForName(
      slotLayout,
      nameMeasurement,
      boardPixelSize,
      WAGER_WIN_STACK_SCALE,
    ),
  };
};

export const playerInfoSlotHasVisibleName = (
  slot: BoardPlayerInfoSlotState,
) => {
  return slot.nameVisible && slot.nameText !== "";
};

export const playerInfoSlotHasNameReaction = (slot: BoardPlayerInfoSlotState) =>
  slot.nameReactionText !== "";

const getInviteBotButtonLayout = (
  scoreX: number,
  scoreY: number,
  scoreWidth: number,
  multiplicator: number,
  avatarSize: number,
): BoardInviteBotButtonLayout => {
  const scoreFontBoardUnits =
    (SCORE_TEXT_FONT_SIZE_MULTIPLIER * multiplicator) / 100;
  const fontSizePx = Math.max(
    INVITE_BOT_BUTTON_MIN_FONT_SIZE_PX,
    Math.round(
      SCORE_TEXT_FONT_SIZE_MULTIPLIER *
        multiplicator *
        INVITE_BOT_BUTTON_FONT_TO_SCORE_RATIO,
    ),
  );
  const fontBoardUnits = fontSizePx / 100;
  const height = Math.min(
    fontBoardUnits * INVITE_BOT_BUTTON_HEIGHT_TO_FONT_RATIO,
    avatarSize * 0.88,
  );
  const x =
    scoreX + scoreWidth + INVITE_BOT_BUTTON_X_GAP_MULTIPLIER * multiplicator;
  const horizontalPaddingPx = Math.max(
    6,
    Math.round(fontSizePx * INVITE_BOT_BUTTON_PADDING_TO_FONT_RATIO),
  );
  const width =
    (fontSizePx * INVITE_BOT_BUTTON_TEXT_WIDTH_TO_FONT_RATIO +
      2 * horizontalPaddingPx) /
    100;
  const scoreCenterY = scoreY - scoreFontBoardUnits * 0.35;
  const y = scoreCenterY - height / 2 - 0.023 * multiplicator;
  return { x, y, width, height, fontSizePx, horizontalPaddingPx };
};

const getBotStrengthControlLayout = (
  inviteLayout: BoardInviteBotButtonLayout,
  multiplicator: number,
): { x: number; y: number; size: number } => {
  const size = inviteLayout.height * BOT_STRENGTH_BUTTON_SIZE_TO_INVITE_HEIGHT;
  const x =
    inviteLayout.x - BOT_STRENGTH_BUTTON_LEFT_SHIFT_MULTIPLIER * multiplicator;
  const y = inviteLayout.y + (inviteLayout.height - size) / 2;
  return { x, y, size };
};

const getEndOfGameIconHref = (
  marker: BoardEndOfGameMarker,
  iconHrefs: EndOfGameIconHrefs,
) => {
  if (marker === "none") {
    return "";
  }
  return iconHrefs[marker];
};

const getDynamicNameDelta = ({
  initialX,
  scoreX,
  scoreWidth,
  timerX,
  timerWidth,
  showsTimer,
  endOfGameIcon,
  showsEndOfGameMarker,
  multiplicator,
  extraSpacing = 0,
}: {
  initialX: number;
  scoreX: number;
  scoreWidth: number;
  timerX: number;
  timerWidth: number;
  showsTimer: boolean;
  endOfGameIcon: BoardPlayerInfoSlotLayout["endOfGameIcon"];
  showsEndOfGameMarker: boolean;
  multiplicator: number;
  extraSpacing?: number;
}) => {
  const spacing = 0.14 * multiplicator + extraSpacing;
  const scoreRight = scoreX + scoreWidth;
  let minNameX = scoreRight + spacing;
  if (showsEndOfGameMarker && endOfGameIcon.visible) {
    minNameX = Math.max(
      minNameX,
      endOfGameIcon.x + endOfGameIcon.size + spacing,
    );
  } else if (showsEndOfGameMarker) {
    minNameX = Math.max(
      minNameX,
      scoreRight +
        END_OF_GAME_ICON_GAP_MULTIPLIER * multiplicator +
        END_OF_GAME_ICON_SIZE_MULTIPLIER * multiplicator +
        spacing,
    );
  }
  if (showsTimer) {
    minNameX = Math.max(minNameX, timerX + timerWidth + spacing);
  }
  return Math.max(0, minNameX - initialX);
};

export const getBoardPlayerInfoLayout = (
  state: BoardPlayerInfoOverlayState,
  measurements: BoardPlayerInfoMeasurements,
  iconHrefs: EndOfGameIconHrefs,
  boardPixelSize: { width: number; height: number } | null,
  shouldOffsetFromBorders: boolean,
  isPangchiuBoardLayout: boolean,
): BoardPlayerInfoLayout => {
  const multiplicator = getOuterElementsMultiplicator(boardPixelSize);
  const avatarSize = getAvatarSize(boardPixelSize);
  const scoreFontSize = SCORE_TEXT_FONT_SIZE_MULTIPLIER * multiplicator;
  const nameFontSize = 32 * multiplicator;
  const offsetX = shouldOffsetFromBorders ? MIN_HORIZONTAL_OFFSET : 0;
  const iconSize = END_OF_GAME_ICON_SIZE_MULTIPLIER * multiplicator;
  const iconGap = END_OF_GAME_ICON_GAP_MULTIPLIER * multiplicator;

  const baseForSlot = (
    slot: WagerPileSide,
    scoreMeasurement: BoardTextMeasurement,
  ) => {
    const isOpponent = slot === "opponent";
    const y = isOpponent
      ? 1 - avatarSize * 1.203
      : isPangchiuBoardLayout
        ? 12.75
        : 12.16;
    const scoreX = offsetX + avatarSize * 1.21;
    const scoreY = y + avatarSize * 0.73;
    const timerX = offsetX + avatarSize * 1.85;
    const timerY = scoreY;
    const nameY = y + avatarSize * 0.65;
    const inviteLayout = getInviteBotButtonLayout(
      scoreX,
      scoreY,
      scoreMeasurement.width,
      multiplicator,
      avatarSize,
    );
    const botLayout = getBotStrengthControlLayout(inviteLayout, multiplicator);
    return {
      scoreX,
      scoreY,
      timerX,
      timerY,
      nameY,
      inviteLayout,
      botLayout,
    };
  };

  const playerBase = baseForSlot("player", measurements.playerScore);
  const opponentBase = baseForSlot("opponent", measurements.opponentScore);
  const topBase = state.topControlSlot === "player" ? playerBase : opponentBase;
  const topBotLayout = topBase.botLayout;
  const inviteBotButtonLayout = topBase.inviteLayout;

  const getIconLayout = (
    slotState: BoardPlayerInfoSlotState,
    base: ReturnType<typeof baseForSlot>,
    scoreMeasurement: BoardTextMeasurement,
    isTopControlSlot: boolean,
  ): BoardPlayerInfoSlotLayout["endOfGameIcon"] => {
    const visible =
      slotState.visible &&
      slotState.endOfGameMarker !== "none" &&
      slotState.scoreText !== "";
    if (!visible) {
      return {
        visible: false,
        href: "",
        x: 0,
        y: 0,
        size: iconSize,
      };
    }
    let iconX = base.scoreX + scoreMeasurement.width + iconGap;
    if (isTopControlSlot && state.botStrengthControlVisible) {
      iconX = Math.max(iconX, topBotLayout.x + topBotLayout.size + iconGap);
    }
    let iconY = base.scoreY - iconSize * 0.8;
    if (scoreMeasurement.bounds) {
      iconY =
        scoreMeasurement.bounds.y +
        (scoreMeasurement.bounds.height - iconSize) / 2;
    }
    return {
      visible: true,
      href: getEndOfGameIconHref(slotState.endOfGameMarker, iconHrefs),
      x: iconX,
      y: iconY,
      size: iconSize,
    };
  };

  const playerIcon = getIconLayout(
    state.player,
    playerBase,
    measurements.playerScore,
    state.topControlSlot === "player",
  );
  const opponentIcon = getIconLayout(
    state.opponent,
    opponentBase,
    measurements.opponentScore,
    state.topControlSlot === "opponent",
  );

  const initialX = offsetX + 1.45 * multiplicator + 0.1;
  const timerDelta = 0.95 * multiplicator;
  const statusDelta = END_OF_GAME_NAME_OFFSET_MULTIPLIER * multiplicator;
  const playerHasEndOfGameMarker = state.player.endOfGameMarker !== "none";
  const opponentHasEndOfGameMarker = state.opponent.endOfGameMarker !== "none";
  const topControlSlotState =
    state.topControlSlot === "player" ? state.player : state.opponent;
  const topControlSlotHasEndOfGameMarker =
    topControlSlotState.endOfGameMarker !== "none";
  const topControlHasVoiceReaction =
    playerInfoSlotHasNameReaction(topControlSlotState);
  const topVoiceReactionExtraSpacing =
    state.botStrengthControlVisible &&
    topControlSlotHasEndOfGameMarker &&
    topControlHasVoiceReaction
      ? BOT_STRENGTH_VOICE_REACTION_EXTRA_GAP_MULTIPLIER * multiplicator
      : 0;

  const playerStaticDelta =
    (playerHasEndOfGameMarker ? statusDelta : 0) +
    (state.player.timerVisible ? timerDelta : 0);
  const opponentStaticDelta =
    (opponentHasEndOfGameMarker ? statusDelta : 0) +
    (state.opponent.timerVisible ? timerDelta : 0);
  const playerDynamicDelta = getDynamicNameDelta({
    initialX,
    scoreX: playerBase.scoreX,
    scoreWidth: measurements.playerScore.width,
    timerX: playerBase.timerX,
    timerWidth: measurements.playerTimer.width,
    showsTimer: state.player.timerVisible,
    endOfGameIcon: playerIcon,
    showsEndOfGameMarker: playerHasEndOfGameMarker,
    multiplicator,
    extraSpacing:
      state.topControlSlot === "player" ? topVoiceReactionExtraSpacing : 0,
  });
  const opponentDynamicDelta = getDynamicNameDelta({
    initialX,
    scoreX: opponentBase.scoreX,
    scoreWidth: measurements.opponentScore.width,
    timerX: opponentBase.timerX,
    timerWidth: measurements.opponentTimer.width,
    showsTimer: state.opponent.timerVisible,
    endOfGameIcon: opponentIcon,
    showsEndOfGameMarker: opponentHasEndOfGameMarker,
    multiplicator,
    extraSpacing:
      state.topControlSlot === "opponent" ? topVoiceReactionExtraSpacing : 0,
  });

  let playerBotStrengthDelta = 0;
  let opponentBotStrengthDelta = 0;
  if (state.botStrengthControlVisible) {
    const minNameX =
      topBotLayout.x +
      topBotLayout.size +
      BOT_STRENGTH_BUTTON_NAME_GAP_MULTIPLIER * multiplicator;
    const delta = Math.max(0, minNameX - initialX);
    if (state.topControlSlot === "player") {
      playerBotStrengthDelta = delta;
    } else {
      opponentBotStrengthDelta = delta;
    }
  }

  return {
    player: {
      ...playerBase,
      nameX:
        initialX +
        Math.max(playerStaticDelta, playerDynamicDelta, playerBotStrengthDelta),
      scoreFontSize,
      nameFontSize,
      endOfGameIcon: playerIcon,
    },
    opponent: {
      ...opponentBase,
      nameX:
        initialX +
        Math.max(
          opponentStaticDelta,
          opponentDynamicDelta,
          opponentBotStrengthDelta,
        ),
      scoreFontSize,
      nameFontSize,
      endOfGameIcon: opponentIcon,
    },
    inviteBotButtonLayout,
    botStrengthControlOverlay: {
      visible: state.botStrengthControlVisible && topBotLayout.size > 0,
      mode: state.botStrengthControlMode,
      x: topBotLayout.x,
      y: topBotLayout.y,
      size: topBotLayout.size,
    },
  };
};
