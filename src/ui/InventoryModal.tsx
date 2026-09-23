import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styled from "styled-components";
import {
  fetchNftsForIdentity,
  getNftIdentityKey,
} from "../services/nftService";
import {
  getActiveInventoryItemSelection,
  setOwnershipVerifiedIdCardEmoji,
  setOwnershipVerifiedSpecialItem,
} from "./shinyCardUiPort";
import { AvatarImage } from "./AvatarImage";
import { storage } from "../utils/storage";
import type { AuthState } from "../connection/authModels";
import { TopRightPopoverBase } from "./TopRightPopoverBase";
import type { MaterialName } from "../services/rocksMiningService";
import type { EventPrizeAssignment } from "../connection/connectionModels";
import {
  subscribeToProfileEventPrizes,
  withdrawProfileEventPrize,
} from "./profileSurfaceDataPort";
import { getEventPrizeDefinition } from "@mons/shared/event-prizes";

import { InventoryItemPreview } from "./InventoryItemPreview";
import {
  SWAGPACK_ID_OFFSET,
  SWAGPACK_INVENTORY_IMAGE_BASE_URL,
  type InventoryApplicableItem,
  type InventoryPreviewItem,
  type SwagAvatarItem,
} from "./inventoryItems";

const SWAGPACK_ITEM_COUNT = 467;
const SWAGPACK_THUMB_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/thumbs";
const MATERIAL_IMAGE_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";

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

const CountIndicator = styled.div`
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
        <CountIndicator>{count}</CountIndicator>
      )}
    </>
  );
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
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusFrameRef = useRef<number | null>(null);
  useLayoutEffect(
    () => () => {
      if (returnFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(returnFocusFrameRef.current);
      }
    },
    [],
  );
  const ownerKey = isAuthenticated ? getNftIdentityKey(authState) : null;
  useEffect(() => {
    setEventPrizes([]);
    if (!isAuthenticated || !authState.profileId) {
      setAreEventPrizesLoading(false);
      return;
    }
    setAreEventPrizesLoading(true);
    return subscribeToProfileEventPrizes(
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
  const openPreview = (
    item: InventoryPreviewItem,
    trigger: HTMLButtonElement,
  ) => {
    previewTriggerRef.current = trigger;
    setPreviewItem(item);
  };

  const dismissPreview = useCallback(
    (isOutsideTap: boolean) => {
      if (isOutsideTap) {
        onPreviewOutsideDismiss();
      }
      setPreviewItem(null);
      const trigger = previewTriggerRef.current;
      previewTriggerRef.current = null;
      if (returnFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(returnFocusFrameRef.current);
      }
      returnFocusFrameRef.current = window.requestAnimationFrame(() => {
        returnFocusFrameRef.current = null;
        trigger?.focus({ preventScroll: true });
      });
    },
    [onPreviewOutsideDismiss],
  );

  const handleApplyPreviewItem = (item: InventoryApplicableItem): boolean => {
    if (isPreviewItemCurrent || !canApplyInventoryItem()) {
      return false;
    }
    if (item.kind === "avatar") {
      setOwnershipVerifiedIdCardEmoji(
        item.item.id + SWAGPACK_ID_OFFSET,
        item.item.count >= 3 ? "rainbow" : "",
      );
    } else {
      setOwnershipVerifiedSpecialItem(item.item.id);
    }
    setActiveItemSelection(getActiveInventoryItemSelection());
    return true;
  };

  const handleWithdrawEventPrize = async (
    prize: EventPrizeAssignment,
    recipientAddress: string,
  ): Promise<void> => {
    if (!isAuthenticated) {
      throw new Error("Prize withdrawal requires authentication.");
    }
    const response = await withdrawProfileEventPrize(
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
                        width={definition.imageWidth}
                        height={definition.imageHeight}
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
      {previewItem && (
        <InventoryItemPreview
          key={
            previewItem.kind === "eventPrize"
              ? `eventPrize-${previewItem.prize.eventId}-${previewItem.prize.prizeId}`
              : `${previewItem.kind}-${previewItem.item.id}`
          }
          item={previewItem}
          isCurrent={isPreviewItemCurrent}
          isAuthenticated={isAuthenticated}
          initialWithdrawalAddress={
            previewItem.kind === "eventPrize" ? authState.solAddress.trim() : ""
          }
          onApply={handleApplyPreviewItem}
          onWithdraw={handleWithdrawEventPrize}
          onDismiss={dismissPreview}
        />
      )}
    </InventoryPopup>
  );
});

InventoryModal.displayName = "InventoryModal";
