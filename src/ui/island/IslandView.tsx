import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  startTransition,
} from "react";
import { isMobile } from "../../utils/misc";
import styled, { keyframes } from "styled-components";
import { didDismissSomethingWithOutsideTapJustNow } from "../controls/outsideTapState";
import { closeAllKindsOfPopups } from "../controls/menuPort";
import IslandRock, {
  IslandRockHandle,
  getRockImageUrl,
} from "./IslandRockView";
import { soundPlayer } from "../../utils/SoundPlayer";
import {
  playSounds,
  preloadSounds,
  playRockSound,
  RockSound,
  directlyPlaySoundNamed,
} from "../../content/sounds";
import {
  miningJumpingPetsIdleAndWalking as islandMonsMining,
  shadow as islandMonsShadow,
} from "../../assets/islandMons";
import { getOwnMonIdByType, MonType } from "../../utils/namedMons";
import { storage } from "../../utils/storage";
import { Sound } from "../../utils/gameModels";
import {
  setIslandOverlayState,
  resetIslandOverlayState,
} from "../islandOverlayState";
import {
  MATERIALS,
  MaterialName,
  rocksMiningService,
} from "../../services/rocksMiningService";
import {
  computeAvailableMaterials,
  getFrozenMaterials,
  subscribeToFrozenMaterials,
} from "../../services/wagerMaterialsService";
import { openProfileSignInPopup } from "../identity/profileUiPort";
import { signInButtonVisualStyles } from "../identity/signInButtonStyles";
import {
  DISMISS_ALLOWED_TRIANGLE_A,
  DISMISS_ALLOWED_TRIANGLE_B,
  HOTSPOT_LABELS,
  ISLAND_HOTSPOTS,
  SMALLER_SMOOTH_CYCLING_ELLIPSE,
  STAR_SHINE_PENTAGON,
  STAR_SHINE_PENTAGON_BOUNDS,
  THEORETICAL_ROCK_BOTTOM,
  THEORETICAL_ROCK_SQUARE,
  clampWalkTarget,
  computeOverlapArea,
  createSafeAreaEllipse,
  isInsideEllipse,
  isInsideHole,
  isInsideSmoothEllipse,
  isInsideWalkArea,
  pointInPolygon,
  pointInTriangle,
} from "./geometry";
import {
  ALTERNATE_DUDE_X_SHIFT,
  DEFAULT_DUDE_BOTTOM_Y,
  DEFAULT_DUDE_CENTER_X,
  DUDE_ANCHOR_FRAC,
  DUDE_BOUNDS_HEIGHT_FRAC,
  DUDE_BOUNDS_WIDTH_FRAC,
  DUDE_FRAME_COUNT,
  DUDE_SHEET_ROWS,
  DUDE_SPRITE_HEIGHT_FRAC,
  FACING_DX_EPS,
  FACING_FLIP_HYST_MS,
  INITIAL_DUDE_FACING_LEFT,
  INITIAL_DUDE_X_SHIFT,
  INITIAL_DUDE_Y_SHIFT,
  KEYBOARD_WALK_MAX_FRAME_DELTA_MS,
  MON_BASELINE_Y_OFFSET,
  MON_BOUNDS_X_SHIFT,
  MON_FRAME_COUNT,
  MON_HEIGHT_FRAC,
  MON_REL_X,
  MON_REL_Y,
  ROCK_BOX_INSET_BOTTOM_FRAC,
  ROCK_BOX_INSET_LEFT_FRAC,
  ROCK_BOX_INSET_RIGHT_FRAC,
  ROCK_BOX_INSET_TOP_FRAC,
  SAFE_POINTER_MOVE_EPS,
  WALK_SUPPRESSION_HIT_COUNT,
  WALK_SUPPRESSION_RADIUS,
  getMonBoundsWidthFrac,
} from "./layout";

const STARS_URL = "https://cdn.lil.org/mons/rocks/underground/stars.webp";
const TOUCH_EDGE_DEADZONE_PX = 5;
const ROCK_LAYER_Z_INDEX = 500;
const MIN_OVERLAY_CLOSE_DELAY_MS = 160;
const ANON_SIGN_IN_DROP_SETTLE_MS = 620;
const ensureMonType = (value: string): MonType => {
  const maybe = value as MonType;
  return Object.values(MonType).includes(maybe) ? maybe : MonType.DRAINER;
};

const ButtonWrap = styled.div<{ $hidden: boolean }>`
  position: relative;
  display: inline-flex;
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
`;

const ButtonEl = styled.button<{ $hidden: boolean; $dimmed: boolean }>`
  border: none;
  cursor: pointer;
  height: 32px;
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  margin-right: 8px;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  -webkit-touch-callout: none;
  touch-action: none;
  overflow: hidden;
  position: relative;
  z-index: 1;
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
  user-select: none;
  -webkit-user-select: none;
  & > img {
    max-height: 100%;
    max-width: 100%;
    height: auto;
    width: auto;
    display: block;
    transform: translateY(1px) scale(${(p) => (p.$dimmed ? 1 : 1.3)});
    filter: ${(p) => (p.$dimmed ? "grayscale(1) brightness(0.96)" : "none")};
    opacity: ${(p) => (p.$dimmed ? 0.78 : 1)};
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
  }
`;

const sparkleRotate = keyframes`
  0% { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(360deg); }
`;

const sparklePulse = keyframes`
  0%, 100% { opacity: 0.65; filter: blur(1.5px); }
  50% { opacity: 1; filter: blur(0.5px); }
`;

const twinkle = keyframes`
  0%, 100% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  50% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
`;

const SparkleContainer = styled.div<{
  $visible: boolean;
  $fading: boolean;
  $dimmed: boolean;
}>`
  position: absolute;
  left: 16px;
  top: 16px;
  width: 56px;
  height: 56px;
  transform: translate(-50%, -50%) scale(${(p) => (p.$dimmed ? 0.77 : 1)});
  -webkit-transform: translate(-50%, -50%)
    scale(${(p) => (p.$dimmed ? 0.77 : 1)});
  pointer-events: none;
  z-index: 0;
  opacity: ${(p) => (p.$fading ? 0 : p.$visible ? 1 : 0)};
  will-change: opacity, transform;
  -webkit-transition:
    opacity ${(p) => (p.$fading ? "150ms" : "900ms")} ease-out,
    transform 150ms ease;
  transition:
    opacity ${(p) => (p.$fading ? "150ms" : "900ms")} ease-out,
    transform 150ms ease;
`;

const SparkleRing = styled.div`
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: radial-gradient(
    circle at 50% 50%,
    rgba(255, 215, 100, 0.5) 0%,
    rgba(255, 180, 60, 0.3) 40%,
    transparent 70%
  );
  transform: translate(-50%, -50%);
  animation: ${sparklePulse} 2s ease-in-out infinite;
  @media (prefers-color-scheme: light) {
    background: radial-gradient(
      circle at 50% 50%,
      rgba(120, 170, 255, 0.4) 0%,
      rgba(100, 150, 240, 0.25) 40%,
      transparent 70%
    );
  }
`;

const SparkleCore = styled.div`
  position: absolute;
  left: 50%;
  top: 50%;
  width: 12px;
  height: 12px;
  background: radial-gradient(
    circle,
    rgba(255, 255, 220, 0.95) 0%,
    rgba(255, 230, 140, 0.7) 50%,
    transparent 100%
  );
  border-radius: 50%;
  transform: translate(-50%, -50%);
  animation: ${sparklePulse} 1.5s ease-in-out infinite;
  animation-delay: 0.25s;
  @media (prefers-color-scheme: light) {
    background: radial-gradient(
      circle,
      rgba(130, 175, 255, 0.9) 0%,
      rgba(100, 150, 240, 0.7) 50%,
      transparent 100%
    );
  }
`;

const SparkleRays = styled.div<{ $dimmed: boolean }>`
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  animation: ${sparkleRotate} 8s linear infinite;
  opacity: ${(p) => (p.$dimmed ? 0 : 1)};
  transition: opacity 300ms ease;
`;

const SparkleRay = styled.div<{ $angle: number; $delay: number }>`
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 14px;
  background: linear-gradient(
    to top,
    transparent 0%,
    rgba(255, 240, 180, 0.9) 50%,
    transparent 100%
  );
  transform-origin: center bottom;
  transform: translate(-50%, -100%) rotate(${(p) => p.$angle}deg);
  animation: ${sparklePulse} 1.8s ease-in-out infinite;
  animation-delay: ${(p) => p.$delay}s;
  @media (prefers-color-scheme: light) {
    width: 3px;
    height: 16px;
    background: linear-gradient(
      to top,
      transparent 0%,
      rgba(140, 185, 255, 0.5) 40%,
      rgba(140, 185, 255, 0.5) 60%,
      transparent 100%
    );
  }
`;

const SparkleParticle = styled.div<{
  $x: number;
  $y: number;
  $delay: number;
  $duration: number;
  $dimmed: boolean;
}>`
  position: absolute;
  left: ${(p) => p.$x}%;
  top: ${(p) => p.$y}%;
  width: 4px;
  height: 4px;
  z-index: 2;
  animation: ${twinkle} ${(p) => p.$duration}s ease-in-out infinite;
  animation-delay: ${(p) => p.$delay}s;
  visibility: ${(p) => (p.$dimmed ? "hidden" : "visible")};
  &::before,
  &::after {
    content: "";
    position: absolute;
    background: rgba(255, 245, 200, 0.75);
  }
  &::before {
    left: 50%;
    top: 0;
    width: 1px;
    height: 100%;
    transform: translateX(-50%);
  }
  &::after {
    top: 50%;
    left: 0;
    width: 100%;
    height: 1px;
    transform: translateY(-50%);
  }
  @media (prefers-color-scheme: light) {
    &::before,
    &::after {
      background: rgba(80, 140, 240, 0.85);
    }
  }
`;

const anonSignInDrop = keyframes`
  0% {
    opacity: 0;
    transform: translate3d(-50%, -50%, 0) translate3d(0, -52px, 0) scale(0.96);
  }
  18% {
    opacity: 1;
  }
  74% {
    opacity: 1;
    transform: translate3d(-50%, -50%, 0) translate3d(0, 2px, 0) scale(1);
  }
  100% {
    opacity: 1;
    transform: translate3d(-50%, -50%, 0) translate3d(0, 0, 0) scale(1);
  }
`;

const anonSignInShadowDrop = keyframes`
  0% {
    opacity: 0;
    transform: translate3d(-50%, -50%, 0) scale(0.35);
  }
  24% {
    opacity: 0;
  }
  100% {
    opacity: 0.24;
    transform: translate3d(-50%, -50%, 0) scale(1);
  }
`;

const RockSignInShadow = styled.div<{ $settled: boolean; $hidden?: boolean }>`
  position: absolute;
  left: 48.8%;
  top: 40.8%;
  width: 18%;
  height: 3.2%;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.24);
  pointer-events: none;
  z-index: 759;
  opacity: ${(p) => (p.$hidden ? 0 : 0.24)};
  filter: blur(1.2px);
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
  will-change: transform, opacity;
  backface-visibility: hidden;
  transform-origin: center center;
  contain: layout paint;
  transform: translate3d(-50%, -50%, 0);
  animation: ${(p) => (p.$hidden || p.$settled ? "none" : anonSignInShadowDrop)}
    ${ANON_SIGN_IN_DROP_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
`;

const RockSignInButton = styled.button<{
  $settled: boolean;
  $isConnected?: boolean;
  $hidden?: boolean;
}>`
  ${signInButtonVisualStyles}
  position: absolute;
  left: 48.8%;
  top: 37%;
  white-space: nowrap;
  outline: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  visibility: ${(p) => (p.$hidden ? "hidden" : "visible")};
  opacity: ${(p) => (p.$hidden ? 0 : 1)};
  pointer-events: ${(p) => (p.$hidden ? "none" : p.$settled ? "auto" : "none")};
  z-index: 760;
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.16);
  will-change: transform, opacity;
  backface-visibility: hidden;
  transform-origin: center center;
  contain: layout paint;
  transform: translate3d(-50%, -50%, 0);
  animation: ${(p) => (p.$hidden || p.$settled ? "none" : anonSignInDrop)}
    ${ANON_SIGN_IN_DROP_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
`;

const MaterialsBar = styled.div<{ $visible: boolean }>`
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: max-content;
  max-width: calc(100dvw - 60px);
  padding: 0 1px;
  box-sizing: border-box;
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  transition: opacity 220ms ease;
  pointer-events: ${(p) => (p.$visible ? "auto" : "none")};
  cursor: pointer;
`;

const MaterialsBarContent = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: nowrap;
  transform: scale(var(--materials-scale, 1));
  transform-origin: center bottom;

  @media (min-width: 480px) {
    gap: 14px;
  }
  @media (min-width: 768px) {
    gap: 18px;
  }
  @media (max-width: 413px) {
    gap: 8px;
  }
  @media (max-width: 396px) {
    gap: 7px;
  }
  @media (max-width: 375px) {
    gap: 4px;
  }
  @media (max-width: 340px) {
    gap: 3px;
  }
  @media (max-width: 327px) {
    gap: 2px;
  }
  @media (max-width: 324px) {
    gap: 1px;
  }
`;

const MaterialItem = styled.div`
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  background: var(--interactiveHoverBackgroundLight);
  border-radius: 999px;
  padding: 0 8px 0 4px;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
  @media (prefers-color-scheme: dark) {
    background: var(--panel-dark-90);
  }
  @media (max-width: 413px) {
    gap: 1px;
    padding: 0 8px 0 3px;
  }
  @media (max-width: 375px) {
    gap: 1px;
    padding: 0 8px 0 2px;
  }
  @media (max-width: 333px) {
    gap: 1px;
    padding: 0 8px 0 1px;
  }
`;

const MaterialIcon = styled.img`
  width: 33px;
  height: 33px;
  display: block;
`;

const MaterialAmount = styled.span`
  font-size: 11px;
  line-height: 1;
  color: var(--instruction-text-color);
  font-weight: 600;
  font-family:
    ui-monospace,
    SFMono-Regular,
    SF Mono,
    Menlo,
    Consolas,
    "Liberation Mono",
    "Courier New",
    monospace;
  letter-spacing: 0.2px;
`;

const SafeBarStack = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0px;
`;

const Overlay = styled.div<{
  $visible: boolean;
  $opening: boolean;
  $closing: boolean;
}>`
  position: fixed;
  inset: 0;
  cursor: pointer;
  background: rgba(0, 0, 0, 0.1);
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  transition: ${(p) =>
    p.$opening
      ? "opacity 380ms cubic-bezier(0.16, 1, 0.3, 1) 100ms"
      : p.$closing
        ? "opacity 320ms ease-out 50ms"
        : "opacity 320ms ease-in"};
  pointer-events: ${(p) => (p.$visible ? "auto" : "none")};
  cursor: pointer;
  z-index: ${(p) => (p.$visible || p.$opening || p.$closing ? 90000 : 0)};
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  @media (prefers-color-scheme: dark) and (hover: none) and (pointer: coarse) {
    background: rgba(15, 15, 15, 0.11);
  }
  @media (prefers-color-scheme: light) {
    background: rgba(0, 0, 0, 0.01);
  }
`;

const SafeBarRow = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  cursor: pointer;
  z-index: 90001;
`;

const SafeHitbox = styled.div<{ $active: boolean }>`
  display: inline-flex;
  pointer-events: ${(p) => (p.$active ? "auto" : "none")};
  cursor: pointer;
  padding: 30px 30px;
  margin: -30px 0;
  background: transparent;
  outline: none;
  position: relative;
  z-index: 1;
`;

const Layer = styled.div<{
  $visible: boolean;
  $opening: boolean;
  $closing: boolean;
}>`
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: ${(p) => (p.$visible || p.$opening || p.$closing ? 90001 : 0)};
  pointer-events: ${(p) =>
    p.$visible || p.$opening || p.$closing ? "auto" : "none"};
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
`;

const Animator = styled.div<{
  $tx: number;
  $ty: number;
  $sx: number;
  $sy: number;
}>`
  pointer-events: auto;
  cursor: pointer;
  transition: transform 300ms ease;
  transform: translate(${(p) => p.$tx}px, ${(p) => p.$ty}px)
    scale(${(p) => p.$sx}, ${(p) => p.$sy});
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
`;

const Hero = styled.img`
  max-height: 50dvh;
  max-width: 92dvw;
  width: auto;
  height: auto;
  display: block;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
`;

const Rock = styled(IslandRock)`
  height: 100%;
`;

const RockLayer = styled.div<{ $visible: boolean }>`
  cursor: pointer;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 10%;
  height: 20%;
  pointer-events: auto;
  transition: opacity 260ms ease;
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  touch-action: none;
  -webkit-user-select: none;
`;

const HeroWrap = styled.div`
  position: relative;
  display: inline-block;
`;

const WalkOverlay = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
  cursor: pointer;
`;

const HotspotOverlay = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
  cursor: pointer;
  z-index: 100000;
`;

const fadePulse = keyframes`
  0% { opacity: 0; transform: scale(0.8); }
  10% { opacity: 1; transform: scale(1); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.05); }
`;

const HotspotCircle = styled.div<{ $visible: boolean }>`
  position: absolute;
  border-radius: 50%;
  box-sizing: border-box;
  touch-action: none;
  pointer-events: none;
  background: radial-gradient(
    circle at 50% 50%,
    rgba(0, 200, 255, 0.9) 0%,
    rgba(0, 200, 255, 0.45) 40%,
    rgba(0, 200, 255, 0.2) 60%,
    rgba(0, 0, 0, 0) 70%
  );
  box-shadow:
    0 0 14px rgba(0, 200, 255, 0.7),
    0 0 28px rgba(0, 200, 255, 0.35),
    inset 0 0 22px rgba(0, 200, 255, 0.5);
  opacity: ${(p) => (p.$visible ? 0 : 0)};
  animation: ${(p) => (p.$visible ? fadePulse : "none")} 520ms ease-out;
  cursor: pointer;
  &::before {
    content: "";
    position: absolute;
    inset: 16%;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      rgba(255, 255, 255, 0.85) 0%,
      rgba(0, 200, 255, 0) 70%
    );
    filter: blur(6px);
    opacity: 0.8;
    pointer-events: none;
    cursor: pointer;
  }
`;

const overlayFlash = keyframes`
  0% { opacity: 0; }
  10% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
`;

const StarsOverlayImage = styled.img<{ $visible: boolean; $hold: boolean }>`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  cursor: pointer;
  z-index: 3;
  filter: brightness(3) saturate(3) contrast(3) blur(0.5px);
  opacity: ${(p) => (p.$hold ? 1 : 0)};
  animation: ${(p) => (p.$hold ? "none" : p.$visible ? overlayFlash : "none")}
    520ms ease-out;
`;

const MaskedArea = styled.div<{ $cx: number; $cy: number; $visible: boolean }>`
  position: absolute;
  inset: 0;
  pointer-events: none;
  cursor: pointer;
  z-index: 2;
  -webkit-mask-image: radial-gradient(
    circle at ${(p) => p.$cx}% ${(p) => p.$cy}%,
    rgba(0, 0, 0, 1) 0%,
    rgba(0, 0, 0, 1) 9%,
    rgba(0, 0, 0, 0) 14%
  );
  mask-image: radial-gradient(
    circle at ${(p) => p.$cx}% ${(p) => p.$cy}%,
    rgba(0, 0, 0, 1) 0%,
    rgba(0, 0, 0, 1) 9%,
    rgba(0, 0, 0, 0) 14%
  );
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
`;

const ShadowImg = styled.img`
  position: absolute;
  left: 50%;
  top: 0;
  width: auto;
  height: auto;
  transform: translate(-50%, -50%);
  pointer-events: none;
  cursor: pointer;
  opacity: 0.23;
  transition: opacity 260ms ease;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
`;

const DudeSpriteWrap = styled.div`
  position: absolute;
  height: ${DUDE_SPRITE_HEIGHT_FRAC * 100}%;
  transform: translate(-50%, -${DUDE_ANCHOR_FRAC * 100}%);
  aspect-ratio: var(--dude-frame-aspect, 1);
  pointer-events: none;
  cursor: pointer;
  transition: opacity 260ms ease;
`;

const DudeSpriteFrame = styled.div<{ $facingLeft: boolean }>`
  position: absolute;
  left: 0;
  top: 0;
  width: auto;
  height: 100%;
  overflow: hidden;
  transform: scaleX(${(p) => (p.$facingLeft ? -1 : 1)});
  aspect-ratio: var(--dude-frame-aspect, 1);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  pointer-events: none;
`;

const DudeSpriteStrip = styled.img`
  position: absolute;
  left: 0;
  top: 0;
  height: calc(100% * var(--dude-strip-rows, 1));
  width: calc(100% * var(--dude-frame-count, 1));
  max-width: none;
  max-height: none;
  will-change: transform;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  pointer-events: none;
`;

const MonLayer = styled.div<{ $visible: boolean }>`
  position: absolute;
  inset: 0;
  pointer-events: none;
  transition: opacity 260ms ease;
  opacity: ${(p) => (p.$visible ? 1 : 0)};
`;

const MonSpriteWrap = styled.div`
  position: absolute;
  height: ${MON_HEIGHT_FRAC * 100}%;
  transform: translate(-50%, -${DUDE_ANCHOR_FRAC * 100}%);
  aspect-ratio: var(--mon-frame-aspect, 1);
  pointer-events: none;
  transition: opacity 260ms ease;
`;

const MonSpriteFrame = styled.div<{ $facingLeft: boolean }>`
  position: absolute;
  left: 0;
  top: 0;
  width: auto;
  height: 100%;
  overflow: hidden;
  transform: scaleX(${(p) => (p.$facingLeft ? -1 : 1)});
  aspect-ratio: var(--mon-frame-aspect, 1);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  pointer-events: none;
`;

const MonSpriteStrip = styled.img`
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: calc(100% * var(--mon-frame-count, 1));
  max-width: none;
  max-height: none;
  will-change: transform;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  pointer-events: none;
