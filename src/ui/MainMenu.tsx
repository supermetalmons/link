import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import { logoBase64 } from "../content/uiAssets";
import {
  didDismissSomethingWithOutsideTapJustNow,
  didNotDismissAnythingWithOutsideTapJustNow,
  closeNavigationAndAppearancePopupIfAny,
} from "./BottomControls";
import styled from "styled-components";
import {
  defaultEarlyInputEventName,
  isMobile,
  getBuildInfo,
} from "../utils/misc";
import { storage } from "../utils/storage";
import {
  Leaderboard,
  LeaderboardType,
  LEADERBOARD_TYPE_ICON_URLS,
} from "./Leaderboard";
import { setAnimatedMonsEnabled } from "../game/board";
import { closeProfilePopupIfAny } from "./ProfileSignIn";
import {
  FaTelegramPlane,
  FaUniversity,
  FaPlay,
  FaStop,
  FaBackward,
  FaForward,
  FaCog,
  FaPowerOff,
  FaVolumeMute,
  FaVolumeUp,
  FaMusic,
  FaInfoCircle,
  FaRegGem,
  FaEllipsisH,
} from "react-icons/fa";
import { showsShinyCardSomewhere } from "./ShinyCard";
import {
  startPlayingMusic,
  stopPlayingMusic,
  playNextTrack,
  playPreviousTrack,
  setMusicMuted,
  getIsMusicPlaying,
  subscribeToMusicPlayback,
} from "../content/music";
import {
  HowToPlayContent,
  HowToPlayPopoverSurface,
  HowToPlaySeparator,
  howToPlayContentStyles,
  InfoPopover,
} from "./InfoPopover";
import { TopRightPopoverBase } from "./TopRightPopoverBase";
import {
  MINING_MATERIAL_NAMES,
  MiningMaterialName,
} from "../connection/connectionModels";
import { registerMainMenuTransientUiHandler } from "./uiSession";
import { connection } from "../connection/connection";
import type { EventCreateDateTimePayload } from "../connection/connection";
import {
  getEventModalState,
  openEventModal,
  openEventModalPendingCreate,
  setEventModalPendingCreateError,
} from "./eventModalController";
import {
  EVENT_SCHEDULE_TIMEZONE_OPTIONS,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  isMonsLinkAdmin,
  type EventScheduleTimezone,
} from "@mons/shared/events";
import type { AuthState } from "../connection/authentication";
import { InventoryModal } from "./InventoryModal";

const MATERIAL_TYPES: MiningMaterialName[] = [...MINING_MATERIAL_NAMES];
const LEADERBOARD_TYPES: LeaderboardType[] = [
  "rating",
  ...MATERIAL_TYPES,
  "total",
  "mp",
];
const MATERIAL_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";
type LeaderboardSpecialType = keyof typeof LEADERBOARD_TYPE_ICON_URLS;

type EventScheduleMode = "minutes" | "datetime";

const TOP_RIGHT_CONTROL_IDS = {
  info: "top-right-info-button",
  more: "top-right-more-button",
  music: "top-right-music-button",
  gem: "top-right-gem-button",
} as const;

const TOP_RIGHT_POPOVER_IDS = {
  info: "top-right-info-popover",
  more: "top-right-more-popover",
  music: "top-right-music-popover",
  inventory: "top-right-inventory-popover",
} as const;

const FOCUS_CLAIMING_TARGET_SELECTOR =
  "a[href], area[href], button:not([disabled]), input:not([disabled]), " +
  "select:not([disabled]), textarea:not([disabled]), summary, iframe, " +
  "audio[controls], video[controls], label, [tabindex], " +
  "[contenteditable]:not([contenteditable='false'])";

type TopRightPopoverName = keyof typeof TOP_RIGHT_POPOVER_IDS | null;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const formatLocalDateInputValue = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const formatLocalTimeInputValue = (date: Date): string =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

const DEFAULT_EVENT_SCHEDULE_LEAD_MINUTES = 30;

const getDefaultScheduledDateTimeInput = (): { date: string; time: string } => {
  const minimumStartMs =
    Date.now() + DEFAULT_EVENT_SCHEDULE_LEAD_MINUTES * 60 * 1000;
  const rounded = new Date(minimumStartMs);
  rounded.setMinutes(0, 0, 0);
  if (rounded.getTime() < minimumStartMs) {
    rounded.setHours(rounded.getHours() + 1);
  }
  return {
    date: formatLocalDateInputValue(rounded),
    time: formatLocalTimeInputValue(rounded),
  };
};

const materialImagePromises: Map<
  MiningMaterialName,
  Promise<string | null>
> = new Map();
const specialLeaderboardTypeImagePromises: Map<
  LeaderboardSpecialType,
  Promise<string | null>
> = new Map();

const fetchImageUrl = (url: string): Promise<string | null> =>
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error("Failed to fetch image");
      return res.blob();
    })
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => null);

const getMaterialImageUrl = (name: MiningMaterialName) => {
  if (!materialImagePromises.has(name)) {
    materialImagePromises.set(
      name,
      fetchImageUrl(`${MATERIAL_BASE_URL}/${name}.webp`),
    );
  }
  return materialImagePromises.get(name)!;
};

const getSpecialLeaderboardTypeImageUrl = (type: LeaderboardSpecialType) => {
  if (!specialLeaderboardTypeImagePromises.has(type)) {
    specialLeaderboardTypeImagePromises.set(
      type,
      fetchImageUrl(LEADERBOARD_TYPE_ICON_URLS[type]),
    );
  }
  return specialLeaderboardTypeImagePromises.get(type)!;
};

const isMaterialLeaderboardType = (
  value: LeaderboardType,
): value is MiningMaterialName =>
  value !== "rating" && value !== "mp" && value !== "total";

const RockButtonContainer = styled.div`
  position: absolute;
  top: 9pt;
  left: 9pt;

  @media screen and (max-height: 500px) {
    top: 7pt;
  }

  @media screen and (max-height: 453px) {
    top: 5pt;
  }

  @media screen and (max-width: 420px) {
    left: 8px;
  }

  @media screen and (max-width: 387px) {
    left: 6px;
  }
`;

const Crack = styled.div`
  position: absolute;
  height: 2px;
  transform-origin: left center;
  animation: grow 0.1s ease-out forwards;
  z-index: 80025;
  transition: transform 5s linear;

  @keyframes grow {
    from {
      width: 0;
    }
    to {
      width: 23%;
    }
  }
`;

