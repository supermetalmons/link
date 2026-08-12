import React, { useCallback, useEffect, useRef, useState } from "react";
import { createEmptyMaterials } from "@mons/shared/mining";
import styled from "styled-components";
import { resolveENS } from "../utils/ensResolver";
import { showShinyCard } from "./shinyCardUiPort";
import {
  PlayerProfile,
  MiningMaterialName,
  MINING_MATERIAL_NAMES,
} from "../connection/connectionModels";
import { AvatarImage } from "./AvatarImage";
import { storage } from "../utils/storage";
import { getStashedPlayerProfile } from "../utils/playerMetadata";
import {
  leaderboardCache,
  type LeaderboardEntry,
  type LeaderboardType,
} from "./leaderboardCache";
import { getLeaderboardProfiles } from "./profileSurfaceDataPort";
import {
  LEADERBOARD_ENTRY_LIMIT,
  createLeaderboardEntry,
  getLeaderboardDisplayName,
  getLeaderboardMaterialTotal,
  populateMaterialLeaderboardCaches,
  profilesToLeaderboardEntries,
} from "./leaderboardModels";

export {
  resetLeaderboardCache,
  type LeaderboardType,
} from "./leaderboardCache";

export const LEADERBOARD_TYPE_ICON_URLS = {
  rating: "https://cdn.lil.org/mons/icons/elo_2.webp",
  mp: "https://cdn.lil.org/mons/emojipack/thumbs/1271.webp",
} as const;

const LeaderboardContainer = styled.div`
  position: relative;
  opacity: 1;
  height: calc(
    min(
      69dvh + 34px - env(safe-area-inset-bottom) * 0.63,
      100dvh - 66pt - env(safe-area-inset-bottom) * 0.63
    )
  );
  margin: -2px -6px 0 -6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
`;

const LeaderboardTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  color: var(--color-gray-33);
  table-layout: fixed;
  font-size: 0.85rem;

  @media (max-width: 360px) {
    font-size: 0.8rem;
  }

  @media (max-width: 320px) {
    font-size: 0.75rem;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }

  thead {
    position: sticky;
    top: 0;
    background-color: var(--color-white);
    z-index: 1;
    font-size: 0.93rem;

    @media (prefers-color-scheme: dark) {
      background-color: var(--color-deep-gray);
    }
  }

  th {
    padding: 0px 0 5px 0px;
    color: var(--color-gray-99);
    font-size: 0.777rem;

    @media (prefers-color-scheme: dark) {
      color: var(--color-gray-99);
    }
  }

  td {
    padding: 6px 0 6px 0px;

    @media (max-width: 360px) {
      padding: 4px 0 4px 0px;
    }
  }

  th,
  td {
    border-bottom: 1px solid var(--color-gray-dd);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;

    @media (prefers-color-scheme: dark) {
      border-bottom: 1px solid var(--color-gray-33);
    }

    &:nth-child(1) {
      width: 9.5%;
      text-align: left;
      font-size: 0.75rem;
      color: var(--color-gray-99);
      padding-left: 11px;

      @media (max-width: 320px) {
        width: 11.5%;
        padding-left: 9px;
      }
    }
    &:nth-child(2) {
      width: 11.5%;
      font-size: 0;
      text-align: left;
      overflow: visible;

      @media (max-width: 320px) {
        width: 13%;
      }
    }
    &:nth-child(3) {
      width: 60.5%;
      text-align: left;

      @media (max-width: 320px) {
        width: 55.5%;
      }
    }
    &:nth-child(4) {
      width: 18.5%;
      text-align: right;
      padding-right: 15px;

      @media (max-width: 360px) {
        padding-right: 10px;
      }

      @media (max-width: 320px) {
        width: 20%;
        padding-right: 5px;
      }
    }
  }

  tbody tr {
    cursor: pointer;

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--leaderboardRowHoverBackground);

        @media (prefers-color-scheme: dark) {
          background-color: var(--leaderboardRowHoverBackgroundDark);
        }
      }
    }
  }

  tbody tr[data-current="true"] {
    background-color: rgba(0, 122, 255, 0.08);
  }

  tbody tr[data-current="true"] td:first-child {
    box-shadow: inset 3px 0 0 var(--color-blue-primary);
  }

  tbody tr[data-current="true"] td:nth-child(3) {
    font-weight: 600;
  }

  @media (prefers-color-scheme: dark) {
    tbody tr[data-current="true"] {
      background-color: rgba(11, 132, 255, 0.16);
    }

    tbody tr[data-current="true"] td:first-child {
      box-shadow: inset 3px 0 0 var(--color-blue-primary-dark);
    }
  }

  @media (hover: hover) and (pointer: fine) {
    tbody tr[data-current="true"]:hover {
      background-color: rgba(0, 122, 255, 0.12);
    }
  }

  @media (prefers-color-scheme: dark) and (hover: hover) and (pointer: fine) {
    tbody tr[data-current="true"]:hover {
      background-color: rgba(11, 132, 255, 0.22);
    }
  }