`;

type Props = {
  imageUrl?: string;
  dimmed?: boolean;
};

const DEFAULT_URL = "https://cdn.lil.org/mons/rocks/island.webp";

const MINING_FRAME_MS = 175;
const WALKING_FRAME_MS = 120;
const STANDING_FRAME_MS = 200;

let islandImagePromise: Promise<string | null> | null = null;

const getIslandImageUrl = () => {
  if (!islandImagePromise) {
    islandImagePromise = fetch(DEFAULT_URL)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch image");
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => null);
  }
  return islandImagePromise;
};

type MaterialPullRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
const MATERIAL_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";
let persistentMonPosRef: { x: number; y: number } | null = null;

const materialImagePromises: Map<
  MaterialName,
  Promise<string | null>
> = new Map();

let monSpritesModulePromise: Promise<{
  getSpriteByKey: (key: string) => string;
}> | null = null;
const getMonSpritesModule = () => {
  if (!monSpritesModulePromise) {
    monSpritesModulePromise = import("../../assets/monsSprites");
  }
  return monSpritesModulePromise;
};

const getMaterialImageUrl = (name: MaterialName) => {
  if (!materialImagePromises.has(name)) {
    const url = `${MATERIAL_BASE_URL}/${name}.webp`;
    const p = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch image");
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => null);
    materialImagePromises.set(name, p);
  }
  return materialImagePromises.get(name)!;
};

function IslandButton({ imageUrl = DEFAULT_URL, dimmed = false }: Props) {
  const [islandImgLoaded, setIslandImgLoaded] = useState(false);
  const [islandNatural, setIslandNatural] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const islandButtonImgRef = useRef<HTMLImageElement | null>(null);
  const islandButtonRef = useRef<HTMLButtonElement | null>(null);
  const islandHeroImgRef = useRef<HTMLImageElement | null>(null);
  const [islandOverlayShown, setIslandOverlayShown] = useState(false);
  const [islandOverlayVisible, setIslandOverlayVisible] = useState(false);
  const [walkReady, setWalkReady] = useState(false);
  const [islandActive, setIslandActive] = useState(false);
  const [islandAnimating, setIslandAnimating] = useState(false);
  const [islandClosing, setIslandClosing] = useState(false);
  const [islandOpening, setIslandOpening] = useState(false);
  const [islandTranslate, setIslandTranslate] = useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });
  const [islandScale, setIslandScale] = useState<{ x: number; y: number }>({
    x: 1,
    y: 1,
  });
  const overlayJustOpenedAtRef = useRef<number>(0);
  const [resolvedUrl, setResolvedUrl] = useState<string>(imageUrl);
  const heroHitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayActiveRef = useRef<boolean>(false);
  const heroTransformFrameRef = useRef<number | null>(null);
  const overlayPhaseRef = useRef<"idle" | "opening" | "open" | "closing">(
    "idle",
  );
  const [decorVisible, setDecorVisible] = useState(false);
  const [starsVisible, setStarsVisible] = useState(false);
  const [starsMaskCenter, setStarsMaskCenter] = useState<{
    xPct: number;
    yPct: number;
  }>({ xPct: 50, yPct: 50 });
  const starsTimerRef = useRef<number>(0);
  const [starsHold, setStarsHold] = useState(false);
  const starsAnimActiveRef = useRef<boolean>(false);
  const wasStarsInsideRef = useRef<boolean>(false);
  const starsHoldRef = useRef<boolean>(false);
  useEffect(() => {
    starsHoldRef.current = starsHold;
  }, [starsHold]);
  const starsDismissedRef = useRef<boolean>(false);
  useEffect(() => {
    setIslandOverlayState({
      visible: islandOverlayVisible,
      opening: islandOpening,
      closing: islandClosing,
    });
  }, [islandOverlayVisible, islandOpening, islandClosing]);
  useEffect(() => {
    return () => {
      resetIslandOverlayState();
    };
  }, []);
  const starsCenterTargetRef = useRef<{ xPct: number; yPct: number } | null>(
    null,
  );
  const starsCenterRafRef = useRef<number | null>(null);
  const lastStarsCenterRef = useRef<{ xPct: number; yPct: number }>(
    starsMaskCenter,
  );
  const setStarsCenterImmediate = useCallback((xPct: number, yPct: number) => {
    const cx = Math.max(0, Math.min(100, xPct));
    const cy = Math.max(0, Math.min(100, yPct));
    if (starsCenterRafRef.current !== null) {
      cancelAnimationFrame(starsCenterRafRef.current);
      starsCenterRafRef.current = null;
    }
    starsCenterTargetRef.current = null;
    const next = { xPct: cx, yPct: cy };
    lastStarsCenterRef.current = next;
    setStarsMaskCenter(next);
  }, []);
  const queueStarsCenterUpdate = useCallback((xPct: number, yPct: number) => {
    const cx = Math.max(0, Math.min(100, xPct));
    const cy = Math.max(0, Math.min(100, yPct));
    const last = lastStarsCenterRef.current;
    const dx = cx - last.xPct;
    const dy = cy - last.yPct;
    if (dx * dx + dy * dy < 0.16) return;
    starsCenterTargetRef.current = { xPct: cx, yPct: cy };
    if (starsCenterRafRef.current === null) {
      starsCenterRafRef.current = requestAnimationFrame(() => {
        starsCenterRafRef.current = null;
        const t = starsCenterTargetRef.current;
        if (!t) return;
        starsCenterTargetRef.current = null;
        lastStarsCenterRef.current = t;
        setStarsMaskCenter(t);
      });
    }
  }, []);
  const cancelQueuedStarsCenterUpdate = useCallback(() => {
    if (starsCenterRafRef.current !== null) {
      cancelAnimationFrame(starsCenterRafRef.current);
      starsCenterRafRef.current = null;
    }
    starsCenterTargetRef.current = null;
  }, []);
  const starsImgRef = useRef<HTMLImageElement | null>(null);
  const heroWrapRef = useRef<HTMLDivElement | null>(null);
  const [materialAmounts, setMaterialAmounts] = useState<
    Record<MaterialName, number>
  >(() => {
    const snapshot = rocksMiningService.getSnapshot();
    return computeAvailableMaterials(snapshot.materials, getFrozenMaterials());
  });
  const latestServiceMaterialsRef = useRef<Record<MaterialName, number>>({
    ...rocksMiningService.getSnapshot().materials,
  });
  const frozenMaterialsRef =
    useRef<Record<MaterialName, number>>(getFrozenMaterials());
  const amountsDecoupledRef = useRef(false);
  const [materialUrls, setMaterialUrls] = useState<
    Record<MaterialName, string | null>
  >(() => {
    const initial: Partial<Record<MaterialName, string | null>> = {};
    MATERIALS.forEach((n) => (initial[n] = null));
    return initial as Record<MaterialName, string | null>;
  });
  const [dudeVisible, setDudeVisible] = useState(false);
  const [monVisible, setMonVisible] = useState(false);
  const [monTeleporting, setMonTeleporting] = useState(false);
  const materialItemRefs = useRef<Record<MaterialName, HTMLDivElement | null>>({
    dust: null,
    slime: null,
    gum: null,
    metal: null,
    ice: null,
  });
  const decodedMaterialsRef = useRef<Set<MaterialName>>(new Set());
  useEffect(() => {
    const unsubscribe = rocksMiningService.subscribe((snapshot) => {
      const next = { ...snapshot.materials };
      latestServiceMaterialsRef.current = next;
      if (!amountsDecoupledRef.current) {
        const available = computeAvailableMaterials(
          next,
          frozenMaterialsRef.current,
        );
        setMaterialAmounts(available);
      }
      setRockAvailable(rocksMiningService.shouldShowRock());
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeToFrozenMaterials((materials) => {
      frozenMaterialsRef.current = materials;
      if (!amountsDecoupledRef.current) {
        const available = computeAvailableMaterials(
          latestServiceMaterialsRef.current,
          materials,
        );
        setMaterialAmounts(available);
      }
    });
    return unsubscribe;
  }, []);
  const isMaterialTarget = useCallback(
    (node: Node | null) => {
      if (!node) return false;
      const refs = materialItemRefs.current;
      for (const key in refs) {
        const el = refs[key as MaterialName];
        if (el && (el === node || el.contains(node))) {
          return true;
        }
      }
      return false;
    },
    [materialItemRefs],
  );
  const materialsBarRef = useRef<HTMLDivElement | null>(null);
  const materialsBarContentRef = useRef<HTMLDivElement | null>(null);
  const updateMaterialsBarScale = useCallback(() => {
    const bar = materialsBarRef.current;
    const content = materialsBarContentRef.current;
    if (!bar || !content) return;

    const barStyle = window.getComputedStyle(bar);
    const availableWidth =
      bar.clientWidth -
      parseFloat(barStyle.paddingLeft) -
      parseFloat(barStyle.paddingRight);
    const scale =
      content.scrollWidth > availableWidth
        ? availableWidth / content.scrollWidth
        : 1;
    content.style.setProperty("--materials-scale", scale.toFixed(4));
  }, []);
  useLayoutEffect(() => {
    updateMaterialsBarScale();
    window.addEventListener("resize", updateMaterialsBarScale);
    return () => window.removeEventListener("resize", updateMaterialsBarScale);
  }, [
    islandOverlayShown,
    materialAmounts,
    materialUrls,
    updateMaterialsBarScale,
  ]);
  const safeHitboxRef = useRef<HTMLDivElement | null>(null);
  const rockLayerRef = useRef<HTMLDivElement | null>(null);
  const rockRef = useRef<IslandRockHandle | null>(null);
  const fxContainerRef = useRef<HTMLDivElement | null>(null);
  const lastRockRectRef = useRef<DOMRect | null>(null);
  const [rockAvailable, setRockAvailable] = useState(() =>
    rocksMiningService.shouldShowRock(),
  );
  const [sparkleFading, setSparkleFading] = useState(false);
  const [sparkleMounted, setSparkleMounted] = useState(false);
  const walkSuppressedUntilRef = useRef<number>(0);
  const walkSuppressionHitsRemainingRef = useRef<number>(0);
  const walkSuppressionAnchorRef = useRef<{ x: number; y: number } | null>(
    null,
  );
  const [rockReady, setRockReadyState] = useState(false);
  const [rockImageUrl, setRockImageUrl] = useState(() => getRockImageUrl());
  const [rockRenderKey, setRockRenderKey] = useState(0);
  const [rockBreaking, setRockBreaking] = useState(false);
  const rockReadyRef = useRef(rockReady);
  const setRockReady = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      setRockReadyState((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        rockReadyRef.current = next;
        return next;
      });
    },
    [setRockReadyState],
  );
  const rockBoxRef = useRef<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  const [rockBottomY, setRockBottomYState] = useState<number>(1);
  const rockBottomYRef = useRef(rockBottomY);
  const setRockBottomY = useCallback(
    (value: number | ((prev: number) => number)) => {
      setRockBottomYState((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        rockBottomYRef.current = next;
        return next;
      });
    },
    [setRockBottomYState],
  );
  const anonSignInDropCounterRef = useRef(0);
  const anonSignInDropSettleTimeoutRef = useRef<number | null>(null);
  const anonSignInDropPointerHandledRef = useRef(false);
  const [anonSignInDropState, setAnonSignInDropState] = useState<{
    key: number;
    settled: boolean;
  } | null>(null);

  const clearAnonSignInDrop = useCallback(() => {
    if (anonSignInDropSettleTimeoutRef.current !== null) {
      window.clearTimeout(anonSignInDropSettleTimeoutRef.current);
      anonSignInDropSettleTimeoutRef.current = null;
    }
    anonSignInDropPointerHandledRef.current = false;
    setAnonSignInDropState(null);
  }, []);

  const showAnonSignInDrop = useCallback(() => {
    if (anonSignInDropSettleTimeoutRef.current !== null) {
      window.clearTimeout(anonSignInDropSettleTimeoutRef.current);
      anonSignInDropSettleTimeoutRef.current = null;
    }
    const key = anonSignInDropCounterRef.current + 1;
    anonSignInDropCounterRef.current = key;
    setAnonSignInDropState({ key, settled: false });
    anonSignInDropSettleTimeoutRef.current = window.setTimeout(() => {
      anonSignInDropSettleTimeoutRef.current = null;
      setAnonSignInDropState((current) =>
        current && current.key === key
          ? { ...current, settled: true }
          : current,
      );
    }, ANON_SIGN_IN_DROP_SETTLE_MS);
  }, []);

  useEffect(() => {
    if (!rockAvailable) return;
    setRockBreaking(false);
    setRockReady(false);
    clearAnonSignInDrop();
    rockBoxRef.current = null;
    setRockImageUrl(getRockImageUrl());
    setRockRenderKey((prev) => prev + 1);
  }, [clearAnonSignInDrop, rockAvailable, setRockReady]);
  const computeEntityZIndex = useCallback(
    (baselineY: number) => {
      const clampedBaseline = Math.max(0, Math.min(1, baselineY));
      const base = Math.round(clampedBaseline * 100);
      if (!rockAvailable) return 600 + base;
      const measuredBottom =
        rockBottomY < 1 ? Math.max(0, Math.min(1, rockBottomY)) : null;
      const effectiveBottom =
        measuredBottom !== null ? measuredBottom : THEORETICAL_ROCK_BOTTOM;
      return clampedBaseline >= effectiveBottom ? 700 + base : 300 + base;
    },
    [rockBottomY, rockAvailable],
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const img = new Image();
    img.src = rockImageUrl;
    if (typeof img.decode === "function") {
      img.decode().catch(() => {});
    }
  }, [rockImageUrl]);
  useEffect(() => {
    const hasRock = rocksMiningService.shouldShowRock();
    setRockAvailable(hasRock);
    if (!islandOverlayVisible && hasRock) {
      setSparkleFading(false);
    }
  }, [islandOverlayVisible]);
  const isSignedIn = storage.getProfileId("") !== "";
  useEffect(() => {
    if (isSignedIn) {
      clearAnonSignInDrop();
    }
  }, [clearAnonSignInDrop, isSignedIn]);
  type MaterialDropEntry = {
    id: number;
    el: HTMLImageElement;
    shadow: HTMLElement;
    name: MaterialName;
    phase: "flight" | "settled";
    baseline: number;
    zone: "neutral" | "front" | "behind";
    lastZ: number;
  };

  const materialDropsRef = useRef<MaterialDropEntry[]>([]);
  const materialDropCounterRef = useRef(0);
  const materialPullQueueRef = useRef<
    Array<{ name: MaterialName; rect: MaterialPullRect }>
  >([]);
  const materialPullFlushRef = useRef<number | null>(null);

  const [heroSize, setHeroSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const heroSizeRef = useRef(heroSize);
  heroSizeRef.current = heroSize;

  const editorOverlayRef = useRef<HTMLDivElement | null>(null);
  const isPointerDownRef = useRef<boolean>(false);
  const lastInsideRef = useRef<Set<number>>(new Set());
  const circlesGestureActiveRef = useRef<boolean>(false);
  const walkingDragActiveRef = useRef<boolean>(false);
  const walkingDragCleanupRef = useRef<(() => void) | null>(null);
  const lastMaterialsInsideRef = useRef<Set<MaterialName>>(new Set());

  const circleTrackingRef = useRef<{
    lastAngle: number | null;
    totalRotation: number;
    direction: "cw" | "ccw" | null;
    center: { x: number; y: number } | null;
  }>({ lastAngle: null, totalRotation: 0, direction: null, center: null });
  const [hotspotVisible, setHotspotVisible] = useState<boolean[]>(() =>
    new Array(ISLAND_HOTSPOTS.length).fill(false),
  );
  const hotspotTimersRef = useRef<number[]>(
    new Array(ISLAND_HOTSPOTS.length).fill(0),
  );
  const lastTouchAtRef = useRef<number>(0);
  const flashEntriesRef = useRef<((indices: Set<number>) => void) | null>(null);
  const spawnIconParticlesFnRef = useRef<
    ((el: HTMLElement, src: string) => void) | null
  >(null);

  const activateMaterial = useCallback(
    (name: MaterialName) => {
      const url = materialUrls[name];
      if (!url) return;
      const host = materialItemRefs.current[name];
      if (!host) return;
      directlyPlaySoundNamed(name, 0.1);
      const img = host.querySelector("img");
      if (!img) return;
      const f = spawnIconParticlesFnRef.current;
      if (f) f(img as HTMLImageElement, url);
    },
    [materialUrls],
  );

  useEffect(() => {
    const getInsideSet = (clientX: number, clientY: number) => {
      const overlay = editorOverlayRef.current;
      const set = new Set<number>();
      if (!overlay) return set;
      const rect = overlay.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      for (let i = 0; i < ISLAND_HOTSPOTS.length; i++) {
        const c = ISLAND_HOTSPOTS[i];
        const cx = c.cxPct * w;
        const cy = c.cyPct * h;
        const r = (c.dPct * Math.min(w, h)) / 2;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) set.add(i);
      }
      return set;
    };
    const getMaterialsInsideSet = (clientX: number, clientY: number) => {
      const set = new Set<MaterialName>();
      const refs = materialItemRefs.current;
      const names = MATERIALS as readonly MaterialName[];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        const el = refs[n];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom
        )
          set.add(n);
      }
      return set;
    };
    const tapMaterialByName = (name: MaterialName) => activateMaterial(name);
    const flashEntries = (indices: Set<number>) => {
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        return;
      }
      if (walkingDragActiveRef.current) return;
      if (indices.size === 0) return;
      indices.forEach((i) => {
        const originalLabel = HOTSPOT_LABELS[i] ?? i + 1;
        let sound: RockSound | null = null;
        const pick = (arr: RockSound[]) =>
          arr[Math.floor(Math.random() * arr.length)];
        switch (originalLabel) {
          case 11:
            sound = pick([RockSound.S1A, RockSound.S1B, RockSound.S1C]);
            break;
          case 10:
            sound = pick([RockSound.S2A, RockSound.S2B]);
            break;
          case 9:
            sound = RockSound.S3;
            break;
          case 8:
            sound = pick([RockSound.S4A, RockSound.S4B, RockSound.S4C]);
            break;
          case 7:
            sound = pick([RockSound.S5A, RockSound.S5B, RockSound.S5C]);
            break;
          case 6:
            sound = pick([RockSound.S6A, RockSound.S6B, RockSound.S6C]);
            break;
          case 5:
            sound = pick([RockSound.S7A, RockSound.S7B, RockSound.S7C]);
            break;
          case 4:
            sound = pick([RockSound.S8A, RockSound.S8B, RockSound.S8C]);
            break;
          case 3:
            sound = pick([
              RockSound.S9A,
              RockSound.S9B,
              RockSound.S9C,
              RockSound.S9D,
            ]);
            break;
          case 2:
            sound = pick([
              RockSound.S10A,
              RockSound.S10B,
              RockSound.S10C,
              RockSound.S10D,
            ]);
            break;
          case 1:
            sound = pick([
              RockSound.S11A,
              RockSound.S11B,
              RockSound.S11C,
              RockSound.S11D,
            ]);
            break;
        }
        if (sound) playRockSound(sound);
      });
      setHotspotVisible((prev) => {
        const next = [...prev];
        indices.forEach((i) => {
          next[i] = false;
        });
        return next;
      });
      requestAnimationFrame(() => {
        setHotspotVisible((prev) => {
          const next = [...prev];
          indices.forEach((i) => {
            next[i] = true;
            if (hotspotTimersRef.current[i])
              window.clearTimeout(hotspotTimersRef.current[i]);
            hotspotTimersRef.current[i] = window.setTimeout(() => {
              setHotspotVisible((cur) => {
                const n2 = [...cur];
                n2[i] = false;
                return n2;
              });
            }, 520);
          });
          return next;
        });
      });
    };
    flashEntriesRef.current = flashEntries;
    const onDown = (ev: MouseEvent | TouchEvent) => {
      const now = performance.now();
      isPointerDownRef.current = true;
      if (walkingDragActiveRef.current) return;
      let clientX = 0;
      let clientY = 0;
      if ((ev as TouchEvent).touches && (ev as TouchEvent).touches.length) {
        clientX = (ev as TouchEvent).touches[0].clientX;
        clientY = (ev as TouchEvent).touches[0].clientY;
        lastTouchAtRef.current = now;
      } else {
        if (now - lastTouchAtRef.current < 600) return;
        clientX = (ev as MouseEvent).clientX;
        clientY = (ev as MouseEvent).clientY;
      }
      const inside = getInsideSet(clientX, clientY);
      lastInsideRef.current = inside;
      circlesGestureActiveRef.current = inside.size > 0;
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        return;
      }
      if (inside.size) flashEntries(inside);
      const mats = getMaterialsInsideSet(clientX, clientY);
      lastMaterialsInsideRef.current = mats;
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        return;
      }
      if (mats.size) mats.forEach((n) => tapMaterialByName(n));
    };
    const onUp = () => {
      isPointerDownRef.current = false;
      lastInsideRef.current = new Set();
      circlesGestureActiveRef.current = false;
      lastMaterialsInsideRef.current = new Set();
    };
    const onMoveMouse = (ev: MouseEvent) => {
      const now = performance.now();
      if (now - lastTouchAtRef.current < 600) return;
      if (!isPointerDownRef.current) return;
      if (walkingDragActiveRef.current) return;
      const inside = getInsideSet(ev.clientX, ev.clientY);
      const prev = lastInsideRef.current;
      const entrants = new Set<number>();
      inside.forEach((i) => {
        if (!prev.has(i)) entrants.add(i);
      });
      if (entrants.size) flashEntries(entrants);
      lastInsideRef.current = inside;
      const mats = getMaterialsInsideSet(ev.clientX, ev.clientY);
      const prevMats = lastMaterialsInsideRef.current;
      const matEntrants: MaterialName[] = [];
      mats.forEach((n) => {
        if (!prevMats.has(n)) matEntrants.push(n);
      });
      if (matEntrants.length) matEntrants.forEach((n) => tapMaterialByName(n));
      lastMaterialsInsideRef.current = mats;
    };
    const onMoveTouch = (ev: TouchEvent) => {
      if (!isPointerDownRef.current) return;
      if (walkingDragActiveRef.current) return;
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const inside = getInsideSet(t.clientX, t.clientY);
      const prev = lastInsideRef.current;
      const entrants = new Set<number>();
      inside.forEach((i) => {
        if (!prev.has(i)) entrants.add(i);
      });
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        lastInsideRef.current = new Set();
        return;
      }
      if (entrants.size) flashEntries(entrants);
      lastInsideRef.current = inside;
      const mats = getMaterialsInsideSet(t.clientX, t.clientY);
      const prevMats = lastMaterialsInsideRef.current;
      const matEntrants: MaterialName[] = [];
      mats.forEach((n) => {
        if (!prevMats.has(n)) matEntrants.push(n);
      });
      if (matEntrants.length) matEntrants.forEach((n) => tapMaterialByName(n));
      lastMaterialsInsideRef.current = mats;
    };
    window.addEventListener("mousedown", onDown as any, { capture: true });
    window.addEventListener("mouseup", onUp, { capture: true });
    window.addEventListener("touchstart", onDown as any, {
      passive: true,
      capture: true,
    });
    window.addEventListener("touchend", onUp, { capture: true });
    window.addEventListener("touchcancel", onUp, { capture: true });
    window.addEventListener("mousemove", onMoveMouse, { capture: true });
    window.addEventListener("touchmove", onMoveTouch as any, {
      passive: true,
      capture: true,
    });
    return () => {
      window.removeEventListener(
        "mousedown",
        onDown as any,
        { capture: true } as any,
      );
      window.removeEventListener("mouseup", onUp, { capture: true } as any);
      window.removeEventListener(
        "touchstart",
        onDown as any,
        { capture: true } as any,
      );
      window.removeEventListener("touchend", onUp, { capture: true } as any);
      window.removeEventListener("touchcancel", onUp, { capture: true } as any);
      window.removeEventListener("mousemove", onMoveMouse, {
        capture: true,
      } as any);
      window.removeEventListener(
        "touchmove",
        onMoveTouch as any,
        { capture: true } as any,
      );
    };
  }, [activateMaterial, islandOverlayVisible, islandClosing, islandOpening]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!islandOverlayVisible || islandClosing) return;
      const k = ev.key;
      let label: number | null = null;
      if (k >= "1" && k <= "9") label = 12 - parseInt(k, 10);
      else if (k === "0") label = 2;
      else if (k === "-") label = 1;
      if (!label) return;
      const idx = HOTSPOT_LABELS.indexOf(label);
      if (idx < 0) return;
      ev.preventDefault();
      const fn = flashEntriesRef.current;
      if (fn) fn(new Set([idx]));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [islandOverlayVisible, islandClosing]);

  const [dudePos, setDudePos] = useState<{ x: number; y: number }>({
    x: DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT,
    y: DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT,
  });
  const [dudeFacingLeft, setDudeFacingLeft] = useState<boolean>(false);

  const hasSyncedDudeRef = useRef<boolean>(false);
  const initialDudePosRef = useRef<{ x: number; y: number } | null>({
    x: DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT,
    y: DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT,
  });
  const dudeWrapRef = useRef<HTMLDivElement | null>(null);

  const moveAnimRef = useRef<{
    start: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
    duration: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const keyboardWalkRafRef = useRef<number | null>(null);
  const keyboardWalkLastTsRef = useRef<number | null>(null);
  const keyboardWalkingRef = useRef<boolean>(false);
  const pressedWalkKeysRef = useRef<{
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
  }>({
    up: false,
    down: false,
    left: false,
    right: false,
  });

  const [miningPlaying, setMiningPlaying] = useState(false);
  const miningFrameWrapRef = useRef<HTMLDivElement | null>(null);
  const miningStripImgRef = useRef<HTMLImageElement | null>(null);
  const miningImageRef = useRef<HTMLImageElement | null>(null);
  const [walkingPlaying, setWalkingPlaying] = useState(false);
  const [pettingPlaying, setPettingPlaying] = useState(false);
  const [standingPlaying, setStandingPlaying] = useState(false);
  const sheetAnimRef = useRef<{
    start: number;
    raf: number | null;
    lastFrame: number;
  } | null>(null);
  const currentAnimKindRef = useRef<
    "none" | "mining" | "walking" | "petting" | "standing"
  >("none");

  const [monPos, setMonPos] = useState<{ x: number; y: number } | null>(null);
  const [monFacingLeft, setMonFacingLeftState] = useState<boolean>(false);
  const monFacingLeftRef = useRef(monFacingLeft);
  const setMonFacingLeft = useCallback<
    React.Dispatch<React.SetStateAction<boolean>>
  >(
    (value) => {
      setMonFacingLeftState((prev) => {
        const nextValue =
          typeof value === "function"
            ? (value as (prev: boolean) => boolean)(prev)
            : value;
        monFacingLeftRef.current = nextValue;
        return nextValue;
      });
    },
    [setMonFacingLeftState],
  );
  const [monSpriteData, setMonSpriteData] = useState<string>("");
  const [monKey, setMonKey] = useState<string | null>(null);

  const monWrapRef = useRef<HTMLDivElement | null>(null);
  const monFrameWrapRef = useRef<HTMLDivElement | null>(null);
  const monStripImgRef = useRef<HTMLImageElement | null>(null);
  const monAnimRef = useRef<{
    start: number;
    raf: number | null;
    lastFrame: number;
  } | null>(null);
  const monNaturalSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const monResizeObserverRef = useRef<ResizeObserver | null>(null);
  const monFlipTimerRef = useRef<number | null>(null);
  const monPetTimerRef = useRef<number | null>(null);
  const startPettingAnimationRef = useRef<() => void>(() => {});
  const initialMonPosRef = useRef<{ x: number; y: number } | null>(null);
  const latestMonPosRef = useRef<{ x: number; y: number } | null>(null);
  const latestMonKeyRef = useRef<string | null>(null);
  const updateMonStripSizing = useCallback(() => {
    const wrap = monWrapRef.current as HTMLDivElement | null;
    const frameWrap = monFrameWrapRef.current as HTMLDivElement | null;
    const stripImg = monStripImgRef.current as HTMLImageElement | null;
    const nat = monNaturalSizeRef.current;
    if (!wrap || !frameWrap || !stripImg || !nat.w || !nat.h) return;
    const frameWidth = nat.w / MON_FRAME_COUNT;
    const frameAspect = frameWidth / nat.h;
    wrap.style.setProperty("--mon-frame-aspect", frameAspect.toString());
    frameWrap.style.setProperty("--mon-frame-aspect", frameAspect.toString());
    stripImg.style.setProperty("--mon-frame-count", MON_FRAME_COUNT.toString());
    frameWrap.style.removeProperty("width");
    frameWrap.style.removeProperty("height");
    stripImg.style.removeProperty("width");
    stripImg.style.removeProperty("height");
    const currentFrameIndex = Math.max(0, monAnimRef.current?.lastFrame ?? 0);
    const frameShiftPct = currentFrameIndex * (100 / MON_FRAME_COUNT);
    stripImg.style.transform = `translateX(${-frameShiftPct}%)`;
  }, []);

  const updateMonSprite = useCallback((monType: MonType) => {
    const key = getOwnMonIdByType(monType);
    setMonKey(key);
    latestMonKeyRef.current = key;
    getMonSpritesModule()
      .then(({ getSpriteByKey }) => {
        if (latestMonKeyRef.current !== key) return;
        const data = getSpriteByKey(key);
        setMonSpriteData(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const img = new Image();
    img.src = `data:image/png;base64,${islandMonsMining}`;
    miningImageRef.current = img;
  }, []);

  const playSheetAnimation = useCallback(
    (
      kind: "mining" | "walking" | "petting" | "standing",
      opts?: { onStep?: () => void },
    ) => {
      if (!dudeWrapRef.current) return;
      const sheetImg = miningImageRef.current;
      if (!sheetImg) return;
      if (kind === "mining" && miningPlaying) return;
      if (
        kind === "walking" &&
        currentAnimKindRef.current === "walking" &&
        sheetAnimRef.current &&
        sheetAnimRef.current.raf !== null
      )
        return;
      if (kind === "petting" && pettingPlaying) return;
      if (
        kind === "standing" &&
        currentAnimKindRef.current === "standing" &&
        sheetAnimRef.current &&
        sheetAnimRef.current.raf !== null
      )
        return;

      try {
        if (sheetAnimRef.current && sheetAnimRef.current.raf)
          cancelAnimationFrame(sheetAnimRef.current.raf);
        sheetAnimRef.current = null;
        currentAnimKindRef.current = "none";
        setMiningPlaying(false);
        setWalkingPlaying(false);
        setPettingPlaying(false);
        setStandingPlaying(false);
      } catch {}

      if (kind === "mining") setMiningPlaying(true);
      if (kind === "walking") setWalkingPlaying(true);
      if (kind === "petting") setPettingPlaying(true);
      if (kind === "standing") setStandingPlaying(true);

      let initAttempts = 0;
      const init = () => {
        const wrap = dudeWrapRef.current;
        const frameWrap = miningFrameWrapRef.current;
        const stripImg = miningStripImgRef.current;
        const sheet = miningImageRef.current;
        if (!wrap || !frameWrap || !stripImg || !sheet) {
          initAttempts += 1;
          if (initAttempts <= 5) {
            requestAnimationFrame(init);
            return;
          }
          if (kind === "mining") setMiningPlaying(false);
          if (kind === "walking") setWalkingPlaying(false);
          if (kind === "petting") setPettingPlaying(false);
          if (kind === "standing") setStandingPlaying(false);
          return;
        }

        const { naturalWidth, naturalHeight } = sheet;
        if (!naturalWidth || !naturalHeight) return;
        const frameWidth = naturalWidth / DUDE_FRAME_COUNT;
        const singleRowHeight = naturalHeight / DUDE_SHEET_ROWS;
        if (!frameWidth || !singleRowHeight) return;

        const frameAspect = frameWidth / singleRowHeight;
        wrap.style.setProperty("--dude-frame-aspect", frameAspect.toString());
        frameWrap.style.setProperty(
          "--dude-frame-aspect",
          frameAspect.toString(),
        );
        stripImg.style.setProperty(
          "--dude-frame-count",
          DUDE_FRAME_COUNT.toString(),
        );
        stripImg.style.setProperty(
          "--dude-strip-rows",
          DUDE_SHEET_ROWS.toString(),
        );
        wrap.style.removeProperty("width");
        frameWrap.style.removeProperty("width");
        frameWrap.style.removeProperty("height");
        stripImg.style.removeProperty("width");
        stripImg.style.removeProperty("height");

        const rowIndex =
          kind === "mining"
            ? 0
            : kind === "walking"
              ? 1
              : kind === "petting"
                ? 2
                : 3;
        const rowShiftPct = rowIndex * (100 / DUDE_SHEET_ROWS);
        const initialFrameIndex = kind === "walking" ? 1 : 0;
        const initialFrameShiftPct =
          initialFrameIndex * (100 / DUDE_FRAME_COUNT);
        stripImg.style.transform = `translate(${-initialFrameShiftPct}%, ${-rowShiftPct}%)`;

        const frameMs =
          kind === "walking"
            ? WALKING_FRAME_MS
            : kind === "standing"
              ? STANDING_FRAME_MS
              : MINING_FRAME_MS;
        const loop = kind === "walking" || kind === "standing";

        const animObj = {
          start: performance.now(),
          raf: null as number | null,
          lastFrame: -1,
        };
        sheetAnimRef.current = animObj;
        currentAnimKindRef.current = kind;

        const step = () => {
          if (sheetAnimRef.current !== animObj) return;
          const anim = animObj;
          const elapsed = performance.now() - anim.start;
          const rawFrame = Math.floor(elapsed / frameMs);
          const baseFrame = loop
            ? ((rawFrame % DUDE_FRAME_COUNT) + DUDE_FRAME_COUNT) %
              DUDE_FRAME_COUNT
            : Math.min(DUDE_FRAME_COUNT - 1, Math.max(0, rawFrame));
          const frame =
            kind === "walking" ? (baseFrame + 1) % DUDE_FRAME_COUNT : baseFrame;
          if (frame !== anim.lastFrame) {
            anim.lastFrame = frame;
            const frameShiftPct = frame * (100 / DUDE_FRAME_COUNT);
            stripImg.style.transform = `translate(${-frameShiftPct}%, ${-rowShiftPct}%)`;
          }
          if (opts && opts.onStep) opts.onStep();

          if (loop) {
            animObj.raf = requestAnimationFrame(step);
          } else {
            if (elapsed < DUDE_FRAME_COUNT * frameMs) {
              animObj.raf = requestAnimationFrame(step);
            } else {
              if (kind === "mining") setMiningPlaying(false);
              if (kind === "petting") setPettingPlaying(false);
              sheetAnimRef.current = null;
              currentAnimKindRef.current = "none";
              playSheetAnimation("standing");
            }
          }
        };
        animObj.raf = requestAnimationFrame(step);
      };
      requestAnimationFrame(init);
    },
    [miningPlaying, pettingPlaying],
  );

  const updateDudeStripSizing = useCallback(() => {
    const sheetImg = miningImageRef.current;
    const wrap = dudeWrapRef.current;
    const frameWrap = miningFrameWrapRef.current;
    const stripImg = miningStripImgRef.current;
    if (!sheetImg || !wrap || !frameWrap || !stripImg) return;
    const { naturalWidth, naturalHeight } = sheetImg;
    if (!naturalWidth || !naturalHeight) return;
    const frameWidth = naturalWidth / DUDE_FRAME_COUNT;
    const singleRowHeight = naturalHeight / DUDE_SHEET_ROWS;
    if (!frameWidth || !singleRowHeight) return;

    const frameAspect = frameWidth / singleRowHeight;
    wrap.style.setProperty("--dude-frame-aspect", frameAspect.toString());
    frameWrap.style.setProperty("--dude-frame-aspect", frameAspect.toString());
    stripImg.style.setProperty(
      "--dude-frame-count",
      DUDE_FRAME_COUNT.toString(),
    );
    stripImg.style.setProperty("--dude-strip-rows", DUDE_SHEET_ROWS.toString());
    frameWrap.style.removeProperty("width");
    frameWrap.style.removeProperty("height");
    stripImg.style.removeProperty("width");
    stripImg.style.removeProperty("height");

    const kind = currentAnimKindRef.current;
    const rowIndex =
      kind === "mining"
        ? 0
        : kind === "walking"
          ? 1
          : kind === "petting"
            ? 2
            : 3;
    const rowShiftPct = rowIndex * (100 / DUDE_SHEET_ROWS);
    const lastFrame = sheetAnimRef.current?.lastFrame ?? -1;
    const frameIndex =
      lastFrame === -1 && kind === "walking" ? 1 : Math.max(0, lastFrame);
    const frameShiftPct = frameIndex * (100 / DUDE_FRAME_COUNT);
    stripImg.style.transform = `translate(${-frameShiftPct}%, ${-rowShiftPct}%)`;
  }, []);

  useEffect(() => {
    if (!islandOverlayVisible || islandClosing) return;
    const handler = () => {
      updateDudeStripSizing();
    };
    window.addEventListener("resize", handler);
    document.addEventListener("fullscreenchange", handler);
    handler();
    return () => {
      window.removeEventListener("resize", handler);
      document.removeEventListener("fullscreenchange", handler);
    };
  }, [islandOverlayVisible, islandClosing, updateDudeStripSizing]);

  useLayoutEffect(() => {
    if (!islandOverlayVisible || islandClosing) return;
    updateDudeStripSizing();
  }, [
    islandOverlayVisible,
    islandClosing,
    updateDudeStripSizing,
    heroSize.h,
    heroSize.w,
    dudeVisible,
  ]);

  const startStandingAnimation = useCallback(
    () => playSheetAnimation("standing"),
    [playSheetAnimation],
  );

  useEffect(() => {
    if (!islandOverlayVisible || islandClosing) return;
    if (!dudeVisible) return;
    let raf1 = 0;
    let raf2 = 0;
    let timer: number | null = null;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (
            miningPlaying ||
            walkingPlaying ||
            pettingPlaying ||
            standingPlaying
          )
            return;
          startStandingAnimation();
        }, 180);
      });
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    islandOverlayVisible,
    islandClosing,
    dudeVisible,
    miningPlaying,
    walkingPlaying,
    pettingPlaying,
    standingPlaying,
    startStandingAnimation,
  ]);

  useEffect(() => {
    const shouldBeMarkedOpen =
      islandOverlayShown || islandOpening || islandClosing;
    if (shouldBeMarkedOpen) {
      document.body.classList.add("island-overlay-open");
    } else {
      document.body.classList.remove("island-overlay-open");
    }
    return () => {
      document.body.classList.remove("island-overlay-open");
    };
  }, [islandOverlayShown, islandOpening, islandClosing]);

  useEffect(() => {
    overlayActiveRef.current =
      islandOverlayVisible || islandOpening || islandClosing;
  }, [islandOverlayVisible, islandOpening, islandClosing]);

  useEffect(() => {
    return () => {
      if (heroTransformFrameRef.current !== null) {
        cancelAnimationFrame(heroTransformFrameRef.current);
        heroTransformFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    if (islandOverlayVisible && !islandClosing) {
      timer = window.setTimeout(() => {
        setDecorVisible(true);
        setDudeVisible(true);
        updateDudeStripSizing();
      }, 120);
    } else {
      setDecorVisible(false);
      setDudeVisible(false);
      setMonVisible(false);
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [islandOverlayVisible, islandClosing, updateDudeStripSizing]);

  useEffect(() => {
    let mounted = true;
    if (imageUrl === DEFAULT_URL) {
      getIslandImageUrl().then((url) => {
        if (!mounted) return;
        setResolvedUrl(url || imageUrl);
      });
    } else {
      setResolvedUrl(imageUrl);
    }
    return () => {
      mounted = false;
    };
  }, [imageUrl]);

  useEffect(() => {
    if (!resolvedUrl) return;
    const img = new Image();
    img.src = resolvedUrl;
    if (img.complete) {
      setIslandNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setIslandImgLoaded(true);
    } else {
      img.onload = () => {
        setIslandNatural({ w: img.naturalWidth, h: img.naturalHeight });
        setIslandImgLoaded(true);
      };
    }
  }, [resolvedUrl]);

  useEffect(() => {
    if (!islandImgLoaded) return;
    const timer = setTimeout(() => {
      setSparkleMounted(true);
    }, 50);
    return () => clearTimeout(timer);
  }, [islandImgLoaded]);

  useEffect(() => {
    let mounted = true;
    MATERIALS.forEach((name) => {
      getMaterialImageUrl(name).then((url) => {
        if (!mounted) return;
        setMaterialUrls((prev) => ({ ...prev, [name]: url }));
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const win: any = typeof window !== "undefined" ? (window as any) : null;
    const schedule = (fn: () => void) => {
      if (!win) {
        const t = setTimeout(() => {
          if (!cancelled) fn();
        }, 120);
        return () => clearTimeout(t);
      }
      if (typeof win.requestIdleCallback === "function") {
        const id = win.requestIdleCallback(() => {
          if (!cancelled) fn();
        });
        return () => {
          if (typeof win.cancelIdleCallback === "function")
            win.cancelIdleCallback(id);
        };
      }
      const t = setTimeout(() => {
        if (!cancelled) fn();
      }, 120);
      return () => clearTimeout(t);
    };
    const cleanups: Array<() => void> = [];
    MATERIALS.forEach((name) => {
      if (decodedMaterialsRef.current.has(name)) return;
      const cleanup = schedule(() => {
        getMaterialImageUrl(name).then((url) => {
          if (!url || cancelled) return;
          const img = new Image();
          img.src = url;
          const p: Promise<void> =
            typeof (img as any).decode === "function"
              ? (img as any).decode()
              : Promise.resolve();
          p.then(() => {
            if (!cancelled) decodedMaterialsRef.current.add(name);
          }).catch(() => {});
        });
      });
      if (cleanup) cleanups.push(cleanup);
    });
    return () => {
      cancelled = true;
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  }, []);

  useEffect(() => {
    if (!islandOverlayVisible || islandClosing) return;
    const hero = islandHeroImgRef.current;
    if (!hero) return;
    const rect = hero.getBoundingClientRect();
    setHeroSize({
      w: Math.max(1, Math.round(rect.width)),
      h: Math.max(1, Math.round(rect.height)),
    });
    let canvas = heroHitCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      heroHitCanvasRef.current = canvas;
    }
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(hero, 0, 0, w, h);
    } catch {}
  }, [islandOverlayVisible, islandClosing, resolvedUrl]);

  useEffect(() => {
    const onResize = () => {
      const hero = islandHeroImgRef.current;
      if (!hero) return;
      const rect = hero.getBoundingClientRect();
      setHeroSize({
        w: Math.max(1, Math.round(rect.width)),
        h: Math.max(1, Math.round(rect.height)),
      });
    };
    if (islandOverlayVisible) {
      window.addEventListener("resize", onResize);
      onResize();
    }
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [islandOverlayVisible]);

  const syncDudePosFromOriginal = useCallback(() => {
    if (hasSyncedDudeRef.current) return;
    const cx = DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT;
    const cy = DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT;
    const clampedX = Math.max(0, Math.min(1, cx));
    const clampedY = Math.max(0, Math.min(1, cy));
    setDudePos({ x: clampedX, y: clampedY });
    initialDudePosRef.current = { x: clampedX, y: clampedY };
    hasSyncedDudeRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!islandOverlayVisible) return;
    if (hasSyncedDudeRef.current) return;
    const cx = DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT;
    const cy = DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT;
    const clampedX = Math.max(0, Math.min(1, cx));
    const clampedY = Math.max(0, Math.min(1, cy));
    setDudePos({ x: clampedX, y: clampedY });
    initialDudePosRef.current = { x: clampedX, y: clampedY };
    hasSyncedDudeRef.current = true;
  }, [islandOverlayVisible]);

  const initializeWalkPolygonIfNeeded = useCallback(() => {}, []);

  useEffect(() => {
    if (!islandOverlayVisible || islandOpening || islandClosing) return;
    if (!heroSize.w || !heroSize.h) return;
    if (walkReady) return;
    initializeWalkPolygonIfNeeded();
  }, [
    islandOverlayVisible,
    islandOpening,
    islandClosing,
    heroSize.w,
    heroSize.h,
    walkReady,
    initializeWalkPolygonIfNeeded,
  ]);

  const getDudeBounds = useCallback((): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    area: number;
  } => {
    const widthFrac = Math.max(0.001, Math.min(1, DUDE_BOUNDS_WIDTH_FRAC));
    const heightFrac = Math.max(0.001, Math.min(1, DUDE_BOUNDS_HEIGHT_FRAC));
    const refPos = latestDudePosRef.current;
    const hasValidRefPos =
      refPos &&
      isFinite(refPos.x) &&
      isFinite(refPos.y) &&
      !(refPos.x === 0 && refPos.y === 0);
    const fallback = initialDudePosRef.current ?? {
      x: DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT,
      y: DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT,
    };
    const cx = hasValidRefPos ? refPos.x : fallback.x;
    const bottomY = hasValidRefPos ? refPos.y : fallback.y;
    const left = cx - widthFrac * 0.5;
    const right = cx + widthFrac * 0.5;
    const top = bottomY - heightFrac;
    const bottom = bottomY;
    return {
      left,
      top,
      right,
      bottom,
      area: Math.max(0, right - left) * Math.max(0, bottom - top),
    };
  }, []);

  const findValidMonLocation = useCallback(
    (opts: { mode: "initial" | "teleport" }) => {
      const defaultCandidate = { x: MON_REL_X, y: MON_REL_Y };
      const dudeB = getDudeBounds();
      const ellipse = SMALLER_SMOOTH_CYCLING_ELLIPSE;
      const minX = ellipse.cx - ellipse.rx - MON_BOUNDS_X_SHIFT;
      const maxX = ellipse.cx + ellipse.rx - MON_BOUNDS_X_SHIFT;
      const minY = ellipse.cy - ellipse.ryTop - MON_BASELINE_Y_OFFSET;
      const maxY = ellipse.cy + ellipse.ryBottom - MON_BASELINE_Y_OFFSET;
      const rx = ellipse.rx;
      const centerX = ellipse.cx;
      const centerY = ellipse.cy;
      const invRxSq = rx > 0 ? 1 / (rx * rx) : 0;
      const invRyTopSq =
        ellipse.ryTop > 0 ? 1 / (ellipse.ryTop * ellipse.ryTop) : 0;
      const invRyBottomSq =
        ellipse.ryBottom > 0 ? 1 / (ellipse.ryBottom * ellipse.ryBottom) : 0;
      const rangeX = maxX - minX;
      const rangeY = maxY - minY;
      const insideEllipse = (cx: number, bottomY: number) => {
        if (invRxSq === 0) return false;
        const dx = cx - centerX;
        const dy = bottomY - centerY;
        const invRySq = dy <= 0 ? invRyTopSq : invRyBottomSq;
        if (invRySq === 0) return false;
        return dx * dx * invRxSq + dy * dy * invRySq <= 1;
      };
      const widthFrac = getMonBoundsWidthFrac(
        latestMonKeyRef.current ?? monKey,
      );
      const heightFrac = MON_HEIGHT_FRAC;
      const halfWidth = widthFrac * 0.5;
      const monArea = widthFrac * heightFrac;
      const DUDE_MAX_OVERLAP_FRAC = 0.055;
      const ROCK_MAX_OVERLAP_FRAC = 0.5;
      const dudeOverlapLimit = DUDE_MAX_OVERLAP_FRAC * monArea;
      const rockOverlapLimit = ROCK_MAX_OVERLAP_FRAC * monArea;
      const rockHalf = THEORETICAL_ROCK_SQUARE.side * 0.5;
      const rockB = {
        left: THEORETICAL_ROCK_SQUARE.cx - rockHalf,
        right: THEORETICAL_ROCK_SQUARE.cx + rockHalf,
        top: THEORETICAL_ROCK_SQUARE.cy - rockHalf,
        bottom: THEORETICAL_ROCK_SQUARE.cy + rockHalf,
      } as { left: number; top: number; right: number; bottom: number };
      const tryFindNonOverlappingPosition = (): {
        x: number;
        y: number;
      } | null => {
        let attempts = 0;
        while (attempts < 777) {
          attempts++;
          const x = minX + Math.random() * rangeX;
          const y = minY + Math.random() * rangeY;
          const cx = x + MON_BOUNDS_X_SHIFT;
          const bottomY = y + MON_BASELINE_Y_OFFSET;
          if (!insideEllipse(cx, bottomY)) continue;
          const left = cx - halfWidth;
          const right = cx + halfWidth;
          const top = bottomY - heightFrac;
          const bottom = bottomY;
          let ix = Math.max(
            0,
            Math.min(rockB.right, right) - Math.max(rockB.left, left),
          );
          if (ix > 0) {
            let iy = Math.max(
              0,
              Math.min(rockB.bottom, bottom) - Math.max(rockB.top, top),
            );
            if (ix * iy > rockOverlapLimit) continue;
          }
          if (dudeB) {
            ix = Math.max(
              0,
              Math.min(dudeB.right, right) - Math.max(dudeB.left, left),
            );
            if (ix > 0) {
              const iy = Math.max(
                0,
                Math.min(dudeB.bottom, bottom) - Math.max(dudeB.top, top),
              );
              if (ix * iy > dudeOverlapLimit) continue;
            }
          }
          return { x, y };
        }
        return null;
      };
      if (opts.mode === "initial") {
        if (persistentMonPosRef) return persistentMonPosRef;
        if (initialMonPosRef.current) return initialMonPosRef.current;
        const pt = tryFindNonOverlappingPosition();
        if (pt) {
          initialMonPosRef.current = pt;
          return pt;
        }
        initialMonPosRef.current = defaultCandidate;
      }
      if (opts.mode === "teleport") {
        const tp = tryFindNonOverlappingPosition();
        if (tp) return tp;
      }
      return defaultCandidate;
    },
    [monKey, getDudeBounds],
  );

  useEffect(() => {
    if (!islandOverlayVisible) return;
    const pt = findValidMonLocation({ mode: "initial" });
    setMonPos(pt);
    latestMonPosRef.current = pt;
    setMonFacingLeft(Math.random() < 0.5);
    const storedType = ensureMonType(storage.getIslandMonType(MonType.DRAINER));
    updateMonSprite(storedType);
  }, [
    islandOverlayVisible,
    setMonFacingLeft,
    findValidMonLocation,
    updateMonSprite,
  ]);

  useEffect(() => {
    if (!decorVisible || islandClosing || !islandOverlayVisible) return;
    if (!monSpriteData || !monPos) return;
    const tick = () => {
      if (!overlayActiveRef.current) return;
      if (Math.random() < 0.5) setMonFacingLeft((prev) => !prev);
    };
    monFlipTimerRef.current = window.setInterval(tick, 15000);
    return () => {
      if (monFlipTimerRef.current !== null) {
        clearInterval(monFlipTimerRef.current);
        monFlipTimerRef.current = null;
      }
    };
  }, [
    decorVisible,
    islandClosing,
    islandOverlayVisible,
    setMonFacingLeft,
    monSpriteData,
    monPos,
  ]);

  const petMon = useCallback(() => {
    const frame = monFrameWrapRef.current;
    if (!frame) return;
    const baseX = monFacingLeft ? -1 : 1;
    try {
      frame.style.transformOrigin = "50% 100%";
      frame.style.transition = "transform 80ms ease-out";
      frame.style.transform = `scale(${baseX * 1.06}, 0.86)`;
      playSounds([Sound.PetMon]);
    } catch {}
    try {
      startPettingAnimationRef.current();
    } catch {}
    if (monPetTimerRef.current !== null) {
      clearTimeout(monPetTimerRef.current);
      monPetTimerRef.current = null;
    }
    monPetTimerRef.current = window.setTimeout(() => {
      try {
        frame.style.transition =
          "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
        frame.style.transform = `scale(${baseX}, 1)`;
      } catch {}
      if (monPetTimerRef.current !== null) {
        clearTimeout(monPetTimerRef.current);
        monPetTimerRef.current = null;
      }
      monPetTimerRef.current = window.setTimeout(() => {
        try {
          frame.style.removeProperty("transform");
          frame.style.removeProperty("transition");
          frame.style.removeProperty("transform-origin");
        } catch {}
        monPetTimerRef.current = null;
      }, 230);
    }, 100);
  }, [monFacingLeft]);

  useEffect(() => {
    return () => {
      if (monPetTimerRef.current !== null) {
        clearTimeout(monPetTimerRef.current);
        monPetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!decorVisible || islandClosing) return;
    if (!monSpriteData || !monPos) return;

    requestAnimationFrame(() => {
      const wrap = monWrapRef.current;
      const frameWrap = monFrameWrapRef.current;
      const stripImg = monStripImgRef.current;
      if (!wrap || !frameWrap || !stripImg) return;
      const img = new Image();
      img.src = `data:image/webp;base64,${monSpriteData}`;
      const startAnim = () => {
        const frameCount = MON_FRAME_COUNT;
        monNaturalSizeRef.current = {
          w: img.naturalWidth || 1,
          h: img.naturalHeight || 1,
        };
        stripImg.style.visibility = "hidden";
        updateMonStripSizing();
        stripImg.style.transform = `translateX(0%)`;
        monAnimRef.current = {
          start: performance.now(),
          raf: null,
          lastFrame: -1,
        };
        const MON_FRAME_MS = 220;
        const step = () => {
          const anim = monAnimRef.current;
          if (!anim) return;
          if (!overlayActiveRef.current) {
            monAnimRef.current = null;
            setMonVisible(false);
            return;
          }
          const elapsed = performance.now() - anim.start;
          const rawFrame = Math.floor(elapsed / MON_FRAME_MS);
          const frame = ((rawFrame % frameCount) + frameCount) % frameCount;
          if (frame !== anim.lastFrame) anim.lastFrame = frame;
          const frameShiftPct = frame * (100 / MON_FRAME_COUNT);
          stripImg.style.transform = `translateX(${-frameShiftPct}%)`;
          if (stripImg.style.visibility !== "visible") {
            stripImg.style.visibility = "visible";
            setMonVisible(true);
          }

          anim.raf = requestAnimationFrame(step);
        };
        step();

        try {
          if (typeof ResizeObserver !== "undefined" && wrap) {
            const ro = new ResizeObserver(() => updateMonStripSizing());
            monResizeObserverRef.current = ro;
            ro.observe(wrap);
          }
        } catch {}
      };
      if (img.complete) startAnim();
      else img.onload = () => startAnim();
    });
    const cleanupWrap = monWrapRef.current;
    return () => {
      const anim = monAnimRef.current;
      if (anim && anim.raf) cancelAnimationFrame(anim.raf);
      monAnimRef.current = null;
      try {
        const ro = monResizeObserverRef.current;
        if (ro && cleanupWrap) ro.unobserve(cleanupWrap);
      } catch {}
      monResizeObserverRef.current = null;
      setMonVisible(false);
    };
  }, [
    decorVisible,
    islandClosing,
    monSpriteData,
    monPos,
    updateMonStripSizing,
  ]);

  useLayoutEffect(() => {
    if (!decorVisible || islandClosing) return;
    if (!monSpriteData || !monPos) return;
    updateMonStripSizing();
  }, [
    decorVisible,
    islandClosing,
    monSpriteData,
    monPos,
    heroSize.h,
    heroSize.w,
    updateMonStripSizing,
  ]);

  const measureHeroSize = useCallback(() => {
    const hero = islandHeroImgRef.current;
    if (!hero) return;
    const rect = hero.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    setHeroSize({ w, h });
  }, []);

  const updateRockBox = useCallback(() => {
    if (!rockReadyRef.current) return;
    const hero = islandHeroImgRef.current;
    const rockEl = rockLayerRef.current;
    if (!hero || !rockEl) return;
    const h = hero.getBoundingClientRect();
    const r = rockEl.getBoundingClientRect();
    if (h.width <= 0 || h.height <= 0) return;
    const rawLeft = (r.left - h.left) / h.width;
    const rawTop = (r.top - h.top) / h.height;
    const rawRight = (r.right - h.left) / h.width;
    const rawBottom = (r.bottom - h.top) / h.height;
    const w = Math.max(0, rawRight - rawLeft);
    const hh = Math.max(0, rawBottom - rawTop);
    let left = rawLeft + ROCK_BOX_INSET_LEFT_FRAC * w;
    let right = rawRight - ROCK_BOX_INSET_RIGHT_FRAC * w;
    let top = rawTop + ROCK_BOX_INSET_TOP_FRAC * hh;
    let bottom = rawBottom - ROCK_BOX_INSET_BOTTOM_FRAC * hh;
    left = Math.max(0, Math.min(1, left));
    right = Math.max(0, Math.min(1, right));
    top = Math.max(0, Math.min(1, top));
    bottom = Math.max(0, Math.min(1, bottom));
    if (right < left) right = left;
    if (bottom < top) bottom = top;

    rockBoxRef.current = { left, top, right, bottom };
    setRockBottomY(bottom);
  }, [setRockBottomY]);

  useEffect(() => {
    if (!islandOverlayVisible) return;
    updateRockBox();
    const onResize = () => updateRockBox();
    window.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    const node = rockLayerRef.current;
    try {
      if (node && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => updateRockBox());
        ro.observe(node);
      }
    } catch {}
    return () => {
      window.removeEventListener("resize", onResize);
      try {
        if (ro && node) ro.unobserve(node);
      } catch {}
    };
  }, [islandOverlayVisible, updateRockBox]);

  useEffect(() => {
    if (!islandOverlayVisible || !decorVisible) return;
    updateRockBox();
  }, [decorVisible, islandOverlayVisible, updateRockBox]);

  useLayoutEffect(() => {
    if (!islandOverlayVisible || !rockAvailable) return;
    const frame = requestAnimationFrame(() => updateRockBox());
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [islandOverlayVisible, rockAvailable, updateRockBox]);

  useLayoutEffect(() => {
    if (!islandOverlayVisible || !rockReady) return;
    updateRockBox();
  }, [islandOverlayVisible, rockReady, updateRockBox]);

  useEffect(() => {
    if (!islandOverlayVisible) return;
    try {
      requestAnimationFrame(() => updateRockBox());
    } catch {}
  }, [resolvedUrl, islandOverlayVisible, updateRockBox]);

  const finalizeOverlayClose = useCallback(() => {
    if (heroTransformFrameRef.current !== null) {
      cancelAnimationFrame(heroTransformFrameRef.current);
      heroTransformFrameRef.current = null;
    }
    overlayPhaseRef.current = "idle";
    overlayActiveRef.current = false;
    overlayJustOpenedAtRef.current = 0;
    clearAnonSignInDrop();
    amountsDecoupledRef.current = false;
    const resetMaterials = computeAvailableMaterials(
      latestServiceMaterialsRef.current,
      frozenMaterialsRef.current,
    );
    setMaterialAmounts(resetMaterials);
    const container = fxContainerRef.current;
    if (container && container.parentNode) {
      try {
        container.parentNode.removeChild(container);
      } catch {}
    }
    fxContainerRef.current = null;
    const heroImg = islandHeroImgRef.current;
    if (heroImg) {
      const heroWrap = heroImg.parentElement as HTMLElement | null;
      if (heroWrap) {
        const nodes = heroWrap.querySelectorAll(
          '[data-fx="material-drop"], [data-fx="material-drop-shadow"]',
        );
        nodes.forEach((n) => {
          try {
            n.parentElement?.removeChild(n);
          } catch {}
        });
      }
    }
    materialDropsRef.current = [];
    moveAnimRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const walkCleanup = walkingDragCleanupRef.current;
    if (walkCleanup) walkCleanup();
    walkingDragCleanupRef.current = null;
    walkingDragActiveRef.current = false;
    const sheetAnim = sheetAnimRef.current;
    if (sheetAnim && sheetAnim.raf) cancelAnimationFrame(sheetAnim.raf);
    sheetAnimRef.current = null;
    currentAnimKindRef.current = "none";
    const monAnim = monAnimRef.current;
    if (monAnim && monAnim.raf) cancelAnimationFrame(monAnim.raf);
    monAnimRef.current = null;
    const monFlip = monFlipTimerRef.current;
    if (monFlip !== null) {
      window.clearTimeout(monFlip);
      monFlipTimerRef.current = null;
    }
    const monPet = monPetTimerRef.current;
    if (monPet !== null) {
      window.clearTimeout(monPet);
      monPetTimerRef.current = null;
    }
    latestMonKeyRef.current = null;
    setMonSpriteData("");
    setMonPos(null);
    setMonKey(null);
    setMonVisible(false);
    setMonTeleporting(false);
    setDecorVisible(false);
    setDudeVisible(false);
    setMiningPlaying(false);
    setWalkingPlaying(false);
    setPettingPlaying(false);
    setStandingPlaying(false);
    setStarsVisible(false);
    setStarsHold(false);
    starsHoldRef.current = false;
    starsAnimActiveRef.current = false;
    wasStarsInsideRef.current = false;
    starsDismissedRef.current = false;
    if (starsTimerRef.current) {
      window.clearTimeout(starsTimerRef.current);
      starsTimerRef.current = 0;
    }
    if (starsCenterRafRef.current !== null) {
      cancelAnimationFrame(starsCenterRafRef.current);
      starsCenterRafRef.current = null;
    }
    starsCenterTargetRef.current = null;
    lastStarsCenterRef.current = { xPct: 50, yPct: 50 };
    setStarsMaskCenter({ xPct: 50, yPct: 50 });
    rockBoxRef.current = null;
    lastRockRectRef.current = null;
    setIslandActive(false);
    setIslandAnimating(false);
    setIslandOpening(false);
    setIslandClosing(false);
    setIslandOverlayVisible(false);
    setIslandOverlayShown(false);
    setIslandTranslate({ x: 0, y: 0 });
    setIslandScale({ x: 1, y: 1 });
    setWalkReady(false);
  }, [clearAnonSignInDrop]);

  const handleIslandOpen = useCallback(
    function handleIslandOpen() {
      if (overlayPhaseRef.current !== "idle") {
        return;
      }

      setSparkleFading(true);

      const playerSeemedInitialized = soundPlayer.isInitialized;

      if (!playerSeemedInitialized) {
        soundPlayer.scheduleIslandShowUpOnInitComplete();
      }

      soundPlayer.initializeOnUserInteraction(true).then(() => {
        if (playerSeemedInitialized) {
          playSounds([Sound.IslandShowUp]);
        }
        preloadSounds([
          Sound.PickaxeHit,
          Sound.PickaxeMiss,
          Sound.RockOpen,
          Sound.CollectingMaterials,
          Sound.IslandClose,
        ]).catch(() => {});
      });

      closeAllKindsOfPopups();
      if (!islandImgLoaded || !islandNatural) return;
      const imgEl = islandButtonImgRef.current;
      if (!imgEl) return;
      overlayPhaseRef.current = "opening";
      const snapshot = rocksMiningService.getSnapshot();
      const nextMaterials = { ...snapshot.materials };
      latestServiceMaterialsRef.current = nextMaterials;
      amountsDecoupledRef.current = false;
      const available = computeAvailableMaterials(
        nextMaterials,
        frozenMaterialsRef.current,
      );
      setMaterialAmounts(available);
      const rect = imgEl.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const ratio = islandNatural.w / islandNatural.h;
      const restH = Math.min(vh * 0.5, (vw * 0.92) / ratio);
      const cx = vw / 2;
      const cy = vh / 2;
      const bx = rect.left + rect.width / 2;
      const by = rect.top + rect.height / 2;
      const deltaX = bx - cx;
      const deltaY = by - cy;
      const displayedH = rect.height;
      const uniformScale = displayedH / restH;
      overlayJustOpenedAtRef.current = Date.now();
      setIslandOverlayShown(true);
      setIslandOverlayVisible(false);
      setIslandAnimating(true);
      setIslandClosing(false);
      setIslandOpening(true);
      setIslandActive(false);
      clearAnonSignInDrop();
      setRockBreaking(false);
      setRockReady(false);
      try {
        rockBoxRef.current = null;
        setRockBottomY(1);
      } catch {}
      setIslandTranslate({ x: deltaX, y: deltaY });
      setIslandScale({ x: uniformScale, y: uniformScale });
      if (heroTransformFrameRef.current !== null) {
        cancelAnimationFrame(heroTransformFrameRef.current);
        heroTransformFrameRef.current = null;
      }
      heroTransformFrameRef.current = requestAnimationFrame(() => {
        heroTransformFrameRef.current = null;
        overlayPhaseRef.current = "opening";
        setIslandActive(true);
        setIslandTranslate({ x: 0, y: 0 });
        setIslandScale({ x: 1, y: 1 });
        setIslandOverlayVisible(true);
        setWalkReady(false);
        try {
          updateRockBox();
        } catch {}
      });
    },
    [
      clearAnonSignInDrop,
      islandImgLoaded,
      islandNatural,
      setRockBottomY,
      setRockReady,
      updateRockBox,
    ],
  );

  const spawnIconParticles = useCallback(
    (sourceEl: HTMLElement, src: string) => {
      const numParticles = 10;
      const durationMs = 420;
      const start = performance.now();
      const rect = sourceEl.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const baseSize = Math.max(14, Math.min(28, rect.width * 0.7));
      const els: HTMLImageElement[] = [];
      let fxContainer = fxContainerRef.current as HTMLDivElement | null;
      if (!fxContainer) {
        fxContainer = document.createElement("div");
        fxContainer.style.position = "fixed";
        fxContainer.style.left = "0";
        fxContainer.style.top = "0";
        fxContainer.style.right = "0";
        fxContainer.style.bottom = "0";
        fxContainer.style.pointerEvents = "none";
        fxContainer.style.zIndex = "90005";

        fxContainerRef.current = fxContainer;
        document.body.appendChild(fxContainer);
      }
      for (let i = 0; i < numParticles; i++) {
        const el = document.createElement("img");
        el.src = src;
        el.draggable = false;
        el.style.position = "absolute";
        el.style.left = "0";
        el.style.top = "0";
        el.style.width = `${baseSize}px`;
        el.style.height = `${baseSize}px`;
        el.style.pointerEvents = "none";
        el.style.zIndex = "90003";
        el.style.backfaceVisibility = "hidden";
        el.style.transform = `translate(${startX - baseSize / 2}px, ${startY - baseSize / 2}px) scale(1)`;
        el.style.opacity = "1";
        el.setAttribute("data-fx", "icon-particle");
        fxContainer.appendChild(el);
        els.push(el);
      }
      const angles = els.map(
        (_, i) =>
          (i / numParticles) * Math.PI * 2 +
          Math.random() * (Math.PI / numParticles) -
          Math.PI / 2,
      );
      const distances = els.map(() => 60 + Math.random() * 80);
      const rotations = els.map(() => (Math.random() - 0.5) * 0.4);
      function easeOutCubic(t: number) {
        return 1 - Math.pow(1 - t, 3);
      }
      function step(now: number) {
        const t = Math.min(1, (now - start) / durationMs);
        const e = easeOutCubic(t);
        for (let i = 0; i < els.length; i++) {
          const dx = Math.cos(angles[i]) * distances[i] * e;
          const dy =
            Math.sin(angles[i]) * distances[i] * e +
            0.35 * distances[i] * e * e;
          const s = 1 - 0.35 * e;
          const r = rotations[i] * 90 * e;
          els[i].style.transform =
            `translate(${startX - baseSize / 2 + dx}px, ${startY - baseSize / 2 + dy}px) scale(${s}) rotate(${r}deg)`;
          els[i].style.opacity = `${1 - e}`;
        }
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          for (const el of els) el.remove();
        }
      }
      requestAnimationFrame(step);
    },
    [],
  );

  useEffect(() => {
    spawnIconParticlesFnRef.current = spawnIconParticles;
  }, [spawnIconParticles]);

  const pullMaterialToBar = useCallback(
    (name: MaterialName, fromRect: MaterialPullRect) => {
      const url = materialUrls[name];
      if (!url) return;
      const host = materialItemRefs.current[name];
      if (!host) return;
      const targetImg =
        (host.querySelector("img") as HTMLImageElement | null) || null;
      const toRect = (targetImg || host).getBoundingClientRect();

      let fxContainer = fxContainerRef.current as HTMLDivElement | null;
      if (!fxContainer) {
        fxContainer = document.createElement("div");
        fxContainer.style.position = "fixed";
        fxContainer.style.left = "0";
        fxContainer.style.top = "0";
        fxContainer.style.right = "0";
        fxContainer.style.bottom = "0";
        fxContainer.style.pointerEvents = "none";
        fxContainer.style.zIndex = "90005";
        fxContainerRef.current = fxContainer;
        document.body.appendChild(fxContainer);
      }

      const startX = fromRect.left + fromRect.width / 2;
      const startY = fromRect.top + fromRect.height / 2;
      const endX = toRect.left + toRect.width / 2;
      const endY = toRect.top + toRect.height / 2;
      const startW = Math.max(1, fromRect.width);
      const startH = Math.max(1, fromRect.height);
      const endW = Math.max(1, toRect.width);
      const endH = Math.max(1, toRect.height);

      const img = document.createElement("img");
      img.src = url;
      img.draggable = false;
      img.style.position = "absolute";
      img.style.left = "0";
      img.style.top = "0";
      img.style.width = `${startW}px`;
      img.style.height = `${startH}px`;
      img.style.pointerEvents = "none";
      img.style.zIndex = "90006";
      img.style.backfaceVisibility = "hidden";
      img.style.transform = `translate(${startX - startW / 2}px, ${startY - startH / 2}px) scale(1)`;
      img.style.opacity = "1";
      img.setAttribute("data-fx", "material-pull");
      fxContainer.appendChild(img);

      const durationMs = 500;
      const start = performance.now();

      const ease = (t: number) => 1 - Math.pow(1 - t, 3);

      function step(now: number) {
        const t = Math.min(1, (now - start) / durationMs);
        const e = ease(t);
        const bx = startX + (endX - startX) * e;
        const by = startY + (endY - startY) * e;
        const o = 1 - 0.1 * e;
        const w = startW + (endW - startW) * e;
        const h = startH + (endH - startH) * e;
        img.style.width = `${w}px`;
        img.style.height = `${h}px`;
        img.style.transform = `translate(${bx - w / 2}px, ${by - h / 2}px) scale(1)`;
        img.style.opacity = `${o}`;
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          img.remove();
        }
      }
      requestAnimationFrame(step);
      if (amountsDecoupledRef.current) {
        setMaterialAmounts((prev) => ({
          ...prev,
          [name]: prev[name] + 1,
        }));
      }
    },
    [materialItemRefs, materialUrls, setMaterialAmounts],
  );

  const flushMaterialPullQueue = useCallback(() => {
    materialPullFlushRef.current = null;
    const queue = materialPullQueueRef.current;
    if (!queue.length) return;
    materialPullQueueRef.current = [];
    for (let i = 0; i < queue.length; i++) {
      pullMaterialToBar(queue[i].name, queue[i].rect);
    }
  }, [pullMaterialToBar]);

  const queueMaterialPull = useCallback(
    (name: MaterialName, rect: MaterialPullRect) => {
      materialPullQueueRef.current.push({ name, rect });
      if (materialPullFlushRef.current !== null) return;
      materialPullFlushRef.current = requestAnimationFrame(() =>
        flushMaterialPullQueue(),
      );
    },
    [flushMaterialPullQueue],
  );

  useEffect(() => {
    return () => {
      if (materialPullFlushRef.current !== null) {
        cancelAnimationFrame(materialPullFlushRef.current);
        materialPullFlushRef.current = null;
      }
      materialPullQueueRef.current = [];
    };
  }, []);

  useEffect(() => {
    return () => {
      if (anonSignInDropSettleTimeoutRef.current !== null) {
        window.clearTimeout(anonSignInDropSettleTimeoutRef.current);
        anonSignInDropSettleTimeoutRef.current = null;
      }
    };
  }, []);

  const calculateMaterialZ = useCallback((baselineFrac: number) => {
    const clamped = Math.max(0, Math.min(1, baselineFrac));
    const depth = Math.round(clamped * 100);
    const rockReadyNow = rockReadyRef.current;
    const rockBottomNow = Math.max(0, Math.min(1, rockBottomYRef.current));
    let zone: MaterialDropEntry["zone"] = "neutral";
    let zoneBase = 600;
    if (rockReadyNow) {
      const inFront = clamped >= rockBottomNow;
      zone = inFront ? "front" : "behind";
      zoneBase = inFront ? 700 : 300;
    }
    const zBase = Math.max(zoneBase, ROCK_LAYER_Z_INDEX);
    const zMain = zBase + depth;
    const zShadow = Math.max(0, zMain - 1);
    return { clamped, zone, zMain, zShadow };
  }, []);

  const setMaterialDropZ = useCallback(
    (
      entry: MaterialDropEntry,
      info: {
        clamped: number;
        zone: MaterialDropEntry["zone"];
        zMain: number;
        zShadow: number;
      },
    ) => {
      entry.baseline = info.clamped;
      entry.zone = info.zone;
      entry.lastZ = info.zMain;
      entry.el.style.zIndex = `${info.zMain}`;
      entry.shadow.style.zIndex = `${info.zShadow}`;
    },
    [],
  );

  const updateFlightZoneIfNeeded = useCallback(
    (entry: MaterialDropEntry, baselineFrac: number) => {
      const info = calculateMaterialZ(baselineFrac);
      if (info.zone !== entry.zone) {
        setMaterialDropZ(entry, info);
      } else {
        entry.baseline = info.clamped;
      }
    },
    [calculateMaterialZ, setMaterialDropZ],
  );

  const settleMaterialDrop = useCallback(
    (entry: MaterialDropEntry, baselineFrac: number) => {
      const info = calculateMaterialZ(baselineFrac);
      entry.phase = "settled";
      setMaterialDropZ(entry, info);
    },
    [calculateMaterialZ, setMaterialDropZ],
  );

  const refreshMaterialDropZ = useCallback(() => {
    const heroImg = islandHeroImgRef.current;
    const heroWrap = heroImg
      ? (heroImg.parentElement as HTMLElement | null)
      : null;
    if (!heroWrap) return;
    const wrapBox = heroWrap.getBoundingClientRect();
    materialDropsRef.current = materialDropsRef.current.filter((drop) => {
      const { el, shadow } = drop;
      if (!el.isConnected || !shadow.isConnected) return false;
      const elBox = el.getBoundingClientRect();
      const baselineFrac = Math.max(
        0,
        Math.min(
          1,
          (elBox.top - wrapBox.top + elBox.height * 0.8) /
            Math.max(1, wrapBox.height),
        ),
      );
      if (drop.phase === "flight") {
        updateFlightZoneIfNeeded(drop, baselineFrac);
      } else {
        setMaterialDropZ(drop, calculateMaterialZ(baselineFrac));
      }
      return true;
    });
  }, [calculateMaterialZ, setMaterialDropZ, updateFlightZoneIfNeeded]);

  useEffect(() => {
    refreshMaterialDropZ();
  }, [refreshMaterialDropZ, rockReady, rockBottomY]);

  const spawnMaterialDrop = useCallback(
    async (
      name: MaterialName,
      delay: number,
      common?: {
        duration1: number;
        spread: number;
        lift: number;
        fall: number;
        start: number;
        angle?: number;
      },
    ): Promise<MaterialName> => {
      const url = await getMaterialImageUrl(name);
      if (!url) return name;
      const rockLayer = rockLayerRef.current;
      const heroImg = islandHeroImgRef.current;
      if (!rockLayer || !heroImg) return name;
      const heroWrap = heroImg.parentElement as HTMLElement | null;
      if (!heroWrap) return name;
      const rect = rockLayer.getBoundingClientRect();
      lastRockRectRef.current = rect;
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height * 0.5;
      const originOffsetX = (Math.random() - 0.5) * rect.width * 0.2;
      const originOffsetY =
        -rect.height * 0.12 + Math.random() * rect.height * 0.16;
      const wrapBox = heroWrap.getBoundingClientRect();
      const baseXPct =
        ((startX + originOffsetX - wrapBox.left) / Math.max(1, wrapBox.width)) *
        100;
      const baseYPct =
        ((startY + originOffsetY - wrapBox.top) / Math.max(1, wrapBox.height)) *
        100;
      const el = document.createElement("img");
      el.src = url;
      el.draggable = false;
      el.style.position = "absolute";
      el.style.left = `${baseXPct}%`;
      el.style.top = `${baseYPct}%`;
      el.style.width = "auto";
      el.style.height = "11.5%";
      el.style.pointerEvents = "none";
      el.style.willChange = "left, top, transform, opacity, z-index";
      el.style.backfaceVisibility = "hidden";
      el.style.transform = "translate(-50%, -50%) scale(0.95)";
      el.setAttribute("data-fx", "material-drop");
      heroWrap.appendChild(el);
      const shadowEl = document.createElement("div");
      shadowEl.style.position = "absolute";
      shadowEl.style.left = `${baseXPct}%`;
      shadowEl.style.top = `${baseYPct}%`;
      shadowEl.style.width = "0%";
      shadowEl.style.height = "2%";
      shadowEl.style.borderRadius = "50%";
      shadowEl.style.background = "rgba(0,0,0,0.28)";
      shadowEl.style.pointerEvents = "none";
      shadowEl.style.willChange =
        "left, top, width, height, filter, opacity, z-index";
      shadowEl.style.transform = "translate(-50%, -50%)";
      shadowEl.style.display = "none";
      shadowEl.setAttribute("data-fx", "material-drop-shadow");
      heroWrap.appendChild(shadowEl);
      const elBoxInit = el.getBoundingClientRect();
      const baselineInitFrac = Math.max(
        0,
        Math.min(
          1,
          (elBoxInit.top - wrapBox.top + elBoxInit.height * 0.8) /
            Math.max(1, wrapBox.height),
        ),
      );
      const initInfo = calculateMaterialZ(baselineInitFrac);
      const dropEntry: MaterialDropEntry = {
        id: materialDropCounterRef.current++,
        el,
        shadow: shadowEl,
        name,
        phase: "flight",
        baseline: initInfo.clamped,
        zone: initInfo.zone,
        lastZ: initInfo.zMain,
      };
      setMaterialDropZ(dropEntry, initInfo);
      materialDropsRef.current = materialDropsRef.current.concat([dropEntry]);
      const angle = common?.angle ?? (Math.random() - 0.5) * Math.PI * 0.5;
      const spreadLocal = common?.spread ?? 24 + Math.random() * 48;
      const liftLocal = common?.lift ?? 12 + Math.random() * 18;
      const fallLocal =
        common?.fall ?? 12 + Math.random() * 14 + rect.height * 0.15;
      const duration1 = common?.duration1 ?? 600 + Math.random() * 140;
      const start = (common?.start ?? performance.now()) + delay;
      function easeOutQuart(t: number) {
        return 1 - Math.pow(1 - t, 4);
      }
      return new Promise<MaterialName>((resolve) => {
        function step1(now: number) {
          if (!overlayActiveRef.current || !el.isConnected) {
            el.remove();
            try {
              shadowEl.remove();
            } catch {}
            materialDropsRef.current = materialDropsRef.current.filter(
              (drop) => drop.id !== dropEntry.id,
            );
            resolve(name);
            return;
          }
          if (now < start) {
            requestAnimationFrame(step1);
            return;
          }
          const t = Math.min(1, (now - start) / duration1);
          const e = easeOutQuart(t);
          const wrapEl = islandHeroImgRef.current
            ? (islandHeroImgRef.current.parentElement as HTMLElement | null)
            : null;
          if (!wrapEl) {
            el.remove();
            try {
              shadowEl.remove();
            } catch {}
            materialDropsRef.current = materialDropsRef.current.filter(
              (drop) => drop.id !== dropEntry.id,
            );
            resolve(name);
            return;
          }
          const currentWrapBox = wrapEl.getBoundingClientRect();
          const dxPct =
            Math.sin(angle) *
            (spreadLocal / Math.max(1, currentWrapBox.width)) *
            100 *
            e;
          const u = 1 - (2 * t - 1) * (2 * t - 1);
          const liftPct =
            (liftLocal / Math.max(1, currentWrapBox.height)) * 100;
          const fallPct =
            (fallLocal / Math.max(1, currentWrapBox.height)) * 100;
          const dyPct = -liftPct * u + fallPct * t * t;
          const s = 0.95 + 0.05 * e;
          const cx = baseXPct + dxPct;
          const cy = baseYPct + dyPct;
          el.style.left = `${cx}%`;
          el.style.top = `${cy}%`;
          if (t < 1) {
            const elBox = el.getBoundingClientRect();
            const widthPctItem =
              (elBox.width / Math.max(1, currentWrapBox.width)) * 100;
            const widthScale = 0.62 + 0.08 * e;
            const clampedWidthPct = Math.max(
              0,
              Math.min(100, widthPctItem * widthScale),
            );
            const baselinePct =
              ((elBox.top - currentWrapBox.top + elBox.height * 0.8) /
                Math.max(1, currentWrapBox.height)) *
              100;
            const maxBlurPx = Math.max(0.5, currentWrapBox.height * 0.014);
            const minBlurPx = Math.max(0.2, currentWrapBox.height * 0.004);
            const blurPx = minBlurPx + (maxBlurPx - minBlurPx) * (1 - e);
            const shadowOpacity = 0.12 + 0.16 * e;
            const shadowHeightPct = Math.max(1.0, 3.6 - 0.8 * e);
            shadowEl.style.display = "block";
            shadowEl.style.top = `${Math.max(0, Math.min(100, baselinePct + 0.04))}%`;
            shadowEl.style.left = `${cx}%`;
            shadowEl.style.width = `${clampedWidthPct}%`;
            shadowEl.style.height = `${shadowHeightPct}%`;
            shadowEl.style.filter = `blur(${blurPx}px)`;
            shadowEl.style.background = `rgba(0,0,0,${shadowOpacity.toFixed(3)})`;
            const baselineFracNow = Math.max(0, Math.min(1, baselinePct / 100));
            updateFlightZoneIfNeeded(dropEntry, baselineFracNow);
          } else {
            const elBox = el.getBoundingClientRect();
            const widthPctItem =
              (elBox.width / Math.max(1, currentWrapBox.width)) * 100;
            const finalWidthScale = 0.62 + 0.08 * 1;
            const finalWidthPct = Math.max(
              0,
              Math.min(100, widthPctItem * finalWidthScale),
            );
            const baselinePct =
              ((elBox.top - currentWrapBox.top + elBox.height * 0.8) /
                Math.max(1, currentWrapBox.height)) *
              100;
            const minBlurPx = Math.max(0.2, currentWrapBox.height * 0.004);
            const finalBlurPx = minBlurPx;
            const finalOpacity = 0.12 + 0.16 * 1;
            const finalHeightPct = Math.max(1.0, 3.6 - 0.8 * 1);
            shadowEl.style.display = "block";
            shadowEl.style.top = `${Math.max(0, Math.min(100, baselinePct + 0.04))}%`;
            shadowEl.style.left = `${cx}%`;
            shadowEl.style.width = `${finalWidthPct}%`;
            shadowEl.style.height = `${finalHeightPct}%`;
            shadowEl.style.filter = `blur(${finalBlurPx}px)`;
            shadowEl.style.background = `rgba(0,0,0,${finalOpacity.toFixed(3)})`;
            const baselineFracNow = Math.max(0, Math.min(1, baselinePct / 100));
            updateFlightZoneIfNeeded(dropEntry, baselineFracNow);
          }
          el.style.transform = `translate(-50%, -50%) scale(${s})`;
          if (t < 1) {
            requestAnimationFrame(step1);
          } else {
            const elBoxFinal = el.getBoundingClientRect();
            const baselineFinalFrac = Math.max(
              0,
              Math.min(
                1,
                (elBoxFinal.top -
                  currentWrapBox.top +
                  elBoxFinal.height * 0.8) /
                  Math.max(1, currentWrapBox.height),
              ),
            );
            settleMaterialDrop(dropEntry, baselineFinalFrac);
            resolve(name);
          }
        }
        requestAnimationFrame(step1);
      });
    },
    [
      calculateMaterialZ,
      setMaterialDropZ,
      settleMaterialDrop,
      updateFlightZoneIfNeeded,
    ],
  );

  const handleIslandClose = useCallback(
    (event?: React.MouseEvent | React.TouchEvent) => {
      if (event) {
        const targetNode = (event.target as Node) || null;
        if (targetNode) {
          const safeHitbox = safeHitboxRef.current;
          if (safeHitbox && safeHitbox.contains(targetNode)) {
            return;
          }
        }
      }
      if (
        Date.now() - overlayJustOpenedAtRef.current <
        MIN_OVERLAY_CLOSE_DELAY_MS
      ) {
        return;
      }
      if (overlayPhaseRef.current === "opening" && !islandOverlayVisible) {
        return;
      }
      const phase = overlayPhaseRef.current;
      if (phase !== "open" && phase !== "opening") {
        return;
      }
      const wasVisible = islandOverlayVisible;
      overlayPhaseRef.current = wasVisible ? "closing" : "idle";
      didDismissSomethingWithOutsideTapJustNow();
      playSounds([Sound.IslandClose]);
      setIslandOpening(false);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      moveAnimRef.current = null;
      const walkCleanup = walkingDragCleanupRef.current;
      if (walkCleanup) walkCleanup();
      walkingDragCleanupRef.current = null;
      walkingDragActiveRef.current = false;
      clearAnonSignInDrop();
      try {
        const heroImg = islandHeroImgRef.current;
        const heroWrap = heroImg
          ? (heroImg.parentElement as HTMLElement | null)
          : null;
        if (heroWrap) {
          const nodes = heroWrap.querySelectorAll(
            '[data-fx="material-drop"], [data-fx="material-drop-shadow"]',
          );
          nodes.forEach((n) => {
            try {
              n.parentElement?.removeChild(n);
            } catch {}
          });
          materialDropsRef.current = [];
        }
      } catch {}
      if (!wasVisible) {
        finalizeOverlayClose();
        return;
      }
      try {
        const container = fxContainerRef.current;
        if (container && container.parentNode) {
          container.parentNode.removeChild(container);
        }
      } catch {}
      fxContainerRef.current = null;
      const anim = sheetAnimRef.current;
      if (anim && anim.raf) cancelAnimationFrame(anim.raf);
      sheetAnimRef.current = null;
      setMiningPlaying(false);
      currentAnimKindRef.current = "none";
      setWalkingPlaying(false);
      setPettingPlaying(false);
      setStandingPlaying(false);
      materialDropsRef.current = [];
      const imgEl = islandButtonImgRef.current;
      if (!imgEl || !islandNatural) {
        finalizeOverlayClose();
        return;
      }
      const rect = imgEl.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const ratio = islandNatural.w / islandNatural.h;
      const restH = Math.min(vh * 0.5, (vw * 0.92) / ratio);
      const cx = vw / 2;
      const cy = vh / 2;
      const bx = rect.left + rect.width / 2;
      const by = rect.top + rect.height / 2;
      const deltaX = bx - cx;
      const deltaY = by - cy;
      const displayedH = rect.height;
      const uniformScale = displayedH / restH;
      setIslandActive(false);
      setIslandAnimating(true);
      setIslandClosing(true);
      setIslandOverlayVisible(false);
      if (heroTransformFrameRef.current !== null) {
        cancelAnimationFrame(heroTransformFrameRef.current);
        heroTransformFrameRef.current = null;
      }
      heroTransformFrameRef.current = requestAnimationFrame(() => {
        heroTransformFrameRef.current = null;
        setIslandTranslate({ x: deltaX, y: deltaY });
        setIslandScale({ x: uniformScale, y: uniformScale });
      });
    },
    [
      clearAnonSignInDrop,
      finalizeOverlayClose,
      islandNatural,
      islandOverlayVisible,
    ],
  );

  const handleAnonSignInDropPress = useCallback(
    (
      event:
        | React.MouseEvent<HTMLButtonElement>
        | React.TouchEvent<HTMLButtonElement>,
    ) => {
      if (!anonSignInDropState?.settled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      anonSignInDropPointerHandledRef.current = true;
      clearAnonSignInDrop();
      handleIslandClose();
      requestAnimationFrame(() => {
        openProfileSignInPopup();
      });
    },
    [anonSignInDropState?.settled, clearAnonSignInDrop, handleIslandClose],
  );

  const handleAnonSignInDropClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!anonSignInDropState?.settled) {
        return;
      }
      if (anonSignInDropPointerHandledRef.current) {
        anonSignInDropPointerHandledRef.current = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearAnonSignInDrop();
      handleIslandClose();
      requestAnimationFrame(() => {
        openProfileSignInPopup();
      });
    },
    [anonSignInDropState?.settled, clearAnonSignInDrop, handleIslandClose],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        handleIslandClose();
      }
    };
    if (islandOverlayVisible || islandOpening || islandClosing) {
      document.addEventListener("keydown", handleKeyDown, true);
      return () => {
        document.removeEventListener("keydown", handleKeyDown, true);
      };
    }
  }, [islandOverlayVisible, islandOpening, islandClosing, handleIslandClose]);

  const handleIslandTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.propertyName !== "transform") return;
      if (islandActive) {
        setIslandAnimating(false);
        setIslandOpening(false);
        overlayPhaseRef.current = "open";
        try {
          requestAnimationFrame(() => {
            measureHeroSize();
            requestAnimationFrame(() => {
              initializeWalkPolygonIfNeeded();
              setWalkReady(true);
            });
          });
        } catch {}
        return;
      }
      setIslandAnimating(false);
    },
    [islandActive, initializeWalkPolygonIfNeeded, measureHeroSize],
  );

  const handleOverlayTransitionEnd = useCallback(
    (e: React.TransitionEvent<HTMLDivElement>) => {
      if (e.propertyName !== "opacity") return;
      if (!islandOverlayVisible) {
        finalizeOverlayClose();
      }
      try {
        updateRockBox();
      } catch {}
    },
    [finalizeOverlayClose, islandOverlayVisible, updateRockBox],
  );

  const getSafeAreaEllipse = useCallback((): {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
  } | null => {
    const box = rockBoxRef.current;
    if (!box) return null;
    return createSafeAreaEllipse(box);
  }, []);
  const isInsideSafeArea = useCallback(
    (x: number, y: number) => {
      const ellipse = getSafeAreaEllipse();
      return isInsideEllipse(x, y, ellipse);
    },
    [getSafeAreaEllipse],
  );

  const getMonBounds = useCallback(() => {
    const pos = latestMonPosRef.current || monPos;
    const key = latestMonKeyRef.current ?? monKey;
    if (!pos) return null;
    const widthFrac = Math.max(0.001, Math.min(1, getMonBoundsWidthFrac(key)));
    const heightFrac = Math.max(0.001, Math.min(1, MON_HEIGHT_FRAC));
    const cx = (pos.x ?? MON_REL_X) + MON_BOUNDS_X_SHIFT;
    const bottomY = (pos.y ?? MON_REL_Y) + MON_BASELINE_Y_OFFSET;
    const left = cx - widthFrac * 0.5;
    const right = cx + widthFrac * 0.5;
    const top = bottomY - heightFrac;
    const bottom = bottomY;
    return {
      left,
      top,
      right,
      bottom,
      area: Math.max(0, right - left) * Math.max(0, bottom - top),
    };
  }, [monKey, monPos]);

  const getMonBoundsWithExpansion = useCallback(() => {
    const pos = latestMonPosRef.current || monPos;
    const key = latestMonKeyRef.current ?? monKey;
    if (!pos) return null;
    const widthFrac = Math.max(0.001, Math.min(1, getMonBoundsWidthFrac(key)));
    const heightFrac = Math.max(0.001, Math.min(1, MON_HEIGHT_FRAC));
    const cx = (pos.x ?? MON_REL_X) + MON_BOUNDS_X_SHIFT;
    const bottomY = (pos.y ?? MON_REL_Y) + MON_BASELINE_Y_OFFSET;
    const topY = bottomY - heightFrac;
    const base = {
      left: cx - widthFrac * 0.5,
      top: topY,
      right: cx + widthFrac * 0.5,
      bottom: bottomY,
      widthFrac,
      heightFrac,
    };
    const expandedWidthFrac = Math.max(
      0.001,
      Math.min(1, widthFrac + DUDE_BOUNDS_WIDTH_FRAC * 1.35),
    );
    const expandedHeightFrac = Math.max(0.001, Math.min(1, heightFrac * 1.4));
    const expandedVerticalShift = heightFrac * 0.35;
    const expanded = {
      left: cx - expandedWidthFrac * 0.5,
      top: topY + expandedVerticalShift,
      right: cx + expandedWidthFrac * 0.5,
      bottom: topY + expandedHeightFrac,
      widthFrac: expandedWidthFrac,
      heightFrac: expandedHeightFrac - expandedVerticalShift,
    };
    return { base, expanded, cx, bottomY, topY };
  }, [monKey, monPos]);

  const teleportFXStart = useCallback(() => {
    const frame = monFrameWrapRef.current;
    const strip = monStripImgRef.current;
    if (!frame || !strip) return;
    const baseX = monFacingLeftRef.current ? -1 : 1;
    try {
      frame.style.transformOrigin = "50% 100%";
      frame.style.transition = "transform 160ms ease-in";
      frame.style.transform = `scale(${baseX * 0.06}, 1.08)`;
    } catch {}
  }, []);

  const prepareTeleportAppear = useCallback(() => {
    const frame = monFrameWrapRef.current;
    const strip = monStripImgRef.current;
    if (!frame || !strip) return;
    const baseX = monFacingLeftRef.current ? -1 : 1;
    try {
      frame.style.transformOrigin = "50% 100%";
      frame.style.transition = "none";
      frame.style.transform = `scale(${baseX * 0.06}, 1.08)`;
    } catch {}
  }, []);

  const animateTeleportAppear = useCallback(() => {
    const frame = monFrameWrapRef.current;
    const strip = monStripImgRef.current;
    if (!frame || !strip) return;
    const baseX = monFacingLeftRef.current ? -1 : 1;
    try {
      requestAnimationFrame(() => {
        frame.style.transition =
          "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)";
        frame.style.transform = `scale(${baseX}, 1)`;
        setTimeout(() => {
          try {
            frame.style.removeProperty("transition");
            frame.style.removeProperty("transform-origin");
            frame.style.removeProperty("transform");
          } catch {}
        }, 260);
      });
    } catch {}
  }, []);

  const spawnTeleportSparkles = useCallback(() => {
    const frame = monFrameWrapRef.current;
    const heroImg = islandHeroImgRef.current;
    if (!frame || !heroImg || !overlayActiveRef.current) return;
    const heroWrap = heroImg.parentElement as HTMLElement | null;
    if (!heroWrap) return;
    const frameBox = frame.getBoundingClientRect();
    const wrapBox = heroWrap.getBoundingClientRect();
    const cxPct =
      ((frameBox.left - wrapBox.left + frameBox.width / 2) /
        Math.max(1, wrapBox.width)) *
      100;
    const cyPct =
      ((frameBox.top - wrapBox.top + frameBox.height / 2) /
        Math.max(1, wrapBox.height)) *
      100;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    const monBaselineY =
      (monPos ? monPos.y : MON_REL_Y) + MON_BASELINE_Y_OFFSET;
    svg.style.zIndex = `${computeEntityZIndex(monBaselineY)}`;
    heroWrap.appendChild(svg);
    const num = 13;
    let remaining = num;
    const runParticle = (
      group: SVGGElement,
      c1: SVGCircleElement,
      c2: SVGCircleElement,
      start: number,
      duration: number,
      dx: number,
      dy: number,
    ) => {
      function step(now: number) {
        if (now < start) {
          requestAnimationFrame(step);
          return;
        }
        const t = Math.min(1, (now - start) / duration);
        const e = 1 - Math.pow(1 - t, 3);
        const x = cxPct + dx * e;
        const y = cyPct + dy * e;
        group.setAttribute(
          "transform",
          `translate(${x} ${y}) scale(${0.8 + 0.3 * e})`,
        );
        const fade = 1 - Math.pow(t, 1.6);
        c1.setAttribute("opacity", (0.9 * fade).toString());
        c2.setAttribute("opacity", (0.85 * fade).toString());
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          try {
            if (group.parentNode) group.parentNode.removeChild(group);
          } catch {}
          remaining--;
          if (remaining <= 0) {
            try {
              if (svg.parentNode) svg.parentNode.removeChild(svg);
            } catch {}
          }
        }
      }
      requestAnimationFrame(step);
    };
    for (let i = 0; i < num; i++) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const c1 = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      const c2 = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      const r = 0.6 + Math.random() * 0.9;
      c1.setAttribute("r", r.toString());
      c1.setAttribute("fill", "#c6dcff");
      c1.setAttribute("opacity", "0");
      c2.setAttribute("r", (r * 0.55).toString());
      c2.setAttribute("fill", "#b8d4ff");
      c2.setAttribute("opacity", "0");
      g.appendChild(c1);
      g.appendChild(c2);
      g.setAttribute("transform", `translate(${cxPct} ${cyPct}) scale(0.8)`);
      svg.appendChild(g);
      const angle = Math.random() * Math.PI * 2;
      const dist = 6 + Math.random() * 10;
      const swirl = (Math.random() - 0.5) * 0.5;
      const dx = Math.cos(angle + swirl) * dist;
      const dy = Math.sin(angle + swirl) * dist;
      const start = performance.now() + Math.random() * 30;
      const duration = 360 + Math.random() * 140;
      runParticle(
        g as SVGGElement,
        c1 as SVGCircleElement,
        c2 as SVGCircleElement,
        start,
        duration,
        dx,
        dy,
      );
    }
  }, [monPos, computeEntityZIndex]);

  const teleportMonToRandomNonOverlappingSpot = useCallback(() => {
    if (!monPos) return;
    teleportFXStart();
    directlyPlaySoundNamed("happy", 0.1);
    setMonTeleporting(true);
    setTimeout(() => {
      const chosen = findValidMonLocation({ mode: "teleport" });
      if (chosen) {
        setMonFacingLeft(Math.random() < 0.5);
        setMonPos(chosen);
        latestMonPosRef.current = chosen;
        persistentMonPosRef = chosen;
      }
      setTimeout(() => {
        prepareTeleportAppear();
        setMonTeleporting(false);
        spawnTeleportSparkles();
        animateTeleportAppear();
      }, 30);
    }, 180);
  }, [
    findValidMonLocation,
    monPos,
    setMonFacingLeft,
    teleportFXStart,
    spawnTeleportSparkles,
    prepareTeleportAppear,
    animateTeleportAppear,
  ]);

  const onThreeCirclesComplete = useCallback(
    (direction: "cw" | "ccw") => {
      if (!monPos) return;
      const typeOrder: MonType[] = [
        MonType.DEMON,
        MonType.ANGEL,
        MonType.DRAINER,
        MonType.SPIRIT,
        MonType.MYSTIC,
      ];
      const storedType = storage.getIslandMonType(MonType.DRAINER) as MonType;
      const currentType = typeOrder.includes(storedType)
        ? storedType
        : MonType.DRAINER;
      const currentIndex = typeOrder.indexOf(currentType);
      const nextIndex =
        direction === "ccw"
          ? (currentIndex + 1) % typeOrder.length
          : (currentIndex - 1 + typeOrder.length) % typeOrder.length;
      const nextType = typeOrder[nextIndex];
      storage.setIslandMonType(nextType);

      teleportFXStart();
      directlyPlaySoundNamed("bewo", 0.075);
      setMonTeleporting(true);
      setTimeout(() => {
        updateMonSprite(nextType);
        const chosen = findValidMonLocation({ mode: "teleport" });
        if (chosen) {
          setMonFacingLeft(Math.random() < 0.5);
          setMonPos(chosen);
          latestMonPosRef.current = chosen;
          persistentMonPosRef = chosen;
        }
        setTimeout(() => {
          prepareTeleportAppear();
          setMonTeleporting(false);
          spawnTeleportSparkles();
          animateTeleportAppear();
        }, 30);
      }, 180);
    },
    [
      monPos,
      teleportFXStart,
      updateMonSprite,
      setMonFacingLeft,
      findValidMonLocation,
      prepareTeleportAppear,
      spawnTeleportSparkles,
      animateTeleportAppear,
    ],
  );

  const updateCircleTracking = useCallback(
    (dudeX: number, dudeY: number) => {
      const monPosition = latestMonPosRef.current || monPos;
      if (!monPosition) return;

      const monBaselineCenterX =
        (monPosition.x ?? MON_REL_X) + MON_BOUNDS_X_SHIFT;
      const monBaselineCenterY =
        (monPosition.y ?? MON_REL_Y) + MON_BASELINE_Y_OFFSET;
      const dx = dudeX - monBaselineCenterX;
      const dy = dudeY - monBaselineCenterY;
      const currentAngle = Math.atan2(dy, dx);
      const tracking = circleTrackingRef.current;

      if (tracking.lastAngle === null) {
        tracking.lastAngle = currentAngle;
        tracking.center = { x: monBaselineCenterX, y: monBaselineCenterY };
        return;
      }

      let angleDiff = currentAngle - tracking.lastAngle;
      if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

      if (Math.abs(angleDiff) < 0.005) return;

      const currentDirection: "cw" | "ccw" = angleDiff > 0 ? "ccw" : "cw";

      if (tracking.direction === null) {
        tracking.direction = currentDirection;
        tracking.totalRotation += Math.abs(angleDiff);
      } else if (tracking.direction !== currentDirection) {
        const reversalAmount = Math.abs(angleDiff);
        if (reversalAmount < 0.3 && tracking.totalRotation > reversalAmount) {
          tracking.totalRotation -= reversalAmount;
        } else {
          tracking.totalRotation = 0;
          tracking.direction = currentDirection;
          tracking.lastAngle = currentAngle;
          tracking.center = { x: monBaselineCenterX, y: monBaselineCenterY };
          return;
        }
      } else {
        tracking.totalRotation += Math.abs(angleDiff);
      }

      tracking.lastAngle = currentAngle;

      const REQUIRED_CIRCLES = 3 * 2 * Math.PI;
      if (tracking.totalRotation >= REQUIRED_CIRCLES) {
        onThreeCirclesComplete(tracking.direction);
        tracking.totalRotation = 0;
        tracking.center = { x: monBaselineCenterX, y: monBaselineCenterY };
      }
    },
    [monPos, onThreeCirclesComplete],
  );

  const resetCircleTracking = useCallback(() => {
    circleTrackingRef.current = {
      lastAngle: null,
      totalRotation: 0,
      direction: null,
      center: null,
    };
  }, []);

  const clearTeleportCheckTimeout = useCallback(() => {
    if (teleportCheckTimeoutRef.current !== null) {
      window.clearTimeout(teleportCheckTimeoutRef.current);
      teleportCheckTimeoutRef.current = null;
    }
  }, []);

  const checkAndTeleportMonIfOverlapped = useCallback(() => {
    const monB = getMonBounds();
    if (!monB) return;
    const dudeB = getDudeBounds();
    const overlap = computeOverlapArea(dudeB, monB);
    const overlapFracOfMon = monB.area > 0 ? overlap / monB.area : 0;
    if (overlapFracOfMon > 0.55) {
      clearTeleportCheckTimeout();
      teleportMonToRandomNonOverlappingSpot();
    }
  }, [
    getMonBounds,
    getDudeBounds,
    teleportMonToRandomNonOverlappingSpot,
    clearTeleportCheckTimeout,
  ]);

  const scheduleTeleportOverlapCheck = useCallback(() => {
    if (teleportCheckTimeoutRef.current !== null) return;
    teleportCheckTimeoutRef.current = window.setTimeout(() => {
      teleportCheckTimeoutRef.current = null;
      checkAndTeleportMonIfOverlapped();
    }, 300);
  }, [checkAndTeleportMonIfOverlapped]);

  const stopMoveAnim = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    moveAnimRef.current = null;
    scheduleTeleportOverlapCheck();
    const wAnim =
      currentAnimKindRef.current === "walking" ? sheetAnimRef.current : null;
    if (wAnim) {
      if (wAnim.raf) cancelAnimationFrame(wAnim.raf);
      sheetAnimRef.current = null;
      currentAnimKindRef.current = "none";
    }
    setWalkingPlaying(false);
  }, [scheduleTeleportOverlapCheck]);

  const latestDudePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const moveTargetMetaRef = useRef<{
    x: number;
    y: number;
    facingLeft: boolean;
    onArrive?: () => void;
  } | null>(null);
  const dragModeRef = useRef<"none" | "free" | "edge">("none");
  const lastFacingFlipAtRef = useRef<number>(0);
  const lastFacingDirRef = useRef<boolean>(false);
  const lastEllipsePointerRef = useRef<{ x: number; y: number }>({
    x: -1,
    y: -1,
  });
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });
  const teleportCheckTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    latestDudePosRef.current = dudePos;
  }, [dudePos]);

  useEffect(() => {
    return () => {
      clearTeleportCheckTimeout();
    };
  }, [clearTeleportCheckTimeout]);
  const getReferencePos = useCallback(() => {
    const ref = latestDudePosRef.current;
    if (
      ref &&
      Number.isFinite(ref.x) &&
      Number.isFinite(ref.y) &&
      !(ref.x === 0 && ref.y === 0)
    )
      return ref;
    return dudePos;
  }, [dudePos]);
  const decideFacingWithHysteresis = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x;
      if (Math.abs(dx) < FACING_DX_EPS) {
        return lastFacingDirRef.current;
      }
      const desiredLeft = dx < 0;
      if (desiredLeft !== lastFacingDirRef.current) {
        const now = performance.now();
        if (now - lastFacingFlipAtRef.current >= FACING_FLIP_HYST_MS) {
          lastFacingFlipAtRef.current = now;
          lastFacingDirRef.current = desiredLeft;
        }
      }
      return lastFacingDirRef.current;
    },
    [],
  );

  const startMiningAnimation = useCallback(
    () => playSheetAnimation("mining"),
    [playSheetAnimation],
  );

  const startWalkingAnimation = useCallback(() => {
    const onStep = () => {
      if (materialDropsRef.current.length > 0) {
        try {
          const dudeB = getDudeBounds();
          const hero = islandHeroImgRef.current;
          const wrapBox = hero ? hero.getBoundingClientRect() : null;
          if (wrapBox) {
            const wrapWidth = Math.max(1, wrapBox.width);
            const wrapHeight = Math.max(1, wrapBox.height);
            const collected: Array<number> = [];
            const collectedPulls: Array<{
              name: MaterialName;
              rect: MaterialPullRect;
            }> = [];
            for (let i = 0; i < materialDropsRef.current.length; i++) {
              const m = materialDropsRef.current[i];
              if (!m.el.isConnected) {
                collected.push(i);
                continue;
              }
              const eb = m.el.getBoundingClientRect();
              const left = (eb.left - wrapBox.left) / wrapWidth;
              const right = (eb.right - wrapBox.left) / wrapWidth;
              const top = (eb.top - wrapBox.top) / wrapHeight;
              const bottom = (eb.bottom - wrapBox.top) / wrapHeight;
              const area =
                Math.max(0, right - left) * Math.max(0, bottom - top);
              const overlap = computeOverlapArea(dudeB, {
                left,
                top,
                right,
                bottom,
              });
              const frac = area > 0 ? overlap / area : 0;
              if (frac > 0.55) {
                collected.push(i);
                const absLeft = eb.left;
                const absTop = eb.top;
                const width = eb.width;
                const height = eb.height;
                collectedPulls.push({
                  name: m.name,
                  rect: { left: absLeft, top: absTop, width, height },
                });
              }
            }
            if (collected.length > 0) {
              for (let i = 0; i < collected.length; i++) {
                const idx = collected[i];
                const drop = materialDropsRef.current[idx];
                if (!drop) continue;
                try {
                  drop.el.remove();
                } catch {}
                try {
                  drop.shadow.remove();
                } catch {}
              }
              const delta: Partial<Record<MaterialName, number>> = {};
              const nextArr: typeof materialDropsRef.current = [];
              const collectedSet = new Set<number>(collected);
              for (let i = 0; i < materialDropsRef.current.length; i++) {
                if (collectedSet.has(i)) {
                  const name = materialDropsRef.current[i].name;
                  delta[name] = (delta[name] || 0)! + 1;
                } else {
                  nextArr.push(materialDropsRef.current[i]);
                }
              }
              materialDropsRef.current = nextArr;
              for (let i = 0; i < collectedPulls.length; i++) {
                const item = collectedPulls[i];
                queueMaterialPull(item.name, item.rect);
              }
              playSounds([Sound.CollectingMaterials]);
            }
          }
        } catch {}
      }
    };
    playSheetAnimation("walking", { onStep });
  }, [playSheetAnimation, getDudeBounds, queueMaterialPull]);

  const startPettingAnimation = useCallback(
    () => playSheetAnimation("petting"),
    [playSheetAnimation],
  );

  useEffect(() => {
    startPettingAnimationRef.current = startPettingAnimation;
  }, [startPettingAnimation]);

  const startMoveTo = useCallback(
    (tx: number, ty: number) => {
      syncDudePosFromOriginal();
      const now = performance.now();
      let currentX = latestDudePosRef.current.x;
      let currentY = latestDudePosRef.current.y;
      const anim = moveAnimRef.current;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / anim.duration);
        const ease = 1 - Math.pow(1 - t, 3);
        currentX = anim.from.x + (anim.to.x - anim.from.x) * ease;
        currentY = anim.from.y + (anim.to.y - anim.from.y) * ease;
      }
      const from = { x: currentX, y: currentY };
      const to = { x: tx, y: ty };
      setDudeFacingLeft(decideFacingWithHysteresis(from, to));
      const w = heroSize.w;
      const h = heroSize.h;
      const dx = (to.x - from.x) * w;
      const dy = (to.y - from.y) * h;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = Math.max(60, Math.min(220, h * 0.45));
      const duration = (dist / speed) * 1000;
      moveAnimRef.current = {
        start: now,
        from,
        to,
        duration: Math.max(200, duration),
      };
      if (currentAnimKindRef.current !== "walking") startWalkingAnimation();
      if (!rafRef.current) {
        const step = () => {
          if (!moveAnimRef.current) return;
          const n = performance.now();
          const t2 = Math.min(
            1,
            (n - moveAnimRef.current.start) / moveAnimRef.current.duration,
          );
          const e2 = 1 - Math.pow(1 - t2, 3);
          const nx =
            moveAnimRef.current.from.x +
            (moveAnimRef.current.to.x - moveAnimRef.current.from.x) * e2;
          const ny =
            moveAnimRef.current.from.y +
            (moveAnimRef.current.to.y - moveAnimRef.current.from.y) * e2;
          let nextX = nx;
          let nextY = ny;
          setDudePos({ x: nextX, y: nextY });
          if (t2 < 1) {
            rafRef.current = requestAnimationFrame(step);
          } else {
            let triggeredArrival = false;
            const targetMeta = moveTargetMetaRef.current;
            if (targetMeta) {
              const closeEnough =
                Math.hypot(nextX - targetMeta.x, nextY - targetMeta.y) < 0.012;
              if (closeEnough) {
                setDudeFacingLeft(targetMeta.facingLeft);
                try {
                  if (targetMeta.onArrive) {
                    triggeredArrival = true;
                    targetMeta.onArrive();
                  }
                } catch {}
                moveTargetMetaRef.current = null;
              }
            } else {
              const initial = initialDudePosRef.current;
              if (initial) {
                const closeEnough =
                  Math.hypot(nextX - initial.x, nextY - initial.y) < 0.012;
                if (closeEnough) setDudeFacingLeft(INITIAL_DUDE_FACING_LEFT);
              }
            }
            latestDudePosRef.current = { x: nextX, y: nextY };
            stopMoveAnim();
            if (!triggeredArrival) startStandingAnimation();
          }
        };
        rafRef.current = requestAnimationFrame(step);
      }
    },
    [
      heroSize.w,
      heroSize.h,
      stopMoveAnim,
      syncDudePosFromOriginal,
      decideFacingWithHysteresis,
      startWalkingAnimation,
      startStandingAnimation,
    ],
  );

  const updateMoveTarget = useCallback(
    (tx: number, ty: number) => {
      const now = performance.now();
      const anim = moveAnimRef.current;
      let currentX = latestDudePosRef.current.x;
      let currentY = latestDudePosRef.current.y;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / anim.duration);
        const ease = 1 - Math.pow(1 - t, 3);
        currentX = anim.from.x + (anim.to.x - anim.from.x) * ease;
        currentY = anim.from.y + (anim.to.y - anim.from.y) * ease;
      }
      const from = { x: currentX, y: currentY };
      const to = { x: tx, y: ty };
      setDudeFacingLeft(decideFacingWithHysteresis(from, to));
      const w = heroSize.w;
      const h = heroSize.h;
      const dx = (to.x - from.x) * w;
      const dy = (to.y - from.y) * h;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = Math.max(60, Math.min(220, h * 0.45));
      const duration = (dist / speed) * 1000;
      moveAnimRef.current = {
        start: now,
        from,
        to,
        duration: Math.max(200, duration),
      };
      if (currentAnimKindRef.current !== "walking") startWalkingAnimation();
      if (!rafRef.current) {
        const step = () => {
          if (!moveAnimRef.current) return;
          const n = performance.now();
          const tt = Math.min(
            1,
            (n - moveAnimRef.current.start) / moveAnimRef.current.duration,
          );
          const e = 1 - Math.pow(1 - tt, 3);
          const nx =
            moveAnimRef.current.from.x +
            (moveAnimRef.current.to.x - moveAnimRef.current.from.x) * e;
          const ny =
            moveAnimRef.current.from.y +
            (moveAnimRef.current.to.y - moveAnimRef.current.from.y) * e;
          let nextX = nx;
          let nextY = ny;
          setDudePos({ x: nextX, y: nextY });
          if (tt < 1) {
            rafRef.current = requestAnimationFrame(step);
          } else {
            latestDudePosRef.current = { x: nextX, y: nextY };
            stopMoveAnim();
            startStandingAnimation();
          }
        };
        rafRef.current = requestAnimationFrame(step);
      }
    },
    [
      heroSize.h,
      heroSize.w,
      stopMoveAnim,
      decideFacingWithHysteresis,
      startWalkingAnimation,
      startStandingAnimation,
    ],
  );

  useEffect(() => {
    const clearPressedWalkKeys = () => {
      const keys = pressedWalkKeysRef.current;
      keys.up = false;
      keys.down = false;
      keys.left = false;
      keys.right = false;
    };

    const hasPressedWalkKeys = () => {
      const keys = pressedWalkKeysRef.current;
      return keys.up || keys.down || keys.left || keys.right;
    };

    const stopKeyboardWalking = () => {
      keyboardWalkLastTsRef.current = null;
      if (keyboardWalkRafRef.current !== null) {
        cancelAnimationFrame(keyboardWalkRafRef.current);
        keyboardWalkRafRef.current = null;
      }
      if (keyboardWalkingRef.current) {
        keyboardWalkingRef.current = false;
        moveTargetMetaRef.current = null;
        stopMoveAnim();
        if (islandOverlayVisible && !islandClosing) {
          startStandingAnimation();
        }
      }
    };

    const mapWalkKey = (
      key: string,
    ): "up" | "down" | "left" | "right" | null => {
      switch (key.toLowerCase()) {
        case "w":
        case "arrowup":
          return "up";
        case "a":
        case "arrowleft":
          return "left";
        case "s":
        case "arrowdown":
          return "down";
        case "d":
        case "arrowright":
          return "right";
        default:
          return null;
      }
    };

    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      if (element.isContentEditable) return true;
      const tag = element.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const step = (ts: number) => {
      keyboardWalkRafRef.current = null;
      if (
        !islandOverlayVisible ||
        islandClosing ||
        islandOpening ||
        !hasPressedWalkKeys()
      ) {
        stopKeyboardWalking();
        return;
      }

      const hasTargetedMoveInFlight =
        !!moveTargetMetaRef.current &&
        !!moveAnimRef.current &&
        rafRef.current !== null;
      if (hasTargetedMoveInFlight) {
        if (keyboardWalkingRef.current) {
          keyboardWalkingRef.current = false;
        }
        clearPressedWalkKeys();
        stopKeyboardWalking();
        return;
      }
      if (moveTargetMetaRef.current && !moveAnimRef.current) {
        moveTargetMetaRef.current = null;
      }

      if (walkingDragActiveRef.current) {
        if (keyboardWalkingRef.current) {
          keyboardWalkingRef.current = false;
        }
        clearPressedWalkKeys();
        stopKeyboardWalking();
        return;
      }

      const keys = pressedWalkKeysRef.current;
      let axisX = 0;
      let axisY = 0;
      if (keys.left) axisX -= 1;
      if (keys.right) axisX += 1;
      if (keys.up) axisY -= 1;
      if (keys.down) axisY += 1;
      const axisLength = Math.hypot(axisX, axisY);
      if (axisLength < 1e-6) {
        stopKeyboardWalking();
        return;
      }

      const lastTs = keyboardWalkLastTsRef.current;
      keyboardWalkLastTsRef.current = ts;
      const elapsedMs = lastTs === null ? 16 : ts - lastTs;
      const clampedElapsedMs = Math.max(
        0,
        Math.min(KEYBOARD_WALK_MAX_FRAME_DELTA_MS, elapsedMs),
      );
      const dtSec = clampedElapsedMs > 0 ? clampedElapsedMs / 1000 : 1 / 60;
      const h = Math.max(1, heroSize.h);
      const w = Math.max(1, heroSize.w);
      const walkSpeedPxPerSec = Math.max(60, Math.min(220, h * 0.45));
      const unitX = axisX / axisLength;
      const unitY = axisY / axisLength;

      const refPos = latestDudePosRef.current;
      const hasValidRefPos =
        refPos &&
        Number.isFinite(refPos.x) &&
        Number.isFinite(refPos.y) &&
        !(refPos.x === 0 && refPos.y === 0);
      const fallback = initialDudePosRef.current ?? {
        x: DEFAULT_DUDE_CENTER_X + INITIAL_DUDE_X_SHIFT,
        y: DEFAULT_DUDE_BOTTOM_Y + INITIAL_DUDE_Y_SHIFT,
      };
      const from = hasValidRefPos ? refPos : fallback;
      const desired = {
        x: from.x + (unitX * walkSpeedPxPerSec * dtSec) / w,
        y: from.y + (unitY * walkSpeedPxPerSec * dtSec) / h,
      };
      const target = clampWalkTarget(from, desired);
      const movedEnough =
        Math.hypot(target.x - from.x, target.y - from.y) > 1e-5;

      if (!movedEnough) {
        if (keyboardWalkingRef.current) {
          keyboardWalkingRef.current = false;
          moveTargetMetaRef.current = null;
          stopMoveAnim();
          startStandingAnimation();
        }
        keyboardWalkRafRef.current = requestAnimationFrame(step);
        return;
      }

      if (!keyboardWalkingRef.current) {
        keyboardWalkingRef.current = true;
        moveTargetMetaRef.current = null;
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        moveAnimRef.current = null;
      }

      if (currentAnimKindRef.current !== "walking") {
        startWalkingAnimation();
      }
      setDudeFacingLeft(decideFacingWithHysteresis(from, target));
      latestDudePosRef.current = target;
      setDudePos(target);
      updateCircleTracking(target.x, target.y);
      keyboardWalkRafRef.current = requestAnimationFrame(step);
    };

    const startKeyboardWalkLoop = () => {
      if (keyboardWalkRafRef.current !== null) return;
      keyboardWalkLastTsRef.current = null;
      keyboardWalkRafRef.current = requestAnimationFrame(step);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!islandOverlayVisible || islandClosing || islandOpening) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const dir = mapWalkKey(event.key);
      if (!dir) return;
      pressedWalkKeysRef.current[dir] = true;
      event.preventDefault();
      startKeyboardWalkLoop();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const dir = mapWalkKey(event.key);
      if (!dir) return;
      const wasPressed = pressedWalkKeysRef.current[dir];
      if (!wasPressed) return;
      pressedWalkKeysRef.current[dir] = false;
      event.preventDefault();
      if (!hasPressedWalkKeys()) {
        stopKeyboardWalking();
      }
    };

    const onBlur = () => {
      clearPressedWalkKeys();
      stopKeyboardWalking();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") return;
      clearPressedWalkKeys();
      stopKeyboardWalking();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (!islandOverlayVisible || islandClosing || islandOpening) {
      clearPressedWalkKeys();
      stopKeyboardWalking();
    }

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPressedWalkKeys();
      stopKeyboardWalking();
    };
  }, [
    islandOverlayVisible,
    islandClosing,
    islandOpening,
    heroSize.h,
    heroSize.w,
    decideFacingWithHysteresis,
    startStandingAnimation,
    startWalkingAnimation,
    stopMoveAnim,
    updateCircleTracking,
  ]);

  const handleMaterialItemTap = useCallback(
    (name: MaterialName) => () => {
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        return;
      }
      activateMaterial(name);
    },
    [activateMaterial, islandClosing, islandOpening, islandOverlayVisible],
  );

  const isDraggingRef = useRef(false);

  const handlePointerStart = useCallback(
    (
      event:
        React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
    ) => {
      if (!islandOverlayVisible || islandClosing || islandOpening) {
        return;
      }
      walkingDragCleanupRef.current = null;
      const eventTarget = (event.target as Node) || null;
      const skipForProtectedUi = isMaterialTarget(eventTarget);
      const isInsideRockBox = (nx: number, ny: number) => {
        if (!rockAvailable) return false;
        const box = rockBoxRef.current;
        if (!rockReady || !box) return false;
        return (
          nx >= box.left && nx <= box.right && ny >= box.top && ny <= box.bottom
        );
      };
      const isInsideMonBox = (nx: number, ny: number) => {
        if (!monPos) return false;
        const widthFrac = Math.max(
          0.001,
          Math.min(1, getMonBoundsWidthFrac(monKey)),
        );
        const heightFrac = Math.max(0.001, Math.min(1, MON_HEIGHT_FRAC));
        const cx = (monPos.x ?? MON_REL_X) + MON_BOUNDS_X_SHIFT;
        const bottomY = (monPos.y ?? MON_REL_Y) + MON_BASELINE_Y_OFFSET;
        const left = cx - widthFrac * 0.5;
        const right = cx + widthFrac * 0.5;
        const top = bottomY - heightFrac;
        const bottom = bottomY;
        return nx >= left && nx <= right && ny >= top && ny <= bottom;
      };
      const heroEl = islandHeroImgRef.current;
      if (!heroEl) return;
      const rect = heroEl.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const skipDueToCircleGesture = circlesGestureActiveRef.current;
      let clientX = 0;
      let clientY = 0;
      const anyEvent = event as any;
      if (anyEvent.touches && anyEvent.touches[0]) {
        clientX = anyEvent.touches[0].clientX;
        clientY = anyEvent.touches[0].clientY;
      } else {
        clientX = (event as React.MouseEvent).clientX;
        clientY = (event as React.MouseEvent).clientY;
      }
      const nxxEarly = (clientX - rect.left) / width;
      const nyyEarly = (clientY - rect.top) / height;
      const isInsideSafeAreaEarly = isInsideSafeArea(nxxEarly, nyyEarly);
      const inside =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      if (!inside && !isInsideSafeAreaEarly) {
        if (!skipForProtectedUi) {
          const vw = window.innerWidth;
          const isTouchEvent = !!(anyEvent.touches && anyEvent.touches[0]);
          const isAtScreenEdge =
            isTouchEvent &&
            (clientX <= TOUCH_EDGE_DEADZONE_PX ||
              clientX >= vw - TOUCH_EDGE_DEADZONE_PX);
          if (isAtScreenEdge) {
            return;
          }
          handleIslandClose(
            event as unknown as React.MouseEvent | React.TouchEvent,
          );
          return;
        }
      }
      const rx = Math.floor(clientX - rect.left);
      const ry = Math.floor(clientY - rect.top);
      const nx = rx / width;
      const ny = ry / height;

      const isInAnyHotspot = (() => {
        for (let i = 0; i < ISLAND_HOTSPOTS.length; i++) {
          const c = ISLAND_HOTSPOTS[i];
          const dx = nx - c.cxPct;
          const dy = ny - c.cyPct;
          const r = c.dPct * 0.5;
          if (dx * dx + dy * dy <= r * r) return true;
        }
        return false;
      })();

      const allowStarsInteraction =
        skipForProtectedUi || !isInAnyHotspot || skipDueToCircleGesture;

      const shouldSuppressInputNearLastRock = (px: number, py: number) => {
        const now = performance.now();
        if (now < walkSuppressedUntilRef.current) {
          const anchor = walkSuppressionAnchorRef.current;
          if (anchor) {
            const dx = px - anchor.x;
            const dy = py - anchor.y;
            if (
              dx * dx + dy * dy <=
              WALK_SUPPRESSION_RADIUS * WALK_SUPPRESSION_RADIUS
            ) {
              if (walkSuppressionHitsRemainingRef.current > 0) {
                walkSuppressionHitsRemainingRef.current -= 1;
                return true;
              }
            }
          }
        } else if (walkSuppressionHitsRemainingRef.current > 0) {
          walkSuppressionHitsRemainingRef.current = 0;
        }
        return false;
      };

      const starWithinBounds = (px: number, py: number) =>
        px >= STAR_SHINE_PENTAGON_BOUNDS.minX &&
        px <= STAR_SHINE_PENTAGON_BOUNDS.maxX &&
        py >= STAR_SHINE_PENTAGON_BOUNDS.minY &&
        py <= STAR_SHINE_PENTAGON_BOUNDS.maxY &&
        pointInPolygon(px, py, STAR_SHINE_PENTAGON);

      const resetStarInteractionState = () => {
        if (starsTimerRef.current) {
          window.clearTimeout(starsTimerRef.current);
          starsTimerRef.current = 0;
        }
        cancelQueuedStarsCenterUpdate();
        starsAnimActiveRef.current = false;
        starsDismissedRef.current = false;
        wasStarsInsideRef.current = false;
        setStarsVisible(false);
        if (starsHoldRef.current) setStarsHold(false);
      };

      const startStarInteractionAt = (px: number, py: number) => {
        if (!starWithinBounds(px, py)) {
          setStarsHold(false);
          setStarsVisible(false);
          wasStarsInsideRef.current = false;
          starsDismissedRef.current = true;
          return;
        }
        if (starsTimerRef.current) {
          window.clearTimeout(starsTimerRef.current);
          starsTimerRef.current = 0;
        }
        setStarsVisible(false);
        if (starsAnimActiveRef.current) {
          starsAnimActiveRef.current = false;
        }
        setStarsCenterImmediate(px * 100, py * 100);
        setStarsHold(true);
        wasStarsInsideRef.current = true;
        starsDismissedRef.current = false;
      };

      const updateStarInteractionAt = (px: number, py: number) => {
        if (starWithinBounds(px, py)) {
          if (!starsHoldRef.current) {
            setStarsCenterImmediate(px * 100, py * 100);
            setStarsHold(true);
          } else {
            queueStarsCenterUpdate(px * 100, py * 100);
          }
          if (starsTimerRef.current) {
            window.clearTimeout(starsTimerRef.current);
            starsTimerRef.current = 0;
          }
          if (starsAnimActiveRef.current) {
            setStarsVisible(false);
            starsAnimActiveRef.current = false;
          }
          wasStarsInsideRef.current = true;
          starsDismissedRef.current = false;
          return;
        }
        if (starsHoldRef.current) setStarsHold(false);
        if (!starsAnimActiveRef.current && !starsDismissedRef.current) {
          cancelQueuedStarsCenterUpdate();
          if (starsTimerRef.current) {
            window.clearTimeout(starsTimerRef.current);
            starsTimerRef.current = 0;
          }
          setStarsVisible(false);
          starsAnimActiveRef.current = true;
          starsDismissedRef.current = true;
          requestAnimationFrame(() => {
            setStarsVisible(true);
            starsTimerRef.current = window.setTimeout(() => {
              setStarsVisible(false);
              starsAnimActiveRef.current = false;
            }, 520);
          });
        } else if (starsDismissedRef.current || starsAnimActiveRef.current) {
          if (starsTimerRef.current) {
            window.clearTimeout(starsTimerRef.current);
            starsTimerRef.current = 0;
          }
          setStarsVisible(false);
        }
        wasStarsInsideRef.current = false;
      };

      const finalizeStarInteraction = () => {
        if (starsHoldRef.current) setStarsHold(false);
        if (wasStarsInsideRef.current && !starsAnimActiveRef.current) {
          if (starsTimerRef.current) {
            window.clearTimeout(starsTimerRef.current);
            starsTimerRef.current = 0;
          }
          cancelQueuedStarsCenterUpdate();
          starsAnimActiveRef.current = true;
          setStarsVisible(true);
          if (starsHoldRef.current) setStarsHold(false);
          starsTimerRef.current = window.setTimeout(() => {
            setStarsVisible(false);
            starsAnimActiveRef.current = false;
            starsDismissedRef.current = false;
          }, 520);
        } else {
          setStarsVisible(false);
          starsDismissedRef.current = false;
        }
      };

      if (
        !skipForProtectedUi &&
        !skipDueToCircleGesture &&
        !walkingDragActiveRef.current &&
        isInsideRockBox(nx, ny)
      ) {
        syncDudePosFromOriginal();
        const initial = initialDudePosRef.current || latestDudePosRef.current;
        const alternate = {
          x: initial.x + ALTERNATE_DUDE_X_SHIFT - INITIAL_DUDE_X_SHIFT,
          y: initial.y,
        };
        const distToInitial = Math.hypot(
          dudePos.x - initial.x,
          dudePos.y - initial.y,
        );
        const distToAlternate = Math.hypot(
          dudePos.x - alternate.x,
          dudePos.y - alternate.y,
        );
        const targetPos = distToAlternate < distToInitial ? alternate : initial;
        const isAlternate = targetPos === alternate;
        const atTarget =
          Math.hypot(dudePos.x - targetPos.x, dudePos.y - targetPos.y) < 0.015;
        if (!atTarget) {
          moveTargetMetaRef.current = {
            x: targetPos.x,
            y: targetPos.y,
            facingLeft: isAlternate
              ? !INITIAL_DUDE_FACING_LEFT
              : INITIAL_DUDE_FACING_LEFT,
            onArrive: () => {
              startMiningAnimation();
            },
          };
          startMoveTo(targetPos.x, targetPos.y);
          playSounds([Sound.WalkToRock]);
        } else {
          setDudeFacingLeft(
            isAlternate ? !INITIAL_DUDE_FACING_LEFT : INITIAL_DUDE_FACING_LEFT,
          );
          try {
            walkSuppressionAnchorRef.current = { x: nx, y: ny };
            rockRef.current?.tap();
          } catch {}
        }
        if ((event as any).preventDefault) (event as any).preventDefault();
        return;
      }
      if (
        !skipForProtectedUi &&
        !skipDueToCircleGesture &&
        isInsideMonBox(nx, ny)
      ) {
        if (shouldSuppressInputNearLastRock(nx, ny)) {
          if ((event as any).preventDefault) (event as any).preventDefault();
          return;
        }
        const detailed = getMonBoundsWithExpansion();
        if (!detailed) return;
        const leftX = detailed.expanded.left;
        const rightX = detailed.expanded.right;
        const top = detailed.expanded.top;
        const bottom = detailed.expanded.bottom;
        const clampedY = Math.max(top, Math.min(bottom, dudePos.y));
        const candidates = [
          { x: leftX, y: clampedY },
          { x: rightX, y: clampedY },
        ];
        let best = candidates[0];
        let bestDist = Math.hypot(dudePos.x - best.x, dudePos.y - best.y);
        for (let i = 1; i < candidates.length; i++) {
          const d = Math.hypot(
            dudePos.x - candidates[i].x,
            dudePos.y - candidates[i].y,
          );
          if (d < bestDist) {
            best = candidates[i];
            bestDist = d;
          }
        }
        const fromPoint = getReferencePos();
        const insideWalk = isInsideWalkArea(best.x, best.y);
        const target = insideWalk ? best : clampWalkTarget(fromPoint, best);
        const onLeftSide =
          Math.abs(best.x - leftX) <= Math.abs(best.x - rightX);
        const facingLeft = onLeftSide ? false : true;
        const atTarget =
          Math.hypot(dudePos.x - target.x, dudePos.y - target.y) < 0.015;
        if (!atTarget) {
          moveTargetMetaRef.current = {
            x: target.x,
            y: target.y,
            facingLeft,
            onArrive: () => {
              try {
                startPettingAnimationRef.current();
              } catch {}
            },
          };
          startMoveTo(target.x, target.y);
          playSounds([Sound.WalkToMon]);
        } else {
          setDudeFacingLeft(facingLeft);
          petMon();
          scheduleTeleportOverlapCheck();
        }
        if ((event as any).preventDefault) (event as any).preventDefault();
        return;
      }

      const insideSafeAreaStart = isInsideSafeArea(nx, ny);
      const insideHoleStart = isInsideHole(nx, ny);
      if (!skipForProtectedUi && !skipDueToCircleGesture && insideHoleStart) {
        if ("preventDefault" in event) {
          event.preventDefault();
        }
        return;
      }
      if (
        !skipForProtectedUi &&
        !skipDueToCircleGesture &&
        (isInsideSmoothEllipse(nx, ny) || insideSafeAreaStart)
      ) {
        if (shouldSuppressInputNearLastRock(nx, ny)) {
          return;
        }
        const fromPointStart = getReferencePos();
        const desiredStart = { x: nx, y: ny };
        const target = clampWalkTarget(fromPointStart, desiredStart);
        if (isInsideHole(target.x, target.y)) {
          if ("preventDefault" in event) {
            event.preventDefault();
          }
          return;
        }
        moveTargetMetaRef.current = null;
        startMoveTo(target.x, target.y);
        isDraggingRef.current = true;
        const insideWalkStart = isInsideWalkArea(nx, ny);
        dragModeRef.current = insideWalkStart ? "free" : "edge";
        lastPointerRef.current = { x: nx, y: ny };
        lastEllipsePointerRef.current = { x: nx, y: ny };
        walkingDragActiveRef.current = true;
        const enableStars = allowStarsInteraction;
        let starHandledImmediately = false;
        if (enableStars) {
          resetStarInteractionState();
          startStarInteractionAt(nx, ny);
          finalizeStarInteraction();
          setStarsHold(false);
          starsHoldRef.current = false;
          starHandledImmediately = true;
        }

        const handleMove = (e: MouseEvent | TouchEvent) => {
          if (!isDraggingRef.current) return;
          let cx = 0;
          let cy = 0;
          if ("touches" in e && e.touches[0]) {
            cx = e.touches[0].clientX;
            cy = e.touches[0].clientY;
          } else if ("clientX" in e) {
            cx = (e as MouseEvent).clientX;
            cy = (e as MouseEvent).clientY;
          }
          const rxx = Math.floor(cx - rect.left);
          const ryy = Math.floor(cy - rect.top);
          const nxx = rxx / width;
          const nyy = ryy / height;
          if (dragModeRef.current === "edge") {
            const lp = lastEllipsePointerRef.current;
            const dxp = nxx - lp.x;
            const dyp = nyy - lp.y;
            if (
              dxp * dxp + dyp * dyp <
              SAFE_POINTER_MOVE_EPS * SAFE_POINTER_MOVE_EPS
            ) {
              if ("preventDefault" in e) e.preventDefault();
              return;
            }
          } else {
            const lp = lastPointerRef.current;
            const dxp = nxx - lp.x;
            const dyp = nyy - lp.y;
            if (
              dxp * dxp + dyp * dyp <
              SAFE_POINTER_MOVE_EPS * SAFE_POINTER_MOVE_EPS
            ) {
              if ("preventDefault" in e) e.preventDefault();
              return;
            }
          }
          const desiredPoint = { x: nxx, y: nyy };
          const nextTarget = clampWalkTarget(getReferencePos(), desiredPoint);
          if (isInsideWalkArea(nxx, nyy)) {
            dragModeRef.current = "free";
            lastPointerRef.current = { x: nxx, y: nyy };
            lastEllipsePointerRef.current = { x: nxx, y: nyy };
          } else {
            dragModeRef.current = "edge";
            lastEllipsePointerRef.current = { x: nxx, y: nyy };
          }
          updateMoveTarget(nextTarget.x, nextTarget.y);
          latestDudePosRef.current = moveAnimRef.current
            ? {
                x:
                  moveAnimRef.current.from.x +
                  (moveAnimRef.current.to.x - moveAnimRef.current.from.x) *
                    Math.min(
                      1,
                      (performance.now() - moveAnimRef.current.start) /
                        moveAnimRef.current.duration,
                    ),
                y:
                  moveAnimRef.current.from.y +
                  (moveAnimRef.current.to.y - moveAnimRef.current.from.y) *
                    Math.min(
                      1,
                      (performance.now() - moveAnimRef.current.start) /
                        moveAnimRef.current.duration,
                    ),
              }
            : latestDudePosRef.current;
          updateCircleTracking(
            latestDudePosRef.current.x,
            latestDudePosRef.current.y,
          );
          if ("preventDefault" in e) {
            e.preventDefault();
          }
        };

        const handleEnd = () => {
          isDraggingRef.current = false;
          if (enableStars && !starHandledImmediately) finalizeStarInteraction();
          walkingDragActiveRef.current = false;
          dragModeRef.current = "none";
          lastEllipsePointerRef.current = { x: -1, y: -1 };
          resetCircleTracking();
          window.removeEventListener("mousemove", handleMove as any);
          window.removeEventListener("mouseup", handleEnd as any);
          window.removeEventListener("touchmove", handleMove as any);
          window.removeEventListener("touchend", handleEnd as any);
          window.removeEventListener("touchcancel", handleEnd as any);
          window.removeEventListener("blur", handleEnd as any);
          document.removeEventListener(
            "visibilitychange",
            handleVisibilityChange as any,
          );
          if (!moveAnimRef.current) {
            const wAnim =
              currentAnimKindRef.current === "walking"
                ? sheetAnimRef.current
                : null;
            if (wAnim && wAnim.raf) cancelAnimationFrame(wAnim.raf);
            sheetAnimRef.current = null;
            currentAnimKindRef.current = "none";
            setWalkingPlaying(false);
            scheduleTeleportOverlapCheck();
            startStandingAnimation();
          }
          walkingDragCleanupRef.current = null;
        };

        walkingDragCleanupRef.current = handleEnd;

        const handleVisibilityChange = () => {
          if (document.visibilityState !== "visible") {
            handleEnd();
          }
        };

        window.addEventListener("mousemove", handleMove as any, {
          passive: false,
        });
        window.addEventListener("mouseup", handleEnd as any);
        window.addEventListener("touchmove", handleMove as any, {
          passive: false,
        });
        window.addEventListener("touchend", handleEnd as any);
        window.addEventListener("touchcancel", handleEnd as any);
        window.addEventListener("blur", handleEnd as any);
        document.addEventListener(
          "visibilitychange",
          handleVisibilityChange as any,
        );

        if ("preventDefault" in event) {
          event.preventDefault();
        }
        return;
      }
      const inDismissTriangle =
        pointInTriangle(nx, ny, DISMISS_ALLOWED_TRIANGLE_A) ||
        pointInTriangle(nx, ny, DISMISS_ALLOWED_TRIANGLE_B);
      if (!skipForProtectedUi && !skipDueToCircleGesture && inDismissTriangle) {
        handleIslandClose(
          event as unknown as React.MouseEvent | React.TouchEvent,
        );
        return;
      }
      const allowStarDrag = allowStarsInteraction;
      if (allowStarDrag) {
        const handleMove = (e: MouseEvent | TouchEvent) => {
          let cx2 = 0;
          let cy2 = 0;
          if ("touches" in e && e.touches[0]) {
            cx2 = e.touches[0].clientX;
            cy2 = e.touches[0].clientY;
          } else if ("clientX" in e) {
            cx2 = (e as MouseEvent).clientX;
            cy2 = (e as MouseEvent).clientY;
          }
          const rxx2 = Math.floor(cx2 - rect.left);
          const ryy2 = Math.floor(cy2 - rect.top);
          const nxx2 = rxx2 / Math.max(1, rect.width);
          const nyy2 = ryy2 / Math.max(1, rect.height);
          updateStarInteractionAt(nxx2, nyy2);
          if ("preventDefault" in e) (e as any).preventDefault();
        };
        const handleEnd = () => {
          isDraggingRef.current = false;
          finalizeStarInteraction();
          window.removeEventListener("mousemove", handleMove as any);
          window.removeEventListener("mouseup", handleEnd as any);
          window.removeEventListener("touchmove", handleMove as any);
          window.removeEventListener("touchend", handleEnd as any);
          window.removeEventListener("touchcancel", handleEnd as any);
          window.removeEventListener("blur", handleEnd as any);
          document.removeEventListener(
            "visibilitychange",
            handleVisibilityChange as any,
          );
        };
        const handleVisibilityChange = () => {
          if (document.visibilityState !== "visible") {
            handleEnd();
          }
        };
        window.addEventListener("mousemove", handleMove as any, {
          passive: false,
        });
        window.addEventListener("mouseup", handleEnd as any);
        window.addEventListener("touchmove", handleMove as any, {
          passive: false,
        });
        window.addEventListener("touchend", handleEnd as any);
        window.addEventListener("touchcancel", handleEnd as any);
        window.addEventListener("blur", handleEnd as any);
        document.addEventListener(
          "visibilitychange",
          handleVisibilityChange as any,
        );
        isDraggingRef.current = true;
        resetStarInteractionState();
        startStarInteractionAt(nx, ny);
        if ("preventDefault" in event) (event as any).preventDefault();
        return;
      }
    },
    [
      handleIslandClose,
      startMoveTo,
      updateMoveTarget,
      rockAvailable,
      rockReady,
      dudePos,
      startMiningAnimation,
      startStandingAnimation,
      syncDudePosFromOriginal,
      monKey,
      monPos,
      petMon,
      scheduleTeleportOverlapCheck,
      updateCircleTracking,
      resetCircleTracking,
      queueStarsCenterUpdate,
      cancelQueuedStarsCenterUpdate,
      setStarsCenterImmediate,
      isMaterialTarget,
      isInsideSafeArea,
      getReferencePos,
      getMonBoundsWithExpansion,
      islandOverlayVisible,
      islandClosing,
      islandOpening,
    ],
  );

  const handleSafeHitboxPointerDown = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      if (!isMaterialTarget((event.target as Node) || null)) {
        return;
      }
      handlePointerStart(
        event as
          React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
      );
    },
    [handlePointerStart, isMaterialTarget],
  );

  const decorMounted = decorVisible || islandClosing;

  const showSparkle =
    rockAvailable && !islandOverlayShown && !sparkleFading && sparkleMounted;
  const shouldPrewarmAnonSignInDrop =
    islandOverlayVisible &&
    !islandClosing &&
    !isSignedIn &&
    !anonSignInDropState &&
    (rockAvailable || rockBreaking);

  return (
    <>
      {islandImgLoaded && (
        <ButtonWrap $hidden={islandOverlayShown}>
          <SparkleContainer
            $visible={showSparkle}
            $fading={sparkleFading}
            $dimmed={dimmed}
          >
            <SparkleRing />
            <SparkleRays $dimmed={dimmed}>
              <SparkleRay $angle={0} $delay={0} />
              <SparkleRay $angle={60} $delay={0.3} />
              <SparkleRay $angle={120} $delay={0.6} />
              <SparkleRay $angle={180} $delay={0.15} />
              <SparkleRay $angle={240} $delay={0.45} />
              <SparkleRay $angle={300} $delay={0.75} />
            </SparkleRays>
            <SparkleCore />
            <SparkleParticle
              $x={22}
              $y={18}
              $delay={0}
              $duration={1.6}
              $dimmed={dimmed}
            />
            <SparkleParticle
              $x={78}
              $y={25}
              $delay={0.5}
              $duration={1.8}
              $dimmed={dimmed}
            />
            <SparkleParticle
              $x={70}
              $y={72}
              $delay={1.1}
              $duration={1.5}
              $dimmed={dimmed}
            />
            <SparkleParticle
              $x={28}
              $y={80}
              $delay={0.3}
              $duration={1.9}
              $dimmed={dimmed}
            />
            <SparkleParticle
              $x={85}
              $y={50}
              $delay={0.8}
              $duration={1.7}
              $dimmed={dimmed}
            />
          </SparkleContainer>
          <ButtonEl
            ref={islandButtonRef}
            $hidden={islandOverlayShown}
            $dimmed={dimmed}
            onClick={!isMobile ? handleIslandOpen : undefined}
            onTouchStart={isMobile ? handleIslandOpen : undefined}
            aria-label="Island"
          >
            <img
              ref={islandButtonImgRef}
              src={resolvedUrl}
              alt=""
              draggable={false}
            />
          </ButtonEl>
        </ButtonWrap>
      )}
      {(islandOverlayShown || islandAnimating) && (
        <>
          <Overlay
            $visible={islandOverlayVisible}
            $opening={islandOpening}
            $closing={islandClosing}
            onClick={!isMobile ? handleIslandClose : undefined}
            onTouchStart={isMobile ? handleIslandClose : undefined}
            onTransitionEnd={handleOverlayTransitionEnd}
          />
          <Layer
            $visible={islandOverlayVisible}
            $opening={islandOpening}
            $closing={islandClosing}
            onMouseDown={!isMobile ? handlePointerStart : undefined}
            onTouchStart={isMobile ? handlePointerStart : undefined}
          >
            <SafeBarRow>
              <SafeBarStack>
                <SafeHitbox
                  ref={safeHitboxRef}
                  $active={islandOverlayVisible && !islandClosing}
                  onMouseDown={
                    !isMobile ? handleSafeHitboxPointerDown : undefined
                  }
                  onTouchStart={
                    isMobile ? handleSafeHitboxPointerDown : undefined
                  }
                >
                  <MaterialsBar
                    ref={materialsBarRef}
                    $visible={islandOverlayVisible && !islandClosing}
                  >
                    <MaterialsBarContent ref={materialsBarContentRef}>
                      {MATERIALS.map((name) => (
                        <MaterialItem
                          ref={(el) => {
                            materialItemRefs.current[name] = el;
                          }}
                          key={name}
                          onMouseDown={
                            !isMobile ? handleMaterialItemTap(name) : undefined
                          }
                          onTouchStart={
                            isMobile ? handleMaterialItemTap(name) : undefined
                          }
                        >
                          {materialUrls[name] && (
                            <MaterialIcon
                              src={materialUrls[name] || ""}
                              alt=""
                              draggable={false}
                            />
                          )}
                          <MaterialAmount>
                            {materialAmounts[name]}
                          </MaterialAmount>
                        </MaterialItem>
                      ))}
                    </MaterialsBarContent>
                  </MaterialsBar>
                </SafeHitbox>
              </SafeBarStack>
            </SafeBarRow>
            <Animator
              $tx={islandTranslate.x}
              $ty={islandTranslate.y}
              $sx={islandScale.x}
              $sy={islandScale.y}
              onTransitionEnd={handleIslandTransitionEnd}
            >
              <HeroWrap ref={heroWrapRef}>
                <Hero
                  ref={islandHeroImgRef}
                  src={resolvedUrl}
                  alt=""
                  draggable={false}
                />
                <WalkOverlay />
                {islandOverlayVisible && !islandClosing && (
                  <HotspotOverlay ref={editorOverlayRef}>
                    <MaskedArea
                      $cx={starsMaskCenter.xPct}
                      $cy={starsMaskCenter.yPct}
                      $visible={starsHold || starsVisible}
                    >
                      <StarsOverlayImage
                        ref={starsImgRef}
                        src={STARS_URL}
                        alt=""
                        draggable={false}
                        $visible={starsVisible}
                        $hold={starsHold}
                      />
                    </MaskedArea>
                    {ISLAND_HOTSPOTS.map((c, i) => {
                      const left = (c.cxPct - c.dPct / 2) * 100;
                      const top = (c.cyPct - c.dPct / 2) * 100;
                      const size = c.dPct * 100;
                      return (
                        <HotspotCircle
                          key={`glow-${i}`}
                          $visible={hotspotVisible[i]}
                          style={{
                            left: `${left}%`,
                            top: `${top}%`,
                            width: `${size}%`,
                            height: `${size}%`,
                          }}
                        />
                      );
                    })}
                  </HotspotOverlay>
                )}
                {shouldPrewarmAnonSignInDrop && (
                  <>
                    <RockSignInShadow $hidden $settled />
                    <RockSignInButton
                      type="button"
                      $hidden
                      $isConnected={false}
                      $settled
                      aria-hidden="true"
                      tabIndex={-1}
                    >
                      Sign In
                    </RockSignInButton>
                  </>
                )}
                {anonSignInDropState && !islandClosing && (
                  <>
                    <RockSignInShadow
                      key={`shadow-${anonSignInDropState.key}`}
                      $settled={anonSignInDropState.settled}
                    />
                    <RockSignInButton
                      key={anonSignInDropState.key}
                      type="button"
                      $isConnected={false}
                      $settled={anonSignInDropState.settled}
                      onClick={handleAnonSignInDropClick}
                      onMouseDown={
                        !isMobile ? handleAnonSignInDropPress : undefined
                      }
                      onTouchStart={
                        isMobile ? handleAnonSignInDropPress : undefined
                      }
                      aria-label="Sign in"
                    >
                      Sign In
                    </RockSignInButton>
                  </>
                )}
                {(() => {
                  const widthPct = DUDE_BOUNDS_WIDTH_FRAC * 1.3 * 100;
                  const topOffsetFrac = 0.0135;
                  const topFrac = Math.max(
                    0,
                    Math.min(1, dudePos.y - topOffsetFrac),
                  );
                  return (
                    <ShadowImg
                      src={`data:image/png;base64,${islandMonsShadow}`}
                      alt=""
                      draggable={false}
                      style={{
                        left: `${dudePos.x * 100}%`,
                        top: `${topFrac * 100}%`,
                        width: `${widthPct}%`,
                        height: "auto",
                        opacity: dudeVisible ? 0.23 : 0,
                      }}
                    />
                  );
                })()}
                <DudeSpriteWrap
                  ref={dudeWrapRef}
                  style={{
                    left: `${dudePos.x * 100}%`,
                    top: `${dudePos.y * 100}%`,
                    opacity: dudeVisible ? 1 : 0,
                    zIndex: computeEntityZIndex(dudePos.y),
                  }}
                >
                  <DudeSpriteFrame
                    $facingLeft={dudeFacingLeft}
                    ref={miningFrameWrapRef as any}
                  >
                    <DudeSpriteStrip
                      ref={miningStripImgRef as any}
                      src={`data:image/png;base64,${islandMonsMining}`}
                      alt=""
                      draggable={false}
                    />
                  </DudeSpriteFrame>
                </DudeSpriteWrap>
                {decorMounted && (
                  <>
                    {monPos &&
                      monSpriteData &&
                      (() => {
                        const monBaselineY =
                          (monPos ? monPos.y : MON_REL_Y) +
                          MON_BASELINE_Y_OFFSET;
                        const monZIndex = computeEntityZIndex(monBaselineY);
                        return (
                          <MonLayer
                            $visible={decorVisible && !islandClosing}
                            style={{
                              zIndex: monZIndex,
                            }}
                          >
                            {(() => {
                              const widthPct =
                                getMonBoundsWidthFrac(monKey) * 1.3 * 100;
                              const cx =
                                ((monPos?.x ?? MON_REL_X) +
                                  MON_BOUNDS_X_SHIFT) *
                                100;
                              const bottomY =
                                (monPos?.y ?? MON_REL_Y) +
                                MON_BASELINE_Y_OFFSET;
                              const topOffsetFrac = 0.0075;
                              const topFrac = Math.max(
                                0,
                                Math.min(1, bottomY - topOffsetFrac),
                              );
                              return (
                                <ShadowImg
                                  src={`data:image/png;base64,${islandMonsShadow}`}
                                  alt=""
                                  draggable={false}
                                  style={{
                                    left: `${cx}%`,
                                    top: `${topFrac * 100}%`,
                                    width: `${widthPct}%`,
                                    height: "auto",
                                    opacity:
                                      monVisible && !monTeleporting ? 0.23 : 0,
                                  }}
                                />
                              );
                            })()}
                            <MonSpriteWrap
                              ref={monWrapRef}
                              style={{
                                left: `${((monPos?.x ?? MON_REL_X) + MON_BOUNDS_X_SHIFT) * 100}%`,
                                top: `${(monPos?.y ?? MON_REL_Y) * 100}%`,
                                opacity: monVisible && !monTeleporting ? 1 : 0,
                                transition: "opacity 260ms ease",
                                zIndex: monZIndex,
                              }}
                            >
                              <MonSpriteFrame
                                $facingLeft={monFacingLeft}
                                ref={monFrameWrapRef as any}
                              >
                                <MonSpriteStrip
                                  ref={monStripImgRef as any}
                                  src={`data:image/webp;base64,${monSpriteData}`}
                                  alt=""
                                  draggable={false}
                                />
                              </MonSpriteFrame>
                            </MonSpriteWrap>
                          </MonLayer>
                        );
                      })()}
                    <RockLayer
                      ref={rockLayerRef}
                      $visible={decorVisible && (rockAvailable || rockBreaking)}
                      style={{ zIndex: ROCK_LAYER_Z_INDEX }}
                    >
                      <Rock
                        key={rockRenderKey}
                        ref={rockRef as any}
                        heightPct={75}
                        src={rockImageUrl}
                        onOpened={() => {
                          setRockReady(true);
                          updateRockBox();
                        }}
                        onHit={startMiningAnimation}
                        onBroken={() => {
                          setRockBreaking(true);
                          startTransition(() => {
                            setRockReady(false);
                          });
                          if (!amountsDecoupledRef.current) {
                            amountsDecoupledRef.current = true;
                          }
                          const { drops } = rocksMiningService.didBreakRock();
                          requestAnimationFrame(() => {
                            walkSuppressedUntilRef.current = Math.max(
                              walkSuppressedUntilRef.current,
                              performance.now() + 777,
                            );
                            walkSuppressionHitsRemainingRef.current =
                              WALK_SUPPRESSION_HIT_COUNT;
                            const count = drops.length;
                            if (count === 0) {
                              if (storage.getProfileId("") === "") {
                                showAnonSignInDrop();
                              }
                              return;
                            }
                            const now = performance.now();
                            const rect = lastRockRectRef.current;
                            const fallBase = rect ? rect.height * 0.15 : 24;
                            const baseCommon = {
                              duration1: 520,
                              spread: 56,
                              lift: 22,
                              fall: 12 + fallBase,
                              start: now + 30,
                            } as const;
                            const angleSpan = Math.PI * 0.5;
                            const promises = drops.map(
                              (name: MaterialName, i: number) => {
                                const t = count > 1 ? i / (count - 1) : 0.5;
                                const baseAngle =
                                  -angleSpan / 2 + t * angleSpan;
                                const jitter =
                                  (Math.random() - 0.5) * (Math.PI * 0.06);
                                const angle = baseAngle + jitter;
                                return spawnMaterialDrop(name, 0, {
                                  ...baseCommon,
                                  angle,
                                } as any);
                              },
                            );
                            Promise.all(promises).then(() => {});
                          });
                        }}
                        onBreakAnimationComplete={() => {
                          setRockBreaking(false);
                        }}
                      />
                    </RockLayer>
                  </>
                )}
              </HeroWrap>
            </Animator>
          </Layer>
        </>
      )}
    </>
  );
}

export default IslandButton;