const CrackContainer = styled.div`
  position: absolute;
  width: 100px;
  height: 100px;
  top: -30px;
  left: -30px;
  pointer-events: none;
  z-index: 80025;
  overflow: hidden;
`;

const RockButton = styled.button`
  display: block;
  background-color: var(--color-gray-f9);
  border: none;
  border-radius: 20px;
  padding: 3px 6px;
  cursor: pointer;
  position: relative;
  z-index: 80020;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-callout: none;
  -webkit-highlight: none;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--panelBackground);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-25);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--panelBackgroundDark);
      }
    }
  }

  img {
    width: 34px;
    height: 34px;
    opacity: 1;
    display: block;
    -webkit-touch-callout: none;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
    -webkit-tap-highlight-color: transparent;
  }
`;

const RockMenuWrapper = styled.div<{ isOpen: boolean }>`
  position: absolute;
  top: -25px;
  left: -26px;
  padding: 20px;
  pointer-events: ${(props) => (props.isOpen ? "auto" : "none")};
  z-index: ${(props) => (props.isOpen ? 80010 : 0)};

  @media screen and (max-width: 420px) {
    left: -23px;
  }
`;

const RockMenu = styled.div<{ isOpen: boolean; showLeaderboard: boolean }>`
  position: relative;
  background-color: var(--color-white);
  border-radius: 10px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-shadow: ${(props) =>
    props.isOpen ? "0 6px 20px var(--notificationBannerShadow)" : "none"};
  width: ${(props) => (props.showLeaderboard ? "min(300px, 83dvw)" : "230px")};

  transform-origin: top left;
  opacity: ${(props) => (props.isOpen ? 1 : 0)};
  pointer-events: ${(props) => (props.isOpen ? "auto" : "none")};
  z-index: 1;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-deep-gray);
  }
`;

const MenuContent = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
`;

const MenuBody = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0 -6px -6px -6px;
  padding: 0 6px 6px 6px;
`;

const MenuTitleText = styled.i`
  margin-top: -2px;
  margin-left: -1px;
  font-weight: 995;
  font-size: 25px;
  color: var(--color-gray-33);
  cursor: default;

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

const MenuTitle = styled.div`
  margin: 6px 16px 6px 53px;
  text-align: left;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 20px;
`;

const LeaderboardTypeSelector = styled.div`
  display: flex;
  gap: 4px;
  padding: 4px 3px 8px 3px;
`;

const LeaderboardTypeButton = styled.button<{
  isSelected: boolean;
  isText?: boolean;
  isSpecial?: boolean;
  isTotal?: boolean;
}>`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  flex: 1 1 0;
  min-width: 0;
  padding: 0;
  border-radius: 14px;
  border: none;
  cursor: pointer;
  font-size: 0.7rem;
  font-weight: 600;
  background-color: ${(props) =>
    props.isSelected ? "var(--color-blue-primary)" : "var(--color-gray-f9)"};
  color: ${(props) => (props.isSelected ? "#fff" : "#707070")};
  -webkit-touch-callout: none;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.isSelected
          ? "var(--color-blue-primary)"
          : "var(--color-gray-f5)"};
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: ${(props) =>
      props.isSelected
        ? "var(--color-blue-primary-dark)"
        : "var(--color-gray-25)"};
    color: ${(props) => (props.isSelected ? "#fff" : "var(--color-gray-99)")};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.isSelected
            ? "var(--color-blue-primary-dark)"
            : "var(--color-gray-27)"};
      }
    }
  }
`;

const LeaderboardTypeMaterialIcon = styled.img`
  width: 22px;
  height: 22px;
  object-fit: contain;
  margin: 0 -3px;
`;

const LeaderboardTypeSpecialIcon = styled.img`
  width: 22px;
  height: 22px;
  object-fit: contain;
  margin: 0 -3px;
  padding: 2px 3px;
  box-sizing: border-box;
`;

const TotalMaterialsIconContainer = styled.div`
  position: relative;
  width: 22px;
  height: 22px;

  img {
    position: absolute;
    width: 14px;
    height: 14px;
    object-fit: contain;
  }

  img:nth-child(1) {
    top: -1px;
    left: 50%;
    transform: translateX(-50%) translateX(6%) translateY(-6%);
    z-index: 1;
  }

  img:nth-child(2) {
    top: 3px;
    right: -1px;
    z-index: 2;
  }

  img:nth-child(3) {
    bottom: -1px;
    right: 1px;
    transform: translateX(3%);
    z-index: 3;
  }

  img:nth-child(4) {
    bottom: -1px;
    left: 1px;
    z-index: 3;
  }

  img:nth-child(5) {
    top: 3px;
    left: -1px;
    z-index: 2;
  }
`;

const IconLinkButton = styled.a`
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  font-weight: 600;
  justify-content: center;
  height: 26px;
  padding: 0 5px;
  border: none;
  border-radius: 0;
  background-color: transparent;
  color: var(--color-gray-99);
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1;
  overflow: visible;
  -webkit-touch-callout: none;
  touch-action: pan-x;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      color: var(--color-blue-primary);
    }
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-77);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        color: var(--color-blue-primary-dark);
      }
    }
  }

  svg {
    width: 0.8rem;
    height: 0.8rem;
    display: block;
    overflow: visible;
  }
`;

const LinksContainer = styled.div`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 5;
  padding: 3px 6px 4px 6px;
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 0 0 10px 10px;

  @media (prefers-color-scheme: dark) {
    background: rgba(30, 30, 30, 0.5);
  }
`;

const ButtonRow = styled.div`
  display: flex;
  gap: 12px;
  margin: 0;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  padding: 1px 0;
  width: 100%;
`;

const CloseButton = styled.button`
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--color-gray-fb);
  border: none;
  color: var(--lightDisabledTextColor);
  cursor: pointer;
  font-size: 18px;
  font-weight: 230;
  line-height: 18px;
  position: absolute;
  border-radius: 50%;
  height: 26px;
  width: 26px;
  right: 6px;
  top: 6px;
  padding: 0;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;

  @media (hover: none) {
    display: flex;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-42);
    background: var(--color-gray-23);
  }
`;

const MenuOverlay = styled.div`
  position: absolute;
  inset: 0;
  background: var(--menuOverlayBackground);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 0 0 10px 10px;
  z-index: 10;

  @media (prefers-color-scheme: dark) {
    background: var(--color-deep-gray);
  }