`;

const BOTTOM_PANEL_OFFSET = 27;
const BOTTOM_VISIBILITY_THRESHOLD = 30;

const TableWrapper = styled.div`
  overflow-y: auto;
  flex: 1;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }

  overscroll-behavior: contain;
  touch-action: pan-y;
  padding-bottom: ${BOTTOM_PANEL_OFFSET}px;
`;

const FloatingRowContainer = styled.div<{
  $visible: boolean;
  $position: "top" | "bottom";
  $suppressAnimation: boolean;
}>`
  position: absolute;
  ${(props) =>
    props.$position === "top"
      ? "top: -2px; padding-top: 2px;"
      : `bottom: ${BOTTOM_PANEL_OFFSET}px;`}
  left: 0;
  right: 0;
  background: var(--color-white);
  transform: translateY(
    ${(props) =>
      props.$visible ? "0" : props.$position === "top" ? "-100%" : "100%"}
  );
  opacity: ${(props) => (props.$visible ? 1 : 0)};
  transition: ${(props) =>
    props.$suppressAnimation
      ? "none"
      : "transform 0.25s ease-out, opacity 0.2s ease-out"};
  z-index: 10;
  pointer-events: ${(props) => (props.$visible ? "auto" : "none")};

  @media (prefers-color-scheme: dark) {
    background: var(--color-deep-gray);
  }
`;

const FloatingRowInner = styled.div`
  display: flex;
  align-items: center;
  padding: 10px 0;
  font-size: 0.85rem;
  color: var(--color-gray-33);
  background-color: rgba(0, 122, 255, 0.08);
  cursor: pointer;

  @media (max-width: 360px) {
    font-size: 0.8rem;
    padding: 8px 0;
  }

  @media (max-width: 320px) {
    font-size: 0.75rem;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
    background-color: rgba(11, 132, 255, 0.16);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: rgba(0, 122, 255, 0.12);
    }
  }

  @media (prefers-color-scheme: dark) and (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: rgba(11, 132, 255, 0.22);
    }
  }
`;

const FloatingRowRank = styled.div`
  width: 9.5%;
  text-align: left;
  font-size: 0.75rem;
  color: var(--color-gray-99);
  padding-left: 11px;
  box-sizing: border-box;

  @media (max-width: 320px) {
    width: 11.5%;
    padding-left: 9px;
  }
`;

const FloatingRowEmoji = styled.div`
  width: 11.5%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;

  @media (max-width: 320px) {
    width: 13%;
  }
`;

const FloatingRowName = styled.div`
  width: 60.5%;
  text-align: left;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-sizing: border-box;

  @media (max-width: 320px) {
    width: 55.5%;
  }
