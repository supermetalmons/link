import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { VALID_REACTION_IDS } from "@mons/shared/nfts";
import { MATCH_TIMER_DURATION_SECONDS } from "@mons/shared/timers";
import { createEmptyMaterials } from "@mons/shared/mining";
import {
  FaUndo,
  FaFlag,
  FaCommentAlt,
  FaTrophy,
  FaFlagCheckered,
  FaHome,
  FaRobot,
  FaStar,
  FaEnvelope,
  FaLink,
  FaShareAlt,
  FaPaintBrush,
  FaScroll,
  FaHourglassHalf,
} from "react-icons/fa";
import { IoSparklesSharp } from "react-icons/io5";
import styled from "styled-components";
import AnimatedHourglassButton from "./AnimatedHourglassButton";
import {
  canHandleUndo,
  didClickUndoButton,
  didClickStartTimerButton,
  didClickClaimVictoryByTimerButton,
  didClickPrimaryActionButton,
  didClickHomeButton,
  didClickInviteActionButtonBeforeThereIsInviteReady,
  didClickAutomoveButton,
  didClickAutomatchButton,
  didClickStartBotGameButton,
  didClickEndMatchButton,
  didClickConfirmResignButton,
  isGameWithBot,
  puzzleMode,
  playSameCompletedPuzzleAgain,
  dismissPendingAutomatchTransition,
  isOnlineGame,
  isWatchOnly,
  isMatchOver,
  getBoardViewMode,
  getRematchSeriesNavigatorItems,
  didSelectRematchSeriesMatch,
  preloadRematchSeriesScores,
  getSelectedPuzzleId,
  didSelectPuzzle,
} from "../game/gameController";
import type { RematchSeriesNavigatorItem } from "../game/gameController";
import { connection } from "../connection/connection";
import type { NavigationGamesPageCursor } from "../connection/connection";
import type { AuthState } from "../connection/authentication";
import { defaultEarlyInputEventName, isMobile } from "../utils/misc";
import { soundPlayer } from "../utils/SoundPlayer";
import { playReaction, playSounds } from "../content/sounds";
import { newReactionOfKind, newStickerReaction } from "../content/sounds";
import {
  showVoiceReactionText,
  opponentSideMetadata,
  playerSideMetadata,
  isMetadataSideDisplayedAtOpponentSlot,
} from "../game/board";
import NavigationPicker from "./NavigationPicker";
import {
  ControlsContainer,
  BrushButton,
  NavigationListButton,
  NavigationBadge,
  ControlButton,
  BottomPillButton,
  ResignButton,
  ResignConfirmation,
  ReactionPillsContainer,
  ReactionPill,
  StickerPill,
  WagerBetButton,
  WagerMaterialsGrid,
  WagerMaterialItem,
  WagerMaterialIcon,
  WagerMaterialAmount,
  WagerButtonBadge,
  WagerButtonIcon,
  WagerButtonAmount,
  ShimmerText,
} from "./BottomControlsStyles";
import {
  fetchNftsForIdentity,
  getNftIdentityKey,
  NFT_CACHE_TTL_MS,
} from "../services/nftService";
import { closeMenuAndInfoIfAny } from "./MainMenu";
import { showVideoReaction } from "./BoardComponent";
import BoardStylePickerComponent, {
  preloadPangchiuBoardPreview,
} from "./BoardStylePicker";
import { Sound } from "../utils/gameModels";
import MoveHistoryPopup, {
  subscribeMoveHistoryPopupReload,
  triggerMoveHistoryPopupSelectionReset,
} from "./MoveHistoryPopup";
import {
  MATERIALS,
  MaterialName,
  rocksMiningService,
} from "../services/rocksMiningService";
import {
  EventNavigationPreviewParticipant,
  EventRecord,
  MatchWagerState,
  NavigationGameItem,
  NavigationGameStatus,
  NavigationItem,
} from "../connection/connectionModels";
import { compareNavigationItems as compareNavigationItemsByDisplayOrder } from "../services/navigationItemOrdering";
import { subscribeToWagerState } from "../game/wagerState";
import {
  computeAvailableMaterials,
  getFrozenMaterials,
  subscribeToFrozenMaterials,
} from "../services/wagerMaterialsService";
import { getStashedPlayerProfile } from "../utils/playerMetadata";
import { storage, type ReactionExtraStickerCache } from "../utils/storage";
import {
  getCurrentTarget,
  isTransitionInProgress,
  transitionToHome,
} from "../session/AppSessionManager";
import { getCurrentRouteState } from "../navigation/routeState";
import { registerBottomControlsTransientUiHandler } from "./uiSession";
import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";
import { problems } from "../content/problems";
import { emojis } from "../content/emojis";
import {
  getEventModalState,
  openEventModal,
  subscribeToEventModalState,
} from "./eventModalController";
import {
  NavigationGamesCacheScope,
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
  writeNavigationGamesPersistedTopCache,
  writeNavigationGamesRuntimeCache,
} from "../services/navigationGamesCache";

const deltaTimeOutsideTap = isMobile ? 42 : 420;
const EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS = 10000;
const EVENT_GAME_BUTTON_STICKY_DURATION_MS = 2500;
const HOME_NAVIGATION_BADGE_ENABLED = false;
const rematchSeriesDigitsFontFamily =
  'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';

export enum PrimaryActionType {
  None = "none",
  JoinGame = "joinGame",
  Rematch = "rematch",
}

let latestModalOutsideTapDismissDate = Date.now();

export function didDismissSomethingWithOutsideTapJustNow() {
  latestModalOutsideTapDismissDate = Date.now();
}

type CloseNavigationAndAppearancePopupOptions = {
  preserveNavigationSelection?: boolean;
};

let closeNavigationAndAppearancePopupIfAnyImpl: (
  options?: CloseNavigationAndAppearancePopupOptions,
) => void = () => {};
let setNavigationListButtonVisibleImpl: (visible: boolean) => void = () => {};

export const closeNavigationAndAppearancePopupIfAny = (
  options?: CloseNavigationAndAppearancePopupOptions,
) => {
  closeNavigationAndAppearancePopupIfAnyImpl(options);
};

export const setNavigationListButtonVisible = (visible: boolean) => {
  setNavigationListButtonVisibleImpl(visible);
};

export function resetOutsideTapDismissTimeout() {
  if (!isMobile) {
    latestModalOutsideTapDismissDate -= 1000;
  }
}

export function didNotDismissAnythingWithOutsideTapJustNow(): boolean {
  let delta = Date.now() - latestModalOutsideTapDismissDate;
  return delta >= deltaTimeOutsideTap;
}

let isWagerPanelVisible: () => boolean = () => false;
let handleWagerPanelOutsideTap:
  ((event: TouchEvent | MouseEvent) => boolean) | null = null;

export function setWagerPanelVisibilityChecker(checker: () => boolean) {
  isWagerPanelVisible = checker;
}

export function setWagerPanelOutsideTapHandler(
  handler: ((event: TouchEvent | MouseEvent) => boolean) | null,
) {
  handleWagerPanelOutsideTap = handler;
}

export function hasNavigationPopupVisible(): boolean {
  return getIsNavigationPopupOpen();
}

let getIsNavigationPopupOpen: () => boolean = () => false;

let hasBottomPopupsVisible: () => boolean = () => false;
let showVoiceReactionButton: (show: boolean) => void = () => {};
let showMoveHistoryButton: (show: boolean) => void = () => {};
let showResignButton: () => void = () => {};
let setInviteLinkActionVisible: (visible: boolean) => void = () => {};
let setAutomatchEnabled: (enabled: boolean) => void = () => {};
let setAutomatchVisible: (visible: boolean) => void = () => {};
let setBotGameOptionVisible: (visible: boolean) => void = () => {};
let setPlaySamePuzzleAgainButtonVisible: (visible: boolean) => void = () => {};
let setAutomatchWaitingState: (waiting: boolean) => void = () => {};
let setBrushAndNavigationButtonDimmed: (dimmed: boolean) => void = () => {};
let setBadgeVisible: (visible: boolean) => void = () => {};

let showWaitingStateText: (text: string) => void = () => {};
let setHomeVisible: (visible: boolean) => void = () => {};
let setEndMatchVisible: (visible: boolean) => void = () => {};
let setEndMatchConfirmed: (confirmed: boolean) => void = () => {};
let setUndoVisible: (visible: boolean) => void = () => {};
let setAutomoveActionEnabled: (enabled: boolean) => void = () => {};
let setAutomoveActionVisible: (visible: boolean) => void = () => {};
let setWatchOnlyVisible: (visible: boolean) => void = () => {};
let setUndoEnabled: (enabled: boolean) => void = () => {};
let disableAndHideUndoResignAndTimerControls: () => void = () => {};
let setIsReadyToCopyExistingInviteLink: () => void = () => {};
let hideTimerButtons: () => void = () => {};
let showTimerButtonProgressing: (
  currentProgress: number,
  target: number,
  enableWhenTargetReached: boolean,
) => void = () => {};
let toggleReactionPicker: () => void = () => {};
let enableTimerVictoryClaim: () => void = () => {};
let showPrimaryAction: (action: PrimaryActionType) => void = () => {};
let pendingImmediateCancelAutomatchInviteId: string | null = null;
let pendingImmediateCancelAutomatchIntentExpiresAtMs = 0;
let pendingDelayedCancelAutomatchInviteId: string | null = null;
let pendingDelayedCancelAutomatchIntentExpiresAtMs = 0;
let pendingDelayedCancelAutomatchRevealAtMs = 0;
let pendingFreshAutomatchCancelRevealAtMs = 0;

const STICKER_ID_WHITELIST: number[] = [
  ...VALID_REACTION_IDS,
  900316,
  900101,
  900393,
  90063,
  900109,
  900228,
  900245,
  900267,
  900374,
  900347,
  900382,
  900429,
  900225,
  900999,
  900189,
];
const FIXED_STICKER_IDS: number[] = [
  900316, 900101, 900393, 90063, 900109, 900228, 900245, 900189, 900267, 900374,
  900347, 900382, 900429, 900225, 900999,
];
type StickerEntitlementState = {
  stickerIds: number[];
  ownerKey: string | null;
  expiresAtMs: number;
};
const EMPTY_STICKER_ENTITLEMENT: StickerEntitlementState = {
  stickerIds: FIXED_STICKER_IDS,
  ownerKey: null,
  expiresAtMs: 0,
};
const MATERIAL_IMAGE_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";
const STICKER_IMAGE_BASE_URL = "https://cdn.lil.org/mons/emojipack/swagpack/64";
const NAVIGATION_GAMES_PAGE_SIZE = 80;
const NAVIGATION_GAMES_LOAD_MORE_PAGE_SIZE = 50;
const CANCEL_AUTOMATCH_REVEAL_DELAY_MS = 10000;
const NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS = 60000;
const materialImagePromises: Map<
  MaterialName,
  Promise<string | null>
> = new Map();
const stickerImagePromises: Map<number, Promise<string | null>> = new Map();

const fetchImageUrl = (url: string): Promise<string | null> =>
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error("Failed to fetch image");
      return res.blob();
    })
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => null);

const getCachedImageUrl = <T extends string | number>(
  cache: Map<T, Promise<string | null>>,
  key: T,
  url: string,
) => {
  if (!cache.has(key)) {
    cache.set(key, fetchImageUrl(url));
  }
  return cache.get(key)!;
};

const getMaterialImageUrl = (name: MaterialName) =>
  getCachedImageUrl(
    materialImagePromises,
    name,
    `${MATERIAL_IMAGE_BASE_URL}/${name}.webp`,
  );
const getStickerImageUrl = (id: number) =>
  getCachedImageUrl(
    stickerImagePromises,
    id,
    `${STICKER_IMAGE_BASE_URL}/${id}.webp`,
  );

const clearPendingImmediateCancelAutomatchIntent = () => {
  pendingImmediateCancelAutomatchInviteId = null;
  pendingImmediateCancelAutomatchIntentExpiresAtMs = 0;
};

const requestPendingImmediateCancelAutomatchIntent = (inviteId: string) => {
  if (!inviteId) {
    clearPendingImmediateCancelAutomatchIntent();
    return;
  }
  pendingImmediateCancelAutomatchInviteId = inviteId;
  pendingImmediateCancelAutomatchIntentExpiresAtMs =
    Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS;
};

const consumePendingImmediateCancelAutomatchIntent = (): boolean => {
  const pendingInviteId = pendingImmediateCancelAutomatchInviteId;
  if (!pendingInviteId) {
    return false;
  }
  if (pendingImmediateCancelAutomatchIntentExpiresAtMs < Date.now()) {
    clearPendingImmediateCancelAutomatchIntent();
    return false;
  }
  const routeState = getCurrentRouteState();
  const currentInviteId =
    routeState.mode === "invite" && routeState.inviteId
      ? routeState.inviteId
      : "";
  if (currentInviteId === pendingInviteId) {
    clearPendingImmediateCancelAutomatchIntent();
    return true;
  }
  return false;
};

const clearPendingDelayedCancelAutomatchIntent = () => {
  pendingDelayedCancelAutomatchInviteId = null;
  pendingDelayedCancelAutomatchIntentExpiresAtMs = 0;
  pendingDelayedCancelAutomatchRevealAtMs = 0;
};

const requestPendingDelayedCancelAutomatchIntent = (
  inviteId: string,
  revealAtMs: number,
) => {
  if (!inviteId) {
    clearPendingDelayedCancelAutomatchIntent();
    return;
  }
  pendingDelayedCancelAutomatchInviteId = inviteId;
  pendingDelayedCancelAutomatchIntentExpiresAtMs =
    Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS;
  pendingDelayedCancelAutomatchRevealAtMs =
    revealAtMs > 0
      ? Math.floor(revealAtMs)
      : Date.now() + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
};

const consumePendingDelayedCancelAutomatchIntent = (): number | null => {
  const pendingInviteId = pendingDelayedCancelAutomatchInviteId;
  if (!pendingInviteId) {
    return null;
  }
  if (pendingDelayedCancelAutomatchIntentExpiresAtMs < Date.now()) {
    clearPendingDelayedCancelAutomatchIntent();
    return null;
  }
  const routeState = getCurrentRouteState();
  const currentInviteId =
    routeState.mode === "invite" && routeState.inviteId
      ? routeState.inviteId
      : "";
  if (currentInviteId === pendingInviteId) {
    const revealAtMs = pendingDelayedCancelAutomatchRevealAtMs;
    clearPendingDelayedCancelAutomatchIntent();
    return revealAtMs > 0 ? revealAtMs : null;
  }
  return null;
};

const mergeStickerIds = (base: number[], extra: number[]): number[] => {
  if (!extra.length) return base.slice();
  const seen = new Set<number>(base);
  const merged = base.slice();
  for (const id of extra) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
};

const normalizeStickerIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is number =>
      typeof id === "number" &&
      Number.isSafeInteger(id) &&
      VALID_REACTION_IDS.includes(id),
  );
};

const getSwagpackReactionStickerIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => (item as { id?: unknown }).id);
  return normalizeStickerIds(ids);
};

const areStickerIdArraysEqual = (left: number[], right: number[]): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

const getStoredStickerOwnerKey = (): string | null => {
  return getNftIdentityKey(storage.getAuthIdentity());
};

