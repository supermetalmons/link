import type { EventPrizeDefinition } from "@mons/shared/event-prizes";
import { BRACKET_MATCH_H, BRACKET_MATCH_W } from "./bracketGeometry";

export const BRACKET_AVATAR_PX = 28;
export const BRACKET_THIRD_PLACE_SCALE = 0.86;
export const BRACKET_THIRD_PLACE_MATCH_W = Math.round(
  BRACKET_MATCH_W * BRACKET_THIRD_PLACE_SCALE,
);
export const BRACKET_THIRD_PLACE_MATCH_H = Math.round(
  BRACKET_MATCH_H * BRACKET_THIRD_PLACE_SCALE,
);
export const BRACKET_THIRD_PLACE_AVATAR_PX = Math.round(
  BRACKET_AVATAR_PX * BRACKET_THIRD_PLACE_SCALE,
);
export const BRACKET_THIRD_PLACE_GAP = 10;
export const BRACKET_EDGE_PADDING_X = 24;
export const BRACKET_EDGE_PADDING_Y = 16;
export const CONTENT_AREA_PADDING_PX = 16;
export const WINNER_PODIUM_AVATAR_PX = 34;
export const WINNER_PODIUM_COLUMN_W = 70;
export const WINNER_PODIUM_COLUMN_GAP = 10;
export const WINNER_PODIUM_PRIMARY_BAR_H = 36;
export const WINNER_PODIUM_SECONDARY_BAR_H = 30;
export const WINNER_PODIUM_TERTIARY_BAR_H = 24;
export const WINNER_PODIUM_AVATAR_OVERLAP = 10;
export const WINNER_PODIUM_GAP_FROM_BRACKET = 10;
export const WINNER_PODIUM_AVATAR_UPLIFT_PX = 3;
export const WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX = 5;
export const WINNER_PODIUM_HEIGHT =
  WINNER_PODIUM_PRIMARY_BAR_H +
  WINNER_PODIUM_AVATAR_PX -
  WINNER_PODIUM_AVATAR_OVERLAP;

export const FALLBACK_MATCH_H = 40;
export const FALLBACK_AVATAR_PX = 28;
export const PRIZE_SELECTION_AVATAR_PX = 27;
export const PRIZE_SELECTION_GAP_PX = 12;
export const ENDED_AWARD_PRIZE_GAP_CSS =
  "min(clamp(15px, 5vw, 20px), max(4px, calc((100vh - 320px) * 0.08)))";
export const ENDED_AWARD_LEFT_PRIZE_OFFSET_X_CSS =
  "clamp(-30px, calc(95px - 32vw), 0px)";
export const ENDED_AWARD_RIGHT_PRIZE_OFFSET_X_CSS =
  "clamp(0px, calc(32vw - 95px), 30px)";
export const PRIZE_AVATAR_MOVE_DURATION_MS = 180;
export const PRIZE_AVATAR_APPEAR_DURATION_MS = 130;
export const PRIZE_AVATAR_DISAPPEAR_DURATION_MS = 120;
export const PRIZE_DISPLAY_PLACES = [2, 1, 3] as const;
export const PRIZE_IMAGE_WIDTH_CSS =
  "min(clamp(44.8px, 10.4vh, 96px), calc((min(424px, 100vw - 36px) - 20px) / 3))";
export const ENDED_AWARD_PRIZE_WIDTH_CSS = `min(${PRIZE_IMAGE_WIDTH_CSS}, max(16px, calc((100vh - 320px) * 0.45)))`;
export const EMPTY_EVENT_PRIZES = Object.freeze(
  [],
) as readonly EventPrizeDefinition[];
export const PARTICIPANT_PROFILE_CACHE_TTL_MS = 30_000;

export type BracketCardInteraction = "none" | "game" | "participant";
export type WinnerPodiumPlace = 1 | 2 | 3;
export type PrizeSelectionDensity = "relaxed" | "compact" | "crowded";
export type PendingPrizeAvatarAnimations = {
  previousRects: Map<string, DOMRect>;
  enteringProfileIds: Set<string>;
};

export const getWinnerPodiumBarHeight = (place: WinnerPodiumPlace): number => {
  if (place === 1) {
    return WINNER_PODIUM_PRIMARY_BAR_H;
  }
  if (place === 2) {
    return WINNER_PODIUM_SECONDARY_BAR_H;
  }
  return WINNER_PODIUM_TERTIARY_BAR_H;
};
