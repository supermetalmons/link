import styled, { css, keyframes } from "styled-components";
import { EVENT_MODAL_Z_INDEX } from "./modalState";
import {
  CONTENT_AREA_PADDING_PX,
  ENDED_AWARD_LEFT_PRIZE_OFFSET_X_CSS,
  ENDED_AWARD_PRIZE_GAP_CSS,
  ENDED_AWARD_PRIZE_WIDTH_CSS,
  ENDED_AWARD_RIGHT_PRIZE_OFFSET_X_CSS,
  FALLBACK_MATCH_H,
  PRIZE_IMAGE_WIDTH_CSS,
  PRIZE_SELECTION_AVATAR_PX,
  PRIZE_SELECTION_GAP_PX,
  type BracketCardInteraction,
  type PrizeSelectionDensity,
  type WinnerPodiumPlace,
  getWinnerPodiumBarHeight,
  WINNER_PODIUM_AVATAR_OVERLAP,
  WINNER_PODIUM_AVATAR_PX,
  WINNER_PODIUM_AVATAR_UPLIFT_PX,
  WINNER_PODIUM_COLUMN_GAP,
  WINNER_PODIUM_COLUMN_W,
  WINNER_PODIUM_HEIGHT,
  WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX,
} from "./eventLayout";

export const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${EVENT_MODAL_Z_INDEX};
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  img {
    user-select: none;
    -webkit-user-select: none;
    -ms-user-select: none;
    -webkit-user-drag: none;
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) and (hover: none) and (pointer: coarse) {
    background: rgba(15, 15, 15, 0.11);
  }

  @media (prefers-color-scheme: light) {
    background: rgba(0, 0, 0, 0.01);
  }
`;

export const TopBar = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 20px;
  pointer-events: none;
  z-index: ${EVENT_MODAL_Z_INDEX + 1};

  & > * {
    pointer-events: auto;
    cursor: default;
  }
`;

export const statusPillStyles = css`
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--navigationTextMuted);
  background: rgba(255, 255, 255, 0.82);
  text-align: center;

  @media (prefers-color-scheme: dark) {
    background: rgba(12, 12, 12, 0.82);
  }
`;

export const TopBarTitle = styled.div`
  ${statusPillStyles}
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 14px;
`;

export const TopBarStack = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 100%;
`;

export const PrizesRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  max-width: min(424px, calc(100vw - 36px));
  cursor: default;
`;

export const PrizeChoice = styled.div`
  width: ${PRIZE_IMAGE_WIDTH_CSS};
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
`;

export const PrizeChoiceButton = styled.button<{
  $imageWidth: number;
  $imageHeight: number;
}>`
  width: 100%;
  height: auto;
  aspect-ratio: ${(props) => props.$imageWidth} /
    ${(props) => props.$imageHeight};
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  line-height: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
`;

export const PrizeImage = styled.img`
  display: block;
  min-width: 0;
  height: 100%;
  max-width: 100%;
  width: 100%;
`;

export const PrizeSelectionAvatars = styled.div<{
  $density: PrizeSelectionDensity;
}>`
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  column-gap: ${(props) =>
    props.$density === "relaxed"
      ? "4px"
      : props.$density === "compact"
        ? "1px"
        : "0"};
  row-gap: 0;
  margin-top: ${PRIZE_SELECTION_GAP_PX}px;
`;

export const PrizeSelectionAvatarSlot = styled.button<{
  $density: PrizeSelectionDensity;
  $offsetX: number;
  $offsetY: number;
  $layer: number;
}>`
  position: relative;
  z-index: ${(props) => props.$layer};
  width: ${PRIZE_SELECTION_AVATAR_PX}px;
  height: ${PRIZE_SELECTION_AVATAR_PX}px;
  flex: 0 0 ${PRIZE_SELECTION_AVATAR_PX}px;
  margin: ${(props) =>
    props.$density === "relaxed"
      ? "-6px 0"
      : props.$density === "compact"
        ? "-6px -4px"
        : "-6px -8px"};
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  line-height: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transform: translate(
    ${(props) => props.$offsetX}px,
    ${(props) => props.$offsetY}px
  );
`;

export const PrizeSelectionAvatarMotion = styled.span`
  display: block;
  width: 100%;
  height: 100%;
  line-height: 0;
  transform-origin: center;
`;

export const TopBarSubtitle = styled.div`
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: none;
  opacity: 0.7;
`;

export const DevBracketHelper = styled.div`
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: ${EVENT_MODAL_Z_INDEX + 2};
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

export const DevHelperToggle = styled.button`
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(0, 0, 0, 0.16);
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  opacity: 0;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      opacity: 0;
    }
  }

  @media (prefers-color-scheme: dark) {
    color: rgba(255, 255, 255, 0.24);
  }