`;

const ExperimentalMenu = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  background: var(--menuOverlayBackground);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 0 0 10px 10px;
  z-index: 30000;

  @media (prefers-color-scheme: dark) {
    background: var(--color-deep-gray);
  }
`;

const BuildInfo = styled.div`
  font-size: 13px;
  color: var(--buildInfoTextColor);
  text-align: center;
  margin-top: auto;
  padding-bottom: 12px;
  user-select: none;
  cursor: default;

  @media (prefers-color-scheme: dark) {
    color: var(--buildInfoTextColorDark);
  }
`;

const ToggleRow = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: center;
  font-size: 14px;
  color: var(--color-gray-33);

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

const ScheduleModeToggle = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
`;

const ScheduleModeButton = styled.button<{ $active: boolean }>`
  height: 34px;
  border: none;
  border-radius: 999px;
  padding: 0 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  color: ${(props) => (props.$active ? "white" : "var(--color-gray-33)")};
  background: ${(props) =>
    props.$active ? "var(--color-blue-primary)" : "rgba(111, 126, 141, 0.2)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) => (props.$active ? "white" : "var(--color-gray-f5)")};
    background: ${(props) =>
      props.$active
        ? "var(--color-blue-primary-dark)"
        : "rgba(255, 255, 255, 0.12)"};
  }
`;

const ExperimentalInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  background: rgba(111, 126, 141, 0.12);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-gray-f5);
  }
`;

const ExperimentalSelect = styled.select`
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  background: rgba(111, 126, 141, 0.12);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-gray-f5);
  }
`;

const ExperimentalActionButton = styled.button`
  height: 40px;
  border: none;
  border-radius: 999px;
  padding: 0 14px;
  margin-bottom: 24px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  background: var(--color-blue-primary);
  color: white;

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-blue-primary-dark);
  }
`;

const ExperimentalInlineError = styled.div`
  font-size: 12px;
  line-height: 1.35;
  color: var(--dangerButtonBackground);
  text-align: center;

  @media (prefers-color-scheme: dark) {
    color: var(--dangerButtonBackgroundDark);
  }
`;

const TopRightPopover = styled(TopRightPopoverBase)`
  box-sizing: border-box;
`;

const MorePopover = styled(HowToPlayPopoverSurface)``;

const MoreHelpContent = styled.div`
  ${howToPlayContentStyles}
`;

const MoreActions = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: min(22em, 100%);
  padding-top: 2px;
  margin-bottom: 6px;
`;

const MoreActionButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 999px;
  background: rgba(118, 119, 135, 0.08);
  color: var(--iconLinkButtonTextHover);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    transform 140ms ease;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background: rgba(118, 119, 135, 0.13);
      color: var(--navigationTextMuted);
    }
  }

  &:active {
    background: rgba(118, 119, 135, 0.16);
    transform: scale(0.98);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(118, 119, 135, 0.18);
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.06);
    color: var(--iconLinkButtonTextHoverDark);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--secondaryTextColorDark);
      }
    }

    &:active {
      background: rgba(255, 255, 255, 0.13);
    }

    &:focus-visible {
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.14);
    }
  }

  svg {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
  }

  @media (pointer: coarse) {
    min-height: 44px;
  }
`;

const MusicPopover = styled(TopRightPopover)`
  width: min(220px, 70dvw);
  padding: 10px;
  text-align: center;
  transform: none;
  transition: none;
`;

const MusicControlsContainer = styled.div`
  display: grid;
  grid-template-columns:
    repeat(3, minmax(0, 1fr)) 1px
    minmax(0, 1fr);
  gap: 4px;
  align-items: center;
`;

const MusicControlsSeparator = styled.span`
  width: 1px;
  height: 20px;
  background: rgba(118, 119, 135, 0.17);

  @media (prefers-color-scheme: dark) {
    background: rgba(153, 153, 168, 0.16);
  }
`;

const MusicControlButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 10px 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--color-blue-0066cc);
  cursor: pointer;
  font-size: 18px;
  outline: none;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;

  @media (prefers-color-scheme: dark) {
    color: var(--color-blue-66b3ff);
  }

  svg {
    width: 18px;
    height: 18px;
  }
