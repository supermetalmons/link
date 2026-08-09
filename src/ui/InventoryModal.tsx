import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styled, { keyframes } from "styled-components";
import {
  fetchNftsForIdentity,
  getNftIdentityKey,
} from "../services/nftService";
import {
  getActiveInventoryItemSelection,
  setOwnershipVerifiedIdCardEmoji,
  setOwnershipVerifiedSpecialItem,
} from "./ShinyCard";
import { AvatarImage } from "./AvatarImage";
import { storage } from "../utils/storage";
import type { AuthState } from "../connection/authentication";
import { TopRightPopoverBase } from "./TopRightPopoverBase";
import type { MaterialName } from "../services/rocksMiningService";
import { connection } from "../connection/connection";
import type { EventPrizeAssignment } from "../connection/connectionModels";
import { BottomPillButton } from "./BottomControlsStyles";
import { getEventPrizeDefinition } from "@mons/shared/event-prizes";
import { isValidSolanaAddress } from "@mons/shared/solana";

const SWAGPACK_ITEM_COUNT = 467;
const SWAGPACK_ID_OFFSET = 1000;
const SWAGPACK_INVENTORY_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/swagpack/420";
const SWAGPACK_THUMB_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/thumbs";
const MATERIAL_IMAGE_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";

const SPECIAL_ACTION_COPY: Readonly<
  Partial<Record<number, { action: string; current?: string }>>
> = {
  0: { action: "Pick Drainer" },
  1: { action: "Use card background", current: "Current Background" },
  2: { action: "Apply sticker", current: "Current Sticker" },
};

const SHOP_OFFERS: ReadonlyArray<{
  material: MaterialName;
  price: number;
}> = [
  { material: "dust", price: 10 },
  { material: "slime", price: 20 },
  { material: "gum", price: 30 },
  { material: "metal", price: 40 },
  { material: "ice", price: 50 },
];

const getRandomShopItemIds = (): number[] => {
  const ids = new Set<number>();
  while (ids.size < SHOP_OFFERS.length) {
    ids.add(Math.floor(Math.random() * SWAGPACK_ITEM_COUNT));
  }
  return Array.from(ids);
};

const SHOP_ITEM_IDS: readonly number[] = Object.freeze(getRandomShopItemIds());

const previewBackdropEnter = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const previewArtworkEnter = keyframes`
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
`;

const InventoryPreviewBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 90010;
  background: rgba(0, 0, 0, 0.01);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  outline: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  animation: ${previewBackdropEnter} 160ms ease-out both;

  @media (prefers-color-scheme: dark) {
    background: rgba(15, 15, 15, 0.11);
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const InventoryPreviewLayer = styled.div<{ $isCompact: boolean }>`
  position: fixed;
  inset: auto;
  z-index: 90011;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  pointer-events: none;
  cursor: pointer;
  outline: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;

  ${(props) =>
    props.$isCompact &&
    `
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 8px 20px;
    `}
`;

const PreviewArtwork = styled.div<{ $isCompact: boolean }>`
  position: relative;
  width: min(50dvh, 92dvw, 420px);
  aspect-ratio: 1 / 1;
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  animation: ${previewArtworkEnter} 180ms cubic-bezier(0.16, 1, 0.3, 1) both;

  ${(props) =>
    props.$isCompact &&
    `
      width: min(
        72dvw,
        260px,
        max(96px, calc(var(--inventory-preview-height) - 126px))
      );
      align-self: center;
      justify-self: center;
    `}

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const PreviewImage = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

const PreviewActionRow = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: max(14px, env(safe-area-inset-bottom));
  z-index: 90011;
  display: flex;
  justify-content: center;
  pointer-events: none;
`;

const PreviewActionHitbox = styled.div`
  padding: 20px;
  margin: -20px;
  pointer-events: auto;
  cursor: pointer;
`;

const PreviewActionButton = styled(BottomPillButton)`
  min-width: 150px;
  padding-right: 20px;
  padding-left: 20px;
  cursor: pointer;
`;

const PrizeWithdrawalControls = styled.div<{ $isCompact: boolean }>`
  position: absolute;
  left: 50%;
  bottom: max(14px, env(safe-area-inset-bottom));
  z-index: 90012;
  width: min(360px, calc(100dvw - 40px));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  pointer-events: auto;
  cursor: default;

  ${(props) =>
    props.$isCompact &&
    `
      position: static;
      grid-row: 2;
      width: min(360px, 100%);
      transform: none;
      justify-self: center;
    `}
`;

const PrizeWithdrawalInput = styled.input`
  width: 100%;
  height: 38px;
  box-sizing: border-box;
  border: 1px solid #b8b8b8;
  border-radius: 5px;
  padding: 7px 10px;
  outline: none;
  box-shadow: none;
  background: #fff;
  color: #222;
  font: inherit;
  font-size: 0.82rem;
  text-align: left;
  -webkit-tap-highlight-color: transparent;

  @media (pointer: coarse), (max-width: 520px) {
    font-size: 16px;
  }

  &:focus,
  &:focus-visible {
    outline: none;
    box-shadow: none;
  }

  &:disabled {
    background: #eee;
    color: #777;
  }

  @media (prefers-color-scheme: dark) {
    border-color: #686868;
    background: #2f2f2f;
    color: #f5f5f5;

    &:disabled {
      background: #3a3a3a;
      color: #aaa;
    }
  }
`;

const PrizeWithdrawalError = styled.div`
  min-height: 14px;
  color: #d64a4a;
  font-size: 0.7rem;
  font-weight: 650;
  line-height: 14px;
  text-align: center;
`;

const PrizeWithdrawalButton = styled(PreviewActionButton)<{
  $status: "idle" | "sending" | "success";
}>`
  ${(props) =>
    props.$status === "success" &&
    `
      background-color: #47d14d;
      color: var(--color-white);
      cursor: default;

      @media (hover: hover) and (pointer: fine) {
        &:hover {
          background-color: #47d14d;
        }
      }

      &:active {
        background-color: #47d14d;
      }
    `}
`;

const InventoryPopup = styled(TopRightPopoverBase)<{
  $isPreviewOpen: boolean;
}>`
  box-sizing: border-box;
  width: min(301px, calc(100dvw - 18px));
  max-height: calc(100dvh - 113px - env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  transform: none;
  transition: none;

  ${(props) =>
    props.$isPreviewOpen &&
    `
      pointer-events: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;

      & * {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        animation-play-state: paused !important;
        will-change: auto !important;
      }
    `}

  @media screen and (max-height: 500px) {
    max-height: calc(100dvh - 110px - env(safe-area-inset-bottom));
  }

  @media screen and (max-height: 453px) {
    max-height: calc(100dvh - 103px - env(safe-area-inset-bottom));
  }

  &:focus-visible {
    outline: none;
  }
`;

const Content = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  color: var(--color-gray-55);
  font-size: 0.95rem;
  user-select: none;
  cursor: default;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 100%;
  display: block;
  overflow-y: auto;
  overflow-x: hidden;
  text-align: left;
  padding: 2px 14px 14px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-d0);
  }