const hasUsableStickerCacheExpiry = (expiresAtMs: number): boolean => {
  const now = Date.now();
  return expiresAtMs > now && expiresAtMs <= now + NFT_CACHE_TTL_MS;
};

const toUsableStickerEntitlement = (
  cache: ReactionExtraStickerCache | null,
  expectedOwnerKey: string,
): StickerEntitlementState | null => {
  if (
    !cache ||
    getNftIdentityKey(cache) !== expectedOwnerKey ||
    !hasUsableStickerCacheExpiry(cache.expiresAtMs)
  ) {
    return null;
  }
  return {
    stickerIds: mergeStickerIds(
      FIXED_STICKER_IDS,
      normalizeStickerIds(cache.extraIds),
    ),
    ownerKey: expectedOwnerKey,
    expiresAtMs: cache.expiresAtMs,
  };
};

const RematchSeriesInlineControl = styled.div`
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0;
  overflow: hidden;
  mask-image: linear-gradient(to left, transparent 0px, black 6px);
  -webkit-mask-image: linear-gradient(to left, transparent 0px, black 6px);
`;

const LeftCornerInlineControls = styled.div`
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
`;

const RematchSeriesScroll = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const RematchSeriesTrack = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  background: transparent;
  border-radius: 16px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 1px;
`;

const RematchSeriesChip = styled.button<{ $isSelected: boolean }>`
  border: none;
  border-radius: 9px;
  height: 30px;
  min-width: 26px;
  padding: 0 7px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex-shrink: 0;
  cursor: pointer;
  font-family: ${rematchSeriesDigitsFontFamily};
  font-variant-numeric: tabular-nums;
  background: transparent;
  position: relative;

  &::before {
    content: "";
    display: ${(props) => (props.$isSelected ? "block" : "none")};
    position: absolute;
    left: 50%;
    top: 50%;
    width: 18px;
    height: 30px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: rgba(249, 249, 249, 0.77);
    z-index: 0;

    @media (prefers-color-scheme: dark) {
      background: rgba(36, 36, 36, 0.77);
    }
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const RematchScoreOpponent = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchScorePlayer = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchSeriesSeparator = styled.div<{ $hidden: boolean }>`
  width: 0.5px;
  height: 14px;
  background: rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  opacity: ${(props) => (props.$hidden ? 0 : 1)};
  transition: opacity 0.15s ease;

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.12);
  }
`;

const RematchWaitingIcon = styled.span<{ $isSelected: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchLoadingDots = styled.span<{ $isSelected: boolean }>`
  font-size: 11px;
  line-height: 1;
  letter-spacing: 1px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.15)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.15)"};
  }
`;

const EventCloudButtonOuter = styled.button`
  position: relative;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  padding: 0;
  margin-left: -1px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
  outline: none;
  overflow: visible;
  flex-shrink: 0;
`;

const EventCloudShape = styled.path`
  fill: var(--color-gray-f9);
  stroke: none;

  @media (prefers-color-scheme: dark) {
    fill: var(--primaryContainerBackgroundDark);
  }
`;

const EventCloudAvatar = styled.img`
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  z-index: 1;
  object-fit: cover;
  image-rendering: auto;
`;

const EventCloudAvatarPlaceholder = styled.div`
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  z-index: 1;
  background: rgba(128, 128, 128, 0.15);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
  }
`;

type CloudAvatarSlot = { x: number; y: number; r: number };

const CLOUD_VISUAL_SIZE = 48;
const CLOUD_INSET = (36 - CLOUD_VISUAL_SIZE) / 2;
const EVENT_CLOUD_MAX_AVATARS = 4;
const CLOUD_AVATAR_LAYOUT_BASE_SIZE = 38;
const CLOUD_AVATAR_LAYOUT_CENTER_OFFSET =
  CLOUD_VISUAL_SIZE / 2 - CLOUD_AVATAR_LAYOUT_BASE_SIZE / 2;

const CLOUD_AVATAR_LAYOUTS: CloudAvatarSlot[][] = [
  [],
  [{ x: 19, y: 19, r: 0 }],
  [
    { x: 14, y: 19, r: -15 },
    { x: 25, y: 18, r: 12 },
  ],
  [
    { x: 19, y: 12, r: 8 },
    { x: 13, y: 25, r: -12 },
    { x: 26, y: 25, r: 15 },
  ],
  [
    { x: 14, y: 13, r: -10 },
    { x: 26, y: 12, r: 14 },
    { x: 12, y: 26, r: 8 },
    { x: 26, y: 26, r: -12 },
  ],
  [
    { x: 19, y: 11, r: 5 },
    { x: 11, y: 21, r: -15 },
    { x: 28, y: 20, r: 10 },
    { x: 13, y: 29, r: 12 },
    { x: 26, y: 29, r: -8 },
  ],
  [
    { x: 14, y: 12, r: -12 },
    { x: 25, y: 11, r: 15 },
    { x: 11, y: 22, r: 8 },
    { x: 28, y: 21, r: -10 },
    { x: 14, y: 30, r: 5 },
    { x: 26, y: 29, r: -15 },
  ],
];

const CLOUD_AVATAR_SIZE = 11;

function buildEventCloudPath(): string {
  const sz = CLOUD_VISUAL_SIZE;
  const cx = sz / 2;
  const cy = sz / 2;
  const rx = 16;
  const ry = 16;
  const n = 8;
  const step = (Math.PI * 2) / n;
  const bumps = [5.4, 3.8, 6.2, 4.6, 6.0, 3.6, 6.6, 4.2];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const aM = a + step / 2;
    const aE = a + step;
    const x0 = cx + rx * Math.cos(a);
    const y0 = cy + ry * Math.sin(a);
    const cpx = cx + (rx + bumps[i]) * Math.cos(aM);
    const cpy = cy + (ry + bumps[i]) * Math.sin(aM);
    const x1 = cx + rx * Math.cos(aE);
    const y1 = cy + ry * Math.sin(aE);
    if (i === 0) parts.push(`M${x0.toFixed(1)},${y0.toFixed(1)}`);
    parts.push(
      `Q${cpx.toFixed(1)},${cpy.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}`,
    );
  }
  parts.push("Z");
  return parts.join("");
}

const EVENT_CLOUD_PATH = buildEventCloudPath();

const mapEventRecordToNavigationPreview = (
  eventRecord: EventRecord | null,
): EventNavigationPreviewParticipant[] => {
  if (!eventRecord) {
    return [];
  }
  return Object.values(eventRecord.participants)
    .sort((left, right) => left.joinedAtMs - right.joinedAtMs)
    .map((participant) => {
      const displayName = participant.displayName?.trim();
      const username = participant.username?.trim();
      const emojiId = Number.isFinite(participant.emojiId)
        ? Math.trunc(participant.emojiId)
        : NaN;
      return {
        profileId: participant.profileId?.trim() || null,
        displayName: displayName || username || null,
        emojiId: Number.isFinite(emojiId) && emojiId > 0 ? emojiId : null,
        aura: participant.aura?.trim() || null,
      };
    });
};

const getEventCloudAvatarsFromNavigationSources = (
  eventId: string,
  topGames: NavigationItem[],
  pagedGames: NavigationItem[],
): EventNavigationPreviewParticipant[] => {
  const eventNavId = `event_${eventId}`;
  const all = [...topGames, ...pagedGames];
  let eventItem = all.find(
    (item) => item.entityType === "event" && item.id === eventNavId,
  );
  if (!eventItem || eventItem.entityType !== "event") {
    const cacheScope = resolveNavigationGamesCacheScope(
      storage.getProfileId(""),
      storage.getLoginId(""),
    );
    const cached = readNavigationGamesCacheSnapshot(cacheScope);
    const cachedAll = [...cached.topGames, ...cached.pagedGames];
    eventItem = cachedAll.find(
      (item) => item.entityType === "event" && item.id === eventNavId,
    );
  }
  if (!eventItem || eventItem.entityType !== "event") {
    return [];
  }
  return eventItem.participantPreview.slice(0, EVENT_CLOUD_MAX_AVATARS);
};

interface BottomControlsProps {
  authState: AuthState;
}

const BottomControls: React.FC<BottomControlsProps> = ({ authState }) => {
  const { authStatus, profileId, ethAddress, solAddress } = authState;
  const isAuthenticated = authStatus === "authenticated";
  const [isEndMatchButtonVisible, setIsEndMatchButtonVisible] = useState(false);
  const [isEndMatchConfirmed, setIsEndMatchConfirmed] = useState(false);
  const [isInviteLinkButtonVisible, setIsInviteLinkButtonVisible] =
    useState(false);
  const [isBotGameButtonVisible, setIsBotGameButtonVisible] = useState(false);
  const [isAutomatchButtonVisible, setIsAutomatchButtonVisible] =
    useState(false);
  const [isAutomatchButtonEnabled, setIsAutomatchButtonEnabled] =
    useState(true);
  const [isWatchOnlyIndicatorVisible, setIsWatchOnlyIndicatorVisible] =
    useState(false);
  const [isDeepHomeButtonVisible, setIsDeepHomeButtonVisible] = useState(false);
  const [isInviteLoading, setIsInviteLoading] = useState(false);
  const [didCreateInvite, setDidCreateInvite] = useState(false);
  const [automatchButtonTmpState, setAutomatchButtonTmpState] = useState(false);
  const [inviteCopiedTmpState, setInviteCopiedTmpState] = useState(false);
  const [isVoiceReactionDisabled, setIsVoiceReactionDisabled] = useState(false);
  const [isNavigationButtonDimmed, setIsNavigationButtonDimmed] =
    useState(false);
  const [isBrushButtonDimmed, setIsBrushButtonDimmed] = useState(false);
  const [, setIsNavigationListButtonVisible] = useState(false);
  const [isNavigationPopupVisible, setIsNavigationPopupVisible] =
    useState(false);
  const [isBoardStylePickerVisible, setIsBoardStylePickerVisible] =
    useState(false);
  const [isBadgeVisible, setIsBadgeVisible] = useState(false);
  const [navigationProjectedGames, setNavigationProjectedGames] = useState<
    NavigationItem[]
  >([]);
  const [navigationPagedGames, setNavigationPagedGames] = useState<
    NavigationItem[]
  >([]);
  const [isNavigationGamesLoading, setIsNavigationGamesLoading] =
    useState(false);
  const [isNavigationGamesLoadingMore, setIsNavigationGamesLoadingMore] =
    useState(false);
  const [navigationHasMoreGames, setNavigationHasMoreGames] = useState(false);
  const [navigationGamesCursor, setNavigationGamesCursor] =
    useState<NavigationGamesPageCursor>(null);
  const [navigationFallbackLimit, setNavigationFallbackLimit] = useState(
    NAVIGATION_GAMES_PAGE_SIZE,
  );
  const [optimisticPendingAutomatchItem, setOptimisticPendingAutomatchItem] =
    useState<NavigationGameItem | null>(null);
  const [isNavigationFallbackScope, setIsNavigationFallbackScope] =
    useState(false);
  const [navigationRemovingInviteIds, setNavigationRemovingInviteIds] =
    useState<Set<string>>(new Set());
  const [liveEventCloudAvatars, setLiveEventCloudAvatars] = useState<
    EventNavigationPreviewParticipant[]
  >([]);
  const initialEventModalState = getEventModalState();
  const pendingNavigationOpenedEventModalRequestedAtMsRef = useRef(0);
  const pendingNavigationOpenedEventModalRequestSeqRef = useRef(0);
  const wasEventModalVisibleRef = useRef(
    initialEventModalState.isOpen && !!initialEventModalState.eventId,
  );
  const activeEventModalEventIdRef = useRef<string | null>(
    initialEventModalState.isOpen ? initialEventModalState.eventId : null,
  );
  const [selectedEventModalId, setSelectedEventModalId] = useState<
    string | null
  >(initialEventModalState.isOpen ? initialEventModalState.eventId : null);
  const [eventGameButtonStickyEventId, setEventGameButtonStickyEventId] =
    useState<string | null>(null);

  const [isUndoDisabled, setIsUndoDisabled] = useState(true);
  const [waitingStateText, setWaitingStateText] = useState("");
  const [isStartTimerVisible, setIsStartTimerVisible] = useState(false);
  const [primaryAction, setPrimaryAction] = useState<PrimaryActionType>(
    PrimaryActionType.None,
  );
  const [isUndoButtonVisible, setIsUndoButtonVisible] = useState(false);
  const [isAutomoveButtonEnabled, setIsAutomoveButtonEnabled] = useState(true);
  const [isAutomoveButtonVisible, setIsAutomoveButtonVisible] = useState(false);
  const [isResignButtonVisible, setIsResignButtonVisible] = useState(false);
  const [isVoiceReactionButtonVisible, setIsVoiceReactionButtonVisible] =
    useState(false);
  const [isReactionPickerVisible, setIsReactionPickerVisible] = useState(false);
  const [isMoveHistoryButtonVisible, setIsMoveHistoryButtonVisible] =
    useState(false);
  const [isMoveHistoryPopupVisible, setIsMoveHistoryPopupVisible] =
    useState(false);
  const [
    isRematchSeriesSelectionInFlight,
    setIsRematchSeriesSelectionInFlight,
  ] = useState(false);
  const [historyUiVersion, setHistoryUiVersion] = useState(0);
  const [isResignConfirmVisible, setIsResignConfirmVisible] = useState(false);
  const [isTimerConfirmVisible, setIsTimerConfirmVisible] = useState(false);
  const [isClaimVictoryConfirmVisible, setIsClaimVictoryConfirmVisible] =
    useState(false);
  const [isTimerButtonDisabled, setIsTimerButtonDisabled] = useState(true);
  const [isClaimVictoryVisible, setIsClaimVictoryVisible] = useState(false);
  const [isSamePuzzleAgainVisible, setIsSamePuzzleAgainVisible] =
    useState(false);
  const [isEndMatchTemporarilyDisabled, setIsEndMatchTemporarilyDisabled] =
    useState(false);

  const [isCancelAutomatchVisible, setIsCancelAutomatchVisible] =
    useState(false);
  const [isCancelAutomatchDisabled, setIsCancelAutomatchDisabled] =
    useState(false);
  const [cancelAutomatchRevealVersion, setCancelAutomatchRevealVersion] =
    useState(0);

  const [isClaimVictoryButtonDisabled, setIsClaimVictoryButtonDisabled] =
    useState(false);
  const [timerConfig, setTimerConfig] = useState<{
    duration: number;
    progress: number;
    requestDate: number;
  }>({
    duration: MATCH_TIMER_DURATION_SECONDS,
    progress: 0,
    requestDate: Date.now(),
  });
  const [stickerEntitlement, setStickerEntitlement] =
    useState<StickerEntitlementState>(EMPTY_STICKER_ENTITLEMENT);
  const currentStickerOwnerKey = isAuthenticated
    ? getNftIdentityKey(authState)
    : null;
  const clearStickerEntitlement = useCallback(() => {
    setStickerEntitlement((current) => {
      if (
        current.ownerKey === null &&
        current.expiresAtMs === 0 &&
        areStickerIdArraysEqual(current.stickerIds, FIXED_STICKER_IDS)
      ) {
        return current;
      }
      return EMPTY_STICKER_ENTITLEMENT;
    });
  }, []);
  const applyStickerEntitlement = useCallback(
    (next: StickerEntitlementState) => {
      setStickerEntitlement((current) =>
        current.ownerKey === next.ownerKey &&
        current.expiresAtMs > next.expiresAtMs
          ? current
          : next,
      );
    },
    [],
  );
  const hasStickerEntitlementForCurrentOwner =
    currentStickerOwnerKey !== null &&
    stickerEntitlement.ownerKey === currentStickerOwnerKey;
  const hasFreshStickerEntitlement =
    hasStickerEntitlementForCurrentOwner &&
    stickerEntitlement.expiresAtMs > Date.now();
  const visibleStickerIds = hasStickerEntitlementForCurrentOwner
    ? stickerEntitlement.stickerIds
    : FIXED_STICKER_IDS;
  const [pickerMaxHeight, setPickerMaxHeight] = useState<number | undefined>(
    undefined,
  );
  const [timerConfirmLeft, setTimerConfirmLeft] = useState<number | null>(null);
  const [claimVictoryConfirmLeft, setClaimVictoryConfirmLeft] = useState<
    number | null
  >(null);

  const [isWagerMode, setIsWagerMode] = useState(false);
  const [wagerSelection, setWagerSelection] = useState<{
    name: MaterialName | null;
    count: number;
  }>({ name: null, count: 0 });
  const [materialUrls, setMaterialUrls] = useState<
    Record<MaterialName, string | null>
  >(() => {
    const initial: Partial<Record<MaterialName, string | null>> = {};
    MATERIALS.forEach((n) => (initial[n] = null));
    return initial as Record<MaterialName, string | null>;
  });
  const [materialAmounts, setMaterialAmounts] = useState<
    Record<MaterialName, number>
  >(() => {
    const initial: Partial<Record<MaterialName, number>> = {};
    MATERIALS.forEach((n) => (initial[n] = 0));
    return initial as Record<MaterialName, number>;
  });
  const navigationHasPagedGamesRef = useRef(false);
  const navigationLoadMoreInFlightRef = useRef(false);
  const topNavigationItemIdsRef = useRef<Set<string>>(new Set());
  const eventCloudSubscriptionEventIdRef = useRef<string | null>(null);
  const eventGameButtonStickyTimeoutRef = useRef<number | null>(null);
  const navigationCacheScopeRef = useRef<NavigationGamesCacheScope | null>(
    null,
  );
  const navigationPopupEpochRef = useRef(0);
  const navigationSelectionEpochRef = useRef(0);
  const beginInviteFlowRef = useRef<
    (options?: { skipSoundInit?: boolean }) => void
  >(() => {});
  const [stickerUrls, setStickerUrls] = useState<Record<number, string | null>>(
    {},
  );
  const [wagerState, setWagerState] = useState<MatchWagerState | null>(null);
  const frozenMaterialsRef =
    useRef<Record<MaterialName, number>>(getFrozenMaterials());
  const latestServiceMaterialsRef = useRef<Record<MaterialName, number>>(
    createEmptyMaterials(),
  );

  const pickerRef = useRef<HTMLDivElement>(null);
  const controlsContainerRef = useRef<HTMLDivElement>(null);
  const voiceReactionButtonRef = useRef<HTMLButtonElement>(null);
  const moveHistoryButtonRef = useRef<HTMLButtonElement>(null);
  const resignButtonRef = useRef<HTMLButtonElement>(null);
  const resignConfirmRef = useRef<HTMLDivElement>(null);
  const timerButtonRef = useRef<HTMLButtonElement>(null);
  const timerConfirmRef = useRef<HTMLDivElement>(null);
  const claimVictoryButtonRef = useRef<HTMLButtonElement>(null);
  const claimVictoryConfirmRef = useRef<HTMLDivElement>(null);
  const hourglassEnableTimeoutRef = useRef<number | null>(null);
  const hourglassEnableDeadlineRef = useRef<number | null>(null);
  const isTimerButtonDisabledRef = useRef(true);
  const isStartTimerVisibleRef = useRef(false);
  const cancelAutomatchRevealTimeoutRef = useRef<number | null>(null);
  const cancelAutomatchRevealDeadlineRef = useRef<number | null>(null);
  const pendingCancelAutomatchRevealAtMsRef = useRef<number | null>(null);
  const forceImmediateCancelAutomatchRevealRef = useRef(false);
  const automatchCancelRevealModeRef = useRef<
    "unset" | "immediate" | "delayed"
  >("unset");
  const automatchCancelRevealModeDeadlineRef = useRef<number | null>(null);
  const matchScopedTimeoutIdsRef = useRef<Set<number>>(new Set());
  const navigationPopupRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const boardStylePickerRef = useRef<HTMLDivElement>(null);
  const brushButtonRef = useRef<HTMLButtonElement>(null);
  const moveHistoryPopupRef = useRef<HTMLDivElement>(null);
  const rematchSeriesSelectionLockRef = useRef(false);
  const endMatchGracePeriodTimeoutRef = useRef<number | null>(null);

  const clearTrackedMatchScopedTimeout = useCallback(
    (timeoutId: number | null) => {
      if (timeoutId === null) {
        return;
      }
      if (matchScopedTimeoutIdsRef.current.has(timeoutId)) {
        matchScopedTimeoutIdsRef.current.delete(timeoutId);
        decrementLifecycleCounter("uiTimeouts");
      }
      clearTimeout(timeoutId);
    },
    [],
  );

  const isEventModalVisible = useCallback(() => {
    const modalState = getEventModalState();
    return modalState.isOpen && !!modalState.eventId;
  }, []);

  const shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal =
    useCallback(() => {
      if (isEventModalVisible()) {
        return true;
      }
      const requestedAtMs =
        pendingNavigationOpenedEventModalRequestedAtMsRef.current;
      if (requestedAtMs <= 0) {
        return false;
      }
      if (Date.now() - requestedAtMs > EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS) {
        return false;
      }
      return (
        isTransitionInProgress() || getCurrentRouteState().mode === "event"
      );
    }, [isEventModalVisible]);

  const setMatchScopedTimeout = useCallback(
    (callback: () => void, delay: number, guard?: () => boolean): number => {
      const timeoutId = window.setTimeout(() => {
        if (matchScopedTimeoutIdsRef.current.has(timeoutId)) {
          matchScopedTimeoutIdsRef.current.delete(timeoutId);
          decrementLifecycleCounter("uiTimeouts");
        }
        if (guard && !guard()) {
          return;
        }
        callback();
      }, delay);
      matchScopedTimeoutIdsRef.current.add(timeoutId);
      incrementLifecycleCounter("uiTimeouts");
      return timeoutId;
    },
    [],
  );

  const clearAllMatchScopedTimeouts = useCallback(() => {
    matchScopedTimeoutIdsRef.current.forEach((timeoutId) => {
      clearTimeout(timeoutId);
      decrementLifecycleCounter("uiTimeouts");
    });
    matchScopedTimeoutIdsRef.current.clear();
    hourglassEnableTimeoutRef.current = null;
    hourglassEnableDeadlineRef.current = null;
    cancelAutomatchRevealTimeoutRef.current = null;
    cancelAutomatchRevealDeadlineRef.current = null;
    pendingCancelAutomatchRevealAtMsRef.current = null;
    forceImmediateCancelAutomatchRevealRef.current = false;
    automatchCancelRevealModeRef.current = "unset";
    automatchCancelRevealModeDeadlineRef.current = null;
    if (endMatchGracePeriodTimeoutRef.current !== null) {
      clearTimeout(endMatchGracePeriodTimeoutRef.current);
      endMatchGracePeriodTimeoutRef.current = null;
    }
    setIsEndMatchTemporarilyDisabled(false);
    setIsVoiceReactionDisabled(false);
  }, []);

  const clearEventGameButtonStickyState = useCallback(() => {
    if (eventGameButtonStickyTimeoutRef.current !== null) {
      window.clearTimeout(eventGameButtonStickyTimeoutRef.current);
      eventGameButtonStickyTimeoutRef.current = null;
    }
    setEventGameButtonStickyEventId(null);
  }, []);

  const holdEventGameButtonDuringLaunchTransition = useCallback(
    (eventId: string) => {
      const normalizedEventId =
        typeof eventId === "string" ? eventId.trim() : "";
      if (!normalizedEventId) {
        clearEventGameButtonStickyState();
        return;
      }
      if (eventGameButtonStickyTimeoutRef.current !== null) {
        window.clearTimeout(eventGameButtonStickyTimeoutRef.current);
        eventGameButtonStickyTimeoutRef.current = null;
      }
      setEventGameButtonStickyEventId(normalizedEventId);
      eventGameButtonStickyTimeoutRef.current = window.setTimeout(() => {
        eventGameButtonStickyTimeoutRef.current = null;
        setEventGameButtonStickyEventId((currentValue) =>
          currentValue === normalizedEventId ? null : currentValue,
        );
      }, EVENT_GAME_BUTTON_STICKY_DURATION_MS);
    },
    [clearEventGameButtonStickyState],
  );

  useEffect(() => {
    isTimerButtonDisabledRef.current = isTimerButtonDisabled;
  }, [isTimerButtonDisabled]);

  useEffect(() => {
    isStartTimerVisibleRef.current = isStartTimerVisible;
  }, [isStartTimerVisible]);

  const tryEnableTimerButtonFromDeadline = useCallback(() => {
    const deadline = hourglassEnableDeadlineRef.current;
    if (deadline === null || Date.now() < deadline) {
      return;
    }
    if (hourglassEnableTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;
    if (isStartTimerVisibleRef.current && isTimerButtonDisabledRef.current) {
      setIsTimerButtonDisabled(false);
    }
  }, [clearTrackedMatchScopedTimeout]);

  const tryRevealCancelAutomatchFromDeadline = useCallback(() => {
    const deadline = cancelAutomatchRevealDeadlineRef.current;
    if (deadline === null || Date.now() < deadline) {
      return;
    }
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    cancelAutomatchRevealDeadlineRef.current = null;
    if (automatchButtonTmpState && isAutomatchButtonVisible) {
      setIsCancelAutomatchVisible(true);
    }
  }, [
    automatchButtonTmpState,
    clearTrackedMatchScopedTimeout,
    isAutomatchButtonVisible,
  ]);

  useEffect(() => {
    const handleTimerDeadlineCheck = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      tryEnableTimerButtonFromDeadline();
    };
    handleTimerDeadlineCheck();
    document.addEventListener("visibilitychange", handleTimerDeadlineCheck);
    window.addEventListener("focus", handleTimerDeadlineCheck);
    window.addEventListener("pageshow", handleTimerDeadlineCheck);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleTimerDeadlineCheck,
      );
      window.removeEventListener("focus", handleTimerDeadlineCheck);
      window.removeEventListener("pageshow", handleTimerDeadlineCheck);
    };
  }, [tryEnableTimerButtonFromDeadline]);

  useEffect(() => {
    const handleCancelAutomatchDeadlineCheck = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      tryRevealCancelAutomatchFromDeadline();
    };
    handleCancelAutomatchDeadlineCheck();
    document.addEventListener(
      "visibilitychange",
      handleCancelAutomatchDeadlineCheck,
    );
    window.addEventListener("focus", handleCancelAutomatchDeadlineCheck);
    window.addEventListener("pageshow", handleCancelAutomatchDeadlineCheck);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleCancelAutomatchDeadlineCheck,
      );
      window.removeEventListener("focus", handleCancelAutomatchDeadlineCheck);
      window.removeEventListener(
        "pageshow",
        handleCancelAutomatchDeadlineCheck,
      );
    };
  }, [tryRevealCancelAutomatchFromDeadline]);

  useEffect(() => {
    const handleClickOutside = (event: TouchEvent | MouseEvent) => {
      event.stopPropagation();
      if (
        (pickerRef.current &&
          !pickerRef.current.contains(event.target as Node) &&
          !voiceReactionButtonRef.current?.contains(event.target as Node)) ||
        (resignConfirmRef.current &&
          !resignConfirmRef.current.contains(event.target as Node) &&
          !resignButtonRef.current?.contains(event.target as Node)) ||
        (timerConfirmRef.current &&
          !timerConfirmRef.current.contains(event.target as Node) &&
          !timerButtonRef.current?.contains(event.target as Node)) ||
        (claimVictoryConfirmRef.current &&
          !claimVictoryConfirmRef.current.contains(event.target as Node) &&
          !claimVictoryButtonRef.current?.contains(event.target as Node))
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        setIsReactionPickerVisible(false);
        setIsResignConfirmVisible(false);
        setIsTimerConfirmVisible(false);
        setIsClaimVictoryConfirmVisible(false);
      }

      if (
        moveHistoryPopupRef.current &&
        !moveHistoryPopupRef.current.contains(event.target as Node) &&
        !moveHistoryButtonRef.current?.contains(event.target as Node)
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        setIsMoveHistoryPopupVisible(false);
      }

      if (
        navigationPopupRef.current &&
        !navigationPopupRef.current.contains(event.target as Node) &&
        !navigationButtonRef.current?.contains(event.target as Node)
      ) {
        if (!isEventModalVisible()) {
          didDismissSomethingWithOutsideTapJustNow();
          navigationSelectionEpochRef.current += 1;
          setIsNavigationPopupVisible(false);
        }
      }

      if (
        boardStylePickerRef.current &&
        !boardStylePickerRef.current.contains(event.target as Node) &&
        !brushButtonRef.current?.contains(event.target as Node)
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        setIsBoardStylePickerVisible(false);
      }

      if (handleWagerPanelOutsideTap && handleWagerPanelOutsideTap(event)) {
        didDismissSomethingWithOutsideTapJustNow();
      }
    };

    document.addEventListener(defaultEarlyInputEventName, handleClickOutside);
    return () => {
      document.removeEventListener(
        defaultEarlyInputEventName,
        handleClickOutside,
      );
    };
  }, [isEventModalVisible]);

  useEffect(() => {
    let cancelled = false;
    const win: any = typeof window !== "undefined" ? (window as any) : null;
    const schedule = (fn: () => void) => {
      if (!win) {
        const t = setTimeout(() => {
          if (!cancelled) fn();
        }, 200);
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
      }, 200);
      return () => clearTimeout(t);
    };

    const cleanup = schedule(() => {
      preloadPangchiuBoardPreview();
    });

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    if (!isReactionPickerVisible) {
      setPickerMaxHeight(undefined);
      return;
    }
    if (pickerRef.current) {
      const el = pickerRef.current;
      requestAnimationFrame(() => {
        setPickerMaxHeight(el.scrollHeight);
      });
    }
  }, [isReactionPickerVisible]);

  useEffect(() => {
    if (!isReactionPickerVisible) return;
    if (!pickerRef.current) return;
    const el = pickerRef.current;
    requestAnimationFrame(() => {
      setPickerMaxHeight(el.scrollHeight);
    });
  }, [visibleStickerIds, isReactionPickerVisible, isWagerMode, wagerSelection]);

  const updateTimerConfirmPosition = useCallback(() => {
    if (!timerButtonRef.current || !controlsContainerRef.current) return;
    const buttonRect = timerButtonRef.current.getBoundingClientRect();
    const containerRect = controlsContainerRef.current.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2 - containerRect.left;
    const padding = 16;
    const clampedCenter = Math.min(
      containerRect.width - padding,
      Math.max(padding, center),
    );
    setTimerConfirmLeft(clampedCenter);
  }, []);

  const updateClaimVictoryConfirmPosition = useCallback(() => {
    if (!claimVictoryButtonRef.current || !controlsContainerRef.current) return;
    const buttonRect = claimVictoryButtonRef.current.getBoundingClientRect();
    const containerRect = controlsContainerRef.current.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2 - containerRect.left;
    const padding = 16;
    const clampedCenter = Math.min(
      containerRect.width - padding,
      Math.max(padding, center),
    );
    setClaimVictoryConfirmLeft(clampedCenter);
  }, []);

  useEffect(() => {
    if (!isTimerConfirmVisible) return;
    const raf = requestAnimationFrame(updateTimerConfirmPosition);
    window.addEventListener("resize", updateTimerConfirmPosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateTimerConfirmPosition);
    };
  }, [isTimerConfirmVisible, updateTimerConfirmPosition]);

  useEffect(() => {
    if (!isClaimVictoryConfirmVisible) return;
    const raf = requestAnimationFrame(updateClaimVictoryConfirmPosition);
    window.addEventListener("resize", updateClaimVictoryConfirmPosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateClaimVictoryConfirmPosition);
    };
  }, [isClaimVictoryConfirmVisible, updateClaimVictoryConfirmPosition]);

  useEffect(() => {
    if (!isReactionPickerVisible) return;
    let isCancelled = false;
    const ownerKeyAtRequest = currentStickerOwnerKey;
    if (ownerKeyAtRequest === null) {
      clearStickerEntitlement();
      return;
    }
    if (getStoredStickerOwnerKey() !== ownerKeyAtRequest) {
      clearStickerEntitlement();
      return;
    }
    const cached = storage.getReactionExtraStickerCache(null);
    const cachedEntitlement = toUsableStickerEntitlement(
      cached,
      ownerKeyAtRequest,
    );
    if (cachedEntitlement) {
      applyStickerEntitlement(cachedEntitlement);
    } else {
      setStickerEntitlement((current) =>
        current.ownerKey === ownerKeyAtRequest
          ? current
          : EMPTY_STICKER_ENTITLEMENT,
      );
    }
    const fetchReactions = async () => {
      try {
        const snapshot = await fetchNftsForIdentity(authState);
        const { data, expiresAtMs } = snapshot;
        if (
          isCancelled ||
          data.ok !== true ||
          expiresAtMs <= Date.now() ||
          getStoredStickerOwnerKey() !== ownerKeyAtRequest
        ) {
          return;
        }
        const currentCache = storage.getReactionExtraStickerCache(null);
        const currentCacheEntitlement = toUsableStickerEntitlement(
          currentCache,
          ownerKeyAtRequest,
        );
        if (
          currentCacheEntitlement &&
          currentCacheEntitlement.expiresAtMs > expiresAtMs
        ) {
          applyStickerEntitlement(currentCacheEntitlement);
          return;
        }
        const extraIds = getSwagpackReactionStickerIds(data.swagpack_reactions);
        const nextStickerIds = mergeStickerIds(FIXED_STICKER_IDS, extraIds);
        applyStickerEntitlement({
          stickerIds: nextStickerIds,
          ownerKey: ownerKeyAtRequest,
          expiresAtMs,
        });
        const nextCache = {
          profileId,
          ethAddress,
          solAddress,
          extraIds,
          expiresAtMs,
        };
        if (
          !currentCacheEntitlement ||
          currentCacheEntitlement.expiresAtMs !== expiresAtMs ||
          !areStickerIdArraysEqual(
            normalizeStickerIds(currentCache?.extraIds),
            extraIds,
          )
        ) {
          storage.setReactionExtraStickerCache(nextCache);
        }
      } catch {}
    };
    fetchReactions();
    return () => {
      isCancelled = true;
    };
  }, [
    applyStickerEntitlement,
    authState,
    clearStickerEntitlement,
    currentStickerOwnerKey,
    ethAddress,
    isReactionPickerVisible,
    profileId,
    solAddress,
  ]);

  useEffect(() => {
    setStickerEntitlement((current) => {
      if (
        current.ownerKey === null ||
        current.ownerKey === currentStickerOwnerKey
      ) {
        return current;
      }
      return EMPTY_STICKER_ENTITLEMENT;
    });
  }, [currentStickerOwnerKey]);

  useEffect(() => {
    if (!isReactionPickerVisible) {
      setIsWagerMode(false);
      setWagerSelection({ name: null, count: 0 });
    }
  }, [isReactionPickerVisible]);

  useEffect(() => {
    const unsubscribe = subscribeToWagerState((state) => {
      setWagerState(state);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = rocksMiningService.subscribe((snapshot) => {
      const next = { ...snapshot.materials };
      latestServiceMaterialsRef.current = next;
      const available = computeAvailableMaterials(
        next,
        frozenMaterialsRef.current,
      );
      setMaterialAmounts(available);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToFrozenMaterials((materials) => {
      frozenMaterialsRef.current = materials;
      const available = computeAvailableMaterials(
        latestServiceMaterialsRef.current,
        materials,
      );
      setMaterialAmounts(available);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isReactionPickerVisible || !visibleStickerIds.length) return;
    let mounted = true;
    visibleStickerIds.forEach((id) => {
      getStickerImageUrl(id).then((url) => {
        if (!mounted) return;
        setStickerUrls((prev) => {
          if (prev[id] === url) return prev;
          return { ...prev, [id]: url };
        });
      });
    });
    return () => {
      mounted = false;
    };
  }, [isReactionPickerVisible, visibleStickerIds]);

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
    return subscribeToEventModalState((state) => {
      const isVisible = state.isOpen && !!state.eventId;
      const wasVisible = wasEventModalVisibleRef.current;
      if (isVisible && state.eventId) {
        activeEventModalEventIdRef.current = state.eventId;
      }

      if (wasVisible && !isVisible) {
        pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
        const closingEventId = activeEventModalEventIdRef.current;
        activeEventModalEventIdRef.current = null;
        if (
          state.lastCloseReason === "dismiss" &&
          getCurrentRouteState().mode === "event"
        ) {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current =
            Date.now();
        } else {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        }
        if (state.lastCloseReason === "launch_game" && closingEventId) {
          holdEventGameButtonDuringLaunchTransition(closingEventId);
        } else {
          clearEventGameButtonStickyState();
        }
      } else if (isVisible) {
        pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        clearEventGameButtonStickyState();
      } else {
        activeEventModalEventIdRef.current = null;
      }

      wasEventModalVisibleRef.current = isVisible;
      setSelectedEventModalId(isVisible ? state.eventId : null);
    });
  }, [
    clearEventGameButtonStickyState,
    holdEventGameButtonDuringLaunchTransition,
  ]);

  const isNavigationGameBeingRemoved = useCallback(
    (item: NavigationItem) =>
      item.entityType === "game" &&
      item.status === "waiting" &&
      navigationRemovingInviteIds.has(item.inviteId),
    [navigationRemovingInviteIds],
  );

  const topNavigationGames = useMemo(() => {
    const merged = navigationProjectedGames.slice();
    if (
      optimisticPendingAutomatchItem &&
      !merged.some((item) => item.id === optimisticPendingAutomatchItem.id)
    ) {
      merged.push(optimisticPendingAutomatchItem);
    }
    const visibleItems = merged.filter(
      (item) => !isNavigationGameBeingRemoved(item),
    );
    visibleItems.sort(compareNavigationItemsByDisplayOrder);
    return visibleItems;
  }, [
    isNavigationGameBeingRemoved,
    navigationProjectedGames,
    optimisticPendingAutomatchItem,
  ]);

  const topNavigationItemIds = useMemo(() => {
    return new Set(topNavigationGames.map((item) => item.id));
  }, [topNavigationGames]);

  const pagedNavigationGames = useMemo(() => {
    const uniqueById = new Map<string, NavigationItem>();
    navigationPagedGames.forEach((pagedItem) => {
      if (!topNavigationItemIds.has(pagedItem.id)) {
        uniqueById.set(pagedItem.id, pagedItem);
      }
    });
    const visibleItems = Array.from(uniqueById.values()).filter(
      (item) => !isNavigationGameBeingRemoved(item),
    );
    visibleItems.sort(compareNavigationItemsByDisplayOrder);
    return visibleItems;
  }, [
    isNavigationGameBeingRemoved,
    navigationPagedGames,
    topNavigationItemIds,
  ]);

  useEffect(() => {
    topNavigationItemIdsRef.current = topNavigationItemIds;
    navigationHasPagedGamesRef.current = pagedNavigationGames.length > 0;
  }, [topNavigationItemIds, pagedNavigationGames.length]);

  useEffect(() => {
    const scope = navigationCacheScopeRef.current;
    if (!scope) {
      return;
    }
    writeNavigationGamesRuntimeCache(
      scope,
      topNavigationGames,
      pagedNavigationGames,
    );
    writeNavigationGamesPersistedTopCache(
      scope,
      topNavigationGames,
      NAVIGATION_GAMES_PAGE_SIZE,
    );
  }, [topNavigationGames, pagedNavigationGames]);

  useEffect(() => {
    if (!optimisticPendingAutomatchItem) {
      return;
    }
    if (
      navigationProjectedGames.some(
        (item) => item.id === optimisticPendingAutomatchItem.id,
      ) ||
      navigationPagedGames.some(
        (item) => item.id === optimisticPendingAutomatchItem.id,
      )
    ) {
      setOptimisticPendingAutomatchItem(null);
    }
  }, [
    navigationProjectedGames,
    navigationPagedGames,
    optimisticPendingAutomatchItem,
  ]);

  const hydrateNavigationGamesFromCache = useCallback(() => {
    const cacheScope = resolveNavigationGamesCacheScope(
      storage.getProfileId(""),
      storage.getLoginId(""),
    );
    const previousCacheScope = navigationCacheScopeRef.current;
    if (
      previousCacheScope &&
      (!cacheScope || previousCacheScope.scopeKey !== cacheScope.scopeKey)
    ) {
      clearNavigationGamesRuntimeCacheScope(previousCacheScope.scopeKey);
    }
    navigationCacheScopeRef.current = cacheScope;

    const hydratedSnapshot = readNavigationGamesCacheSnapshot(cacheScope);
    setNavigationProjectedGames(hydratedSnapshot.topGames);
    setNavigationPagedGames(hydratedSnapshot.pagedGames);
    const hasHydratedPagedGames = hydratedSnapshot.pagedGames.length > 0;
    navigationHasPagedGamesRef.current = hasHydratedPagedGames;

    const hasProfileScope = cacheScope?.kind === "profile";
    setIsNavigationFallbackScope(!hasProfileScope);

    return {
      cacheScope,
      localProfileId: hasProfileScope && cacheScope ? cacheScope.scopeId : "",
      hasHydratedPagedGames,
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const popupEpoch = navigationPopupEpochRef.current + 1;
    navigationPopupEpochRef.current = popupEpoch;
    const sessionGuard = connection.createSessionGuard();
    const isPopupEpochActive = () =>
      !disposed && navigationPopupEpochRef.current === popupEpoch;
    const stopNavigationInitialLoading = () => {
      setIsNavigationGamesLoading(false);
    };
    const stopNavigationLoadMore = () => {
      navigationLoadMoreInFlightRef.current = false;
      setIsNavigationGamesLoadingMore(false);
    };
    const stopAllNavigationLoading = () => {
      stopNavigationInitialLoading();
      stopNavigationLoadMore();
    };

    const loadFallbackGames = (maxItems: number) => {
      setIsNavigationFallbackScope(true);
      setNavigationGamesCursor(null);
      stopNavigationLoadMore();
      const requestedLimit = maxItems + 1;
      void connection
        .getCurrentLoginFallbackGames(requestedLimit)
        .then((items) => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            stopAllNavigationLoading();
            return;
          }
          const hasMore = items.length > maxItems;
          const visibleItems = hasMore ? items.slice(0, maxItems) : items;
          setNavigationProjectedGames(visibleItems);
          if (!hasMore) {
            setNavigationPagedGames([]);
            navigationHasPagedGamesRef.current = false;
          }
          setNavigationHasMoreGames(hasMore);
          stopNavigationInitialLoading();
        })
        .catch(() => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            stopAllNavigationLoading();
            return;
          }
          setNavigationProjectedGames([]);
          setNavigationHasMoreGames(false);
          stopNavigationInitialLoading();
        });
    };

    if (!isNavigationPopupVisible) {
      setIsNavigationGamesLoading(false);
      navigationLoadMoreInFlightRef.current = false;
      setIsNavigationGamesLoadingMore(false);
      setIsNavigationFallbackScope(false);
      setNavigationRemovingInviteIds(new Set());
      setNavigationHasMoreGames(false);
      setNavigationGamesCursor(null);
      setNavigationFallbackLimit(NAVIGATION_GAMES_PAGE_SIZE);
      return () => {
        disposed = true;
        navigationPopupEpochRef.current += 1;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    }

    const { localProfileId, hasHydratedPagedGames } =
      hydrateNavigationGamesFromCache();
    let didAttemptWarmPagedRefresh = false;

    const maybeWarmRefreshPagedGames = (cursor: NavigationGamesPageCursor) => {
      if (didAttemptWarmPagedRefresh || !hasHydratedPagedGames || !cursor) {
        return;
      }
      if (navigationLoadMoreInFlightRef.current) {
        return;
      }
      didAttemptWarmPagedRefresh = true;
      navigationLoadMoreInFlightRef.current = true;

      void connection
        .getProfileGamesFirestorePage(
          NAVIGATION_GAMES_LOAD_MORE_PAGE_SIZE,
          cursor,
        )
        .then((page) => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            return;
          }

          setNavigationPagedGames((previousItems) => {
            const uniqueById = new Map<string, NavigationItem>();

            page.items.forEach((item) => {
              if (!topNavigationItemIdsRef.current.has(item.id)) {
                uniqueById.set(item.id, item);
              }
            });

            if (page.hasMore) {
              previousItems.forEach((item) => {
                if (
                  !topNavigationItemIdsRef.current.has(item.id) &&
                  !uniqueById.has(item.id)
                ) {
                  uniqueById.set(item.id, item);
                }
              });
            }

            const mergedItems = Array.from(uniqueById.values());
            navigationHasPagedGamesRef.current = mergedItems.some(
              (item) => !topNavigationItemIdsRef.current.has(item.id),
            );
            return mergedItems;
          });

          setNavigationGamesCursor(page.nextCursor);
          setNavigationHasMoreGames(page.hasMore);
        })
        .catch(() => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            return;
          }
        })
        .finally(() => {
          navigationLoadMoreInFlightRef.current = false;
        });
    };

    setIsNavigationGamesLoading(true);
    setIsNavigationGamesLoadingMore(false);

    if (localProfileId !== "") {
      setIsNavigationFallbackScope(false);
      setNavigationFallbackLimit(NAVIGATION_GAMES_PAGE_SIZE);
      unsubscribe = connection.subscribeProfileGamesFirestore(
        NAVIGATION_GAMES_PAGE_SIZE,
        (items) => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            stopNavigationInitialLoading();
            return;
          }
          setNavigationProjectedGames(items);
          stopNavigationInitialLoading();
        },
        () => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            stopAllNavigationLoading();
            return;
          }
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
          setNavigationFallbackLimit(NAVIGATION_GAMES_PAGE_SIZE);
          loadFallbackGames(NAVIGATION_GAMES_PAGE_SIZE);
        },
        (pageMeta) => {
          if (!isPopupEpochActive()) {
            return;
          }
          if (!sessionGuard()) {
            stopNavigationInitialLoading();
            return;
          }
          if (!navigationHasPagedGamesRef.current) {
            setNavigationGamesCursor(pageMeta.nextCursor);
            setNavigationHasMoreGames(pageMeta.hasMore);
          } else if (!pageMeta.hasMore) {
            setNavigationPagedGames([]);
            navigationHasPagedGamesRef.current = false;
            setNavigationGamesCursor(pageMeta.nextCursor);
            setNavigationHasMoreGames(false);
          } else {
            setNavigationGamesCursor(
              (previousCursor) => previousCursor ?? pageMeta.nextCursor,
            );
            setNavigationHasMoreGames(true);
          }

          if (pageMeta.hasMore && pageMeta.nextCursor) {
            maybeWarmRefreshPagedGames(pageMeta.nextCursor);
          }
        },
      );
    } else {
      setNavigationFallbackLimit(NAVIGATION_GAMES_PAGE_SIZE);
      loadFallbackGames(NAVIGATION_GAMES_PAGE_SIZE);
    }

    return () => {
      disposed = true;
      navigationPopupEpochRef.current += 1;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  }, [hydrateNavigationGamesFromCache, isNavigationPopupVisible]);

  useEffect(() => {
    return () => {
      if (eventGameButtonStickyTimeoutRef.current !== null) {
        window.clearTimeout(eventGameButtonStickyTimeoutRef.current);
        eventGameButtonStickyTimeoutRef.current = null;
      }
      clearAllMatchScopedTimeouts();
      hourglassEnableTimeoutRef.current = null;
      hourglassEnableDeadlineRef.current = null;
      cancelAutomatchRevealTimeoutRef.current = null;
      cancelAutomatchRevealDeadlineRef.current = null;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
    };
  }, [clearAllMatchScopedTimeouts]);

  useEffect(() => {
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    cancelAutomatchRevealDeadlineRef.current = null;
    if (automatchButtonTmpState && isAutomatchButtonVisible) {
      setIsCancelAutomatchDisabled(false);
      if (forceImmediateCancelAutomatchRevealRef.current) {
        forceImmediateCancelAutomatchRevealRef.current = false;
        pendingCancelAutomatchRevealAtMsRef.current = null;
        setIsCancelAutomatchVisible(true);
      } else {
        const now = Date.now();
        const pendingRevealAtMs = pendingCancelAutomatchRevealAtMsRef.current;
        pendingCancelAutomatchRevealAtMsRef.current = null;
        const deadline =
          pendingRevealAtMs !== null
            ? pendingRevealAtMs
            : now + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
        if (deadline <= now) {
          setIsCancelAutomatchVisible(true);
        } else {
          setIsCancelAutomatchVisible(false);
          cancelAutomatchRevealDeadlineRef.current = deadline;
          cancelAutomatchRevealTimeoutRef.current = setMatchScopedTimeout(
            () => {
              cancelAutomatchRevealTimeoutRef.current = null;
              cancelAutomatchRevealDeadlineRef.current = null;
              setIsCancelAutomatchVisible(true);
            },
            deadline - now,
          );
          tryRevealCancelAutomatchFromDeadline();
        }
      }
    } else {
      forceImmediateCancelAutomatchRevealRef.current = false;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      setIsCancelAutomatchVisible(false);
      setIsCancelAutomatchDisabled(false);
    }
    return () => {
      if (cancelAutomatchRevealTimeoutRef.current !== null) {
        clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
        cancelAutomatchRevealTimeoutRef.current = null;
      }
      cancelAutomatchRevealDeadlineRef.current = null;
    };
  }, [
    automatchButtonTmpState,
    cancelAutomatchRevealVersion,
    clearTrackedMatchScopedTimeout,
    isAutomatchButtonVisible,
    setMatchScopedTimeout,
    tryRevealCancelAutomatchFromDeadline,
  ]);

  useEffect(() => {
    return subscribeMoveHistoryPopupReload(() => {
      setHistoryUiVersion((value) => value + 1);
    });
  }, []);

  const rematchSeriesItems: RematchSeriesNavigatorItem[] = (() => {
    void historyUiVersion;
    try {
      return getRematchSeriesNavigatorItems();
    } catch {
      return [];
    }
  })();

  const hasRematchSeriesNavigation = rematchSeriesItems.length > 0;
  const rematchSeriesMatchesKey = rematchSeriesItems
    .map((item) => item.matchId)
    .join("|");

  useEffect(() => {
    if (rematchSeriesMatchesKey === "") {
      return;
    }
    let isDisposed = false;
    let retryTimeoutId: number | null = null;
    let retryCount = 0;

    const hasMissingHistoricalScores = (items: RematchSeriesNavigatorItem[]) =>
      items.some(
        (item) =>
          !item.isActiveMatch &&
          !item.isPendingResponse &&
          (item.whiteScore === null || item.blackScore === null),
      );

    const runPreload = async () => {
      let didChange = false;
      try {
        didChange = await preloadRematchSeriesScores();
      } catch {
        didChange = false;
      }
      if (isDisposed) {
        return;
      }
      if (didChange) {
        setHistoryUiVersion((value) => value + 1);
      }
      let latestItems: RematchSeriesNavigatorItem[] = [];
      try {
        latestItems = getRematchSeriesNavigatorItems();
      } catch {
        latestItems = [];
      }
      if (!hasMissingHistoricalScores(latestItems)) {
        return;
      }
      if (retryCount >= 8) {
        return;
      }
      retryCount += 1;
      retryTimeoutId = setMatchScopedTimeout(() => {
        void runPreload();
      }, 650);
    };

    void runPreload();

    return () => {
      isDisposed = true;
      if (retryTimeoutId !== null) {
        clearTrackedMatchScopedTimeout(retryTimeoutId);
      }
    };
  }, [
    clearTrackedMatchScopedTimeout,
    rematchSeriesMatchesKey,
    setMatchScopedTimeout,
  ]);

  const closeNavigationAndAppearancePopupIfAnyHandler = useCallback(
    (options?: CloseNavigationAndAppearancePopupOptions) => {
      if (!options?.preserveNavigationSelection) {
        navigationSelectionEpochRef.current += 1;
      }
      const shouldSuppressNavigationAutoClose =
        options?.preserveNavigationSelection === true &&
        shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal();
      if (!shouldSuppressNavigationAutoClose) {
        setIsNavigationPopupVisible(false);
      }
      setIsBoardStylePickerVisible(false);
      setIsMoveHistoryPopupVisible(false);
      setIsReactionPickerVisible(false);
      setIsResignConfirmVisible(false);
      setIsTimerConfirmVisible(false);
      setIsClaimVictoryConfirmVisible(false);
      setIsWagerMode(false);
    },
    [shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal],
  );

  closeNavigationAndAppearancePopupIfAnyImpl =
    closeNavigationAndAppearancePopupIfAnyHandler;

  useEffect(() => {
    return registerBottomControlsTransientUiHandler(
      closeNavigationAndAppearancePopupIfAnyHandler,
      clearAllMatchScopedTimeouts,
    );
  }, [
    clearAllMatchScopedTimeouts,
    closeNavigationAndAppearancePopupIfAnyHandler,
  ]);

  useEffect(() => {
    return () => {
      closeNavigationAndAppearancePopupIfAnyImpl = () => {};
      setNavigationListButtonVisibleImpl = () => {};
      getIsNavigationPopupOpen = () => false;
      hasBottomPopupsVisible = () => false;
      showVoiceReactionButton = () => {};
      showMoveHistoryButton = () => {};
      showResignButton = () => {};
      setInviteLinkActionVisible = () => {};
      setAutomatchEnabled = () => {};
      setAutomatchVisible = () => {};
      setBotGameOptionVisible = () => {};
      setPlaySamePuzzleAgainButtonVisible = () => {};
      setAutomatchWaitingState = () => {};
      setBrushAndNavigationButtonDimmed = () => {};
      setBadgeVisible = () => {};
      showWaitingStateText = () => {};
      setHomeVisible = () => {};
      setEndMatchVisible = () => {};
      setEndMatchConfirmed = () => {};
      setUndoVisible = () => {};
      setAutomoveActionEnabled = () => {};
      setAutomoveActionVisible = () => {};
      setWatchOnlyVisible = () => {};
      setUndoEnabled = () => {};
      disableAndHideUndoResignAndTimerControls = () => {};
      setIsReadyToCopyExistingInviteLink = () => {};
      hideTimerButtons = () => {};
      showTimerButtonProgressing = () => {};
      toggleReactionPicker = () => {};
      enableTimerVictoryClaim = () => {};
      showPrimaryAction = () => {};
      isWagerPanelVisible = () => false;
      handleWagerPanelOutsideTap = null;
    };
  }, []);

  const beginInviteFlow = (options?: { skipSoundInit?: boolean }) => {
    if (!options?.skipSoundInit) {
      soundPlayer.initializeOnUserInteraction(false);
    }
    if (!didCreateInvite) {
      didClickInviteActionButtonBeforeThereIsInviteReady();
    }
    setIsInviteLoading(true);
    connection.didClickInviteButton((result: boolean) => {
      if (result) {
        const sessionGuard = connection.createSessionGuard();
        if (didCreateInvite) {
          setInviteCopiedTmpState(true);
          setMatchScopedTimeout(() => {
            if (!sessionGuard()) {
              return;
            }
            setInviteCopiedTmpState(false);
          }, 699);
        }
        setIsInviteLoading(false);
        setDidCreateInvite(true);
      } else {
        setIsInviteLoading(false);
      }
    });
  };

  const handleInviteClick = () => {
    beginInviteFlow();
  };
  beginInviteFlowRef.current = beginInviteFlow;

  getIsNavigationPopupOpen = () => isNavigationPopupVisible;

  setNavigationListButtonVisibleImpl = (visible: boolean) => {
    setIsNavigationListButtonVisible(visible);
    if (
      !visible &&
      !shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal()
    ) {
      setIsNavigationPopupVisible(false);
    }
  };

  setBadgeVisible = (visible: boolean) => {
    setIsBadgeVisible(HOME_NAVIGATION_BADGE_ENABLED && visible);
  };

  setBrushAndNavigationButtonDimmed = (dimmed: boolean) => {
    setIsNavigationButtonDimmed(dimmed);
    setIsBrushButtonDimmed(dimmed);
  };

  showVoiceReactionButton = (show: boolean) => {
    setIsVoiceReactionButtonVisible(show);
    if (!show) {
      setIsReactionPickerVisible(false);
    }
  };

  showMoveHistoryButton = (show: boolean) => {
    setIsMoveHistoryButtonVisible(show);
  };

  showResignButton = () => {
    setIsResignButtonVisible(true);
  };

  showWaitingStateText = (text: string) => {
    setWaitingStateText(text);
  };

  setIsReadyToCopyExistingInviteLink = () => {
    setDidCreateInvite(true);
  };

  hideTimerButtons = () => {
    if (hourglassEnableTimeoutRef.current) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;
    setIsTimerButtonDisabled(true);
    setIsStartTimerVisible(false);
    setIsClaimVictoryVisible(false);
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
  };

  showTimerButtonProgressing = (
    currentProgress: number,
    target: number,
    enableWhenTargetReached: boolean,
  ) => {
    if (hourglassEnableTimeoutRef.current) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;

    setIsTimerButtonDisabled(true);
    setIsStartTimerVisible(true);
    setIsAutomoveButtonVisible(false);
    setIsUndoButtonVisible(false);
    setIsClaimVictoryVisible(false);
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
    setTimerConfig({
      duration: target,
      progress: currentProgress,
      requestDate: Date.now(),
    });

    if (enableWhenTargetReached) {
      const timeUntilTarget = Math.max(0, (target - currentProgress) * 1000);
      if (timeUntilTarget <= 0) {
        setIsTimerButtonDisabled(false);
        return;
      }
      hourglassEnableDeadlineRef.current = Date.now() + timeUntilTarget;
      hourglassEnableTimeoutRef.current = setMatchScopedTimeout(() => {
        setIsTimerButtonDisabled(false);
        hourglassEnableTimeoutRef.current = null;
        hourglassEnableDeadlineRef.current = null;
      }, timeUntilTarget);
      tryEnableTimerButtonFromDeadline();
    }
  };

  hasBottomPopupsVisible = () => {
    return (
      isReactionPickerVisible ||
      isMoveHistoryPopupVisible ||
      isResignConfirmVisible ||
      isTimerConfirmVisible ||
      isClaimVictoryConfirmVisible ||
      isBoardStylePickerVisible ||
      isWagerPanelVisible()
    );
  };

  enableTimerVictoryClaim = () => {
    setIsClaimVictoryVisible(true);
    setIsUndoButtonVisible(false);
    setIsAutomoveButtonVisible(false);
    setIsStartTimerVisible(false);
    setIsClaimVictoryButtonDisabled(false);
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
  };

  setPlaySamePuzzleAgainButtonVisible = (visible: boolean) => {
    setIsSamePuzzleAgainVisible(visible);
  };

  setEndMatchVisible = (visible: boolean) => {
    setIsEndMatchButtonVisible(visible);
  };

  setEndMatchConfirmed = (confirmed: boolean) => {
    setIsEndMatchConfirmed(confirmed);
  };

  setBotGameOptionVisible = (visible: boolean) => {
    setIsBotGameButtonVisible(visible);
  };

  setInviteLinkActionVisible = (visible: boolean) => {
    setIsInviteLinkButtonVisible(visible);
    if (!visible) {
      setIsInviteLoading(false);
      setDidCreateInvite(false);
      setInviteCopiedTmpState(false);
    }
  };

  setAutomatchWaitingState = (waiting: boolean) => {
    if (waiting) {
      let revealMode = automatchCancelRevealModeRef.current;
      let revealDeadline = automatchCancelRevealModeDeadlineRef.current;

      if (revealMode === "unset") {
        const shouldRevealImmediatelyFromNavigation =
          consumePendingImmediateCancelAutomatchIntent();
        const delayedRevealAtMs = consumePendingDelayedCancelAutomatchIntent();
        const now = Date.now();
        const shouldDelayReveal =
          !shouldRevealImmediatelyFromNavigation &&
          delayedRevealAtMs !== null &&
          delayedRevealAtMs > now;
        revealMode = shouldDelayReveal ? "delayed" : "immediate";
        revealDeadline = shouldDelayReveal ? delayedRevealAtMs : null;
        automatchCancelRevealModeRef.current = revealMode;
        automatchCancelRevealModeDeadlineRef.current = revealDeadline;
      }

      if (
        revealMode === "delayed" &&
        (revealDeadline === null || revealDeadline <= Date.now())
      ) {
        revealMode = "immediate";
        revealDeadline = null;
        automatchCancelRevealModeRef.current = revealMode;
        automatchCancelRevealModeDeadlineRef.current = null;
      }

      const shouldDelayReveal =
        revealMode === "delayed" && revealDeadline !== null;
      forceImmediateCancelAutomatchRevealRef.current = !shouldDelayReveal;
      pendingCancelAutomatchRevealAtMsRef.current = shouldDelayReveal
        ? revealDeadline
        : null;
      setAutomatchVisible(true);
      setIsAutomatchButtonEnabled(false);
      setAutomatchButtonTmpState(true);
      setCancelAutomatchRevealVersion((value) => value + 1);
      return;
    }
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    clearPendingImmediateCancelAutomatchIntent();
    clearPendingDelayedCancelAutomatchIntent();
    pendingFreshAutomatchCancelRevealAtMs = 0;
    cancelAutomatchRevealDeadlineRef.current = null;
    pendingCancelAutomatchRevealAtMsRef.current = null;
    forceImmediateCancelAutomatchRevealRef.current = false;
    automatchCancelRevealModeRef.current = "unset";
    automatchCancelRevealModeDeadlineRef.current = null;
    setAutomatchButtonTmpState(false);
    setIsCancelAutomatchVisible(false);
    setIsCancelAutomatchDisabled(false);
  };

  setAutomatchEnabled = (enabled: boolean) => {
    setAutomatchButtonTmpState(false);
    setIsAutomatchButtonEnabled(enabled);
  };

  setAutomatchVisible = (visible: boolean) => {
    setIsAutomatchButtonVisible(visible);
  };

  setHomeVisible = (visible: boolean) => {
    setIsDeepHomeButtonVisible(visible);
  };

  setAutomoveActionEnabled = (enabled: boolean) => {
    setIsAutomoveButtonEnabled(enabled);
  };

  setAutomoveActionVisible = (visible: boolean) => {
    setIsAutomoveButtonVisible(visible);
  };

  setUndoVisible = (visible: boolean) => {
    setIsUndoButtonVisible(visible);
  };

  setWatchOnlyVisible = (visible: boolean) => {
    setIsWatchOnlyIndicatorVisible(visible);
  };

  setUndoEnabled = (enabled: boolean) => {
    setIsUndoDisabled(!enabled);
  };

  showPrimaryAction = (action: PrimaryActionType) => {
    setPrimaryAction(action);
  };

  disableAndHideUndoResignAndTimerControls = () => {
    setIsUndoDisabled(true);
    setIsUndoButtonVisible(false);
    setIsAutomoveButtonVisible(false);
    setIsResignButtonVisible(false);
    setIsStartTimerVisible(false);
    setIsClaimVictoryVisible(false);
    setIsResignConfirmVisible(false);
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
  };

  toggleReactionPicker = () => {
    if (!isReactionPickerVisible) {
      if (isVoiceReactionDisabled) {
        return;
      }
      closeMenuAndInfoIfAny();
      setIsResignConfirmVisible(false);
      setIsTimerConfirmVisible(false);
      setIsClaimVictoryConfirmVisible(false);
      setIsMoveHistoryPopupVisible(false);
    }
    setIsReactionPickerVisible((prev) => !prev);
  };

  const toggleMoveHistoryPopup = () => {
    if (!isMoveHistoryPopupVisible) {
      closeMenuAndInfoIfAny();
      setIsResignConfirmVisible(false);
      setIsTimerConfirmVisible(false);
      setIsClaimVictoryConfirmVisible(false);
      setIsReactionPickerVisible(false);
      navigationSelectionEpochRef.current += 1;
      setIsNavigationPopupVisible(false);
    }
    setIsMoveHistoryPopupVisible((prev) => !prev);
  };

  const handleRematchSeriesChipClick = useCallback(async (matchId: string) => {
    if (rematchSeriesSelectionLockRef.current) {
      return;
    }
    rematchSeriesSelectionLockRef.current = true;
    setIsRematchSeriesSelectionInFlight(true);
    try {
      const didSwitch = await didSelectRematchSeriesMatch(matchId);
      if (didSwitch) {
        triggerMoveHistoryPopupSelectionReset();
      }
    } finally {
      rematchSeriesSelectionLockRef.current = false;
      setIsRematchSeriesSelectionInFlight(false);
    }
  }, []);

  const renderRematchSeriesChipContent = useCallback(
    (item: RematchSeriesNavigatorItem) => {
      if (item.isPendingResponse) {
        return (
          <RematchWaitingIcon $isSelected={item.isSelected}>
            <FaHourglassHalf />
          </RematchWaitingIcon>
        );
      }
      if (item.whiteScore !== null && item.blackScore !== null) {
        const opponentScore = item.playerIsWhite
          ? item.blackScore
          : item.whiteScore;
        const playerScore = item.playerIsWhite
          ? item.whiteScore
          : item.blackScore;
        return (
          <>
            <RematchScoreOpponent $isSelected={item.isSelected}>
              {opponentScore}
            </RematchScoreOpponent>
            <RematchScorePlayer $isSelected={item.isSelected}>
              {playerScore}
            </RematchScorePlayer>
          </>
        );
      }
      return (
        <RematchLoadingDots $isSelected={item.isSelected}>·</RematchLoadingDots>
      );
    },
    [],
  );

  const handleBrushClick = () => {
    if (!isBoardStylePickerVisible) {
      closeMenuAndInfoIfAny();
      setIsResignConfirmVisible(false);
      setIsTimerConfirmVisible(false);
      setIsClaimVictoryConfirmVisible(false);
      setIsReactionPickerVisible(false);
      navigationSelectionEpochRef.current += 1;
      setIsNavigationPopupVisible(false);
    }
    setIsBoardStylePickerVisible(!isBoardStylePickerVisible);
  };

  const handleResignClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isResignConfirmVisible) {
      closeMenuAndInfoIfAny();
    }
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
    setIsResignConfirmVisible(!isResignConfirmVisible);
  };

  const handleTimerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isTimerConfirmVisible) {
      closeMenuAndInfoIfAny();
      updateTimerConfirmPosition();
    }
    setIsResignConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(false);
    setIsTimerConfirmVisible(!isTimerConfirmVisible);
  };

  const handleHomeClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    navigationSelectionEpochRef.current += 1;
    didClickHomeButton();
  };

  const handleAutomoveClick = () => {
    if (!isAutomoveButtonEnabled) return;
    setAutomoveActionEnabled(false);
    didClickAutomoveButton();
  };

  const handleClaimVictoryClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!isClaimVictoryConfirmVisible) {
      closeMenuAndInfoIfAny();
      updateClaimVictoryConfirmPosition();
    }
    setIsResignConfirmVisible(false);
    setIsTimerConfirmVisible(false);
    setIsClaimVictoryConfirmVisible(!isClaimVictoryConfirmVisible);
  };

  const handleConfirmStartTimer = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    setIsTimerConfirmVisible(false);
    didClickStartTimerButton();
    setIsTimerButtonDisabled(true);
  };

  const handleConfirmClaimVictory = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    setIsClaimVictoryConfirmVisible(false);
    didClickClaimVictoryByTimerButton();
    setIsClaimVictoryButtonDisabled(true);
  };

  const handleEndMatchClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    didClickEndMatchButton();
  };

  const handleStickerSelect = useCallback(
    (stickerId: number) => {
      if (!isVoiceReactionButtonVisible) {
        setIsReactionPickerVisible(false);
        return;
      }
      const isFixedSticker = FIXED_STICKER_IDS.includes(stickerId);
      if (
        !isFixedSticker &&
        (currentStickerOwnerKey === null ||
          stickerEntitlement.ownerKey !== currentStickerOwnerKey ||
          stickerEntitlement.expiresAtMs <= Date.now() ||
          getStoredStickerOwnerKey() !== currentStickerOwnerKey ||
          !stickerEntitlement.stickerIds.includes(stickerId))
      ) {
        setIsReactionPickerVisible(false);
        return;
      }
      setIsReactionPickerVisible(false);
      showVideoReaction(
        isMetadataSideDisplayedAtOpponentSlot(false),
        stickerId,
      );
      playSounds([Sound.EmoteSent]);
      if (isGameWithBot) {
        const sessionGuard = connection.createSessionGuard();
        const responseStickerId =
          STICKER_ID_WHITELIST[
            Math.floor(Math.random() * STICKER_ID_WHITELIST.length)
          ];
        setMatchScopedTimeout(() => {
          if (!sessionGuard()) {
            return;
          }
          showVideoReaction(
            isMetadataSideDisplayedAtOpponentSlot(true),
            responseStickerId,
          );
          playSounds([Sound.EmoteReceived]);
        }, 5000);
      } else if (!puzzleMode) {
        connection.sendVoiceReaction(newStickerReaction(stickerId));
        setIsVoiceReactionDisabled(true);
        setMatchScopedTimeout(() => {
          setIsVoiceReactionDisabled(false);
        }, 9999);
      }
    },
    [
      currentStickerOwnerKey,
      isVoiceReactionButtonVisible,
      setMatchScopedTimeout,
      stickerEntitlement.expiresAtMs,
      stickerEntitlement.ownerKey,
      stickerEntitlement.stickerIds,
    ],
  );

  const handleReactionSelect = useCallback(
    (reaction: string) => {
      if (!isVoiceReactionButtonVisible) {
        setIsReactionPickerVisible(false);
        return;
      }
      setIsReactionPickerVisible(false);
      const reactionObj = newReactionOfKind(reaction);
      playReaction(reactionObj);
      showVoiceReactionText(reaction, false);

      if (isGameWithBot) {
        const sessionGuard = connection.createSessionGuard();
        const responseReaction = reaction;
        const responseReactionObj = newReactionOfKind(responseReaction);
        setMatchScopedTimeout(() => {
          if (!sessionGuard()) {
            return;
          }
          playReaction(responseReactionObj);
          showVoiceReactionText(reaction, true);
        }, 2000);
      } else if (!puzzleMode) {
        connection.sendVoiceReaction(reactionObj);
        setIsVoiceReactionDisabled(true);
        setMatchScopedTimeout(() => {
          setIsVoiceReactionDisabled(false);
        }, 9999);
      }
    },
    [isVoiceReactionButtonVisible, setMatchScopedTimeout],
  );

  const playerUid = playerSideMetadata.uid;
  const opponentUid = opponentSideMetadata.uid;
  const opponentProfile = opponentUid
    ? getStashedPlayerProfile(opponentUid)
    : undefined;
  const playerHasProfile = isAuthenticated && profileId !== "";
  const opponentHasProfile = !!(opponentProfile && opponentProfile.id);
  const hasAgreedWager = !!wagerState?.agreed;
  const hasResolvedWager = !!wagerState?.resolved;
  const playerHasProposed =
    !!(
      playerUid &&
      wagerState?.proposedBy &&
      wagerState.proposedBy[playerUid]
    ) ||
    !!(playerUid && wagerState?.proposals && wagerState.proposals[playerUid]);
  const hasPlayers = !!playerUid && !!opponentUid;
  const isEligibleForWager =
    isOnlineGame &&
    !isWatchOnly &&
    !isGameWithBot &&
    getBoardViewMode() === "activeLive" &&
    !isMatchOver() &&
    playerHasProfile &&
    opponentHasProfile &&
    hasPlayers;
  const isWatchOnlyMatchFinished =
    isWatchOnly && isMatchOver() && !!connection.rematchSeriesEndIsIndicated();
  const isEndMatchPillVisible =
    (isEndMatchButtonVisible && !isEndMatchTemporarilyDisabled) ||
    isWatchOnlyMatchFinished;
  const isEndMatchPillFinished =
    isEndMatchConfirmed || isWatchOnlyMatchFinished;
  const isCancelAutomatchInFlight =
    isCancelAutomatchVisible && isCancelAutomatchDisabled;
  const isAutomatchPillVisible =
    isAutomatchButtonVisible && !isCancelAutomatchInFlight;
  const canSubmitWager =
    isEligibleForWager &&
    !hasAgreedWager &&
    !hasResolvedWager &&
    !playerHasProposed;
  const wagerMaterial = wagerSelection.name;
  const wagerCount = wagerSelection.count;
  const wagerReady = canSubmitWager && !!wagerMaterial && wagerCount > 0;

  const handleWagerModeToggle = useCallback(() => {
    setIsWagerMode(true);
  }, []);

  const handleMaterialSelect = useCallback(
    (name: MaterialName) => {
      const total = materialAmounts[name] ?? 0;
      if (total <= 0) return;
      setWagerSelection((prev) => {
        if (prev.name === name) {
          const nextCount = Math.min(total, prev.count + 1);
          if (nextCount === prev.count) return prev;
          return { name, count: nextCount };
        }
        return { name, count: 1 };
      });
    },
    [materialAmounts],
  );

  const handleWagerSubmit = useCallback(() => {
    if (!wagerMaterial || wagerCount === 0 || !canSubmitWager) {
      return;
    }
    setIsReactionPickerVisible(false);
    const material = wagerMaterial;
    const count = wagerCount;
    connection.sendWagerProposal(material, count).catch(() => {});
  }, [canSubmitWager, wagerCount, wagerMaterial]);

  const handleUndo = (
    event:
      React.MouseEvent<HTMLButtonElement> | React.TouchEvent<HTMLButtonElement>,
  ) => {
    if ((event.target as HTMLButtonElement).disabled) return;
    didClickUndoButton();
    setIsUndoDisabled(!canHandleUndo());
  };

  const handleConfirmResign = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsResignConfirmVisible(false);
    didClickConfirmResignButton();
  };

  const handleSamePuzzleAgainClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    playSameCompletedPuzzleAgain();
  };

  const handlePrimaryActionClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    soundPlayer.initializeOnUserInteraction(false);
    if (primaryAction === PrimaryActionType.Rematch) {
      if (endMatchGracePeriodTimeoutRef.current !== null) {
        clearTimeout(endMatchGracePeriodTimeoutRef.current);
      }
      setIsEndMatchTemporarilyDisabled(true);
      endMatchGracePeriodTimeoutRef.current = window.setTimeout(() => {
        endMatchGracePeriodTimeoutRef.current = null;
        setIsEndMatchTemporarilyDisabled(false);
      }, 3000);
    }
    didClickPrimaryActionButton(primaryAction);
    setPrimaryAction(PrimaryActionType.None);
  };

  const handleBotGameClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    soundPlayer.initializeOnUserInteraction(false);
    didClickStartBotGameButton();
  };

  const beginAutomatchFlow = useCallback(
    (options?: { skipSoundInit?: boolean }) => {
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs =
        Date.now() + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
      pendingCancelAutomatchRevealAtMsRef.current =
        pendingFreshAutomatchCancelRevealAtMs;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      if (!options?.skipSoundInit) {
        soundPlayer.initializeOnUserInteraction(false);
      }
      didClickAutomatchButton((response) => {
        const inviteId =
          response && typeof response.inviteId === "string"
            ? response.inviteId
            : "";
        const mode =
          response && typeof response.mode === "string" ? response.mode : "";
        if (mode === "pending" && inviteId) {
          requestPendingDelayedCancelAutomatchIntent(
            inviteId,
            pendingFreshAutomatchCancelRevealAtMs,
          );
          setOptimisticPendingAutomatchItem(
            connection.createOptimisticPendingAutomatchItem(inviteId),
          );
        } else if (mode === "matched") {
          clearPendingDelayedCancelAutomatchIntent();
          setOptimisticPendingAutomatchItem(null);
        } else {
          clearPendingDelayedCancelAutomatchIntent();
        }
        pendingFreshAutomatchCancelRevealAtMs = 0;
      });
      setIsAutomatchButtonEnabled(false);
      setAutomatchButtonTmpState(true);
      setIsCancelAutomatchDisabled(false);
      setCancelAutomatchRevealVersion((value) => value + 1);
    },
    [],
  );

  const handleAutomatchClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    beginAutomatchFlow();
  };

  const handleCancelAutomatchClick = async (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (isCancelAutomatchDisabled) return;
    const sessionGuard = connection.createSessionGuard();
    setIsCancelAutomatchDisabled(true);
    try {
      const result = await connection.cancelAutomatch();
      if (!sessionGuard()) {
        return;
      }
      if (result && result.ok) {
        setOptimisticPendingAutomatchItem(null);
        dismissPendingAutomatchTransition();
        await transitionToHome({ forceMatchScopeReset: true });
      } else {
        setIsCancelAutomatchDisabled(false);
      }
    } catch (_) {
      if (!sessionGuard()) {
        return;
      }
      setIsCancelAutomatchDisabled(false);
    }
  };

  const getPrimaryActionButtonText = () => {
    switch (primaryAction) {
      case PrimaryActionType.JoinGame:
        return "Join Game";
      case PrimaryActionType.Rematch:
        return puzzleMode ? "Next Lesson" : "Play Again";
      default:
        return "";
    }
  };

  const handleNavigationButtonClick = () => {
    if (!isNavigationPopupVisible) {
      closeMenuAndInfoIfAny();
      hydrateNavigationGamesFromCache();
    } else {
      navigationSelectionEpochRef.current += 1;
    }
    setIsNavigationPopupVisible(!isNavigationPopupVisible);
  };

  const handleNavigationGameSelect = (
    item: NavigationItem,
    options?: { status?: NavigationGameStatus },
  ) => {
    navigationSelectionEpochRef.current += 1;
    setIsBoardStylePickerVisible(false);
    if (item.entityType === "event") {
      const requestSeq =
        pendingNavigationOpenedEventModalRequestSeqRef.current + 1;
      pendingNavigationOpenedEventModalRequestSeqRef.current = requestSeq;
      pendingNavigationOpenedEventModalRequestedAtMsRef.current = Date.now();
      openEventModal(item.eventId, { restoreHomeOnClose: false });
      if (
        pendingNavigationOpenedEventModalRequestSeqRef.current === requestSeq
      ) {
        pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
      }
      return;
    }
    pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
    pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
    setIsNavigationPopupVisible(false);
    const inviteId = item.inviteId;
    if (options?.status === "pending") {
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
      requestPendingImmediateCancelAutomatchIntent(inviteId);
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = true;
      automatchCancelRevealModeRef.current = "immediate";
      automatchCancelRevealModeDeadlineRef.current = null;
      setIsAutomatchButtonVisible(true);
      setAutomatchButtonTmpState(true);
      setIsAutomatchButtonEnabled(false);
      setIsCancelAutomatchVisible(true);
      setIsCancelAutomatchDisabled(false);
      setCancelAutomatchRevealVersion((value) => value + 1);
    } else {
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
    }
    connection.connectToInvite(inviteId);
  };

  const handleNavigationGameRemove = useCallback(
    (inviteId: string) => {
      if (isNavigationFallbackScope || !inviteId) {
        return;
      }
      if (navigationRemovingInviteIds.has(inviteId)) {
        return;
      }

      const sessionGuard = connection.createSessionGuard();
      setNavigationRemovingInviteIds((prev) => {
        if (prev.has(inviteId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(inviteId);
        return next;
      });

      const clearRemovingFlag = () => {
        setNavigationRemovingInviteIds((prev) => {
          if (!prev.has(inviteId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(inviteId);
          return next;
        });
      };

      void connection
        .removeWaitingNavigationGame(inviteId)
        .then((result) => {
          if (!sessionGuard()) {
            return;
          }

          if (result && result.ok && !result.skipped) {
            setNavigationProjectedGames((prev) =>
              prev.filter(
                (item) =>
                  !(
                    item.entityType === "game" &&
                    item.inviteId === inviteId &&
                    item.status === "waiting"
                  ),
              ),
            );
            setNavigationPagedGames((prev) =>
              prev.filter(
                (item) =>
                  !(
                    item.entityType === "game" &&
                    item.inviteId === inviteId &&
                    item.status === "waiting"
                  ),
              ),
            );
          }

          clearRemovingFlag();
        })
        .catch(() => {
          if (!sessionGuard()) {
            return;
          }
          clearRemovingFlag();
        });
    },
    [isNavigationFallbackScope, navigationRemovingInviteIds],
  );

  const handleNavigationProblemSelect = (problemId: string) => {
    const selectedProblem = problems.find((item) => item.id === problemId);
    if (!selectedProblem) {
      return;
    }
    const selectionEpoch = navigationSelectionEpochRef.current + 1;
    navigationSelectionEpochRef.current = selectionEpoch;
    setIsNavigationPopupVisible(false);
    setIsBoardStylePickerVisible(false);
    dismissPendingAutomatchTransition();
    void (async () => {
      try {
        await transitionToHome({ forceMatchScopeReset: true });
      } catch {}
      if (navigationSelectionEpochRef.current !== selectionEpoch) {
        return;
      }
      const currentTarget = getCurrentTarget();
      if (currentTarget.mode !== "home" || currentTarget.path !== "") {
        return;
      }
      didSelectPuzzle(selectedProblem);
    })();
  };

  const handleNavigationLoadMoreGames = () => {
    if (
      !isNavigationPopupVisible ||
      !navigationHasMoreGames ||
      isNavigationGamesLoading ||
      isNavigationGamesLoadingMore ||
      navigationLoadMoreInFlightRef.current
    ) {
      return;
    }

    navigationLoadMoreInFlightRef.current = true;
    setIsNavigationGamesLoadingMore(true);
    const localProfileId = storage.getProfileId("");
    const sessionGuard = connection.createSessionGuard();
    const popupEpoch = navigationPopupEpochRef.current;
    const isCallbackActive = () =>
      navigationPopupEpochRef.current === popupEpoch;
    const stopLoadMore = () => {
      navigationLoadMoreInFlightRef.current = false;
      setIsNavigationGamesLoadingMore(false);
    };

    if (localProfileId !== "" && !isNavigationFallbackScope) {
      const nextCursor = navigationGamesCursor;
      if (!nextCursor) {
        setNavigationHasMoreGames(false);
        stopLoadMore();
        return;
      }

      void connection
        .getProfileGamesFirestorePage(
          NAVIGATION_GAMES_LOAD_MORE_PAGE_SIZE,
          nextCursor,
        )
        .then((page) => {
          if (!isCallbackActive()) {
            stopLoadMore();
            return;
          }
          if (!sessionGuard()) {
            stopLoadMore();
            return;
          }
          setNavigationPagedGames((previousItems) => {
            const uniqueById = new Map<string, NavigationItem>();
            previousItems.forEach((item) => uniqueById.set(item.id, item));
            page.items.forEach((item) => uniqueById.set(item.id, item));
            const mergedItems = Array.from(uniqueById.values());
            navigationHasPagedGamesRef.current = mergedItems.some(
              (item) => !topNavigationItemIdsRef.current.has(item.id),
            );
            return mergedItems;
          });
          setNavigationGamesCursor(page.nextCursor);
          setNavigationHasMoreGames(page.hasMore);
          stopLoadMore();
        })
        .catch(() => {
          if (!isCallbackActive()) {
            stopLoadMore();
            return;
          }
          if (!sessionGuard()) {
            stopLoadMore();
            return;
          }
          setNavigationHasMoreGames(false);
          stopLoadMore();
        });
      return;
    }

    const nextFallbackLimit =
      navigationFallbackLimit + NAVIGATION_GAMES_LOAD_MORE_PAGE_SIZE;
    const requestedLimit = nextFallbackLimit + 1;
    setNavigationFallbackLimit(nextFallbackLimit);
    void connection
      .getCurrentLoginFallbackGames(requestedLimit)
      .then((items) => {
        if (!isCallbackActive()) {
          stopLoadMore();
          return;
        }
        if (!sessionGuard()) {
          stopLoadMore();
          return;
        }
        const hasMore = items.length > nextFallbackLimit;
        const visibleItems = hasMore
          ? items.slice(0, nextFallbackLimit)
          : items;
        const nextProjectedItems = visibleItems.slice(
          0,
          NAVIGATION_GAMES_PAGE_SIZE,
        );
        const nextPagedItems = visibleItems.slice(NAVIGATION_GAMES_PAGE_SIZE);
        setNavigationProjectedGames(nextProjectedItems);
        setNavigationPagedGames(nextPagedItems);
        const nextTopItemIds = new Set(
          nextProjectedItems.map((item) => item.id),
        );
        if (optimisticPendingAutomatchItem) {
          nextTopItemIds.add(optimisticPendingAutomatchItem.id);
        }
        navigationHasPagedGamesRef.current = nextPagedItems.some(
          (item) => !nextTopItemIds.has(item.id),
        );
        setNavigationHasMoreGames(hasMore);
        stopLoadMore();
      })
      .catch(() => {
        if (!isCallbackActive()) {
          stopLoadMore();
          return;
        }
        if (!sessionGuard()) {
          stopLoadMore();
          return;
        }
        setNavigationHasMoreGames(false);
        stopLoadMore();
      });
  };

  const handleShare = async () => {
    try {
      await navigator.share({
        url: window.location.href,
        title: "Play Mons",
      });
    } catch (_) {}
  };

  const routeState = getCurrentRouteState();
  const selectedProblemId =
    routeState.mode === "home" || routeState.mode === "event"
      ? getSelectedPuzzleId()
      : null;
  const selectedNavigationItemId = selectedEventModalId
    ? `event_${selectedEventModalId}`
    : routeState.mode === "event" && routeState.eventId
      ? `event_${routeState.eventId}`
      : routeState.mode === "invite"
        ? routeState.inviteId
        : null;
  const currentInviteEventId = connection.getCurrentInviteEventId();
  const routeIsInvite = routeState.mode === "invite";
  const shouldUseStickyEventGameButton =
    routeIsInvite &&
    !!eventGameButtonStickyEventId &&
    (!currentInviteEventId ||
      currentInviteEventId === eventGameButtonStickyEventId);
  const effectiveInviteEventId =
    currentInviteEventId ??
    (shouldUseStickyEventGameButton ? eventGameButtonStickyEventId : null);
  const isEventGameButtonVisible =
    (isOnlineGame &&
      connection.isCurrentInviteEventOwned() &&
      !!currentInviteEventId) ||
    shouldUseStickyEventGameButton;

  useEffect(() => {
    if (!eventGameButtonStickyEventId) {
      return;
    }
    if (!routeIsInvite) {
      clearEventGameButtonStickyState();
      return;
    }
    if (
      currentInviteEventId &&
      currentInviteEventId !== eventGameButtonStickyEventId
    ) {
      clearEventGameButtonStickyState();
    }
  }, [
    clearEventGameButtonStickyState,
    currentInviteEventId,
    eventGameButtonStickyEventId,
    routeIsInvite,
  ]);

  useEffect(() => {
    if (!effectiveInviteEventId) {
      eventCloudSubscriptionEventIdRef.current = null;
      setLiveEventCloudAvatars([]);
      return;
    }
    if (eventCloudSubscriptionEventIdRef.current === effectiveInviteEventId) {
      return;
    }
    eventCloudSubscriptionEventIdRef.current = effectiveInviteEventId;
    setLiveEventCloudAvatars(
      getEventCloudAvatarsFromNavigationSources(
        effectiveInviteEventId,
        topNavigationGames,
        pagedNavigationGames,
      ),
    );
  }, [effectiveInviteEventId, pagedNavigationGames, topNavigationGames]);

  useEffect(() => {
    if (!effectiveInviteEventId || !isEventGameButtonVisible) {
      return;
    }
    let disposed = false;

    const unsubscribe = connection.subscribeToEvent(
      effectiveInviteEventId,
      (eventRecord) => {
        if (disposed) {
          return;
        }
        const nextAvatars = mapEventRecordToNavigationPreview(
          eventRecord,
        ).slice(0, EVENT_CLOUD_MAX_AVATARS);
        setLiveEventCloudAvatars((previousAvatars) => {
          if (previousAvatars.length >= EVENT_CLOUD_MAX_AVATARS) {
            return previousAvatars;
          }
          if (previousAvatars.length === 0) {
            return nextAvatars.length > 0 ? nextAvatars : previousAvatars;
          }
          if (nextAvatars.length > previousAvatars.length) {
            return nextAvatars;
          }
          return previousAvatars;
        });
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [effectiveInviteEventId, isEventGameButtonVisible]);

  const eventCloudAvatars = useMemo(() => {
    if (!effectiveInviteEventId) {
      return [];
    }
    const liveFallback = liveEventCloudAvatars.slice(
      0,
      EVENT_CLOUD_MAX_AVATARS,
    );
    if (liveFallback.length > 0) {
      return liveFallback;
    }
    return getEventCloudAvatarsFromNavigationSources(
      effectiveInviteEventId,
      topNavigationGames,
      pagedNavigationGames,
    );
  }, [
    effectiveInviteEventId,
    liveEventCloudAvatars,
    topNavigationGames,
    pagedNavigationGames,
  ]);

  return (
    <>
      <BrushButton
        ref={brushButtonRef}
        dimmed={isBrushButtonDimmed}
        onClick={!isMobile ? handleBrushClick : undefined}
        onTouchStart={isMobile ? handleBrushClick : undefined}
        aria-label="Appearance"
      >
        <FaPaintBrush />
      </BrushButton>
      {isBoardStylePickerVisible && (
        <div ref={boardStylePickerRef}>
          <BoardStylePickerComponent />
        </div>
      )}
      {isNavigationPopupVisible && (
        <div ref={navigationPopupRef}>
          <NavigationPicker
            showsHomeNavigation={isDeepHomeButtonVisible}
            navigateHome={handleHomeClick}
            topGames={topNavigationGames}
            pagedGames={pagedNavigationGames}
            selectedProblemId={selectedProblemId}
            selectedNavigationItemId={selectedNavigationItemId}
            isGamesLoading={isNavigationGamesLoading}
            isLoadingMoreGames={isNavigationGamesLoadingMore}
            hasMoreGames={navigationHasMoreGames}
            onSelectGame={handleNavigationGameSelect}
            onRemoveGame={
              !isNavigationFallbackScope
                ? handleNavigationGameRemove
                : undefined
            }
            removingGameInviteIds={navigationRemovingInviteIds}
            onSelectProblem={handleNavigationProblemSelect}
            onLoadMoreGames={handleNavigationLoadMoreGames}
          />
        </div>
      )}
      {isMoveHistoryPopupVisible && (
        <MoveHistoryPopup ref={moveHistoryPopupRef} />
      )}
      <ControlsContainer ref={controlsContainerRef}>
        {(isEventGameButtonVisible || hasRematchSeriesNavigation) && (
          <LeftCornerInlineControls>
            {isEventGameButtonVisible && (
              <EventCloudButtonOuter
                onClick={
                  !isMobile
                    ? () =>
                        openEventModal(effectiveInviteEventId as string, {
                          restoreHomeOnClose: false,
                        })
                    : undefined
                }
                onTouchStart={
                  isMobile
                    ? () =>
                        openEventModal(effectiveInviteEventId as string, {
                          restoreHomeOnClose: false,
                        })
                    : undefined
                }
                aria-label="Event"
              >
                <svg
                  width={CLOUD_VISUAL_SIZE}
                  height={CLOUD_VISUAL_SIZE}
                  viewBox={`0 0 ${CLOUD_VISUAL_SIZE} ${CLOUD_VISUAL_SIZE}`}
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    overflow: "visible",
                    pointerEvents: "none",
                  }}
                  aria-hidden="true"
                >
                  <EventCloudShape d={EVENT_CLOUD_PATH} />
                </svg>
                {(
                  CLOUD_AVATAR_LAYOUTS[
                    Math.min(eventCloudAvatars.length, EVENT_CLOUD_MAX_AVATARS)
                  ] ?? CLOUD_AVATAR_LAYOUTS[0]
                ).map((slot, i) => {
                  const participant = eventCloudAvatars[i];
                  const emojiId =
                    participant?.emojiId != null
                      ? Number(participant.emojiId)
                      : NaN;
                  const posStyle = {
                    width: CLOUD_AVATAR_SIZE,
                    height: CLOUD_AVATAR_SIZE,
                    left:
                      slot.x +
                      CLOUD_AVATAR_LAYOUT_CENTER_OFFSET -
                      CLOUD_AVATAR_SIZE / 2 +
                      CLOUD_INSET,
                    top:
                      slot.y +
                      CLOUD_AVATAR_LAYOUT_CENTER_OFFSET -
                      CLOUD_AVATAR_SIZE / 2 +
                      CLOUD_INSET,
                    transform: `rotate(${slot.r}deg)`,
                  };
                  if (Number.isFinite(emojiId) && emojiId > 0) {
                    return (
                      <EventCloudAvatar
                        key={i}
                        src={emojis.getEmojiUrl(Math.trunc(emojiId).toString())}
                        alt=""
                        style={posStyle}
                      />
                    );
                  }
                  return (
                    <EventCloudAvatarPlaceholder key={i} style={posStyle} />
                  );
                })}
              </EventCloudButtonOuter>
            )}
            {hasRematchSeriesNavigation && (
              <RematchSeriesInlineControl>
                <RematchSeriesScroll>
                  <RematchSeriesTrack>
                    {rematchSeriesItems.map((seriesItem, idx, arr) => (
                      <React.Fragment key={seriesItem.matchId}>
                        <RematchSeriesChip
                          $isSelected={seriesItem.isSelected}
                          disabled={isRematchSeriesSelectionInFlight}
                          onClick={() =>
                            void handleRematchSeriesChipClick(
                              seriesItem.matchId,
                            )
                          }
                        >
                          {renderRematchSeriesChipContent(seriesItem)}
                        </RematchSeriesChip>
                        {idx < arr.length - 1 && (
                          <RematchSeriesSeparator $hidden={false} />
                        )}
                      </React.Fragment>
                    ))}
                  </RematchSeriesTrack>
                </RematchSeriesScroll>
              </RematchSeriesInlineControl>
            )}
          </LeftCornerInlineControls>
        )}
        {isEndMatchPillVisible && (
          <BottomPillButton
            onClick={!isEndMatchPillFinished ? handleEndMatchClick : undefined}
            isBlue={!isEndMatchPillFinished}
            disabled={isEndMatchPillFinished}
            isViewOnly={isEndMatchPillFinished}
          >
            {isEndMatchPillFinished ? (
              "Finished"
            ) : (
              <>
                <FaFlagCheckered />
                {"End Match"}
              </>
            )}
          </BottomPillButton>
        )}
        {isWatchOnlyIndicatorVisible &&
          !isWatchOnlyMatchFinished &&
          !isEndMatchConfirmed && (
            <BottomPillButton isViewOnly={true} disabled={true}>
              {"Watching"}
            </BottomPillButton>
          )}
        {isInviteLinkButtonVisible && !didCreateInvite && (
          <BottomPillButton
            onClick={handleInviteClick}
            isBlue={true}
            disabled={isInviteLoading}
          >
            {isInviteLoading ? (
              "Creating a Link..."
            ) : (
              <>
                <FaEnvelope style={{ marginRight: "6px", fontSize: "0.9em" }} />
                {"New Link Game"}
              </>
            )}
          </BottomPillButton>
        )}
        {isAutomatchPillVisible && (
          <BottomPillButton
            onClick={handleAutomatchClick}
            isBlue={true}
            isViewOnly={automatchButtonTmpState}
            disabled={!isAutomatchButtonEnabled}
          >
            {automatchButtonTmpState ? (
              <ShimmerText>Automatching</ShimmerText>
            ) : (
              <>
                <FaStar style={{ marginRight: "6px", fontSize: "0.9em" }} />
                {"Automatch"}
              </>
            )}
          </BottomPillButton>
        )}
        {isCancelAutomatchVisible && (
          <BottomPillButton
            onClick={handleCancelAutomatchClick}
            isBlue={true}
            disabled={isCancelAutomatchDisabled}
            isViewOnly={isCancelAutomatchDisabled}
          >
            {isCancelAutomatchDisabled ? (
              <ShimmerText>Canceling</ShimmerText>
            ) : (
              "Cancel"
            )}
          </BottomPillButton>
        )}
        {isBotGameButtonVisible && (
          <BottomPillButton onClick={handleBotGameClick} isBlue={true}>
            <FaRobot style={{ marginRight: "6px", fontSize: "0.9em" }} />
            {"Bot Game"}
          </BottomPillButton>
        )}
        {isInviteLinkButtonVisible && didCreateInvite && (
          <>
            <BottomPillButton onClick={handleInviteClick} isBlue={true}>
              {inviteCopiedTmpState ? (
                "Link is copied"
              ) : (
                <>
                  <FaLink style={{ marginRight: "6px", fontSize: "0.9em" }} />
                  {"Copy Link"}
                </>
              )}
            </BottomPillButton>
            <BottomPillButton onClick={handleShare} isBlue={true}>
              <FaShareAlt style={{ marginRight: "6px", fontSize: "0.9em" }} />
              {"Share"}
            </BottomPillButton>
          </>
        )}
        {primaryAction !== PrimaryActionType.None && (
          <BottomPillButton isBlue={true} onClick={handlePrimaryActionClick}>
            {getPrimaryActionButtonText()}
          </BottomPillButton>
        )}
        {isSamePuzzleAgainVisible && (
          <BottomPillButton onClick={handleSamePuzzleAgainClick} isBlue={true}>
            {"Victory Lap"}
          </BottomPillButton>
        )}
        {waitingStateText !== "" && (
          <BottomPillButton disabled={true} isViewOnly={true}>
            {waitingStateText}
          </BottomPillButton>
        )}
        {isClaimVictoryVisible && (
          <ControlButton
            ref={claimVictoryButtonRef}
            onClick={handleClaimVictoryClick}
            aria-label="Claim Victory"
            disabled={isClaimVictoryButtonDisabled}
          >
            <FaTrophy />
          </ControlButton>
        )}
        {isStartTimerVisible && (
          <AnimatedHourglassButton
            ref={timerButtonRef}
            config={timerConfig}
            onClick={handleTimerClick}
            disabled={isTimerButtonDisabled}
          />
        )}
        {isUndoButtonVisible && (
          <ControlButton
            onClick={!isMobile ? handleUndo : undefined}
            onTouchStart={isMobile ? handleUndo : undefined}
            aria-label="Undo"
            disabled={isUndoDisabled}
          >
            <FaUndo />
          </ControlButton>
        )}
        {isAutomoveButtonVisible && (
          <ControlButton
            onClick={!isMobile ? handleAutomoveClick : undefined}
            onTouchStart={isMobile ? handleAutomoveClick : undefined}
            aria-label="Bot"
            disabled={!isAutomoveButtonEnabled}
          >
            <IoSparklesSharp />
          </ControlButton>
        )}
        {isMoveHistoryButtonVisible && (
          <ControlButton
            onClick={!isMobile ? toggleMoveHistoryPopup : undefined}
            onTouchStart={isMobile ? toggleMoveHistoryPopup : undefined}
            aria-label="Move History"
            ref={moveHistoryButtonRef}
          >
            <FaScroll />
          </ControlButton>
        )}
        {isVoiceReactionButtonVisible && !puzzleMode && (
          <ControlButton
            onClick={!isMobile ? toggleReactionPicker : undefined}
            onTouchStart={isMobile ? toggleReactionPicker : undefined}
            aria-label="Voice Reaction"
            ref={voiceReactionButtonRef}
            disabled={isVoiceReactionDisabled}
          >
            <FaCommentAlt />
          </ControlButton>
        )}
        {isResignButtonVisible && (
          <ControlButton
            onClick={handleResignClick}
            aria-label="Resign"
            ref={resignButtonRef}
            disabled={false}
          >
            <FaFlag />
          </ControlButton>
        )}
        <NavigationListButton
          ref={navigationButtonRef}
          dimmed={isNavigationButtonDimmed}
          onClick={!isMobile ? handleNavigationButtonClick : undefined}
          onTouchStart={isMobile ? handleNavigationButtonClick : undefined}
          aria-label="Navigation"
        >
          {HOME_NAVIGATION_BADGE_ENABLED && isBadgeVisible && (
            <NavigationBadge />
          )}
          <FaHome />
        </NavigationListButton>
        {isReactionPickerVisible && (
          <ReactionPillsContainer
            ref={pickerRef}
            animatedMaxHeight={pickerMaxHeight}
          >
            {isWagerMode ? (
              <>
                <WagerBetButton
                  $ready={wagerReady}
                  onClick={
                    wagerReady && !isMobile ? handleWagerSubmit : undefined
                  }
                  onTouchStart={
                    wagerReady && isMobile ? handleWagerSubmit : undefined
                  }
                  disabled={!wagerReady}
                  style={{
                    cursor: wagerReady ? "pointer" : "default",
                    opacity: wagerReady ? 1 : 0.6,
                  }}
                >
                  {wagerMaterial && wagerCount > 0 ? (
                    <>
                      <span>Propose</span>
                      <WagerButtonBadge>
                        {materialUrls[wagerMaterial] && (
                          <WagerButtonIcon
                            src={materialUrls[wagerMaterial] || ""}
                            alt=""
                            draggable={false}
                          />
                        )}
                        <WagerButtonAmount>{wagerCount}</WagerButtonAmount>
                      </WagerButtonBadge>
                    </>
                  ) : (
                    "Select a Material"
                  )}
                </WagerBetButton>
                <WagerMaterialsGrid>
                  {MATERIALS.map((name) => (
                    <WagerMaterialItem
                      key={name}
                      onClick={
                        !isMobile ? () => handleMaterialSelect(name) : undefined
                      }
                      onTouchStart={
                        isMobile ? () => handleMaterialSelect(name) : undefined
                      }
                      disabled={materialAmounts[name] <= 0}
                      style={{ opacity: materialAmounts[name] > 0 ? 1 : 0.4 }}
                    >
                      {materialUrls[name] && (
                        <WagerMaterialIcon
                          src={materialUrls[name] || ""}
                          alt=""
                          draggable={false}
                        />
                      )}
                      <WagerMaterialAmount>
                        {materialAmounts[name]}
                      </WagerMaterialAmount>
                    </WagerMaterialItem>
                  ))}
                </WagerMaterialsGrid>
              </>
            ) : (
              <>
                {canSubmitWager && (
                  <WagerBetButton
                    $ready={true}
                    onClick={!isMobile ? handleWagerModeToggle : undefined}
                    onTouchStart={isMobile ? handleWagerModeToggle : undefined}
                  >
                    Propose a Wager
                  </WagerBetButton>
                )}
                <ReactionPill onClick={() => handleReactionSelect("yo")}>
                  yo
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("wahoo")}>
                  wahoo
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("drop")}>
                  drop
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("slurp")}>
                  slurp
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("gg")}>
                  gg
                </ReactionPill>
                {visibleStickerIds.map((id) => (
                  <StickerPill
                    key={id}
                    onClick={() => handleStickerSelect(id)}
                    disabled={
                      !FIXED_STICKER_IDS.includes(id) &&
                      !hasFreshStickerEntitlement
                    }
                    aria-label={`Sticker ${id}`}
                  >
                    <img
                      src={
                        stickerUrls[id] ||
                        `${STICKER_IMAGE_BASE_URL}/${id}.webp`
                      }
                      alt=""
                      loading="lazy"
                    />
                  </StickerPill>
                ))}
              </>
            )}
          </ReactionPillsContainer>
        )}
        {isTimerConfirmVisible && (
          <ResignConfirmation
            ref={timerConfirmRef}
            style={
              timerConfirmLeft !== null
                ? {
                    left: `${timerConfirmLeft}px`,
                    right: "auto",
                    transform: "translateX(-50%)",
                  }
                : undefined
            }
          >
            <ReactionPill onClick={handleConfirmStartTimer}>
              Start a Timer
            </ReactionPill>
          </ResignConfirmation>
        )}
        {isClaimVictoryConfirmVisible && (
          <ResignConfirmation
            ref={claimVictoryConfirmRef}
            style={
              claimVictoryConfirmLeft !== null
                ? {
                    left: `${claimVictoryConfirmLeft}px`,
                    right: "auto",
                    transform: "translateX(-50%)",
                  }
                : undefined
            }
          >
            <ReactionPill onClick={handleConfirmClaimVictory}>
              Claim Victory
            </ReactionPill>
          </ResignConfirmation>
        )}
        {isResignConfirmVisible && (
          <ResignConfirmation ref={resignConfirmRef}>
            <ResignButton onClick={handleConfirmResign}>Resign</ResignButton>
          </ResignConfirmation>
        )}
      </ControlsContainer>
    </>
  );
};

export {
  BottomControls as default,
  setBrushAndNavigationButtonDimmed,
  setPlaySamePuzzleAgainButtonVisible,
  showWaitingStateText,
  setEndMatchConfirmed,
  setEndMatchVisible,
  setBotGameOptionVisible,
  setAutomatchWaitingState,
  setAutomatchEnabled,
  hasBottomPopupsVisible,
  setWatchOnlyVisible,
  setAutomoveActionEnabled,
  setAutomoveActionVisible,
  setIsReadyToCopyExistingInviteLink,
  showVoiceReactionButton,
  showMoveHistoryButton,
  setInviteLinkActionVisible,
  setAutomatchVisible,
  showResignButton,
  setUndoEnabled,
  setUndoVisible,
  setHomeVisible,
  hideTimerButtons,
  showTimerButtonProgressing,
  disableAndHideUndoResignAndTimerControls,
  enableTimerVictoryClaim,
  showPrimaryAction,
  setBadgeVisible,
};