`;

export const DevHelperPanel = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);

  @media (prefers-color-scheme: dark) {
    background: rgba(20, 20, 20, 0.92);
  }
`;

export const DevHelperSelect = styled.select`
  height: 28px;
  border: none;
  border-radius: 8px;
  padding: 0 8px;
  font-size: 0.78rem;
  background: var(--color-gray-f0);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-33);
    color: var(--color-gray-f0);
  }
`;

export const DevHelperAction = styled.button`
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  background: var(--color-blue-primary);
  color: white;

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--bottomButtonBackgroundHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-blue-primary-dark);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--bottomButtonBackgroundHoverDark);
      }
    }
  }
`;

export const ContentArea = styled.div`
  width: min(400px, calc(100vw - 48px));
  max-height: min(560px, calc(100vh - 96px));
  max-height: min(560px, calc(100dvh - 96px));
  overflow-y: auto;
  padding: ${CONTENT_AREA_PADDING_PX}px;
  border-radius: 16px;
  background: var(--color-white);
  cursor: default;

  @media (prefers-color-scheme: dark) {
    background: var(--color-deep-gray);
  }
`;

export const ParticipantsCloud = styled.div<{ $scale: number }>`
  width: min(880px, calc(100vw - 48px));
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 16px;
  pointer-events: none;
  transform: scale(${(p) => p.$scale});
  transform-origin: center center;
`;

export const ParticipantPill = styled.button`
  min-height: ${FALLBACK_MATCH_H}px;
  max-width: 100%;
  border: none;
  border-radius: ${FALLBACK_MATCH_H / 2}px;
  padding: 6px 12px 6px 6px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;

  &:disabled {
    cursor: default;
    opacity: 0.72;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--color-gray-e0);
    }
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--color-gray-33);
      }
    }
  }
`;

export const Avatar = styled.img.attrs({
  draggable: false,
})<{ $size?: number }>`
  user-select: none;
  -webkit-user-select: none;
  -ms-user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  width: ${(props) => props.$size ?? 24}px;
  height: ${(props) => props.$size ?? 24}px;
  border-radius: ${(props) =>
    Math.max(4, Math.round((props.$size ?? 24) / 4))}px;
  flex-shrink: 0;
`;

export const AvatarFallback = styled.span<{ $size?: number }>`
  width: ${(props) => Math.round((props.$size ?? 24) * 0.7)}px;
  height: ${(props) => Math.round((props.$size ?? 24) * 0.7)}px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.13);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: ${(props) => Math.round((props.$size ?? 24) * 0.38)}px;
  font-weight: 600;
  color: rgba(128, 128, 128, 0.55);
  line-height: 1;
  user-select: none;

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.3);
  }
`;

export const ParticipantPillName = styled.div`
  min-width: 0;
  max-width: min(44vw, 180px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

export const BracketContainer = styled.div<{
  $w: number;
  $h: number;
  $scale: number;
}>`
  position: relative;
  flex: 0 0 auto;
  width: ${(p) => p.$w}px;
  height: ${(p) => p.$h}px;
  cursor: default;
  pointer-events: none;
  transform: scale(${(p) => p.$scale});
  transform-origin: center center;
`;

export const BracketPlacement = styled.div<{ $offsetY: number }>`
  position: relative;
  z-index: 1;
  pointer-events: none;
  transform: translateY(${(p) => p.$offsetY}px);
`;

export const endedAwardSparkleTwinkle = keyframes`
  0%, 100% {
    opacity: 0.56;
    transform: rotate(-3deg);
  }

  48% {
    opacity: 1;
    transform: rotate(4deg);
  }

  72% {
    opacity: 0.74;
    transform: rotate(1deg);
  }
`;

export const EndedAwardsRow = styled.div<{ $bottom: number }>`
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: ${(p) => p.$bottom}px;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: ${WINNER_PODIUM_COLUMN_GAP}px;
  max-width: min(424px, calc(100vw - 36px));
  pointer-events: none;
`;

export const EndedAwardColumn = styled.div`
  width: max(${WINNER_PODIUM_COLUMN_W}px, ${ENDED_AWARD_PRIZE_WIDTH_CSS});
  min-width: 0;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${ENDED_AWARD_PRIZE_GAP_CSS};