`;

type MainMenuApi = {
  close: () => void;
  closeIfAllowedForEvent: (event: TouchEvent | MouseEvent) => void;
  isOpen: () => boolean;
};

type TopRightControlsApi = {
  close: () => void;
  hasVisiblePopover: () => boolean;
};

let mainMenuApi: MainMenuApi | null = null;
let topRightControlsApi: TopRightControlsApi | null = null;

const closeTopRightPopover = () => {
  topRightControlsApi?.close();
};

export const closeMenuAndInfoIfAny = () => {
  mainMenuApi?.close();
  closeTopRightPopover();
};

export const closeAllKindsOfPopups = () => {
  closeProfilePopupIfAny();
  closeNavigationAndAppearancePopupIfAny();
  mainMenuApi?.close();
  closeTopRightPopover();
};

export const closeMenuAndInfoIfAllowedForEvent = (
  event: TouchEvent | MouseEvent,
) => {
  mainMenuApi?.closeIfAllowedForEvent(event);
};

export function hasMainMenuPopupsVisible(): boolean {
  return (
    (mainMenuApi?.isOpen() ?? false) ||
    (topRightControlsApi?.hasVisiblePopover() ?? false)
  );
}

interface TopRightControlsProps {
  authState: AuthState;
  isMuted: boolean;
  isVisible: boolean;
  onBeforeOpen: () => void;
  onToggleMute: () => void;
  onOpenSettings: (returnFocusId?: string) => void;
  onRequestLogout: (returnFocusId?: string) => void;
}

const getVisibleTopRightPopover = (
  activePopover: TopRightPopoverName,
  isVisible: boolean,
  isAuthenticated: boolean,
): TopRightPopoverName => {
  if (!isVisible) {
    return null;
  }
  if (activePopover === "music") {
    return "music";
  }
  if (activePopover === "inventory") {
    return "inventory";
  }
  if (activePopover === "more" && isAuthenticated) {
    return "more";
  }
  if (activePopover === "info" && !isAuthenticated) {
    return "info";
  }
  return null;
};

export const TopRightControls: React.FC<TopRightControlsProps> = ({
  authState,
  isMuted,
  isVisible,
  onBeforeOpen,
  onToggleMute,
  onOpenSettings,
  onRequestLogout,
}) => {
  const isAuthenticated = authState.authStatus === "authenticated";
  const [activeTopRightPopover, setActiveTopRightPopover] =
    useState<TopRightPopoverName>(null);
  const visibleTopRightPopover = getVisibleTopRightPopover(
    activeTopRightPopover,
    isVisible,
    isAuthenticated,
  );
  const isInfoOpen = visibleTopRightPopover === "info";
  const isMoreOpen = visibleTopRightPopover === "more";
  const isMusicOpen = visibleTopRightPopover === "music";
  const isInventoryOpen = visibleTopRightPopover === "inventory";
  const isMusicPlaying = useSyncExternalStore(
    subscribeToMusicPlayback,
    getIsMusicPlaying,
  );
  const visibleTopRightPopoverRef = useRef(visibleTopRightPopover);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const musicButtonRef = useRef<HTMLButtonElement>(null);
  const gemButtonRef = useRef<HTMLButtonElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const musicRef = useRef<HTMLDivElement>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const musicFirstControlRef = useRef<HTMLButtonElement>(null);
  const inventoryIdentityKey = JSON.stringify([
    isAuthenticated,
    authState.profileId,
    authState.solAddress,
    authState.ethAddress,
  ]);

  useLayoutEffect(() => {
    visibleTopRightPopoverRef.current = visibleTopRightPopover;
  }, [visibleTopRightPopover]);

  const updateActiveTopRightPopover = useCallback(
    (nextPopover: TopRightPopoverName) => {
      visibleTopRightPopoverRef.current = getVisibleTopRightPopover(
        nextPopover,
        isVisible,
        isAuthenticated,
      );
      setActiveTopRightPopover(nextPopover);
    },
    [isAuthenticated, isVisible],
  );

  useEffect(() => {
    const api: TopRightControlsApi = {
      close: () => updateActiveTopRightPopover(null),
      hasVisiblePopover: () => visibleTopRightPopoverRef.current !== null,
    };
    topRightControlsApi = api;
    return () => {
      if (topRightControlsApi === api) {
        topRightControlsApi = null;
      }
    };
  }, [updateActiveTopRightPopover]);

  useEffect(() => {
    setMusicMuted(isMuted);
  }, [isMuted]);

  useEffect(() => {
    if (activeTopRightPopover !== null && visibleTopRightPopover === null) {
      updateActiveTopRightPopover(null);
    }
  }, [
    activeTopRightPopover,
    updateActiveTopRightPopover,
    visibleTopRightPopover,
  ]);

  useEffect(() => {
    if (visibleTopRightPopover === null) {
      return;
    }
    let focusTarget: HTMLElement | null;
    if (visibleTopRightPopover === "info") {
      focusTarget = infoRef.current;
    } else if (visibleTopRightPopover === "more") {
      focusTarget = moreRef.current;
    } else if (visibleTopRightPopover === "inventory") {
      focusTarget = inventoryRef.current;
    } else {
      focusTarget = musicFirstControlRef.current;
    }
    if (!focusTarget) {
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      focusTarget.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [visibleTopRightPopover]);

  useEffect(() => {
    if (visibleTopRightPopover === null) {
      return;
    }
    const openPopover = visibleTopRightPopover;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateActiveTopRightPopover(null);
      window.requestAnimationFrame(() => {
        const trigger =
          openPopover === "music"
            ? musicButtonRef.current
            : openPopover === "inventory"
              ? gemButtonRef.current
              : primaryButtonRef.current;
        trigger?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [updateActiveTopRightPopover, visibleTopRightPopover]);

  useEffect(() => {
    if (visibleTopRightPopover === null) {
      return;
    }
    const openPopover = visibleTopRightPopover;
    const handleTapOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const targetElement =
        target instanceof Element ? target : target.parentElement;
      if (
        openPopover === "inventory" &&
        targetElement?.closest('[data-inventory-item-preview="true"]')
      ) {
        return;
      }
      const popover =
        openPopover === "info"
          ? infoRef.current
          : openPopover === "more"
            ? moreRef.current
            : openPopover === "inventory"
              ? inventoryRef.current
              : musicRef.current;
      const trigger =
        openPopover === "music"
          ? musicButtonRef.current
          : openPopover === "inventory"
            ? gemButtonRef.current
            : primaryButtonRef.current;
      if (popover && !popover.contains(target) && !trigger?.contains(target)) {
        const targetClaimsFocus =
          target instanceof Element &&
          target.closest(FOCUS_CLAIMING_TARGET_SELECTOR) !== null;
        const hadPopoverFocus = popover.contains(document.activeElement);
        didDismissSomethingWithOutsideTapJustNow();
        updateActiveTopRightPopover(null);
        if (hadPopoverFocus) {
          window.requestAnimationFrame(() => {
            const activeElement = document.activeElement;
            if (
              (event.defaultPrevented || !targetClaimsFocus) &&
              (activeElement === null ||
                activeElement === document.body ||
                popover.contains(activeElement)) &&
              trigger?.isConnected
            ) {
              trigger.focus({ preventScroll: true });
            }
          });
        }
      }
    };

    document.addEventListener(defaultEarlyInputEventName, handleTapOutside);
    return () => {
      document.removeEventListener(
        defaultEarlyInputEventName,
        handleTapOutside,
      );
    };
  }, [updateActiveTopRightPopover, visibleTopRightPopover]);

  const togglePopover = (
    popover: Exclude<TopRightPopoverName, null>,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (visibleTopRightPopover === popover) {
      updateActiveTopRightPopover(null);
      return;
    }
    onBeforeOpen();
    updateActiveTopRightPopover(popover);
  };

  const handleDismissInventory = () => {
    didDismissSomethingWithOutsideTapJustNow();
    updateActiveTopRightPopover(null);
    window.requestAnimationFrame(() => {
      gemButtonRef.current?.focus({ preventScroll: true });
    });
  };

  const handleMusicPlaybackToggle = () => {
    if (isMusicPlaying) {
      stopPlayingMusic();
    } else {
      startPlayingMusic();
    }
  };

  const handleOpenSettingsFromMore = () => {
    updateActiveTopRightPopover(null);
    onOpenSettings(TOP_RIGHT_CONTROL_IDS.more);
  };

  const handleLogoutFromMore = () => {
    updateActiveTopRightPopover(null);
    onRequestLogout(TOP_RIGHT_CONTROL_IDS.more);
  };

  const primaryTopRightPopover = isAuthenticated ? "more" : "info";

  return (
    <>
      {isVisible && (
        <div className="small-top-control-buttons">
          <button
            ref={primaryButtonRef}
            id={TOP_RIGHT_CONTROL_IDS[primaryTopRightPopover]}
            type="button"
            className={isAuthenticated ? "more-button" : "info-button"}
            onClick={(event) => togglePopover(primaryTopRightPopover, event)}
            aria-label={isAuthenticated ? "More" : "Info"}
            aria-haspopup="dialog"
            aria-controls={TOP_RIGHT_POPOVER_IDS[primaryTopRightPopover]}
            aria-expanded={visibleTopRightPopover === primaryTopRightPopover}
          >
            {isAuthenticated ? <FaEllipsisH /> : <FaInfoCircle />}
          </button>
          <button
            ref={musicButtonRef}
            id={TOP_RIGHT_CONTROL_IDS.music}
            type="button"
            className="music-button"
            onClick={(event) => togglePopover("music", event)}
            aria-label="Music"
            aria-haspopup="dialog"
            aria-controls={TOP_RIGHT_POPOVER_IDS.music}
            aria-expanded={isMusicOpen}
          >
            <FaMusic />
          </button>
          <button
            ref={gemButtonRef}
            id={TOP_RIGHT_CONTROL_IDS.gem}
            type="button"
            className="gem-button"
            onClick={(event) => togglePopover("inventory", event)}
            aria-label="Collectibles"
            aria-haspopup="dialog"
            aria-controls={TOP_RIGHT_POPOVER_IDS.inventory}
            aria-expanded={isInventoryOpen}
          >
            <FaRegGem />
          </button>
        </div>
      )}

      {!isAuthenticated && (
        <InfoPopover
          ref={infoRef}
          id={TOP_RIGHT_POPOVER_IDS.info}
          isOpen={isInfoOpen}
        />
      )}

      {isAuthenticated && (
        <MorePopover
          ref={moreRef}
          id={TOP_RIGHT_POPOVER_IDS.more}
          $isOpen={isMoreOpen}
          role="dialog"
          aria-label="More"
          aria-hidden={!isMoreOpen}
          tabIndex={-1}
        >
          <MoreHelpContent>
            <HowToPlayContent />
            <br />
            <HowToPlaySeparator ariaHidden />
          </MoreHelpContent>
          <MoreActions>
            <MoreActionButton
              type="button"
              onClick={handleOpenSettingsFromMore}
            >
              <FaCog />
              <span>Settings</span>
            </MoreActionButton>
            <MoreActionButton type="button" onClick={handleLogoutFromMore}>
              <FaPowerOff />
              <span>Log Out</span>
            </MoreActionButton>
          </MoreActions>
        </MorePopover>
      )}

      <MusicPopover
        ref={musicRef}
        id={TOP_RIGHT_POPOVER_IDS.music}
        $isOpen={isMusicOpen}
        role="dialog"
        aria-label="Music"
        aria-hidden={!isMusicOpen}
        tabIndex={-1}
      >
        <MusicControlsContainer>
          <MusicControlButton
            ref={musicFirstControlRef}
            type="button"
            onClick={() => playPreviousTrack()}
            aria-label="Previous track"
          >
            <FaBackward />
          </MusicControlButton>
          <MusicControlButton
            type="button"
            onClick={handleMusicPlaybackToggle}
            aria-label={isMusicPlaying ? "Stop music" : "Play music"}
          >
            {isMusicPlaying ? <FaStop /> : <FaPlay />}
          </MusicControlButton>
          <MusicControlButton
            type="button"
            onClick={() => playNextTrack()}
            aria-label="Next track"
          >
            <FaForward />
          </MusicControlButton>
          <MusicControlsSeparator aria-hidden="true" />
          <MusicControlButton
            type="button"
            onClick={onToggleMute}
            aria-label={isMuted ? "Unmute all audio" : "Mute all audio"}
            aria-pressed={isMuted}
          >
            {isMuted ? <FaVolumeMute /> : <FaVolumeUp />}
          </MusicControlButton>
        </MusicControlsContainer>
      </MusicPopover>

      {isInventoryOpen && (
        <InventoryModal
          key={inventoryIdentityKey}
          ref={inventoryRef}
          id={TOP_RIGHT_POPOVER_IDS.inventory}
          authState={authState}
          onDismiss={handleDismissInventory}
          onPreviewOutsideDismiss={didDismissSomethingWithOutsideTapJustNow}
        />
      )}
    </>
  );
};

const MainMenu: React.FC = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const [showExperimental, setShowExperimental] = useState(false);
  const [eventStartsInMinutes, setEventStartsInMinutes] = useState("5");
  const initialScheduledDateTimeRef = useRef(
    getDefaultScheduledDateTimeInput(),
  );
  const [eventScheduleMode, setEventScheduleMode] =
    useState<EventScheduleMode>("minutes");
  const [eventScheduledDate, setEventScheduledDate] = useState(
    () => initialScheduledDateTimeRef.current.date,
  );
  const [eventScheduledTime, setEventScheduledTime] = useState(
    () => initialScheduledDateTimeRef.current.time,
  );
  const [eventScheduledTimezone, setEventScheduledTimezone] =
    useState<EventScheduleTimezone>("local");
  const [eventAnnounceOnTelegram, setEventAnnounceOnTelegram] = useState(false);
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [eventCreateError, setEventCreateError] = useState("");

  const [areAnimatedMonsEnabled, setAreAnimatedMonsEnabled] = useState<boolean>(
    storage.getIsExperimentingWithSprites(false),
  );
  const [leaderboardType, setLeaderboardType] = useState<LeaderboardType>(
    () => {
      const stored = storage.getLeaderboardType("rating");
      const resolved = stored === "gp" ? "mp" : stored;
      return LEADERBOARD_TYPES.includes(resolved as LeaderboardType)
        ? (resolved as LeaderboardType)
        : "rating";
    },
  );
  const [materialUrls, setMaterialUrls] = useState<
    Record<MiningMaterialName, string | null>
  >({
    dust: null,
    slime: null,
    gum: null,
    metal: null,
    ice: null,
  });
  const [specialLeaderboardTypeUrls, setSpecialLeaderboardTypeUrls] = useState<
    Record<LeaderboardSpecialType, string | null>
  >({
    rating: null,
    mp: null,
  });
  const lastClickTime = useRef(0);
  const [cracks, setCracks] = useState<Array<{ angle: number; color: string }>>(
    [],
  );
  const animationFrameRef = useRef<number | null>(null);
  const activeIndicesRef = useRef<number[]>([]);
  const isMenuOpenRef = useRef(isMenuOpen);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    isMenuOpenRef.current = isMenuOpen;
  }, [isMenuOpen]);

  useEffect(() => {
    let mounted = true;
    MATERIAL_TYPES.forEach((name) => {
      void getMaterialImageUrl(name).then((url) => {
        if (mounted) {
          setMaterialUrls((prev) =>
            prev[name] === url ? prev : { ...prev, [name]: url },
          );
        }
      });
    });
    (
      Object.keys(LEADERBOARD_TYPE_ICON_URLS) as LeaderboardSpecialType[]
    ).forEach((type) => {
      void getSpecialLeaderboardTypeImageUrl(type).then((url) => {
        if (mounted) {
          setSpecialLeaderboardTypeUrls((prev) =>
            prev[type] === url ? prev : { ...prev, [type]: url },
          );
        }
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleLeaderboardTypeChange = useCallback((type: LeaderboardType) => {
    setLeaderboardType(type);
    storage.setLeaderboardType(type);
  }, []);

  useEffect(() => {
    const timeoutRefs: NodeJS.Timeout[] = [];

    if (isMenuOpen) {
      const colors = ["var(--crackAnimationColor)"];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];
      const newCracks = Array.from({ length: 6 }, () => ({
        angle: Math.random() * 140 + 180,
        color: randomColor,
      }));
      setCracks(newCracks);

      const animateCracks = () => {
        let indices: number[] = [];
        while (indices.length < 3) {
          const randomIndex = Math.floor(Math.random() * 6);
          if (!indices.includes(randomIndex)) {
            indices.push(randomIndex);
          }
        }
        activeIndicesRef.current = indices;

        setCracks((prevCracks) => {
          const newCracks = [...prevCracks];
          indices.forEach((index) => {
            newCracks[index] = {
              ...newCracks[index],
              angle: Math.random() * 140 + 180,
            };
          });
          return newCracks;
        });

        animationFrameRef.current = requestAnimationFrame(() => {
          timeoutRefs.push(setTimeout(animateCracks, 5000));
        });
      };

      timeoutRefs.push(setTimeout(animateCracks, 100));
    } else {
      setCracks([]);
      activeIndicesRef.current = [];
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      timeoutRefs.forEach(clearTimeout);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      timeoutRefs.forEach(clearTimeout);
    };
  }, [isMenuOpen]);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
    if (!isMenuOpen) {
      setShowExperimental(false);
      closeTopRightPopover();
    }
  };

  const handleTitleClick = () => {
    const now = Date.now();
    if (now - lastClickTime.current < 500) {
      if (clickCount === 1) {
        showExperimentalFeaturesSelection();
        setClickCount(0);
      } else {
        setClickCount(clickCount + 1);
      }
    } else {
      setClickCount(0);
    }
    lastClickTime.current = now;
  };

  const showExperimentalFeaturesSelection = () => {
    const defaults = getDefaultScheduledDateTimeInput();
    setShowExperimental(true);
    setEventScheduleMode("minutes");
    setEventScheduledDate(defaults.date);
    setEventScheduledTime(defaults.time);
    setEventScheduledTimezone("local");
    setEventAnnounceOnTelegram(false);
    setEventCreateError("");
  };

  const handleBooleanToggle =
    (
      setValue: React.Dispatch<React.SetStateAction<boolean>>,
      applyValue: (checked: boolean) => void,
    ) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const checked = event.target.checked;
      setValue(checked);
      applyValue(checked);
    };

  const handleAnimatedMonsToggle = handleBooleanToggle(
    setAreAnimatedMonsEnabled,
    (checked) => {
      setAnimatedMonsEnabled(checked, false);
    },
  );

  const handleCreateEvent = useCallback(() => {
    let createRequest: number | EventCreateDateTimePayload;
    if (eventScheduleMode === "minutes") {
      const parsedStartsInMinutes = Math.floor(Number(eventStartsInMinutes));
      if (
        !Number.isFinite(parsedStartsInMinutes) ||
        parsedStartsInMinutes < 1
      ) {
        setEventCreateError("Enter at least 1 minute.");
        return;
      }
      createRequest = parsedStartsInMinutes;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventScheduledDate)) {
        setEventCreateError("Enter a valid date.");
        return;
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventScheduledTime)) {
        setEventCreateError("Enter a valid time.");
        return;
      }
      const localTimezoneIana =
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (eventScheduledTimezone === "local" && !localTimezoneIana) {
        setEventCreateError("Could not detect local timezone.");
        return;
      }
      createRequest = {
        scheduledDate: eventScheduledDate,
        scheduledTime: eventScheduledTime,
        scheduledTimezone: eventScheduledTimezone,
        ...(eventScheduledTimezone === "local" ? { localTimezoneIana } : {}),
      };
    }
    setEventCreateError("");
    setIsCreatingEvent(true);
    setIsMenuOpen(false);
    setShowExperimental(false);
    openEventModalPendingCreate({ restoreHomeOnClose: false });
    void connection
      .createEvent(createRequest, {
        announceOnTelegram: eventAnnounceOnTelegram,
      })
      .then((result) => {
        if (!result.ok || !result.eventId) {
          setEventModalPendingCreateError("Failed to create event.");
          return;
        }
        const modalState = getEventModalState();
        if (!modalState.isOpen || !modalState.isPendingCreate) {
          return;
        }
        openEventModal(result.eventId, { restoreHomeOnClose: false });
      })
      .catch((error) => {
        const message =
          error &&
          typeof error === "object" &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.replace(
                /^Firebase:\s*/i,
                "",
              )
            : "Failed to create event.";
        setEventModalPendingCreateError(message);
      })
      .finally(() => {
        setIsCreatingEvent(false);
      });
  }, [
    eventScheduleMode,
    eventStartsInMinutes,
    eventScheduledDate,
    eventScheduledTime,
    eventScheduledTimezone,
    eventAnnounceOnTelegram,
  ]);

  const closeMainMenuPopupsHandler = useCallback(() => {
    setIsMenuOpen(false);
    closeTopRightPopover();
  }, []);

  const closeMenuIfAllowedForEvent = useCallback(
    (event: TouchEvent | MouseEvent) => {
      if (
        isMenuOpenRef.current &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        closeMainMenuPopupsHandler();
      }
    },
    [closeMainMenuPopupsHandler],
  );

  useEffect(() => {
    return registerMainMenuTransientUiHandler(closeMainMenuPopupsHandler);
  }, [closeMainMenuPopupsHandler]);

  useEffect(() => {
    const api: MainMenuApi = {
      close: closeMainMenuPopupsHandler,
      closeIfAllowedForEvent: closeMenuIfAllowedForEvent,
      isOpen: () => isMenuOpenRef.current,
    };
    mainMenuApi = api;
    return () => {
      if (mainMenuApi === api) {
        mainMenuApi = null;
      }
    };
  }, [closeMainMenuPopupsHandler, closeMenuIfAllowedForEvent]);

  useEffect(() => {
    const handleTapOutside = (event: any) => {
      const shouldKeepVisibleWhenShinyCardIsBeingDismissed = isMobile
        ? showsShinyCardSomewhere ||
          !didNotDismissAnythingWithOutsideTapJustNow()
        : false;
      if (
        !shouldKeepVisibleWhenShinyCardIsBeingDismissed &&
        isMenuOpen &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        !event.target.closest('[data-shiny-card="true"]')
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        setIsMenuOpen(false);
        setShowExperimental(false);
      }
    };

    document.addEventListener("touchstart", handleTapOutside);
    return () => {
      document.removeEventListener("touchstart", handleTapOutside);
    };
  }, [isMenuOpen]);

  const showTotalAsIcons = MATERIAL_TYPES.every((name) => !!materialUrls[name]);
  const canCreatePilotEvents = isMonsLinkAdmin(
    storage.getUsername("").trim().toLowerCase(),
  );

  return (
    <>
      <RockButtonContainer ref={menuRef}>
        {isMenuOpen && (
          <CrackContainer>
            {cracks.map((crack, i) => (
              <Crack
                key={i}
                style={{
                  transform: `rotate(${crack.angle}deg)`,
                  background: crack.color,
                  top: "50%",
                  left: "50%",
                }}
              />
            ))}
          </CrackContainer>
        )}
        <RockMenuWrapper
          isOpen={isMenuOpen}
          onMouseLeave={(e) => {
            if (
              window.matchMedia("(hover: hover) and (pointer: fine)").matches
            ) {
              const relatedTarget = e.relatedTarget as Element | null;
              if (
                relatedTarget &&
                relatedTarget.closest &&
                !relatedTarget.closest('[data-shiny-card="true"]')
              ) {
                setIsMenuOpen(false);
                setShowExperimental(false);
              }
            }
          }}
        >
          <RockMenu isOpen={isMenuOpen} showLeaderboard={true}>
            <MenuContent>
              <MenuTitle
                onClick={!isMobile ? handleTitleClick : undefined}
                onTouchStart={isMobile ? handleTitleClick : undefined}
              >
                <MenuTitleText>MONS.LINK</MenuTitleText>
              </MenuTitle>
              <CloseButton
                onClick={() => {
                  setIsMenuOpen(false);
                  setShowExperimental(false);
                }}
              >
                ×
              </CloseButton>
              <MenuBody>
                {showExperimental && <MenuOverlay />}
                <LeaderboardTypeSelector>
                  {LEADERBOARD_TYPES.map((type) => {
                    const isMaterialType = isMaterialLeaderboardType(type);
                    const isSpecialType = type === "rating" || type === "mp";
                    const typeIconUrl =
                      type === "rating"
                        ? specialLeaderboardTypeUrls.rating
                        : type === "mp"
                          ? specialLeaderboardTypeUrls.mp
                          : isMaterialType
                            ? materialUrls[type]
                            : null;
                    const isTextType =
                      (type === "total" && !showTotalAsIcons) ||
                      (type !== "total" && !typeIconUrl);
                    return (
                      <LeaderboardTypeButton
                        key={type}
                        isSelected={leaderboardType === type}
                        isText={isTextType}
                        isSpecial={isSpecialType}
                        isTotal={type === "total"}
                        onClick={() => handleLeaderboardTypeChange(type)}
                        onTouchStart={
                          isMobile
                            ? (e) => {
                                e.stopPropagation();
                              }
                            : undefined
                        }
                      >
                        {type === "total" ? (
                          showTotalAsIcons ? (
                            <TotalMaterialsIconContainer>
                              <img
                                src={materialUrls.ice!}
                                alt="ice"
                                draggable={false}
                              />
                              <img
                                src={materialUrls.metal!}
                                alt="metal"
                                draggable={false}
                              />
                              <img
                                src={materialUrls.gum!}
                                alt="gum"
                                draggable={false}
                              />
                              <img
                                src={materialUrls.slime!}
                                alt="slime"
                                draggable={false}
                              />
                              <img
                                src={materialUrls.dust!}
                                alt="dust"
                                draggable={false}
                              />
                            </TotalMaterialsIconContainer>
                          ) : (
                            "Total"
                          )
                        ) : typeIconUrl ? (
                          isSpecialType ? (
                            <LeaderboardTypeSpecialIcon
                              src={typeIconUrl}
                              alt={type === "rating" ? "Elo" : "MP"}
                              draggable={false}
                            />
                          ) : (
                            <LeaderboardTypeMaterialIcon
                              src={typeIconUrl}
                              alt={type}
                              draggable={false}
                            />
                          )
                        ) : type === "rating" ? (
                          "Elo"
                        ) : type === "mp" ? (
                          "MP"
                        ) : (
                          type.charAt(0).toUpperCase() + type.slice(1)
                        )}
                      </LeaderboardTypeButton>
                    );
                  })}
                </LeaderboardTypeSelector>
                <Leaderboard
                  show={isMenuOpen}
                  leaderboardType={leaderboardType}
                />
                <LinksContainer>
                  <ButtonRow>
                    <IconLinkButton
                      href="https://mons.academy"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FaUniversity />
                    </IconLinkButton>
                    <IconLinkButton
                      href="https://x.com/supermetalx"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="1em"
                        height="1em"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path
                          d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                          stroke="currentColor"
                          strokeWidth="0.2"
                        />
                      </svg>
                    </IconLinkButton>
                    <IconLinkButton
                      href="https://farcaster.xyz/~/channel/mons"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <svg
                        width="1.2em"
                        height="1.2em"
                        viewBox="0 0 777 777"
                        xmlns="http://www.w3.org/2000/svg"
                        version="1.1"
                        fill="currentColor"
                      >
                        <path
                          id="path"
                          d="M145.778 44.556 L630.222 44.556 630.222 733.445 559.111 733.445 559.111 417.889 558.414 417.889 C550.554 330.677 477.258 262.333 388 262.333 298.742 262.333 225.446 330.677 217.586 417.889 L216.889 417.889 216.889 733.445 145.778 733.445 145.778 44.556 Z"
                        />
                        <path
                          id="path-1"
                          d="M16.889 142.333 L45.778 240.111 70.222 240.111 70.222 635.667 C57.949 635.667 48 645.616 48 657.889 L48 684.556 43.556 684.556 C31.283 684.556 21.333 694.505 21.333 706.778 L21.333 733.445 270.222 733.445 270.222 706.778 C270.222 694.505 260.273 684.556 248 684.556 L243.556 684.556 243.556 657.889 C243.556 645.616 233.606 635.667 221.333 635.667 L194.667 635.667 194.667 142.333 16.889 142.333 Z"
                        />
                        <path
                          id="path-2"
                          d="M563.556 635.667 C551.283 635.667 541.333 645.616 541.333 657.889 L541.333 684.556 536.889 684.556 C524.616 684.556 514.667 694.505 514.667 706.778 L514.667 733.445 763.556 733.445 763.556 706.778 C763.556 694.505 753.606 684.556 741.333 684.556 L736.889 684.556 736.889 657.889 C736.889 645.616 726.94 635.667 714.667 635.667 L714.667 240.111 739.111 240.111 768 142.333 590.222 142.333 590.222 635.667 563.556 635.667 Z"
                        />
                      </svg>
                    </IconLinkButton>
                    <IconLinkButton
                      href="https://t.me/supermetalmons"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FaTelegramPlane />
                    </IconLinkButton>
                    <IconLinkButton
                      href="https://github.com/supermetalmons"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="1em"
                        height="1em"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                      </svg>
                    </IconLinkButton>
                  </ButtonRow>
                </LinksContainer>
                {showExperimental && (
                  <ExperimentalMenu>
                    {canCreatePilotEvents && (
                      <>
                        <ScheduleModeToggle>
                          <ScheduleModeButton
                            type="button"
                            $active={eventScheduleMode === "minutes"}
                            onClick={() => {
                              setEventScheduleMode("minutes");
                              setEventCreateError("");
                            }}
                          >
                            In minutes
                          </ScheduleModeButton>
                          <ScheduleModeButton
                            type="button"
                            $active={eventScheduleMode === "datetime"}
                            onClick={() => {
                              setEventScheduleMode("datetime");
                              setEventCreateError("");
                            }}
                          >
                            Date & time
                          </ScheduleModeButton>
                        </ScheduleModeToggle>
                        {eventScheduleMode === "minutes" ? (
                          <ExperimentalInput
                            type="number"
                            min={MIN_STARTS_IN_MINUTES}
                            max={MAX_STARTS_IN_MINUTES}
                            step="1"
                            value={eventStartsInMinutes}
                            onChange={(event) => {
                              setEventStartsInMinutes(event.target.value);
                              setEventCreateError("");
                            }}
                            placeholder="minutes from now"
                          />
                        ) : (
                          <>
                            <ExperimentalInput
                              type="date"
                              value={eventScheduledDate}
                              onChange={(event) => {
                                setEventScheduledDate(event.target.value);
                                setEventCreateError("");
                              }}
                            />
                            <ExperimentalInput
                              type="time"
                              step="60"
                              value={eventScheduledTime}
                              onChange={(event) => {
                                setEventScheduledTime(event.target.value);
                                setEventCreateError("");
                              }}
                            />
                            <ExperimentalSelect
                              value={eventScheduledTimezone}
                              onChange={(event) => {
                                setEventScheduledTimezone(
                                  event.target.value as EventScheduleTimezone,
                                );
                                setEventCreateError("");
                              }}
                            >
                              {EVENT_SCHEDULE_TIMEZONE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </ExperimentalSelect>
                          </>
                        )}
                        <ExperimentalActionButton
                          type="button"
                          onClick={handleCreateEvent}
                          disabled={isCreatingEvent}
                        >
                          {isCreatingEvent
                            ? "Creating Event..."
                            : "Create Event"}
                        </ExperimentalActionButton>
                        <ToggleRow>
                          <input
                            type="checkbox"
                            checked={eventAnnounceOnTelegram}
                            onChange={(event) => {
                              setEventAnnounceOnTelegram(event.target.checked);
                            }}
                          />
                          announce on telegram
                        </ToggleRow>
                      </>
                    )}
                    {eventCreateError !== "" && (
                      <ExperimentalInlineError>
                        {eventCreateError}
                      </ExperimentalInlineError>
                    )}
                    <ToggleRow>
                      <input
                        type="checkbox"
                        checked={areAnimatedMonsEnabled}
                        onChange={handleAnimatedMonsToggle}
                      />
                      animated mons
                    </ToggleRow>
                    <BuildInfo>{getBuildInfo()}</BuildInfo>
                  </ExperimentalMenu>
                )}
              </MenuBody>
            </MenuContent>
          </RockMenu>
        </RockMenuWrapper>
        <RockButton
          {...(isMobile
            ? {
                onTouchStart: () => {
                  if (!isMenuOpen) {
                    closeProfilePopupIfAny();
                    closeNavigationAndAppearancePopupIfAny();
                  }
                  toggleMenu();
                  closeTopRightPopover();
                },
              }
            : {
                onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleMenu();
                },
                onMouseEnter: () => {
                  if (!isMenuOpen) {
                    closeProfilePopupIfAny();
                    closeNavigationAndAppearancePopupIfAny();
                  }
                  setIsMenuOpen(true);
                  closeTopRightPopover();
                },
              })}
        >
          <img src={logoBase64} alt="" />
        </RockButton>
      </RockButtonContainer>
    </>
  );
};

export default MainMenu;