`;

const INVENTORY_SECTION_MIN_HEIGHT_PX = 128;

const LoadingText = styled.div`
  min-height: ${INVENTORY_SECTION_MIN_HEIGHT_PX}px;
  text-align: center;
  font-size: 0.8rem;
  color: var(--color-gray-77);
  display: flex;
  align-items: center;
  justify-content: center;

  @media (prefers-color-scheme: dark) {
    color: var(--leaderboardLoadingTextColorDark);
  }
`;

const ShopSection = styled.section`
  padding: 9px 3px 3px 0;
`;

const ShopGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;

  @media (max-width: 280px) {
    gap: 3px;
  }
`;

const ShopItem = styled.button`
  appearance: none;
  position: relative;
  min-width: 0;
  aspect-ratio: 1 / 1.32;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 7px;
  outline: none;
  font: inherit;
  background: var(--color-gray-f0);
  color: inherit;
  clip-path: inset(0 round 7px);

  @media (prefers-color-scheme: dark) {
    background: var(--inventoryItemBackgroundDark);
  }
`;

const ShopImageFrame = styled.div`
  position: absolute;
  inset: 0 0 auto;
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgb(255 255 255 / 38%);
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    &::after {
      background: rgb(0 0 0 / 18%);
    }
  }
`;

const ShopImage = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  opacity: 0.62;
  filter: blur(8px) saturate(0.5) brightness(1.08);
  transform: scale(1.24);
  pointer-events: none;
  -webkit-user-drag: none;
  user-drag: none;

  @media (prefers-color-scheme: dark) {
    opacity: 0.7;
    filter: blur(8px) saturate(0.5) brightness(0.9);
  }
`;

const PricePanel = styled.div`
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 3;
  width: 100%;
  height: 21px;
  min-width: 0;
  box-sizing: border-box;
  padding: 0 2px;
  overflow: hidden;
  border-radius: 0 0 7px 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: rgb(240 240 240 / 82%);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  color: var(--color-gray-69);
  -webkit-text-fill-color: currentColor;

  @media (prefers-color-scheme: dark) {
    background: rgb(42 42 42 / 82%);
    color: var(--color-gray-a0);
  }

  @media (max-width: 280px) {
    height: 19px;
    padding: 0 1px;
    gap: 0;
  }
`;

const PriceMaterialIcon = styled.img`
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: block;
  opacity: 0.62;
  pointer-events: none;
  -webkit-user-drag: none;
  user-drag: none;

  @media (max-width: 280px) {
    width: 14px;
    height: 14px;
  }