`;

export const EndedAwardPrize = styled.div<{
  $place: WinnerPodiumPlace;
  $imageWidth: number;
  $imageHeight: number;
}>`
  position: relative;
  isolation: isolate;
  width: ${ENDED_AWARD_PRIZE_WIDTH_CSS};
  min-width: 0;
  aspect-ratio: ${(props) => props.$imageWidth} /
    ${(props) => props.$imageHeight};
  display: flex;
  align-items: flex-end;
  justify-content: center;
  line-height: 0;
  pointer-events: auto;
  cursor: default;
  transform: translateX(
    ${(p) =>
      p.$place === 2
        ? ENDED_AWARD_LEFT_PRIZE_OFFSET_X_CSS
        : p.$place === 3
          ? ENDED_AWARD_RIGHT_PRIZE_OFFSET_X_CSS
          : "0px"}
  );
`;

export const EndedAwardSparkles = styled.span<{ $place: WinnerPodiumPlace }>`
  position: absolute;
  z-index: 2;
  inset: 0;
  display: block;
  pointer-events: none;
  transform: ${(p) =>
    p.$place === 2
      ? "translate(-1px, -2px) rotate(-1.5deg)"
      : p.$place === 3
        ? "translate(1px, -1px) rotate(1.5deg)"
        : "translateY(-3px)"};

  > span {
    position: absolute;
    display: block;
    width: clamp(7px, 2.1vh, 16px);
    aspect-ratio: 1;
    animation: ${endedAwardSparkleTwinkle} 2.1s ease-in-out infinite;

    &::before {
      content: "";
      position: absolute;
      inset: 0;
      background: #fff5a3;
      clip-path: polygon(
        50% 0%,
        61% 35%,
        98% 35%,
        68% 56%,
        79% 91%,
        50% 70%,
        21% 91%,
        32% 56%,
        2% 35%,
        39% 35%
      );
      filter: drop-shadow(0 0 2px rgba(255, 226, 52, 1))
        drop-shadow(0 0 7px rgba(255, 180, 0, 0.9));
      transform: rotate(var(--sparkle-rotation, 0deg))
        scaleX(var(--sparkle-scale-x, 1)) scaleY(var(--sparkle-scale-y, 1));
    }
  }

  > span:nth-child(1) {
    --sparkle-rotation: -14deg;
    --sparkle-scale-x: 1.12;
    --sparkle-scale-y: 0.88;
    bottom: calc(100% - 1px);
    left: ${(p) => (p.$place === 1 ? "5%" : p.$place === 2 ? "-8%" : "-2%")};
    animation-delay: ${(p) => `-${0.24 + p.$place * 0.17}s`};
  }

  > span:nth-child(2) {
    --sparkle-rotation: 24deg;
    --sparkle-scale-x: 0.78;
    --sparkle-scale-y: 1.28;
    right: ${(p) => (p.$place === 1 ? "-2%" : p.$place === 2 ? "6%" : "14%")};
    bottom: ${(p) =>
      p.$place === 1
        ? "calc(100% + 20px)"
        : p.$place === 2
          ? "calc(100% + 15px)"
          : "calc(100% + 23px)"};
    width: clamp(5.5px, 1.5vh, 11.5px);
    animation-duration: 2.6s;
    animation-delay: ${(p) => `-${0.82 + p.$place * 0.13}s`};
  }

  > span:nth-child(3) {
    --sparkle-rotation: -28deg;
    --sparkle-scale-x: 1.32;
    --sparkle-scale-y: 0.7;
    top: ${(p) => (p.$place === 1 ? "18%" : p.$place === 2 ? "29%" : "41%")};
    right: ${(p) => (p.$place === 1 ? "auto" : "calc(100% - 3px)")};
    left: ${(p) => (p.$place === 1 ? "calc(100% - 3px)" : "auto")};
    width: clamp(4px, 1vh, 8px);
    animation-duration: 1.85s;
    animation-delay: ${(p) => `-${1.31 + p.$place * 0.11}s`};
  }

  > span:nth-child(4) {
    --sparkle-rotation: 9deg;
    --sparkle-scale-x: 0.86;
    --sparkle-scale-y: 1.2;
    left: ${(p) => (p.$place === 1 ? "58%" : p.$place === 2 ? "45%" : "38%")};
    bottom: ${(p) =>
      p.$place === 1
        ? "calc(100% + 5px)"
        : p.$place === 2
          ? "calc(100% + 9px)"
          : "calc(100% + 3px)"};
    width: clamp(6px, 1.75vh, 13px);
    animation-duration: 2.4s;
    animation-delay: ${(p) => `-${0.57 + p.$place * 0.19}s`};
  }

  > span:nth-child(5) {
    --sparkle-rotation: -18deg;
    --sparkle-scale-x: 1.18;
    --sparkle-scale-y: 0.82;
    left: ${(p) => (p.$place === 1 ? "38%" : p.$place === 2 ? "28%" : "20%")};
    bottom: ${(p) =>
      p.$place === 1
        ? "calc(100% + 26px)"
        : p.$place === 2
          ? "calc(100% + 22px)"
          : "calc(100% + 29px)"};
    width: clamp(4.5px, 1.2vh, 9px);
    animation-duration: 2.8s;
    animation-delay: ${(p) => `-${1.08 + p.$place * 0.07}s`};
  }

  > span:nth-child(6) {
    --sparkle-rotation: 31deg;
    --sparkle-scale-x: 0.9;
    --sparkle-scale-y: 1.16;
    top: ${(p) => (p.$place === 1 ? "62%" : p.$place === 2 ? "56%" : "15%")};
    right: ${(p) => (p.$place === 1 ? "calc(100% - 4px)" : "auto")};
    left: ${(p) => (p.$place === 1 ? "auto" : "calc(100% - 4px)")};
    width: clamp(5.5px, 1.55vh, 12px);
    animation-duration: 2.25s;
    animation-delay: ${(p) => `-${1.53 + p.$place * 0.16}s`};
  }

  > span:nth-child(7) {
    --sparkle-rotation: -35deg;
    --sparkle-scale-x: 1.26;
    --sparkle-scale-y: 0.76;
    left: ${(p) => (p.$place === 1 ? "23%" : p.$place === 2 ? "74%" : "65%")};
    bottom: calc(100% - 3px);
    width: clamp(4px, 1.1vh, 8.5px);
    animation-duration: 2.95s;
    animation-delay: ${(p) => `-${0.91 + p.$place * 0.22}s`};
  }

  @media (max-height: 420px) {
    > span:nth-child(1) {
      top: 4%;
      right: calc(100% + 4px);
      bottom: auto;
      left: auto;
    }

    > span:nth-child(2) {
      top: 6%;
      right: auto;
      bottom: auto;
      left: calc(100% + 4px);
    }

    > span:nth-child(3) {
      top: auto;
      right: calc(100% + 4px);
      bottom: 3%;
      left: auto;
    }

    > span:nth-child(4) {
      top: auto;
      right: auto;
      bottom: 22%;
      left: calc(100% - 2px);
    }

    > span:nth-child(5),
    > span:nth-child(6),
    > span:nth-child(7) {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    > span {
      animation: none;
      opacity: 0.8;
      transform: none;
    }
  }
`;

export const WinnerPodium = styled.div<{
  $x: number;
  $y: number;
  $width: number;
}>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$width}px;
  height: ${WINNER_PODIUM_HEIGHT}px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: ${WINNER_PODIUM_COLUMN_GAP}px;
  pointer-events: none;
`;

export const WinnerPodiumColumn = styled.button<{ $place: WinnerPodiumPlace }>`
  position: relative;
  isolation: isolate;
  width: ${WINNER_PODIUM_COLUMN_W}px;
  height: ${(p) =>
    getWinnerPodiumBarHeight(p.$place) +
    WINNER_PODIUM_AVATAR_PX -
    WINNER_PODIUM_AVATAR_OVERLAP}px;
  flex: 0 0 auto;
  border: none;
  margin: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;

  &:disabled {
    cursor: default;
    opacity: 0.72;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) [data-avatar-slot][data-single-known="true"] {
      transform: translate(
          -50%,
          ${(p) =>
            `-${p.$place === 3 ? WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX : WINNER_PODIUM_AVATAR_UPLIFT_PX}px`}
        )
        scale(1.06);
    }
  }
`;

export const WinnerPodiumBar = styled.div<{ $place: WinnerPodiumPlace }>`
  position: absolute;
  z-index: 1;
  left: 0;
  right: 0;
  bottom: 0;
  top: ${WINNER_PODIUM_AVATAR_PX - WINNER_PODIUM_AVATAR_OVERLAP}px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-sizing: border-box;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--navigationTextMuted);
  background: var(--color-gray-f0);

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);
  }
`;

export const WinnerPodiumAvatarSlot = styled.div<{ $place: WinnerPodiumPlace }>`
  position: absolute;
  z-index: 2;
  top: 0;
  left: 50%;
  transform: translate(
    -50%,
    ${(p) =>
      `-${p.$place === 3 ? WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX : WINNER_PODIUM_AVATAR_UPLIFT_PX}px`}
  );
  width: ${WINNER_PODIUM_AVATAR_PX}px;
  height: ${WINNER_PODIUM_AVATAR_PX}px;
  border: none;
  border-radius: 999px;
  margin: 0;
  padding: 0;
  line-height: 0;
  background: transparent;
  pointer-events: none;
  transition: transform 0.15s ease;
`;

export const WinnerPodiumPlaceLabel = styled.span`
  opacity: 0.82;
`;

export const ClassicConnectorSvg = styled.svg`
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;

  path {
    fill: none;
    stroke: rgba(160, 160, 160, 0.5);
    stroke-width: 2;
  }

  line {
    stroke: rgba(160, 160, 160, 0.5);
    stroke-width: 2;
    stroke-linecap: round;
  }

  g[data-blocked-connector="true"] {
    opacity: 0.5;
  }

  g[data-blocked-connector="true"] path,
  g[data-blocked-connector="true"] line {
    stroke: rgb(160, 160, 160);
  }

  @media (prefers-color-scheme: dark) {
    path {
      stroke: rgba(140, 140, 140, 0.4);
    }

    line {
      stroke: rgba(140, 140, 140, 0.4);
    }

    g[data-blocked-connector="true"] {
      opacity: 0.4;
    }

    g[data-blocked-connector="true"] path,
    g[data-blocked-connector="true"] line {
      stroke: rgb(140, 140, 140);
    }
  }
`;

export const ClassicMatchCard = styled.button<{
  $x: number;
  $y: number;
  $w: number;
  $h: number;
  $interaction: BracketCardInteraction;
}>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$w}px;
  height: ${(p) => p.$h}px;
  border: none;
  border-radius: ${(p) => Math.round(Math.min(p.$w, p.$h) / 2)}px;
  padding: 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: ${(p) => (p.$interaction === "none" ? "default" : "pointer")};
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    ${(p) =>
      p.$interaction === "game"
        ? css`
            &:hover:not(:disabled) {
              background: var(--color-gray-e0);
            }
          `
        : ""}

    ${(p) =>
      p.$interaction === "participant"
        ? css`
            &:hover [data-avatar-slot][data-single-known="true"] {
              transform: scale(1.08);
            }
          `
        : ""}
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      ${(p) =>
        p.$interaction === "game"
          ? css`
              &:hover:not(:disabled) {
                background: var(--color-gray-33);
              }
            `
          : ""}

      ${(p) =>
        p.$interaction === "participant"
          ? css`
              &:hover [data-avatar-slot][data-single-known="true"] {
                transform: scale(1.08);
              }
            `
          : ""}
    }
  }