`;

const FloatingRowValue = styled.div<{
  $isRating?: boolean;
  $win?: boolean;
}>`
  width: 18.5%;
  text-align: right;
  padding-right: 15px;
  font-weight: 500;
  box-sizing: border-box;
  color: ${(props) => {
    if (props.$isRating) {
      return props.$win
        ? "var(--leaderboardRatingWinColor)"
        : "var(--leaderboardRatingLossColor)";
    }
    return "var(--color-gray-77)";
  }};

  @media (max-width: 360px) {
    padding-right: 10px;
  }

  @media (max-width: 320px) {
    width: 20%;
    padding-right: 5px;
  }

  @media (prefers-color-scheme: dark) {
    color: ${(props) => {
      if (props.$isRating) {
        return props.$win
          ? "var(--leaderboardRatingWinColorDark)"
          : "var(--leaderboardRatingLossColorDark)";
      }
      return "var(--color-gray-99)";
    }};
  }
`;

const LoadingText = styled.div`
  text-align: center;
  font-size: 0.8rem;
  color: var(--color-gray-77);
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;

  @media (prefers-color-scheme: dark) {
    color: var(--leaderboardLoadingTextColorDark);
  }
`;

const RatingCell = styled.td<{ $win: boolean }>`
  color: ${(props) =>
    props.$win
      ? "var(--leaderboardRatingWinColor)"
      : "var(--leaderboardRatingLossColor)"};
  font-weight: 500;

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$win
        ? "var(--leaderboardRatingWinColorDark)"
        : "var(--leaderboardRatingLossColorDark)"};
  }
`;

const MaterialCell = styled.td`
  color: var(--color-gray-77);
  font-weight: 500;

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-99);
  }
`;

const NameCellContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
`;

const NameText = styled.span`
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const YouBadge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background-color: rgba(0, 122, 255, 0.16);
  color: var(--color-blue-primary);
  flex-shrink: 0;

  @media (prefers-color-scheme: dark) {
    background-color: rgba(11, 132, 255, 0.28);
    color: #fff;
  }
`;

const EmojiImage = styled.div`
  width: 26px;
  height: 26px;
  vertical-align: middle;
  margin-left: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;

  @media (max-width: 360px) {
    width: 24px;
    height: 24px;
  }

  @media (max-width: 320px) {
    width: 22px;
    height: 22px;
    margin-left: 1px;
  }
`;

const EmojiPlaceholder = styled.div`
  width: 26px;
  height: 26px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  margin-left: 2px;

  @media (max-width: 360px) {
    width: 24px;
    height: 24px;
  }

  @media (max-width: 320px) {
    width: 22px;
    height: 22px;
    margin-left: 1px;
  }

  &:after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background-color: var(--color-gray-e0);

    @media (max-width: 360px) {
      width: 16px;
      height: 16px;
    }

    @media (max-width: 320px) {
      width: 14px;
      height: 14px;
    }
  }

  @media (prefers-color-scheme: dark) {
    &:after {
      background-color: var(--color-gray-44);
    }
  }
`;

interface LeaderboardProps {
  show: boolean;
  leaderboardType: LeaderboardType;
}

type RowPosition = "visible" | "above" | "below";