`;

const PriceAmount = styled.span`
  min-width: 0;
  font-size: 0.58rem;
  font-weight: 650;
  line-height: 1;
  font-family:
    ui-monospace,
    SFMono-Regular,
    SF Mono,
    Menlo,
    Consolas,
    "Liberation Mono",
    "Courier New",
    monospace;
  letter-spacing: 0.1px;

  @media (max-width: 280px) {
    font-size: 0.52rem;
  }
`;

const InventorySection = styled.section`
  padding-top: 7px;
  min-height: ${INVENTORY_SECTION_MIN_HEIGHT_PX}px;
  display: flex;
  flex-direction: column;
`;

const SwagPackLink = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-blue-primary);
  font-weight: 700;
  line-height: 1;
  text-decoration: none;

  @media (prefers-color-scheme: dark) {
    color: var(--color-blue-primary-dark);
  }
`;

const NFTGridContainer = styled.div`
  overflow: visible;
  width: 100%;
  box-sizing: border-box;
  padding: 3px 3px 6px;
`;

const NFTGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  width: 100%;
  padding-right: 0;
  overflow: visible;
`;

const NFTNameContainer = styled.button`
  appearance: none;
  width: 100%;
  min-width: 0;
  aspect-ratio: 1/1;
  margin: 0;
  padding: 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  overflow: hidden;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  text-align: center;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;

  &:focus-visible {
    outline: 2px solid var(--color-blue-primary);
    outline-offset: 2px;
  }

  @media (prefers-color-scheme: dark) {
    &:focus-visible {
      outline-color: var(--color-blue-primary-dark);
    }
  }
`;

const PrizeInventoryTile = styled(NFTNameContainer)`
  padding: 0;
`;

const PrizeInventoryImage = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  border-radius: 6px;
  pointer-events: none;
  -webkit-user-drag: none;
  user-drag: none;
`;

const AvatarTile = styled(NFTNameContainer)`
  position: relative;
  padding: 0;
  overflow: visible;
  transition:
    transform 0.13s ease-out,
    box-shadow 0.13s ease-out;
  will-change: transform;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  touch-action: pan-y;
  -ms-touch-action: pan-y;

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--interactiveActiveBackgroundLight);
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease-out;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      transform: scale(1.023);
    }
    &:active {
      transform: scale(0.95);
    }
  }

  @media (hover: none) and (pointer: coarse) {
    &:active {
      transform: scale(0.96);
    }
    &:active::after {
      opacity: 0.12;
    }
  }
`;

const SpecialImage = styled.img`
  width: 92%;
  height: 92%;
  object-fit: cover;
  display: block;
  border-radius: 6px;
  pointer-events: none;
  -webkit-user-drag: none;
  user-drag: none;
  z-index: 2;
`;

const CountIndicator = styled.div<{ count: number }>`
  position: absolute;
  bottom: -4px;
  right: -4px;
  background: var(--color-gray-e0-70);
  color: var(--color-black);
  font-size: 0.63rem;
  font-weight: 500;
  padding: 2px 4px;
  border-radius: 6px;
  min-width: 12px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  backdrop-filter: blur(2px);

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-44-70);
    color: var(--color-white);
  }
`;

interface CountedInventoryImageProps {
  kind: "avatar" | "special";
  src: string;
  count: number;
  rainbowAura?: boolean;
}

const CountedInventoryImage: React.FC<CountedInventoryImageProps> = ({
  kind,
  src,
  count,
  rainbowAura = false,
}) => {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  return (
    <>
      {kind === "avatar" ? (
        <AvatarImage
          src={src}
          alt=""
          rainbowAura={rainbowAura}
          loading="lazy"
          onLoad={() => setLoadedSrc(src)}
        />
      ) : (
        <SpecialImage
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setLoadedSrc(src)}
        />
      )}
      {count > 1 && loadedSrc === src && (
        <CountIndicator count={count}>{count}</CountIndicator>
      )}
    </>
  );
};

interface SwagAvatarItem {
  id: number;
  count: number;
}

type InventoryPreviewItem =
  | { kind: "avatar"; item: SwagAvatarItem }
  | { kind: "special"; item: SwagAvatarItem }
  | { kind: "eventPrize"; prize: EventPrizeAssignment };

type PrizeWithdrawalStatus = "idle" | "sending" | "success";

interface PreviewViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

const getPreviewViewport = (): PreviewViewport => {
  if (typeof window === "undefined") {
    return { left: 0, top: 0, width: 1024, height: 768 };
  }
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: Math.max(1, viewport?.width ?? window.innerWidth),
    height: Math.max(1, viewport?.height ?? window.innerHeight),
  };
};

