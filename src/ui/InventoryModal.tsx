import React, { useEffect, useState } from "react";
import styled from "styled-components";
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

const SWAGPACK_ITEM_COUNT = 467;
const SWAGPACK_ID_OFFSET = 1000;
const SWAGPACK_INVENTORY_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/swagpack/420";
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

const InventoryPopup = styled(TopRightPopoverBase)`
  box-sizing: border-box;
  width: min(301px, calc(100dvw - 18px));
  max-height: calc(100dvh - 113px - env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  transform: none;
  transition: none;

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

const SoonLabel = styled.span`
  position: absolute;
  inset: 0 0 21px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-gray-55);
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  text-transform: lowercase;
  transform: translateY(2px);
  pointer-events: none;

  @media (max-width: 280px) {
    bottom: 19px;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-d0);
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
  justify-content: center;
`;

const SwagPackLink = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 12px;
  border-radius: 999px;
  background: #41854c;
  color: #fff;
  font-weight: 700;
  line-height: 1;
  text-decoration: none;

  @media (prefers-color-scheme: dark) {
    background: #52a455;
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

const NFTNameContainer = styled.div`
  width: 100%;
  aspect-ratio: 1/1;
  border-radius: 6px;
  background: var(--color-gray-f5);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2px;
  text-align: center;
  box-sizing: border-box;

  @media (prefers-color-scheme: dark) {
    background: var(--inventoryItemBackgroundDark);
  }
`;

const AvatarTile = styled(NFTNameContainer)<{ $isActive: boolean }>`
  position: relative;
  padding: 0;
  overflow: visible;
  outline: ${(props) =>
    props.$isActive ? "2px solid var(--color-blue-primary)" : "none"};
  outline-offset: 2px;
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

  @media (prefers-color-scheme: dark) {
    outline-color: var(--color-blue-primary-dark);
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

interface SwagAvatarItem {
  id: number;
  count: number;
}

interface InventoryModalProps {
  id: string;
  onDismiss: () => void;
  authState: AuthState;
}

export const InventoryModal = React.forwardRef<
  HTMLDivElement,
  InventoryModalProps
>(({ id, onDismiss, authState }, ref) => {
  const isAuthenticated = authState.authStatus === "authenticated";
  const [avatars, setAvatars] = useState<SwagAvatarItem[]>([]);
  const [specials, setSpecials] = useState<SwagAvatarItem[]>([]);
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
  const ownerKey = isAuthenticated ? getNftIdentityKey(authState) : null;

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
          snapshot.data?.ok === true &&
          snapshot.expiresAtMs > 0 &&
          !isSnapshotFresh
        ) {
          snapshot = await fetchCurrentInventory();
          if (isCancelled) {
            return;
          }
          isSnapshotFresh = snapshot.expiresAtMs > Date.now();
        }
        const data = isSnapshotFresh ? snapshot.data : { ok: false };
        const ok = data?.ok === true;
        setDataOk(ok);
        setLoadedInventory(
          ok && ownerKey
            ? { ownerKey, expiresAtMs: snapshot.expiresAtMs }
            : null,
        );
        setAvatars(
          Array.isArray(data?.swagpack_avatars) ? data.swagpack_avatars : [],
        );
        setSpecials(Array.isArray(data?.specials) ? data.specials : []);
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
                <SoonLabel aria-hidden="true">soon</SoonLabel>
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
          {isLoading ? (
            <LoadingText>LOADING...</LoadingText>
          ) : avatars.length === 0 && specials.length === 0 ? (
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
                {specials.map((item) => (
                  <AvatarTile
                    key={`special-${item.id}`}
                    $isActive={activeItemSelection.specialIds.has(item.id)}
                    onClick={() => {
                      if (canApplyInventoryItem()) {
                        setOwnershipVerifiedSpecialItem(item.id);
                        setActiveItemSelection(
                          getActiveInventoryItemSelection(),
                        );
                      }
                    }}
                  >
                    <SpecialImage
                      src={`https://cdn.lil.org/mons/id_cards/misc/bd4/${item.id}.webp`}
                      alt=""
                      loading="lazy"
                    />
                    {item.count > 1 && (
                      <CountIndicator count={item.count}>
                        {item.count}
                      </CountIndicator>
                    )}
                  </AvatarTile>
                ))}
                {avatars.map((item) => (
                  <AvatarTile
                    key={item.id}
                    $isActive={activeItemSelection.avatarId === item.id}
                    onClick={() => {
                      if (canApplyInventoryItem()) {
                        setOwnershipVerifiedIdCardEmoji(
                          item.id + SWAGPACK_ID_OFFSET,
                          item.count >= 3 ? "rainbow" : "",
                        );
                        setActiveItemSelection(
                          getActiveInventoryItemSelection(),
                        );
                      }
                    }}
                  >
                    <AvatarImage
                      src={`${SWAGPACK_INVENTORY_IMAGE_BASE_URL}/${item.id}.webp`}
                      alt=""
                      rainbowAura={item.count >= 3}
                      loading="lazy"
                    />
                    {item.count > 1 && (
                      <CountIndicator count={item.count}>
                        {item.count}
                      </CountIndicator>
                    )}
                  </AvatarTile>
                ))}
              </NFTGrid>
            </NFTGridContainer>
          )}
        </InventorySection>
      </Content>
    </InventoryPopup>
  );
});

InventoryModal.displayName = "InventoryModal";