`;

export const MatchAvatarSlot = styled.div`
  line-height: 0;
  transition: transform 0.15s ease;
`;

export const BracketFallbackPanel = styled(ContentArea)<{
  $maxContentHeight: number;
}>`
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(560px, calc(100vh - 96px), ${(p) => p.$maxContentHeight}px);
  max-height: min(560px, calc(100dvh - 96px), ${(p) => p.$maxContentHeight}px);
  pointer-events: auto;
`;

export const BracketFallbackRound = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const BracketFallbackRoundTitle = styled.div`
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--navigationTextMuted);
`;

export const BracketFallbackGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(82px, 1fr));
  gap: 8px;
`;

export const BracketFallbackMatchCard = styled.button<{
  $interaction: BracketCardInteraction;
}>`
  min-height: ${FALLBACK_MATCH_H}px;
  border: none;
  border-radius: ${FALLBACK_MATCH_H / 2}px;
  padding: 6px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: ${(p) => (p.$interaction === "none" ? "default" : "pointer")};
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    ${(p) =>
      p.$interaction === "game"
        ? css`
            &:hover:not(:disabled) {
              background: var(--color-gray-e0);
            }
          `
        : ""}

    ${(p) =>
      p.$interaction === "participant"
        ? css`
            &:hover [data-avatar-slot][data-single-known="true"] {
              transform: scale(1.08);
            }
          `
        : ""}
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      ${(p) =>
        p.$interaction === "game"
          ? css`
              &:hover:not(:disabled) {
                background: var(--color-gray-33);
              }
            `
          : ""}

      ${(p) =>
        p.$interaction === "participant"
          ? css`
              &:hover [data-avatar-slot][data-single-known="true"] {
                transform: scale(1.08);
              }
            `
          : ""}
    }
  }
`;

export const BottomBar = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  pointer-events: none;
  z-index: ${EVENT_MODAL_Z_INDEX + 1};

  & > * {
    pointer-events: auto;
    cursor: default;
  }
`;

export const ButtonRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: min(560px, calc(100vw - 40px));
`;

export const OverlayStatus = styled.div`
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  ${statusPillStyles}
  pointer-events: none;
`;