const getPrizeWithdrawalErrorMessage = (error: unknown): string => {
  const errorData =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code =
    typeof errorData.code === "string"
      ? errorData.code.replace(/^functions\//, "")
      : "";
  const message =
    typeof errorData.message === "string" ? errorData.message : "";
  if (code === "invalid-argument") {
    return message.includes("destination other than")
      ? "Choose a different destination address."
      : "Enter a valid Solana address.";
  }
  if (code === "not-found" || code === "permission-denied") {
    return "This prize is no longer available.";
  }
  if (code === "aborted") {
    return "Withdrawal is already being processed. Try again shortly.";
  }
  if (code === "failed-precondition") {
    return message.includes("original destination")
      ? "Retry with the original destination address."
      : "This prize cannot be withdrawn right now.";
  }
  return "Could not send the prize. Please try again.";
};

interface InventoryModalProps {
  id: string;
  onDismiss: () => void;
  onPreviewOutsideDismiss: () => void;
  authState: AuthState;
}

export const InventoryModal = React.forwardRef<
  HTMLDivElement,
  InventoryModalProps
>(({ id, onDismiss, onPreviewOutsideDismiss, authState }, ref) => {
  const isAuthenticated = authState.authStatus === "authenticated";
  const [avatars, setAvatars] = useState<SwagAvatarItem[]>([]);
  const [specials, setSpecials] = useState<SwagAvatarItem[]>([]);
  const [eventPrizes, setEventPrizes] = useState<EventPrizeAssignment[]>([]);
  const [areEventPrizesLoading, setAreEventPrizesLoading] = useState(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [dataOk, setDataOk] = useState<boolean | null>(null);
  const [loadedInventory, setLoadedInventory] = useState<{
    ownerKey: string;
    expiresAtMs: number;
  } | null>(null);
  const [activeItemSelection, setActiveItemSelection] = useState(
    getActiveInventoryItemSelection,
  );
  const [inventoryRefreshVersion, setInventoryRefreshVersion] = useState(0);
  const [previewItem, setPreviewItem] = useState<InventoryPreviewItem | null>(
    null,
  );
  const [withdrawalAddress, setWithdrawalAddress] = useState("");
  const [isWithdrawalAddressVisible, setIsWithdrawalAddressVisible] =
    useState(false);
  const [withdrawalStatus, setWithdrawalStatus] =
    useState<PrizeWithdrawalStatus>("idle");
  const [withdrawalError, setWithdrawalError] = useState("");
  const [previewViewport, setPreviewViewport] =
    useState<PreviewViewport>(getPreviewViewport);
  const previewOverlayRef = useRef<HTMLDivElement>(null);
  const previewActionButtonRef = useRef<HTMLButtonElement>(null);
  const withdrawalControlsRef = useRef<HTMLDivElement>(null);
  const withdrawalInputRef = useRef<HTMLInputElement>(null);
  const withdrawalButtonRef = useRef<HTMLButtonElement>(null);
  const withdrawalInFlightRef = useRef(false);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const withdrawalDismissTimeoutRef = useRef<number | null>(null);
  const ownerKey = isAuthenticated ? getNftIdentityKey(authState) : null;
  const previewEventPrizeDefinition =
    previewItem?.kind === "eventPrize"
      ? getEventPrizeDefinition(
          previewItem.prize.eventId,
          previewItem.prize.prizeId,
        )
      : null;
  const isPrizeWithdrawalLocked =
    withdrawalStatus === "sending" || withdrawalStatus === "success";
  const isCompactWithdrawalViewport =
    previewItem?.kind === "eventPrize" &&
    isWithdrawalAddressVisible &&
    previewViewport.height < 560;

  useEffect(
    () => () => {
      if (withdrawalDismissTimeoutRef.current !== null) {
        window.clearTimeout(withdrawalDismissTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setEventPrizes([]);
    if (!isAuthenticated || !authState.profileId) {
      setAreEventPrizesLoading(false);
      return;
    }
    setAreEventPrizesLoading(true);
    return connection.subscribeToProfileEventPrizes(
      authState.profileId,
      (prizes) => {
        setEventPrizes(
          Object.values(prizes).sort((left, right) => {
            if (left.assignedAtMs !== right.assignedAtMs) {
              return right.assignedAtMs - left.assignedAtMs;
            }
            return left.place - right.place;
          }),
        );
        setAreEventPrizesLoading(false);
      },
      () => {
        setEventPrizes([]);
        setAreEventPrizesLoading(false);
      },
    );
  }, [authState.profileId, isAuthenticated]);

  useEffect(() => {
    let isCancelled = false;
    const fetchCurrentInventory = () => fetchNftsForIdentity(authState);
    const fetchTokens = async () => {
      setIsLoading(true);
      setAvatars([]);
      setSpecials([]);
      setDataOk(null);
      setLoadedInventory(null);
      try {
        let snapshot = await fetchCurrentInventory();
        if (isCancelled) {
          return;
        }
        let isSnapshotFresh = snapshot.expiresAtMs > Date.now();
        if (
          snapshot.data.ok === true &&
          snapshot.expiresAtMs > 0 &&
          !isSnapshotFresh
        ) {
          snapshot = await fetchCurrentInventory();
          if (isCancelled) {
            return;
          }
          isSnapshotFresh = snapshot.expiresAtMs > Date.now();
        }
        const data = isSnapshotFresh ? snapshot.data : { ok: false as const };
        const ok = data.ok === true;
        setDataOk(ok);
        setLoadedInventory(
          ok && ownerKey
            ? { ownerKey, expiresAtMs: snapshot.expiresAtMs }
            : null,
        );
        setAvatars(data.ok ? data.swagpack_avatars : []);
        setSpecials(data.ok ? data.specials : []);
      } catch {
        if (isCancelled) {
          return;
        }
        setAvatars([]);
        setSpecials([]);
        setDataOk(false);
        setLoadedInventory(null);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };
    fetchTokens();
    return () => {
      isCancelled = true;
    };
  }, [authState, inventoryRefreshVersion, ownerKey]);

  const canApplyInventoryItem = () => {
    if (
      !isAuthenticated ||
      !ownerKey ||
      loadedInventory?.ownerKey !== ownerKey
    ) {
      return false;
    }
    const hasCurrentStoredOwner =
      getNftIdentityKey(storage.getAuthIdentity()) === ownerKey;
    if (!hasCurrentStoredOwner) {
      return false;
    }
    if (loadedInventory.expiresAtMs <= Date.now()) {
      setInventoryRefreshVersion((current) => current + 1);
      return false;
    }
    return true;
  };

  const previewActionCopy =
    previewItem?.kind === "avatar"
      ? { action: "Set avatar" }
      : previewItem?.kind === "special"
        ? SPECIAL_ACTION_COPY[previewItem.item.id]
        : undefined;
  const desiredPreviewAvatarAura =
    previewItem?.kind === "avatar" && previewItem.item.count >= 3
      ? "rainbow"
      : "";
  const isPreviewItemCurrent =
    previewItem?.kind === "avatar"
      ? activeItemSelection.avatarId === previewItem.item.id &&
        storage.getPlayerEmojiAura("") === desiredPreviewAvatarAura
      : previewItem?.kind === "special"
        ? activeItemSelection.specialIds.has(previewItem.item.id)
        : false;
  const shouldShowPreviewAction =
    previewActionCopy !== undefined &&
    (!isPreviewItemCurrent || previewActionCopy.current !== undefined);
  const previewDialogLabel =
    previewItem?.kind === "avatar"
      ? `Avatar ${previewItem.item.id + SWAGPACK_ID_OFFSET}`
      : previewItem?.kind === "special"
        ? `Collectible ${previewItem.item.id}`
        : previewItem?.kind === "eventPrize"
          ? `Place ${previewItem.prize.place} event prize`
          : "Collectible preview";

  const openPreview = (
    item: InventoryPreviewItem,
    trigger: HTMLButtonElement,
  ) => {
    if (withdrawalDismissTimeoutRef.current !== null) {
      window.clearTimeout(withdrawalDismissTimeoutRef.current);
      withdrawalDismissTimeoutRef.current = null;
    }
    setWithdrawalAddress(
      item.kind === "eventPrize" ? authState.solAddress.trim() : "",
    );
    setIsWithdrawalAddressVisible(false);
    setWithdrawalStatus("idle");
    setWithdrawalError("");
    withdrawalInFlightRef.current = false;
    previewTriggerRef.current = trigger;
    setPreviewItem(item);
  };

  const dismissPreview = useCallback(
    (isOutsideTap = false, force = false) => {
      if (
        (isPrizeWithdrawalLocked || withdrawalInFlightRef.current) &&
        !force
      ) {
        return;
      }
      if (withdrawalDismissTimeoutRef.current !== null) {
        window.clearTimeout(withdrawalDismissTimeoutRef.current);
        withdrawalDismissTimeoutRef.current = null;
      }
      if (isOutsideTap) {
        onPreviewOutsideDismiss();
      }
      setPreviewItem(null);
      setIsWithdrawalAddressVisible(false);
      setWithdrawalStatus("idle");
      setWithdrawalError("");
      withdrawalInFlightRef.current = false;
      const trigger = previewTriggerRef.current;
      previewTriggerRef.current = null;
      window.requestAnimationFrame(() => {
        trigger?.focus({ preventScroll: true });
      });
    },
    [isPrizeWithdrawalLocked, onPreviewOutsideDismiss],
  );

  useLayoutEffect(() => {
    if (!previewItem) {
      return;
    }
    previewOverlayRef.current?.focus({ preventScroll: true });
  }, [previewItem]);

  useLayoutEffect(() => {
    if (!previewItem) {
      return;
    }
    const visualViewport = window.visualViewport;
    let animationFrameId: number | null = null;
    const updatePreviewViewport = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const next = getPreviewViewport();
        setPreviewViewport((current) =>
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.height === next.height
            ? current
            : next,
        );
      });
    };
    updatePreviewViewport();
    window.addEventListener("resize", updatePreviewViewport);
    visualViewport?.addEventListener("resize", updatePreviewViewport);
    visualViewport?.addEventListener("scroll", updatePreviewViewport);
    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      window.removeEventListener("resize", updatePreviewViewport);
      visualViewport?.removeEventListener("resize", updatePreviewViewport);
      visualViewport?.removeEventListener("scroll", updatePreviewViewport);
    };
  }, [previewItem]);

  useLayoutEffect(() => {
    if (
      !isWithdrawalAddressVisible ||
      previewItem?.kind !== "eventPrize" ||
      isPrizeWithdrawalLocked
    ) {
      return;
    }
    withdrawalInputRef.current?.focus({ preventScroll: true });
  }, [isPrizeWithdrawalLocked, isWithdrawalAddressVisible, previewItem]);

  useEffect(() => {
    if (!previewItem) {
      return;
    }
    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (isPrizeWithdrawalLocked) {
        return;
      }
      dismissPreview();
    };
    document.addEventListener("keydown", handlePreviewEscape, true);
    return () => {
      document.removeEventListener("keydown", handlePreviewEscape, true);
    };
  }, [dismissPreview, isPrizeWithdrawalLocked, previewItem]);

  const handleWithdrawEventPrize = async () => {
    if (
      previewItem?.kind !== "eventPrize" ||
      previewEventPrizeDefinition?.claimAvailable !== true ||
      isPrizeWithdrawalLocked ||
      withdrawalInFlightRef.current ||
      !isAuthenticated
    ) {
      return;
    }
    if (!isWithdrawalAddressVisible) {
      setWithdrawalError("");
      setIsWithdrawalAddressVisible(true);
      return;
    }
    const recipientAddress = withdrawalAddress.trim();
    if (!isValidSolanaAddress(recipientAddress)) {
      setWithdrawalError("Enter a valid Solana address.");
      return;
    }
    const prize = previewItem.prize;
    withdrawalInFlightRef.current = true;
    setWithdrawalAddress(recipientAddress);
    setWithdrawalError("");
    setWithdrawalStatus("sending");
    try {
      const response = await connection.withdrawEventPrize(
        prize.eventId,
        prize.prizeId,
        recipientAddress,
      );
      if (!response.ok || response.status !== "completed") {
        throw new Error("Prize withdrawal did not complete.");
      }
      setEventPrizes((current) =>
        current.filter(
          (candidate) =>
            candidate.eventId !== prize.eventId ||
            candidate.prizeId !== prize.prizeId,
        ),
      );
      setWithdrawalStatus("success");
      withdrawalDismissTimeoutRef.current = window.setTimeout(() => {
        withdrawalDismissTimeoutRef.current = null;
        dismissPreview(false, true);
      }, 1000);
    } catch (error) {
      withdrawalInFlightRef.current = false;
      setWithdrawalStatus("idle");
      setWithdrawalError(getPrizeWithdrawalErrorMessage(error));
    }
  };

  const handlePreviewDismissClick = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    if (
      target instanceof Node &&
      (previewActionButtonRef.current?.contains(target) ||
        withdrawalControlsRef.current?.contains(target))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dismissPreview(true);
  };

  const handlePreviewKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === "Enter" &&
      previewItem?.kind === "eventPrize" &&
      event.target === withdrawalInputRef.current
    ) {
      event.preventDefault();
      event.stopPropagation();
      void handleWithdrawEventPrize();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (previewItem?.kind === "eventPrize") {
      if (isPrizeWithdrawalLocked) {
        previewOverlayRef.current?.focus({ preventScroll: true });
        return;
      }
      const controls = [
        withdrawalInputRef.current,
        withdrawalButtonRef.current,
      ].filter((control): control is HTMLInputElement | HTMLButtonElement =>
        Boolean(control),
      );
      const currentIndex = controls.findIndex(
        (control) => control === event.target,
      );
      const nextIndex =
        currentIndex < 0
          ? event.shiftKey
            ? controls.length - 1
            : 0
          : (currentIndex + (event.shiftKey ? -1 : 1) + controls.length) %
            controls.length;
      controls[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (shouldShowPreviewAction && !isPreviewItemCurrent) {
      previewActionButtonRef.current?.focus({ preventScroll: true });
    } else {
      previewOverlayRef.current?.focus({ preventScroll: true });
    }
  };

  const handleApplyPreviewItem = () => {
    if (
      !previewItem ||
      !previewActionCopy ||
      isPreviewItemCurrent ||
      !canApplyInventoryItem()
    ) {
      return;
    }
    if (previewItem.kind === "avatar") {
      setOwnershipVerifiedIdCardEmoji(
        previewItem.item.id + SWAGPACK_ID_OFFSET,
        desiredPreviewAvatarAura,
      );
    } else if (previewItem.kind === "special") {
      setOwnershipVerifiedSpecialItem(previewItem.item.id);
    }
    setActiveItemSelection(getActiveInventoryItemSelection());
    window.requestAnimationFrame(() => {
      previewOverlayRef.current?.focus({ preventScroll: true });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }
  };

  return (
    <InventoryPopup
      ref={ref}
      id={id}
      $isOpen
      $isPreviewOpen={previewItem !== null}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-label="Collectibles"
    >
      <Content>
        <ShopSection aria-label="Shop">
          <ShopGrid>
            {SHOP_OFFERS.map(({ material, price }, index) => (
              <ShopItem
                key={material}
                type="button"
                disabled
                aria-label={`${price} ${material}, coming soon`}
              >
                <ShopImageFrame>
                  <ShopImage
                    src={`${SWAGPACK_THUMB_IMAGE_BASE_URL}/${
                      SHOP_ITEM_IDS[index] + SWAGPACK_ID_OFFSET
                    }.webp`}
                    alt=""
                    loading="eager"
                    decoding="async"
                    draggable={false}
                  />
                </ShopImageFrame>
                <PricePanel aria-hidden="true">
                  <PriceMaterialIcon
                    src={`${MATERIAL_IMAGE_BASE_URL}/${material}.webp`}
                    alt=""
                    draggable={false}
                  />
                  <PriceAmount>{price}</PriceAmount>
                </PricePanel>
              </ShopItem>
            ))}
          </ShopGrid>
        </ShopSection>
        <InventorySection aria-label="Inventory">
          {(isLoading || areEventPrizesLoading) &&
          avatars.length === 0 &&
          specials.length === 0 &&
          eventPrizes.length === 0 ? (
            <LoadingText>LOADING...</LoadingText>
          ) : avatars.length === 0 &&
            specials.length === 0 &&
            eventPrizes.length === 0 ? (
            dataOk ? (
              <LoadingText>
                <SwagPackLink
                  href="https://www.tensor.trade/trade/swag_pack"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get Swag Pack
                </SwagPackLink>
              </LoadingText>
            ) : (
              <LoadingText>Failed to load.</LoadingText>
            )
          ) : (
            <NFTGridContainer>
              <NFTGrid>
                {eventPrizes.map((prize) => {
                  const definition = getEventPrizeDefinition(
                    prize.eventId,
                    prize.prizeId,
                  );
                  if (!definition) {
                    return null;
                  }
                  return (
                    <PrizeInventoryTile
                      key={`event-prize-${prize.eventId}-${prize.prizeId}`}
                      type="button"
                      aria-label={`View place ${prize.place} prize from event ${prize.eventId}`}
                      onClick={(event) =>
                        openPreview(
                          { kind: "eventPrize", prize },
                          event.currentTarget,
                        )
                      }
                    >
                      <PrizeInventoryImage
                        src={definition.imageUrl}
                        alt=""
                        loading="lazy"
                      />
                    </PrizeInventoryTile>
                  );
                })}
                {specials.map((item) => {
                  const isActive = activeItemSelection.specialIds.has(item.id);
                  const imageSrc = `https://cdn.lil.org/mons/id_cards/misc/bd4/${item.id}.webp`;
                  return (
                    <AvatarTile
                      key={`special-${item.id}`}
                      type="button"
                      aria-label={`View collectible ${item.id}${
                        isActive ? ", current" : ""
                      }`}
                      onClick={(event) =>
                        openPreview(
                          { kind: "special", item },
                          event.currentTarget,
                        )
                      }
                    >
                      <CountedInventoryImage
                        kind="special"
                        src={imageSrc}
                        count={item.count}
                      />
                    </AvatarTile>
                  );
                })}
                {avatars.map((item) => {
                  const isActive = activeItemSelection.avatarId === item.id;
                  const imageSrc = `${SWAGPACK_INVENTORY_IMAGE_BASE_URL}/${item.id}.webp`;
                  return (
                    <AvatarTile
                      key={item.id}
                      type="button"
                      aria-label={`View avatar ${
                        item.id + SWAGPACK_ID_OFFSET
                      }${isActive ? ", current" : ""}`}
                      onClick={(event) =>
                        openPreview(
                          { kind: "avatar", item },
                          event.currentTarget,
                        )
                      }
                    >
                      <CountedInventoryImage
                        kind="avatar"
                        src={imageSrc}
                        count={item.count}
                        rainbowAura={item.count >= 3}
                      />
                    </AvatarTile>
                  );
                })}
              </NFTGrid>
            </NFTGridContainer>
          )}
        </InventorySection>
      </Content>
      {previewItem &&
        createPortal(
          <>
            <InventoryPreviewBackdrop
              data-inventory-item-preview="true"
              onClick={handlePreviewDismissClick}
            />
            <InventoryPreviewLayer
              ref={previewOverlayRef}
              $isCompact={isCompactWithdrawalViewport}
              style={
                {
                  top: previewViewport.top,
                  left: previewViewport.left,
                  width: previewViewport.width,
                  height: previewViewport.height,
                  "--inventory-preview-height": `${previewViewport.height}px`,
                } as React.CSSProperties
              }
              data-inventory-item-preview="true"
              role="dialog"
              aria-modal="true"
              aria-label={previewDialogLabel}
              tabIndex={-1}
              onClick={handlePreviewDismissClick}
              onKeyDown={handlePreviewKeyDown}
            >
              <PreviewArtwork $isCompact={isCompactWithdrawalViewport}>
                {previewItem.kind === "avatar" ? (
                  <AvatarImage
                    src={`${SWAGPACK_INVENTORY_IMAGE_BASE_URL}/${previewItem.item.id}.webp`}
                    alt=""
                    rainbowAura={previewItem.item.count >= 3}
                    loading="eager"
                  />
                ) : previewItem.kind === "special" ? (
                  <PreviewImage
                    src={`https://cdn.lil.org/mons/id_cards/misc/bd4/${previewItem.item.id}.webp`}
                    alt=""
                    draggable={false}
                  />
                ) : previewEventPrizeDefinition ? (
                  <PreviewImage
                    src={previewEventPrizeDefinition.imageUrl}
                    alt=""
                    draggable={false}
                  />
                ) : null}
              </PreviewArtwork>
              {previewItem.kind === "eventPrize" &&
                previewEventPrizeDefinition && (
                  <PrizeWithdrawalControls
                    ref={withdrawalControlsRef}
                    $isCompact={isCompactWithdrawalViewport}
                  >
                    {previewEventPrizeDefinition.claimAvailable &&
                      isWithdrawalAddressVisible && (
                        <>
                          <PrizeWithdrawalInput
                            ref={withdrawalInputRef}
                            type="text"
                            value={withdrawalAddress}
                            placeholder="Solana address"
                            aria-label="Solana address"
                            aria-invalid={withdrawalError ? "true" : undefined}
                            disabled={isPrizeWithdrawalLocked}
                            autoCapitalize="none"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) => {
                              setWithdrawalAddress(event.target.value);
                              setWithdrawalError("");
                            }}
                          />
                          <PrizeWithdrawalError
                            role="status"
                            aria-live="polite"
                          >
                            {withdrawalError}
                          </PrizeWithdrawalError>
                        </>
                      )}
                    {previewEventPrizeDefinition.claimAvailable ? (
                      <PrizeWithdrawalButton
                        ref={withdrawalButtonRef}
                        type="button"
                        $status={withdrawalStatus}
                        isBlue={withdrawalStatus === "idle"}
                        isViewOnly={withdrawalStatus === "sending"}
                        disabled={isPrizeWithdrawalLocked}
                        onClick={() => void handleWithdrawEventPrize()}
                      >
                        {withdrawalStatus === "sending"
                          ? "Sending..."
                          : withdrawalStatus === "success"
                            ? "Success"
                            : isWithdrawalAddressVisible
                              ? "Send"
                              : "Withdraw"}
                      </PrizeWithdrawalButton>
                    ) : (
                      <PrizeWithdrawalButton
                        type="button"
                        $status="idle"
                        isBlue={false}
                        isViewOnly={true}
                        disabled={true}
                      >
                        Claim coming soon
                      </PrizeWithdrawalButton>
                    )}
                  </PrizeWithdrawalControls>
                )}
              {previewActionCopy && shouldShowPreviewAction && (
                <PreviewActionRow>
                  <PreviewActionHitbox>
                    <PreviewActionButton
                      ref={previewActionButtonRef}
                      type="button"
                      isBlue={!isPreviewItemCurrent}
                      isViewOnly={isPreviewItemCurrent}
                      disabled={isPreviewItemCurrent}
                      onClick={handleApplyPreviewItem}
                    >
                      {isPreviewItemCurrent
                        ? previewActionCopy.current
                        : previewActionCopy.action}
                    </PreviewActionButton>
                  </PreviewActionHitbox>
                </PreviewActionRow>
              )}
            </InventoryPreviewLayer>
          </>,
          document.body,
        )}
    </InventoryPopup>
  );
});

InventoryModal.displayName = "InventoryModal";