export const Leaderboard: React.FC<LeaderboardProps> = ({
  show,
  leaderboardType,
}) => {
  const [data, setData] = useState<LeaderboardEntry[] | null>(
    () => leaderboardCache.get(leaderboardType) ?? null,
  );
  const [loadedEmojis, setLoadedEmojis] = useState<Set<string>>(new Set());
  const [currentRowPosition, setCurrentRowPosition] =
    useState<RowPosition>("visible");
  const [suppressPanelAnimation, setSuppressPanelAnimation] = useState(true);
  const [bottomPanelHasAnimated, setBottomPanelHasAnimated] = useState(false);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const currentRowRef = useRef<HTMLTableRowElement | null>(null);
  const prevLeaderboardTypeRef = useRef<LeaderboardType>(leaderboardType);
  const prevShowRef = useRef<boolean>(show);
  const currentFetchRef = useRef<number>(0);
  const currentProfileId = storage.getProfileId("");
  const currentLoginId = storage.getLoginId("");

  const getCurrentPlayerEntry = useCallback((): LeaderboardEntry | null => {
    if (!currentProfileId) return null;
    const storedUsername = storage.getUsername("");
    const storedEth = storage.getEthAddress("");
    const storedSol = storage.getSolAddress("");
    const storedEmoji = parseInt(storage.getPlayerEmojiId("1"), 10) || 1;
    const storedAura = storage.getPlayerEmojiAura("") || undefined;
    const storedMaterials = storage.getMiningMaterials(
      createEmptyMaterials(),
    ) as Record<MiningMaterialName, number>;
    const storedMining = {
      lastRockDate: storage.getMiningLastRockDate(null),
      materials: { ...createEmptyMaterials(), ...storedMaterials },
    };
    const stashedProfile = currentLoginId
      ? getStashedPlayerProfile(currentLoginId)
      : undefined;
    const profile =
      stashedProfile && stashedProfile.id === currentProfileId
        ? stashedProfile
        : undefined;
    const mergedProfile: PlayerProfile = {
      id: currentProfileId,
      nonce: profile?.nonce ?? storage.getPlayerNonce(-1),
      rating: profile?.rating ?? storage.getPlayerRating(1500),
      win: profile?.win ?? true,
      emoji: profile?.emoji ?? storedEmoji,
      aura: profile?.aura ?? storedAura,
      totalManaPoints:
        profile?.totalManaPoints ?? storage.getPlayerTotalManaPoints(0),
      cardBackgroundId:
        profile?.cardBackgroundId ?? storage.getCardBackgroundId(0),
      cardSubtitleId: profile?.cardSubtitleId ?? storage.getCardSubtitleId(0),
      profileCounter:
        profile?.profileCounter ?? storage.getProfileCounter("gp"),
      profileMons: profile?.profileMons ?? storage.getProfileMons(""),
      cardStickers: profile?.cardStickers ?? storage.getCardStickers(""),
      username: profile?.username ?? (storedUsername ? storedUsername : null),
      eth: profile?.eth ?? (storedEth ? storedEth : null),
      sol: profile?.sol ?? (storedSol ? storedSol : null),
      completedProblemIds: profile?.completedProblemIds,
      isTutorialCompleted: profile?.isTutorialCompleted,
      mining: profile?.mining ?? storedMining,
    };
    return createLeaderboardEntry(mergedProfile);
  }, [currentProfileId, currentLoginId]);

  useEffect(() => {
    const currentRow = currentRowRef.current;
    const tableWrapper = tableWrapperRef.current;
    if (!currentRow || !tableWrapper) {
      setCurrentRowPosition("visible");
      return;
    }

    const checkPosition = () => {
      const rowRect = currentRow.getBoundingClientRect();
      const wrapperRect = tableWrapper.getBoundingClientRect();
      const visibleBottom = wrapperRect.bottom - BOTTOM_VISIBILITY_THRESHOLD;

      if (rowRect.bottom < wrapperRect.top) {
        setCurrentRowPosition("above");
      } else if (rowRect.top > visibleBottom) {
        setCurrentRowPosition("below");
      } else {
        setCurrentRowPosition("visible");
      }
    };

    checkPosition();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setCurrentRowPosition("visible");
          } else {
            checkPosition();
          }
        });
      },
      {
        root: tableWrapper,
        rootMargin: `0px 0px -${BOTTOM_VISIBILITY_THRESHOLD}px 0px`,
        threshold: 0.1,
      },
    );

    observer.observe(currentRow);
    tableWrapper.addEventListener("scroll", checkPosition, { passive: true });

    return () => {
      observer.disconnect();
      tableWrapper.removeEventListener("scroll", checkPosition);
    };
  }, [data, show]);

  useEffect(() => {
    const menuJustOpened = show && !prevShowRef.current;
    const leaderboardTypeChanged =
      prevLeaderboardTypeRef.current !== leaderboardType;

    if (menuJustOpened || leaderboardTypeChanged) {
      setSuppressPanelAnimation(true);
    }

    prevShowRef.current = show;
    prevLeaderboardTypeRef.current = leaderboardType;

    if (show && tableWrapperRef.current && leaderboardTypeChanged) {
      tableWrapperRef.current.scrollTop = 0;
    }
  }, [show, leaderboardType]);

  useEffect(() => {
    if (!suppressPanelAnimation || !show || !data) return;

    const timer = setTimeout(() => {
      setSuppressPanelAnimation(false);
    }, 50);

    return () => clearTimeout(timer);
  }, [suppressPanelAnimation, show, data]);

  useEffect(() => {
    if (currentRowPosition === "below" && !bottomPanelHasAnimated) {
      const timer = setTimeout(() => {
        setBottomPanelHasAnimated(true);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [currentRowPosition, bottomPanelHasAnimated]);

  useEffect(() => {
    setData(leaderboardCache.get(leaderboardType) ?? null);
  }, [leaderboardType]);

  useEffect(() => {
    if (!show) {
      currentFetchRef.current += 1;
      return;
    }

    if (tableWrapperRef.current) {
      setTimeout(() => {
        if (tableWrapperRef.current) {
          tableWrapperRef.current.scrollTop = 0;
        }
      }, 5);
    }

    const fetchId = ++currentFetchRef.current;

    getLeaderboardProfiles(leaderboardType)
      .then((profiles) => {
        if (fetchId !== currentFetchRef.current) return;

        const leaderboardData = profilesToLeaderboardEntries(profiles);
        const currentEntry = getCurrentPlayerEntry();
        const mergedLeaderboardData =
          currentEntry &&
          !leaderboardData.some((entry) => entry.id === currentEntry.id)
            ? [...leaderboardData, currentEntry]
            : leaderboardData;
        const displayLeaderboardData = mergedLeaderboardData;
        leaderboardCache.set(leaderboardType, displayLeaderboardData);
        setData(displayLeaderboardData);

        if (
          leaderboardType === "total" ||
          MINING_MATERIAL_NAMES.includes(leaderboardType as MiningMaterialName)
        ) {
          populateMaterialLeaderboardCaches(
            leaderboardCache,
            profilesToLeaderboardEntries(profiles),
          );
        }

        const activeLeaderboardType = leaderboardType;
        displayLeaderboardData.forEach((entry, index) => {
          if (entry.eth && !entry.username) {
            void resolveENS(entry.eth).then((ensName) => {
              if (!ensName || fetchId !== currentFetchRef.current) {
                return;
              }
              setData((prevData) => {
                if (
                  !prevData ||
                  fetchId !== currentFetchRef.current ||
                  index >= prevData.length
                ) {
                  return prevData;
                }
                const newData = [...prevData];
                newData[index] = { ...newData[index], ensName };
                leaderboardCache.set(activeLeaderboardType, newData);
                return newData;
              });
            });
          }
        });
      })
      .catch((error) => {
        console.error("Failed to fetch leaderboard data:", error);
      });
    return () => {
      currentFetchRef.current += 1;
    };
  }, [show, leaderboardType, getCurrentPlayerEntry]);

  const handleRowClick = (row: LeaderboardEntry) => {
    showShinyCard(row.profile, getLeaderboardDisplayName(row), true);
  };

  const handleEmojiLoad = (emojiKey: string) => {
    setLoadedEmojis((prev) => new Set(prev).add(emojiKey));
  };

  const getValueCell = (row: LeaderboardEntry) => {
    if (leaderboardType === "rating") {
      return <RatingCell $win={row.win}>{row.rating}</RatingCell>;
    }
    if (leaderboardType === "mp") {
      return <MaterialCell>{row.mp}</MaterialCell>;
    }
    if (leaderboardType === "total") {
      return <MaterialCell>{getLeaderboardMaterialTotal(row)}</MaterialCell>;
    }
    return <MaterialCell>{row.materials[leaderboardType]}</MaterialCell>;
  };

  const isCurrentProfile = (row: LeaderboardEntry): boolean => {
    if (currentProfileId && row.id === currentProfileId) return true;
    return false;
  };

  const currentPlayerData = data?.find((row) => isCurrentProfile(row));
  const currentPlayerIndex =
    data?.findIndex((row) => isCurrentProfile(row)) ?? -1;
  const currentPlayerRankLabel =
    currentPlayerIndex >= LEADERBOARD_ENTRY_LIMIT
      ? "∅"
      : currentPlayerIndex + 1;

  const getFloatingValue = (row: LeaderboardEntry) => {
    if (leaderboardType === "rating") {
      return { value: row.rating, isRating: true, win: row.win };
    }
    if (leaderboardType === "mp") {
      return { value: row.mp, isRating: false, win: false };
    }
    if (leaderboardType === "total") {
      return {
        value: getLeaderboardMaterialTotal(row),
        isRating: false,
        win: false,
      };
    }
    return {
      value: row.materials[leaderboardType],
      isRating: false,
      win: false,
    };
  };

  const scrollToCurrentRow = () => {
    if (currentRowRef.current && tableWrapperRef.current) {
      currentRowRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  };

  return (
    <LeaderboardContainer>
      {data ? (
        <TableWrapper ref={tableWrapperRef}>
          <LeaderboardTable>
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((row: LeaderboardEntry, index: number) => {
                const emojiUrl = emojis.getEmojiUrl(row.emoji.toString());
                const emojiKey = `${row.id}-${row.emoji}`;
                const isEmojiLoaded = loadedEmojis.has(emojiKey);
                const isCurrentPlayer = isCurrentProfile(row);
                const rankLabel =
                  isCurrentPlayer &&
                  currentPlayerIndex >= LEADERBOARD_ENTRY_LIMIT
                    ? "∅"
                    : index + 1;

                return (
                  <tr
                    key={row.id}
                    ref={isCurrentPlayer ? currentRowRef : undefined}
                    data-current={isCurrentPlayer ? "true" : "false"}
                    onClick={() => handleRowClick(row)}
                  >
                    <td>{rankLabel}</td>
                    <td>
                      {!isEmojiLoaded && <EmojiPlaceholder />}
                      <EmojiImage
                        style={{ display: isEmojiLoaded ? "flex" : "none" }}
                      >
                        <AvatarImage
                          src={emojiUrl}
                          alt=""
                          rainbowAura={!!row.aura}
                          loading="eager"
                          onLoad={() => handleEmojiLoad(emojiKey)}
                        />
                      </EmojiImage>
                    </td>
                    <td>
                      <NameCellContent>
                        <NameText>{getLeaderboardDisplayName(row)}</NameText>
                        {isCurrentPlayer && <YouBadge>you</YouBadge>}
                      </NameCellContent>
                    </td>
                    {getValueCell(row)}
                  </tr>
                );
              })}
            </tbody>
          </LeaderboardTable>
        </TableWrapper>
      ) : (
        <LoadingText>UPDATING...</LoadingText>
      )}
      {currentPlayerData && currentPlayerIndex >= 0 && (
        <>
          {(["top", "bottom"] as const).map((position) => (
            <FloatingRowContainer
              key={position}
              $visible={
                currentRowPosition === (position === "top" ? "above" : "below")
              }
              $position={position}
              $suppressAnimation={
                position === "top"
                  ? suppressPanelAnimation
                  : bottomPanelHasAnimated
              }
              onClick={scrollToCurrentRow}
            >
              <FloatingRowInner>
                <FloatingRowRank>{currentPlayerRankLabel}</FloatingRowRank>
                <FloatingRowEmoji>
                  <EmojiImage>
                    <AvatarImage
                      src={emojis.getEmojiUrl(
                        currentPlayerData.emoji.toString(),
                      )}
                      alt=""
                      rainbowAura={!!currentPlayerData.aura}
                      loading="eager"
                    />
                  </EmojiImage>
                </FloatingRowEmoji>
                <FloatingRowName>
                  <NameCellContent>
                    <NameText>
                      {getLeaderboardDisplayName(currentPlayerData)}
                    </NameText>
                    <YouBadge>you</YouBadge>
                  </NameCellContent>
                </FloatingRowName>
                <FloatingRowValue
                  $isRating={getFloatingValue(currentPlayerData).isRating}
                  $win={getFloatingValue(currentPlayerData).win}
                >
                  {getFloatingValue(currentPlayerData).value}
                </FloatingRowValue>
              </FloatingRowInner>
            </FloatingRowContainer>
          ))}
        </>
      )}
    </LeaderboardContainer>
  );
};

const emojis = (await import("../content/emojis")).emojis;
